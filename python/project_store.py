# -*- coding: utf-8 -*-
"""定位「项目自建全局配置 store」—— 跟随项目自己的声明，不硬编码模块名。

背景：ok-end-field / OK-AzurPromilia 这类项目的全局配置不走框架 GlobalConfig，
而是自建 store（模块级 ``get_all_visible_configs()`` 枚举 + ``get_global_config(name)`` 取用）。
插件过去把 ``src.core.global_config_store`` **写死在探针与执行器两处** ——
项目换个模块路径，那批全局配置就整批消失，而且一声不响。

模块放哪由项目自己决定，插件只读它的声明。链路全在项目里：

    src/config.py
        config = { "custom_tabs": [["src.gui.GlobalConfigTab", "GlobalConfigTab"], ...] }
                                                        │
    src/gui/GlobalConfigTab.py                          ▼
        from src.core.global_config_store import ..., get_all_visible_configs
             └──────────────────────────────────────── 这就是 store 模块

两级来源，按可靠性排序；都空才用历史默认名兜底（兼容老项目）：

1. :func:`declared_store_modules` —— 按上面那条链路从项目 config 的 ``custom_tabs``
   静态解析（AST，**不 import**：探针要在 ``OK()`` 之前跑、执行器是 headless，
   import 项目 GUI 模块会有副作用）。
2. :func:`imported_store_modules` —— 退一步，在 ``sys.modules`` 里找**文件位于项目目录下**
   且提供 store 接口的模块（项目自己的任务模块会 import 它，``OK()`` 之后必然在）。

刻意**不**按模块名匹配：store 叫什么、放哪个包，是项目自己的事。
"""

import ast
import os
import sys

#: store 的枚举入口（模块级）—— 判定「这个模块就是 store」的接口凭据之一
STORE_ENUM_ENTRY = "get_all_visible_configs"

#: store 的取用入口（模块级）—— 另一条凭据
STORE_GETTER = "get_global_config"

#: 历史默认名。只在项目里什么都没声明、也没导入时兜底，不再作为唯一来源。
LEGACY_STORE_MODULE = "src.core.global_config_store"


def declared_tab_modules(config):
    """项目 config 里 ``custom_tabs`` 声明的模块名（保序去重）。

    项目 GUI 的全局配置页就在这里面 —— 它是 store 模块的**声明点**。
    """
    modules = []
    for entry in (config or {}).get("custom_tabs") or []:
        if not isinstance(entry, (list, tuple)) or not entry:
            continue
        name = entry[0]
        if isinstance(name, str) and name.strip() and name.strip() not in modules:
            modules.append(name.strip())
    return modules


def module_file(project_dir, module_name):
    """模块名 → 项目下的文件路径；找不到返回 ``None``。

    同时接受 ``src.gui.GlobalConfigTab`` 与 ``src/gui/GlobalConfigTab.py`` 两种写法
    （有的项目在 custom_tabs 里直接写相对路径）。
    """
    text = str(module_name or "").strip()
    if not text:
        return None
    dotted = os.path.join(project_dir, *text.split("."))
    for candidate in (dotted + ".py", os.path.join(dotted, "__init__.py")):
        if os.path.isfile(candidate):
            return candidate
    literal = os.path.join(project_dir, text.replace("/", os.sep).replace("\\", os.sep))
    return literal if os.path.isfile(literal) else None


def module_package(project_dir, path):
    """文件路径 → 它所在的包名（``src/gui/GlobalConfigTab.py`` → ``src.gui``）。

    相对导入必须按这个包解析：只取 ``node.module`` 会把 ``from ..core.X import Y``
    记成顶层 ``core.X``，随后去 import 它，轻则 ImportError（该条信息静默丢失），
    重则撞上同名的无关顶层模块（取到错值并执行其副作用）。
    """
    rel = os.path.relpath(path, project_dir).replace(os.sep, "/")
    parts = rel.split("/")[:-1]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def parse_imports(project_dir, path):
    """AST 解析一个 .py，返回 ``(tree, {本地名: (模块名, 原名)})``；失败返回 ``(None, {})``。"""
    try:
        with open(path, encoding="utf-8") as stream:
            tree = ast.parse(stream.read())
    except Exception:  # noqa: BLE001 — 语法错/编码错都只影响这一个文件
        return None, {}
    package = module_package(project_dir, path)
    imports = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or not (node.module or node.level):
            continue
        module_name = node.module
        if node.level:
            try:
                module_name = importlib_resolve_name("." * node.level + (node.module or ""), package)
            except Exception:  # noqa: BLE001 — 越出顶层包的相对导入，丢弃这一条
                continue
            if module_name.endswith("."):
                module_name = module_name[:-1]
        for alias in node.names:
            imports[alias.asname or alias.name] = (module_name, alias.name)
    return tree, imports


def importlib_resolve_name(name, package):
    """``importlib.util.resolve_name`` 的薄封装（便于单测替换）。"""
    import importlib.util

    return importlib.util.resolve_name(name, package)


def declared_store_modules(config, project_dir):
    """按项目声明解析出 store 模块名（custom_tabs → 该页 import 的 store）。

    判据是**接口**：tab 里 ``from X import ... get_all_visible_configs`` ⇒ ``X`` 就是 store。
    项目把 store 改名、挪包都不用改插件。
    """
    found = []
    for tab_module in declared_tab_modules(config):
        path = module_file(project_dir, tab_module)
        if not path:
            continue
        tree, imports = parse_imports(project_dir, path)
        if tree is None:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            for alias in node.names:
                if alias.name != STORE_ENUM_ENTRY:
                    continue
                owner = imports.get(alias.asname or alias.name)
                if owner and owner[0] and owner[0] not in found:
                    found.append(owner[0])
    return found


def imported_store_modules(project_dir):
    """在 ``sys.modules`` 里找**项目目录下**且提供 store 接口的模块（按模块名排序）。

    位置过滤很关键：框架 ``ok.util.GlobalConfig`` 里这两个入口都是**类方法**，
    但同类名模块在 site-packages 里也不该被当成本项目的 store。
    """
    prefix = os.path.realpath(project_dir) + os.sep
    found = []
    for name, module in list(sys.modules.items()):
        if module is None:
            continue
        path = getattr(module, "__file__", None)
        if not path:
            continue
        try:
            if not os.path.realpath(path).startswith(prefix):
                continue
        except OSError:
            continue
        if callable(getattr(module, STORE_ENUM_ENTRY, None)) and callable(getattr(module, STORE_GETTER, None)):
            found.append(name)
    return sorted(found)


def store_modules(config, project_dir):
    """store 模块名候选：项目声明 → 已导入的 → 历史默认名。"""
    names = declared_store_modules(config, project_dir)
    for name in imported_store_modules(project_dir):
        if name not in names:
            names.append(name)
    if not names:
        names.append(LEGACY_STORE_MODULE)
    return names

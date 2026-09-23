# -*- coding: utf-8 -*-
"""全量 import 采集 ok-script 项目所有任务的配置 schema。

复用 ok-script 的 OK(config) + TaskManager 初始化来实例化任务，拿到经过继承链
合并的真实 default_config / config_type / config_description / 已保存 config。
逐任务 try/except 容错，坏任务标记 broken，不影响其他任务。

用法: python probe_task_schemas.py <project_dir>
输出(最后一行 JSON): {"ok": true, "total": N, "broken": [...], "schemas": {...}}
"""
import ast
import importlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from enum import Enum

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


UNSERIALIZABLE = object()


def _po_string(fragment):
    """解析 PO 行中的 Python/gettext 引号字符串。"""
    try:
        value = ast.literal_eval(fragment.strip())
        return value if isinstance(value, str) else ""
    except (SyntaxError, ValueError):
        return ""


def load_po_catalog(project_dir, locale, po_directory="i18n", domain="ok"):
    """直接读取目标项目 PO，返回 msgid -> msgstr；空译文回退 msgid。"""
    po_root = po_directory if os.path.isabs(po_directory) else os.path.join(project_dir, po_directory)
    file_path = os.path.join(po_root, locale, "LC_MESSAGES", f"{domain}.po")
    if not os.path.isfile(file_path):
        return {}
    catalog = {}
    msgid = None
    msgstr = None
    section = None

    def flush():
        nonlocal msgid, msgstr, section
        if msgid:
            catalog[msgid] = msgstr or msgid
        msgid = None
        msgstr = None
        section = None

    with open(file_path, encoding="utf-8") as stream:
        for raw in stream:
            line = raw.strip()
            if not line:
                flush()
                continue
            if line.startswith("#"):
                continue
            if line.startswith("msgid "):
                if msgid is not None:
                    flush()
                msgid = _po_string(line[6:])
                msgstr = ""
                section = "msgid"
                continue
            if line.startswith("msgstr "):
                msgstr = _po_string(line[7:])
                section = "msgstr"
                continue
            if line.startswith('"'):
                value = _po_string(line)
                if section == "msgid" and msgid is not None:
                    msgid += value
                elif section == "msgstr" and msgstr is not None:
                    msgstr += value
    flush()
    return catalog


# ── 框架 Qt 翻译层（GUI tr() 的第一优先级）─────────────────────────────────
#
# 框架把内置文案（Basic Options / Notification 等的字段名与描述）的翻译编译成
# .qm 藏在 Qt 资源 :/i18n，GUI 的 tr() 先查 QCoreApplication.translate('app', key)，
# 没有才回落 gettext（项目 po）。实测：'Auto Start Game When App Starts' ->
# '程序启动时候自动启动游戏'、'Basic Options' -> '基本设置'。探针此前只接 gettext 层，
# 框架文案全部显示英文原值 —— 与 GUI 不一致。这里补上同一层，优先级与 GUI 对齐：
# Qt(.qm) > 项目 po > 原文。项目 venv 没有 PySide6 时静默跳过，行为退回纯 po。
#
# 资源模块路径随框架大版本变过：1.0.x 是 ok.gui.resources，2.0.x 迁到
# ok.ui.qt.resources。只认后者会让 1.0.x 项目（如 ok-gm，ok-script==1.0.179）
# 整层翻译静默丢失 —— 框架文案全英文，与 GUI 不一致且没有任何提示。
QT_RESOURCE_MODULES = ("ok.ui.qt.resources", "ok.gui.resources")

_QT_TRANSLATOR = None
_QT_TRANSLATOR_REASON = None


def load_qt_translator(locale):
    """加载框架 Qt 资源 :/i18n/<locale>.qm；失败返回 None（探针继续用 po）。

    刻意**不创建 QCoreApplication**：
      * 探针只用 translator.translate() 直接查表，既不 installTranslator 也不要
        事件循环 —— 实测无 app 实例时 QTranslator 照样能 load 并翻译。
      * 一旦先建了 QCoreApplication，项目导入链里任何 `QApplication(sys.argv)`
        （ok 2.x 的 App -> init_app_config）都会抛
        "libshiboken: Please destroy the QCoreApplication singleton before
        creating a new QApplication instance."，整个探针报废。
    """
    global _QT_TRANSLATOR, _QT_TRANSLATOR_REASON
    module_used = None
    for module_name in QT_RESOURCE_MODULES:
        try:
            importlib.import_module(module_name)  # import 副作用：注册 :/i18n 资源
            module_used = module_name
            break
        except Exception:  # noqa: BLE001 — 该版本没有这个模块，试下一个
            continue
    if module_used is None:
        _QT_TRANSLATOR = None
        _QT_TRANSLATOR_REASON = f"未找到 Qt 资源模块 {QT_RESOURCE_MODULES}"
        # venv 没装 Qt 的项目（纯 headless/web）属正常，不报；装了 Qt 却认不出
        # 资源模块 = 框架布局又变了，这种"整层翻译静默消失"必须留痕。
        try:
            import PySide6  # noqa: F401
            sys.stderr.write(f"[probe] {_QT_TRANSLATOR_REASON}，框架文案回落到 po/原文\n")
        except Exception:  # noqa: BLE001 — 无 Qt 的 venv，静默退回纯 po
            pass
        return None
    try:
        from PySide6.QtCore import QTranslator

        translator = QTranslator()
        if translator.load(locale, ':/i18n'):
            _QT_TRANSLATOR = translator
            _QT_TRANSLATOR_REASON = None
        else:
            # 框架只为非源语言编译 .qm（en_US 是源语言）—— 该 locale 没有 .qm 是
            # 正常情况，译文等于原文，不报。
            _QT_TRANSLATOR = None
            _QT_TRANSLATOR_REASON = f"{module_used} 未提供 {locale}.qm"
    except Exception as e:  # noqa: BLE001 — 有资源模块却 import 不到 Qt，属异常
        _QT_TRANSLATOR = None
        _QT_TRANSLATOR_REASON = f"{type(e).__name__}: {e}"
        sys.stderr.write(f"[probe] Qt 翻译层不可用：{_QT_TRANSLATOR_REASON}\n")
    return _QT_TRANSLATOR


def qt_translate(value):
    """查 Qt 层译文；未加载 / 未命中时返回 None（调用方回落 po）。"""
    if _QT_TRANSLATOR is None or not isinstance(value, str) or not value:
        return None
    translated_value = _QT_TRANSLATOR.translate('app', value)
    return translated_value if translated_value and translated_value != value else None


def translated(catalog, value):
    if not isinstance(value, str) or not value:
        return value
    qt_value = qt_translate(value)
    if qt_value is not None:
        return qt_value
    return catalog.get(value, value)


# ── 项目 GUI 的全局配置分组名（对齐 Qt GUI 的标题翻译链路）──────────────────
#
# 项目自建配置页 <project>/src/gui/[Gg]lobal[Cc]onfig[Tt]ab.py 用
# GLOBAL_CONFIG_GROUPS = {"中文分组名": ["config 名", ...]} 给全局配置归组，
# 并把**中文分组名**传给 ConfigCard(None, group_name, ...) 当卡片标题。
# 于是 GUI 标题的翻译链路是 tr("战斗配置") —— po 里的 msgid 是中文分组名
# （ja_JP: 戦闘設定、en_US: Battle Config…），而不是英文 config 名。
# 本探针此前拿 config 名（"Battle Config"）查 po 永远落空，于是显示英文原值。
# 这里按同一约定反查分组名，再用它过 po，与 GUI 逐字对齐。

GUI_GROUP_TAB_CANDIDATES = (
    ("src", "gui", "GlobalConfigTab.py"),
    ("src", "gui", "global_config_tab.py"),
)


def _resolve_gui_constant(node, imports):
    """求值分组映射里的节点：字符串字面量直接取；名字引用从 import 的模块常量取。"""
    if isinstance(node, ast.Constant):
        return node.value if isinstance(node.value, str) else None
    if isinstance(node, ast.Name):
        target = imports.get(node.id)
        if not target:
            return None
        module_name, attr = target
        # 探针主流程已 import 项目 config（任务→core 链），store 模块通常已在
        # sys.modules；不在时再 import 一次，失败只影响这一条映射。
        module = sys.modules.get(module_name)
        if module is None:
            try:
                module = importlib.import_module(module_name)
            except Exception:
                return None
        value = getattr(module, attr, None)
        return value if isinstance(value, str) else None
    return None


def load_gui_group_names(project_dir):
    """读项目 GUI 的 GLOBAL_CONFIG_GROUPS，返回 {config 名: 中文分组名}。

    无该约定的项目返回 {}，此时回退用 config 名查 po，行为不变。
    """
    for rel in GUI_GROUP_TAB_CANDIDATES:
        path = os.path.join(project_dir, *rel)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as stream:
                tree = ast.parse(stream.read())
        except Exception:
            continue
        # 该文件所在包（如 "src.gui"）。相对导入必须按它解析 —— 只取 `node.module` 会把
        # `from ..core.BattleConfig import X` 记成顶层 "core.BattleConfig"，随后
        # `_resolve_gui_constant` 去 import 它：轻则 ImportError（该条映射静默丢失、
        # 配置分段退回英文 config 名），重则撞上同名的无关顶层模块（取到错值并执行其副作用）。
        package = ".".join(rel[:-1])
        imports = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and (node.module or node.level):
                module_name = node.module
                if node.level:
                    try:
                        module_name = importlib.util.resolve_name(
                            "." * node.level + (node.module or ""), package
                        )
                    except (ImportError, ValueError):
                        # 越出顶层包的相对导入（level 超过包层数）—— 丢弃这一条，不影响其余
                        continue
                    if module_name.endswith("."):
                        # `from . import X`（无 module 部分）会解出带尾点的包名
                        module_name = module_name[:-1]
                for alias in node.names:
                    imports[alias.asname or alias.name] = (module_name, alias.name)
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            if not any(isinstance(t, ast.Name) and t.id == "GLOBAL_CONFIG_GROUPS" for t in node.targets):
                continue
            if not isinstance(node.value, ast.Dict):
                continue
            mapping = {}
            for key_node, value_node in zip(node.value.keys, node.value.values):
                group_name = _resolve_gui_constant(key_node, imports)
                if not group_name or not isinstance(value_node, (ast.List, ast.Tuple)):
                    continue
                for element in value_node.elts:
                    config_name = _resolve_gui_constant(element, imports)
                    if config_name:
                        mapping.setdefault(config_name, group_name)
            return mapping
    return {}


def group_display_name(catalog, gui_names, gname):
    """全局配置组显示名：GUI 分组名过 po（对齐 Qt GUI 标题）> config 名过 po。"""
    gname = str(gname)
    return translated(catalog, gui_names.get(gname, gname))


def translated_type_meta(type_meta, catalog):
    """复制 config_type，并附加显示标签，不改变任何原始 option 值。"""
    serialized = jsonable(type_meta)
    if not isinstance(serialized, dict):
        return serialized
    options = type_meta.get("options") if isinstance(type_meta, dict) else None
    if isinstance(options, (list, tuple)):
        serialized["option_labels"] = [translated(catalog, value) if isinstance(value, str) else str(value) for value in options]
    elif isinstance(options, dict):
        serialized["option_labels"] = {
            str(category): [translated(catalog, value) if isinstance(value, str) else str(value) for value in values]
            for category, values in options.items()
            if isinstance(values, (list, tuple))
        }
        serialized["category_labels"] = {
            str(category): translated(catalog, str(category)) for category in options
        }
    available = type_meta.get("options_available") if isinstance(type_meta, dict) else None
    if isinstance(available, (list, tuple)):
        serialized["options_available_labels"] = [
            translated(catalog, value) if isinstance(value, str) else str(value) for value in available
        ]
    sub_configs = type_meta.get("sub_configs") if isinstance(type_meta, dict) else None
    if isinstance(sub_configs, dict):
        serialized["sub_config_labels"] = {
            str(choice): translated(catalog, str(choice)) for choice in sub_configs
        }
    return serialized


def jsonable(v):
    """转成可 JSON 序列化形式；不可序列化对象返回 UNSERIALIZABLE。"""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, Enum):
        return jsonable(v.value)
    if isinstance(v, (list, tuple)):
        out = []
        for x in v:
            jx = jsonable(x)
            if jx is not UNSERIALIZABLE:
                out.append(jx)
        return out
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            jx = jsonable(x)
            if jx is not UNSERIALIZABLE:
                out[str(k)] = jx
        return out
    return UNSERIALIZABLE


def normalize_group_map(value):
    """规范化配置分组为 {组名: [字段/子组]}，保留声明顺序。"""
    if not isinstance(value, dict):
        return {}
    groups = {}
    for group_name, children in value.items():
        if isinstance(children, str):
            normalized = [children]
        elif isinstance(children, (list, tuple)):
            normalized = [str(item) for item in children if isinstance(item, str)]
        else:
            continue
        groups[str(group_name)] = normalized
    return groups


def find_pure_group_labels(config_groups, default_config, runtime_config):
    """挑出「纯分组标签」：只作为分组容器、自身没有任何可编辑值的分组名。

    `_init_default_config_group` 会把每个分组名也写进 ``config_type``
    （``{'sub_configs': {True: [...]}}``），所以分组名在 config_type 里总是
    带 type 元数据。但对于像 ok-gf2「自主循环跳过项」这类 key —— 它既不在
    ``default_config`` 也不在运行期 ``config`` 里 —— 它没有值可编辑，
    只是子项的容器。

    这类 key 若照常作为字段输出，前端 ``buildField`` 取到 ``undefined``
    会一路落到 ``buildText`` 兜底分支，凭空渲染出一个无意义的输入框。

    判定必须同时看 default_config 与 runtime_config：分组名恰好又是一个
    真实开关的情况（如「活动层」「班组」）必须保留为字段。
    """
    return {
        group_name
        for group_name in config_groups
        if group_name not in default_config and group_name not in runtime_config
    }


def find_group_selector(config_type, declared_groups):
    """识别 register_config_groups 生成的分组下拉，而非普通条件下拉。"""
    for key, type_meta in config_type.items():
        if not isinstance(type_meta, dict) or type_meta.get("type") != "drop_down":
            continue
        options = type_meta.get("options")
        rules = type_meta.get("sub_configs")
        if not isinstance(options, (list, tuple)) or not isinstance(rules, dict):
            continue
        normalized_rules = normalize_group_map(rules)
        rule_keys = set(normalized_rules)
        declared_matches = all(
            normalized_rules.get(group_name) == children
            for group_name, children in declared_groups.items()
        )
        if (
            options
            and declared_groups
            and declared_matches
            and all(str(option) in rule_keys for option in options)
        ):
            return str(key), normalized_rules
    return None, {}


def detect_config_folder(project_dir):
    """在导入项目之前用 AST 读取 config_folder，默认 configs。"""
    for candidate in (
        os.path.join(project_dir, "src", "config.py"),
        os.path.join(project_dir, "config.py"),
    ):
        try:
            with open(candidate, encoding="utf-8") as f:
                tree = ast.parse(f.read(), filename=candidate)
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                if (
                    isinstance(key, ast.Constant)
                    and key.value == "config_folder"
                    and isinstance(value, ast.Constant)
                    and isinstance(value.value, str)
                ):
                    return value.value
    return "configs"


def icon_name(icon):
    """把框架/qfluentwidgets 的图标对象序列化为名称字符串（拿不到返回空串）。"""
    if icon is None:
        return ""
    name = getattr(icon, "name", None)
    return name if isinstance(name, str) and name else ""


def field_payload(key, default_config, runtime_config, config_type, config_description, catalog):
    """单个配置键 → 前端字段 payload；不可输出时返回 None。

    任务字段与全局配置组字段共用同一构建逻辑，保证两边输出形状一致，
    前端 configPanel 无需区分来源。
    """
    dv = default_config.get(key, runtime_config.get(key))
    type_meta = config_type.get(key)
    resolved_type = type_meta.get("type") if isinstance(type_meta, dict) else None
    if isinstance(type_meta, dict) and type_meta.get("hidden"):
        return None
    if resolved_type in ("button", "global"):
        return None
    if isinstance(type_meta, dict) and resolved_type is None and (
        "buttons" in type_meta or "callback" in type_meta
    ):
        return None
    jd = jsonable(dv)
    saved_value = runtime_config.get(key, dv)
    if dv is not None and not isinstance(saved_value, type(dv)):
        saved_value = dv
    jv = jsonable(saved_value)
    jt = translated_type_meta(type_meta, catalog)
    if jd is UNSERIALIZABLE and jv is UNSERIALIZABLE and jt is UNSERIALIZABLE:
        return None
    # 值为 None 且没有可编辑类型的 key 通常只是配置组标题。
    if jd is None and jv is None and not isinstance(jt, dict):
        return None
    return {
        "key": str(key),
        "displayKey": translated(catalog, str(key)),
        "default": None if jd is UNSERIALIZABLE else jd,
        "value": (None if jd is UNSERIALIZABLE else jd) if jv is UNSERIALIZABLE else jv,
        "type": jt if isinstance(jt, dict) else None,
        "desc": str(config_description.get(key, "")) if config_description.get(key) else "",
        "displayDesc": translated(catalog, str(config_description.get(key, ""))) if config_description.get(key) else "",
    }


def collect_global_config_groups(ok, catalog, broken, gui_names=None):
    """采集框架 GlobalConfig 的全部可见配置组（含内置 Basic Options/Notification 等）。

    输出与任务 schema 的 fields 同构，前端 configPanel 可直接复用。
    采集失败只记 broken，不影响任务 schema。
    """
    groups = []
    try:
        visible = ok.task_executor.global_config.get_all_visible_configs()
    except Exception as e:  # noqa: BLE001
        broken.append({"task": "<global-config>", "error": f"{type(e).__name__}: {e}"})
        return groups
    for gname, gconfig, goption in visible:
        try:
            gdefault = dict(getattr(goption, "default_config", {}) or {})
            gruntime = dict(gconfig)
            gtype = dict(getattr(goption, "config_type", {}) or {})
            gdesc = dict(getattr(goption, "config_description", {}) or {})
            gkeys = list(dict.fromkeys([
                *gruntime.keys(),
                *gdefault.keys(),
                *gtype.keys(),
            ]))
            gfields = []
            for key in gkeys:
                if str(key).startswith("_"):
                    continue
                payload = field_payload(key, gdefault, gruntime, gtype, gdesc, catalog)
                if payload:
                    gfields.append(payload)
            groups.append({
                "name": str(gname),
                "displayName": group_display_name(catalog, gui_names or {}, gname),
                "description": translated(catalog, str(getattr(goption, "description", "") or "")),
                "fields": gfields,
                "source": "framework",
            })
        except Exception as e:  # noqa: BLE001
            broken.append({"task": f"<global-config:{gname}>", "error": f"{type(e).__name__}: {e}"})
    return groups


# 项目自建全局配置 store 的约定模块路径（接口与框架 GlobalConfig 同形：
# get_all_visible_configs() -> [(name, config, option)]）。ok-end-field / OK-AzurPromilia 实例。
PROJECT_STORE_MODULES = ("src.core.global_config_store",)


def collect_project_store_groups(catalog, broken, gui_names=None):
    """按约定探测项目自建全局配置 store，输出与框架组同构的 payload。

    这些项目的全局配置不走框架 GlobalConfig（自建 store + 聚合 Tab），probe
    拿不到；这里按约定 try-import 补齐。无该模块的项目静默跳过，零影响。
    """
    groups = []
    for module_name in PROJECT_STORE_MODULES:
        try:
            module = importlib.import_module(module_name)
        except Exception:  # noqa: BLE001 — 项目没有自建 store 是常态
            continue
        get_all = getattr(module, "get_all_visible_configs", None)
        if not callable(get_all):
            continue
        try:
            for gname, gconfig, goption in get_all():
                gdefault = dict(getattr(goption, "default_config", {}) or {})
                gruntime = dict(gconfig)
                gtype = dict(getattr(goption, "config_type", {}) or {})
                gdesc = dict(getattr(goption, "config_description", {}) or {})
                gkeys = list(dict.fromkeys([
                    *gruntime.keys(),
                    *gdefault.keys(),
                    *gtype.keys(),
                ]))
                gfields = []
                for key in gkeys:
                    if str(key).startswith("_"):
                        continue
                    payload = field_payload(key, gdefault, gruntime, gtype, gdesc, catalog)
                    if payload:
                        gfields.append(payload)
                groups.append({
                    "name": str(gname),
                    "displayName": group_display_name(catalog, gui_names or {}, gname),
                    "description": translated(catalog, str(getattr(goption, "description", "") or "")),
                    "fields": gfields,
                    "source": "project_store",
                })
        except Exception as e:  # noqa: BLE001
            broken.append({"task": f"<project-store:{module_name}>", "error": f"{type(e).__name__}: {e}"})
    return groups


# 已知支持多账户覆盖的全局组（以项目 GUI 的 Proxy 声明为准；扩展时在此追加）。
# ok-end-field：GlobalKeyConfigProxy（键位配置）+ GlobalZipLineConfigProxy（滑索）。
# 其他全局组没有账号覆盖的运行时消费方，列出来只会误导。
KNOWN_MULTI_ACCOUNT_GLOBAL_GROUPS = {"Game Hotkey Config", "Zip Line Config"}


def collect_multi_account(project_dir, tasks, broken, global_groups):
    """探测多账户存储，返回只读概要与「打开数据位置」的路径。

    存储位置与执行器一致：沙箱（.vscode/ok-script-toolkit/configs/）优先——
    执行器与插件的账号编辑都落沙箱；项目侧文件仅作首次探测回退（执行器启动
    copytree 会把它带进沙箱）。storePath 一律报沙箱路径。
    """
    sandbox_path = os.path.join(
        project_dir, ".vscode", "ok-script-toolkit", "configs", "account_scoped_overrides.json"
    )
    project_path = os.path.join(project_dir, "configs", "account_scoped_overrides.json")
    # store 模块可 import 性：区分「项目不支持账号编辑」与「读取失败（环境问题）」
    has_store_module = False
    for name in ("src.tasks.account.account_scope_store", "src.tasks.account_scope_store"):
        try:
            importlib.import_module(name)
            has_store_module = True
            break
        except Exception:  # noqa: BLE001 — 逐候选尝试
            continue
    has_data_file = os.path.isfile(sandbox_path) or os.path.isfile(project_path)
    info = {
        "available": has_data_file,
        "storePath": sandbox_path,
        "hasStoreModule": has_store_module,
    }
    if not has_data_file:
        return info
    store_data = {}
    enabled_tasks = {}
    rules_module = None
    for name in ("src.tasks.account.account_config_schema", "src.tasks.account_config_schema"):
        try:
            rules_module = importlib.import_module(name)
            break
        except Exception:  # noqa: BLE001 — 项目没有账号配置规则模块是常态
            continue
    # 键筛选：优先复用项目自己的 account_config_rules（零漂移）；规则模块不可达时
    # （如 ok-end-field 把规则内嵌在 Qt GUI 模块里，headless probe 不能 import）退到
    # 内置近似规则：ALWAYS 隐藏集 + 任务自定义 blacklist + button/global + 下划线键。
    fallback_always = {"多账户模式", "多账户独立配置", "账号列表"}

    def task_enabled_keys(task):
        blacklist = set(fallback_always)
        blacklist.update(str(k) for k in (getattr(task, "account_config_blacklist", None) or []))
        if rules_module is not None:
            try:
                rule_blacklist, _whitelist = rules_module.account_config_rules(task)
                blacklist |= set(rule_blacklist)
            except Exception as e:  # noqa: BLE001 — 规则计算失败退到内置近似
                broken.append({"task": f"<multi-account-rules:{getattr(task, 'name', '?')}>",
                               "error": f"{type(e).__name__}: {e}"})
        default_config = dict(getattr(task, "default_config", {}) or {})
        config_types = dict(getattr(task, "config_type", {}) or {})
        keys = []
        for key, default_value in default_config.items():
            if str(key).startswith("_") or key in blacklist:
                continue
            if not isinstance(default_value, (bool, int, float, str, list)):
                continue
            type_meta = config_types.get(key)
            if isinstance(type_meta, dict) and (
                type_meta.get("type") in ("global", "button")
                or ("type" not in type_meta and ("buttons" in type_meta or "callback" in type_meta))
            ):
                continue
            keys.append(str(key))
        return keys

    for task_key, cls_name, task_kind, task in tasks:
        if not getattr(task, "support_multi_account", False):
            continue
        try:
            keys = task_enabled_keys(task)
            if keys:
                enabled_tasks[task_key] = {
                    "storageName": str(getattr(task, "account_override_name", cls_name)),
                    "keys": keys,
                }
        except Exception as e:  # noqa: BLE001
            broken.append({"task": f"<multi-account:{task_key}>", "error": f"{type(e).__name__}: {e}"})
    info["enabledTasks"] = enabled_tasks
    data_path = sandbox_path if os.path.isfile(sandbox_path) else project_path
    try:
        with open(data_path, encoding="utf-8") as fp:
            data = json.load(fp)
        store_data = data
        if isinstance(data, dict):
            registry = data.get("account_registry")
            accounts = data.get("accounts")
            info["accountCount"] = len(registry) if isinstance(registry, dict) else 0
            info["overrideAccounts"] = len(accounts) if isinstance(accounts, dict) else 0
            if isinstance(accounts, dict):
                tasks = set()
                for value in accounts.values():
                    if isinstance(value, dict):
                        tasks.update(value.keys())
                info["overriddenTasks"] = sorted(str(item) for item in tasks)
    except (OSError, ValueError):
        info["readable"] = False

    # 全局配置组的按账号覆盖（ok-end-field 滑索/键位 Proxy 模式：组覆盖存在
    # accounts[acc_id][组名]）——收录条件：组名在已知 Proxy 列表 或 存储里出现过
    # 该组名的覆盖数据（项目 GUI 是覆盖创建入口，probe 不凭空猜测没出现过的组）
    stored_names = set()
    for account_tasks in (store_data or {}).get("accounts", {}).values():
        if isinstance(account_tasks, dict):
            stored_names |= set(account_tasks.keys())
    for group in global_groups or []:
        gname = str(group.get("name", ""))
        if not gname or gname in enabled_tasks:
            continue
        if gname not in KNOWN_MULTI_ACCOUNT_GLOBAL_GROUPS and gname not in stored_names:
            continue
        gkeys = [str(f.get("key", "")) for f in group.get("fields", []) if f.get("key")]
        if gkeys:
            enabled_tasks[gname] = {"storageName": gname, "keys": gkeys, "global": True}
    return info


def force_headless(cfg):
    """就地抹掉 cfg 里的 UI 声明，强制框架走 HeadlessApp。返回同一个 dict。

    ok-script 2.x 的 `config['gui'] = {'type': 'qt'}` 在
    `ok.core.ui_config.resolve_ui_config()` 里**优先于** `use_gui`：只改 use_gui
    时它照样判定为 qt，`do_init()` 于是走 `self.app` -> `App.__init__` ->
    `init_app_config()` -> `QApplication(sys.argv)`，把整套 Qt GUI 拉起来 ——
    探针只要 schema，不需要任何窗口，这一步既慢又会和 Qt 单例/事件循环纠缠。
    置 `gui = None` 让 resolve_ui_config() 返回 None（HeadlessApp + 同步事件分发），
    与 run_executor.py 同一手法。

    注意 `gui = None` 而不是 `del cfg['gui']`：框架判的是 `"gui" in config`，
    显式 None 走的是同一条分支且不改变键集合，对项目的 `config.get('gui')` 更安全。
    """
    cfg["use_gui"] = False
    cfg["gui"] = None
    return cfg


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 project_dir 参数"}, ensure_ascii=False))
        sys.exit(1)
    project_dir = sys.argv[1]
    locale = sys.argv[2] if len(sys.argv) > 2 else "zh_CN"
    po_directory = sys.argv[3] if len(sys.argv) > 3 else "i18n"
    catalog = load_po_catalog(project_dir, locale, po_directory)
    load_qt_translator(locale)
    sys.path.insert(0, project_dir)
    os.chdir(project_dir)

    temp_dir = tempfile.TemporaryDirectory(prefix="ok-script-toolkit-probe-")
    source_config_folder = detect_config_folder(project_dir)
    temp_config_folder = os.path.join(temp_dir.name, "configs")
    source_config_path = os.path.join(project_dir, source_config_folder)
    if os.path.isdir(source_config_path):
        shutil.copytree(source_config_path, temp_config_folder, dirs_exist_ok=True)

    # 项目 config 的导入链也可能用 get_relative_path("configs", ...) 直接
    # 创建/迁移配置；必须在导入前把这类路径统一重定向到沙箱。
    import ok.util.file as ok_file
    from ok.util.config import Config

    original_get_relative_path = ok_file.get_relative_path

    def sandboxed_get_relative_path(*files):
        if files and os.path.normcase(str(files[0])) == "configs":
            return os.path.normpath(os.path.join(temp_config_folder, *files[1:]))
        return original_get_relative_path(*files)

    ok_file.get_relative_path = sandboxed_get_relative_path
    # ok.util.config 在模块导入时复制了函数引用，也需要同步替换。
    import ok.util.config as ok_config
    ok_config.get_relative_path = sandboxed_get_relative_path
    Config.config_folder = temp_config_folder

    try:
        from src.config import config
    except Exception:
        from config import config

    from ok import OK

    cfg = dict(config)
    force_headless(cfg)
    cfg["check_mutex"] = False
    cfg["custom_tasks"] = False
    cfg["config_folder"] = temp_config_folder
    cfg["screenshots_folder"] = os.path.join(temp_dir.name, "screenshots")
    # schema 采集不需要 OCR 模型；禁用可避免打开面板时初始化 OpenVINO/NPU。
    cfg.pop("ocr", None)
    ok = None
    try:
        ok = OK(cfg)

        tasks = []
        seen = set()
        onetime_tasks = list(ok.task_executor.onetime_tasks or [])
        trigger_tasks = list(ok.task_executor.trigger_tasks or [])
        for t in onetime_tasks + trigger_tasks:
            module_name = t.__class__.__module__
            cls_name = t.__class__.__name__
            task_key = f"{module_name}::{cls_name}"
            if task_key in seen:
                continue
            seen.add(task_key)
            task_kind = "trigger" if t in trigger_tasks else "onetime"
            tasks.append((task_key, cls_name, task_kind, t))

        schemas = {}
        broken = []
        for task_key, cls_name, task_kind, task in tasks:
            try:
                default_config = dict(getattr(task, "default_config", {}) or {})
                runtime_config = dict(getattr(task, "config", {}) or {})
                config_type = dict(getattr(task, "config_type", {}) or {})
                config_description = dict(getattr(task, "config_description", {}) or {})
                config_groups = normalize_group_map(getattr(task, "default_config_group", {}) or {})
                group_selector, selector_groups = find_group_selector(config_type, config_groups)
                config_groups.update(selector_groups)
                fields = []
                # 纯分组标签只作容器，不作为字段输出（否则前端会多渲染输入框）。
                pure_group_labels = find_pure_group_labels(
                    config_groups, default_config, runtime_config
                )
                ordered_keys = list(dict.fromkeys([
                    *runtime_config.keys(),
                    *default_config.keys(),
                    *config_type.keys(),
                ]))
                for key in ordered_keys:
                    if str(key).startswith("_"):
                        continue
                    if key in pure_group_labels:
                        continue
                    payload = field_payload(
                        key, default_config, runtime_config, config_type, config_description, catalog
                    )
                    if payload:
                        fields.append(payload)
                group_label_names = set(config_groups)
                for children in config_groups.values():
                    group_label_names.update(child for child in children if child not in default_config)
                group_labels = {
                    group_name: translated(catalog, group_name) for group_name in group_label_names
                }
                schemas[task_key] = {
                    "fields": fields,
                    "displayName": translated(catalog, str(getattr(task, "name", "") or cls_name)),
                    "description": translated(catalog, str(getattr(task, "description", "") or "")),
                    "kind": task_kind,
                    "groupName": str(getattr(task, "group_name", "") or ""),
                    "groupIcon": icon_name(getattr(task, "group_icon", None)),
                    "showInTaskTab": bool(getattr(task, "show_in_task_tab", True)),
                    "configGroups": config_groups,
                    "groupLabels": group_labels,
                    "groupSelector": group_selector,
                    "locale": locale,
                }
            except Exception as e:
                broken.append({"task": task_key, "error": f"{type(e).__name__}: {e}"})
                schemas[task_key] = {
                    "fields": [],
                    "broken": True,
                    "error": f"{type(e).__name__}: {e}",
                    "locale": locale,
                }

        # 项目 GUI 的分组名映射要在 OK(cfg) 构造之后取——此时任务→core 的 import
        # 链已把 src.core.global_config_store 等常量模块带进 sys.modules，
        # GLOBAL_CONFIG_GROUPS 里的常量引用（BATTLE_CONFIG_NAME 等）才能就地求值。
        gui_names = load_gui_group_names(project_dir)
        global_groups = collect_global_config_groups(ok, catalog, broken, gui_names)
        global_groups.extend(collect_project_store_groups(catalog, broken, gui_names))
        multi_account = collect_multi_account(project_dir, tasks, broken, global_groups)

        result = json.dumps({
            "ok": True,
            "total": len(tasks),
            "broken": broken,
            "schemas": schemas,
            "globalConfigGroups": global_groups,
            "multiAccount": multi_account,
        }, ensure_ascii=False)
        sys.stdout.write(result + "\n")
        sys.stdout.flush()
        # ok.quit() 在某些项目（如 SoundContext 线程未退出）会永久阻塞，
        # 导致 120s 超时后被宿主 kill → 报 "Command failed"。
        # schema 已成功输出，强制退出避免清理阻塞。
        os._exit(0)
    finally:
        if ok is not None:
            ok.quit()
        temp_dir.cleanup()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        os._exit(1)

# -*- coding: utf-8 -*-
"""用 AST 安全解析 ok-script 项目的 config.py，提取窗口匹配与模板匹配信息。

查找策略：先通过 main.py 内的 import 信息定位 config.py 的实际路径，
再回退到常见的 src/config.py 或 config.py。

**为什么两类信息共用一个探针**：每次调用都要拉起一个 Python 进程（百毫秒级），
拆成两个脚本就要付两次启动成本，而它们读的是同一个文件、同一棵 AST。
（脚本名保留了历史名字 `probe_window_config`；它现在也返回模板匹配信息。）

用法: python probe_window_config.py <project_dir>
输出(最后一行 JSON):
  {"ok": true, "config_path": "...", "exe_names": [...], "title": "...",
   "player_id": N, "hwnd_class": "...", "coco_feature_json": "assets/coco_annotations.json"}
"""
import ast
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# 需要从 config dict 中提取的窗口匹配相关字段
# config["windows"] 下的键
# args 是启动参数：插件自己拉起游戏时直接带上（框架 start_device() 没有 args 入口）
WINDOWS_SUB_KEYS = ("exe", "title", "hwnd_class", "top_hwnd_class", "capture_method", "args")

# config["template_matching"] 下的键。
# `coco_feature_json` 是 ok 框架加载的**运行时模板库**（ok/__init__.py 里
# `self.config.get('template_matching').get('coco_feature_json')`），
# 实测 5/5 个 ok 系项目都声明了它，写法统一是
# `os.path.join("assets", "coco_annotations.json")`。
TEMPLATE_MATCHING_SUB_KEYS = ("coco_feature_json",)
TEMPLATE_TAB_SUB_KEYS = ("label_enum_relative_path",)


def _resolve_config_path_from_main(project_dir):
    """解析 main.py，找到 config 模块的导入路径，转为文件系统路径。"""
    for main_name in ("main.py", "run.py", "run_task.py"):
        main_path = os.path.join(project_dir, main_name)
        if not os.path.isfile(main_path):
            continue
        try:
            with open(main_path, encoding="utf-8") as f:
                tree = ast.parse(f.read(), filename=main_path)
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            # from src.config import config  /  from config import config
            if isinstance(node, ast.ImportFrom) and node.module:
                mod = node.module
                # 检查是否有 import ... config
                has_config = any(
                    (alias.name == "config" if isinstance(alias, ast.alias) else alias == "config")
                    for alias in (node.names or [])
                )
                if not has_config:
                    continue
                # 把模块路径转为文件路径
                parts = mod.split(".")
                candidate = os.path.join(project_dir, *parts, "config.py")
                if os.path.isfile(candidate):
                    return candidate
                # 模块本身可能就是 config（from config import config）
                candidate2 = os.path.join(project_dir, *parts) + ".py"
                if os.path.isfile(candidate2):
                    return candidate2
            # import src.config  /  import config
            if isinstance(node, ast.Import):
                for alias in (node.names or []):
                    name = alias.name if isinstance(alias, ast.alias) else alias
                    if not name.endswith(".config") and name != "config":
                        continue
                    parts = name.split(".")
                    candidate = os.path.join(project_dir, *parts, "config.py")
                    if os.path.isfile(candidate):
                        return candidate
                    candidate2 = os.path.join(project_dir, *parts) + ".py"
                    if os.path.isfile(candidate2):
                        return candidate2
    return None


def _resolve_config_path(project_dir):
    """综合查找 config.py：先 main.py 解析，再常规路径。"""
    # 1. 通过 main.py 定位
    found = _resolve_config_path_from_main(project_dir)
    if found:
        return found
    # 2. 常规路径
    for candidate in (
        os.path.join(project_dir, "src", "config.py"),
        os.path.join(project_dir, "config.py"),
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def _find_config_dict(tree):
    """找到顶层 `config = {...}` 字典节点；找不到返回 None。

    先只看顶层赋值（正常写法），再回退到 `ast.walk`（有些项目把它写在条件分支里）。
    """
    for node in ast.iter_child_nodes(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "config" and isinstance(node.value, ast.Dict):
                return node.value
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "config" and isinstance(node.value, ast.Dict):
                return node.value
    return None


def _extract_sub_dict(config_dict, name, allowed_keys):
    """从 config dict 里取出 `name` 子字典中 [allowed_keys] 覆盖的那些键。"""
    if not config_dict:
        return {}
    for key, value in zip(config_dict.keys, config_dict.values):
        if isinstance(key, ast.Constant) and key.value == name and isinstance(value, ast.Dict):
            result = {}
            for sub_key, sub_value in zip(value.keys, value.values):
                if isinstance(sub_key, ast.Constant) and sub_key.value in allowed_keys:
                    result[sub_key.value] = _extract_value(sub_value)
            return result
    return {}


def _extract_config_dict_keys(config_path):
    """用 AST 解析 config.py，提取 windows 子字典的窗口匹配字段。"""
    with open(config_path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=config_path)
    return _extract_sub_dict(_find_config_dict(tree), "windows", WINDOWS_SUB_KEYS)


def _extract_template_matching_keys(config_path):
    """用 AST 解析 config.py，提取 template_matching 子字典的键（运行时模板库路径）。"""
    with open(config_path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=config_path)
    return _extract_sub_dict(_find_config_dict(tree), "template_matching", TEMPLATE_MATCHING_SUB_KEYS)


def _extract_template_tab_keys(config_path):
    """Read the enum module path used by the project's own template tab."""
    with open(config_path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=config_path)
    return _extract_sub_dict(_find_config_dict(tree), "template_tab", TEMPLATE_TAB_SUB_KEYS)


def _extract_value(node):
    """递归提取 AST 节点的 Python 值。"""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.List):
        return [_extract_value(el) for el in node.elts]
    if isinstance(node, ast.Tuple):
        return [_extract_value(el) for el in node.elts]
    if isinstance(node, ast.Name):
        # 引用其他变量，返回变量名标记
        return f"<ref:{node.id}>"
    if isinstance(node, ast.Call):
        # 常见模式: re.compile(r"xxx") → 提取字符串参数
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "compile":
            if node.args and isinstance(node.args[0], ast.Constant):
                return node.args[0].value
        # 常见模式: os.path.join("assets", "coco_annotations.json") → 拼成 `/` 分隔的路径。
        # **5/5 个真实项目声明 coco_feature_json 都是这个写法**，不认它等于没接。
        # 只在**全是字面量**时才拼 —— 掺了变量就无从静态求值，交给调用方走兜底。
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "join"
            and isinstance(func.value, ast.Attribute)
            and func.value.attr == "path"
        ):
            parts = [_extract_value(arg) for arg in node.args]
            if parts and all(isinstance(p, str) and not p.startswith("<") for p in parts):
                return "/".join(p.replace("\\", "/").strip("/") for p in parts if p.strip("/"))
        if isinstance(func, ast.Name) and func.id in ("str", "int", "float", "Path", "PurePath", "PurePosixPath"):
            if node.args and isinstance(node.args[0], ast.Constant):
                return node.args[0].value
        # 返回函数名标记
        if isinstance(func, ast.Name):
            return f"<call:{func.id}>"
        if isinstance(func, ast.Attribute):
            return f"<call:{func.attr}>"
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        # pathlib 写法: Path("assets") / "coco_annotations.json"
        left = _extract_value(node.left)
        right = _extract_value(node.right)
        if (
            isinstance(left, str) and isinstance(right, str)
            and not left.startswith("<") and not right.startswith("<")
        ):
            return left.replace("\\", "/").rstrip("/") + "/" + right.replace("\\", "/").lstrip("/")
    if isinstance(node, ast.Dict):
        return {_extract_value(k): _extract_value(v) for k, v in zip(node.keys, node.values)}
    return None


def _clean(value):
    """把 `<ref:...>` / `<call:...>` 标记替换为 None（无法静态解析的值）。"""
    if isinstance(value, str) and (value.startswith("<ref:") or value.startswith("<call:")):
        return None
    if isinstance(value, list):
        return [_clean(item) for item in value]
    return value


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 project_dir 参数"}, ensure_ascii=False))
        sys.exit(1)
    project_dir = sys.argv[1]

    config_path = _resolve_config_path(project_dir)
    if not config_path:
        print(json.dumps({
            "ok": False,
            "error": f"找不到 config.py: {project_dir}",
            "searched": [
                os.path.join(project_dir, "main.py"),
                os.path.join(project_dir, "src", "config.py"),
                os.path.join(project_dir, "config.py"),
            ],
        }, ensure_ascii=False))
        sys.exit(1)

    window_config = _extract_config_dict_keys(config_path)
    template_matching = _extract_template_matching_keys(config_path)
    template_tab = _extract_template_tab_keys(config_path)

    # 把 <ref:...> 和 <call:...> 标记替换为 None（无法静态解析的值）
    window_config = {k: _clean(v) for k, v in window_config.items()}
    coco_feature_json = _clean(template_matching.get("coco_feature_json"))
    label_enum_relative_path = _clean(template_tab.get("label_enum_relative_path"))

    print(json.dumps({
        "ok": True,
        "config_path": config_path,
        **window_config,
        "coco_feature_json": coco_feature_json,
        "label_enum_relative_path": label_enum_relative_path,
    }, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()

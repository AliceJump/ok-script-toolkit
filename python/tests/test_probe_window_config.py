# -*- coding: utf-8 -*-
"""`probe_window_config.py` 的 AST 提取测试。

重点在 `template_matching.coco_feature_json` —— 它是**运行时模板库**的路径，
ok 框架自己也是这么读的（`ok/__init__.py`：`self.config.get('template_matching').get('coco_feature_json')`）。

实测 6 个 ok 系项目**全都声明了**它，写法都是 `os.path.join(...)`（ok-infinity-nikki
甚至跨了 3 行），而且**值不一定是 `coco_annotations.json`** ——
它声明的是 `coco_detection.json`。插件此前硬编码探测 `assets/coco_annotations.json`，
对那个项目等于完全找不到模板库。所以这里要把两种形态都钉住。

**走 CLI 而不是直接调内部 helper**：插件拿到的是子进程 stdout 的最后一行 JSON，
清理（`<ref:...>` → None）发生在 `main()` 里 —— 直接调 `_extract_*` 会看到未清理的标记，
断言就与用户实际看到的不是同一件事了。

不依赖 ok 框架，可直接跑：
    python python/tests/test_probe_window_config.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "probe_window_config.py"
SPEC = importlib.util.spec_from_file_location("probe_under_test", SCRIPT)
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)

failures = []


def check(condition, message):
    if condition:
        print(f"  ok    {message}")
    else:
        print(f"  FAIL  {message}")
        failures.append(message)


def probe(text, at="src/config.py"):
    """在临时项目里写 config.py，然后**像插件那样**跑一遍脚本并解析最后一行 JSON。"""
    tmp = tempfile.mkdtemp(prefix="ok-probe-")
    path = os.path.join(tmp, *at.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    result = subprocess.run(
        [sys.executable, str(SCRIPT), tmp],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    lines = [line for line in (result.stdout or "").splitlines() if line.strip()]
    if not lines:
        return {}
    return json.loads(lines[-1])


# ── 1. os.path.join 的字面量拼接 ────────────────────────────────────
print("os.path.join 提取")

single_line = probe(
    'import os\n'
    'config = {\n'
    '    "template_matching": {\n'
    '        "coco_feature_json": os.path.join("assets", "coco_annotations.json"),\n'
    '    },\n'
    '}\n'
)
check(single_line.get("ok") is True, "探针正常退出（ok=true）")
check(
    single_line.get("coco_feature_json") == "assets/coco_annotations.json",
    "**os.path.join 必须能静态求值** —— 6/6 个真实项目都是这个写法，不认它等于没接",
)

multi_line = probe(
    'import os\n'
    'config = {\n'
    '    "template_matching": {\n'
    '        "coco_feature_json": os.path.join(\n'
    '            "assets", "coco_detection.json"\n'
    '        ),\n'
    '    },\n'
    '}\n'
)
check(
    multi_line.get("coco_feature_json") == "assets/coco_detection.json",
    "**跨行的 join 也要认** —— ok-infinity-nikki 就是这么写的，而且文件名不是 coco_annotations.json",
)
check(
    multi_line.get("coco_feature_json") != "assets/coco_annotations.json",
    "文件名必须来自声明，不能被「默认值」顶替 —— 那正是本次要修的缺陷",
)

# ── 2. 其它写法 ─────────────────────────────────────────────────────
print("\n其它写法")

plain = probe('config = {"template_matching": {"coco_feature_json": "assets/x.json"}}\n')
check(plain.get("coco_feature_json") == "assets/x.json", "纯字符串字面量直接用")

pathlib_style = probe(
    'from pathlib import Path\n'
    'config = {"template_matching": {"coco_feature_json": Path("assets") / "coco.json"}}\n'
)
check(pathlib_style.get("coco_feature_json") == "assets/coco.json", "pathlib 的 `/` 拼接也认")

with_variable = probe(
    'import os\n'
    'name = "coco_annotations.json"\n'
    'config = {"template_matching": {"coco_feature_json": os.path.join("assets", name)}}\n'
)
check(
    with_variable.get("coco_feature_json") is None,
    "**掺了变量就输出 null**（无从静态求值）—— 调用方据此走兜底，绝不能瞎猜一个路径出来",
)

not_object = probe('config = {"template_matching": "不是对象"}\n')
check(not_object.get("coco_feature_json") is None, "template_matching 不是对象时按没写处理（输出 null）")

absent = probe('config = {"windows": {"exe": ["a.exe"]}}\n')
check(absent.get("coco_feature_json") is None, "整段缺席时输出 null（不抛异常）")

# ── 3. windows 提取没有回归 ─────────────────────────────────────────
print("\nwindows 提取（回归）")

both = probe(
    'config = {\n'
    '    "windows": {"exe": ["a.exe", "b.exe"], "title": "^Game"},  # 注释\n'
    '    "template_matching": {"coco_feature_json": "assets/c.json"},\n'
    '}\n'
)
check(both.get("exe") == ["a.exe", "b.exe"], "exe 列表照旧提取")
check(both.get("title") == "^Game", "title 照旧提取")
check("coco_feature_json" in both, "同一份 config 里两组键**一次调用**都取到（共用一个探针的理由）")

whitelist = probe('config = {"windows": {"exe": ["a.exe"], "unknown_key": 1}}\n')
check(whitelist.get("unknown_key") is None, "windows 下不在白名单里的键仍然被丢掉（与改动前一致）")

nested = probe('if True:\n    config = {"windows": {"title": "nested"}}\n')
check(nested.get("title") == "nested", "config 写在分支里时的 ast.walk 回退仍然有效")

no_config = probe('config = {"windows": {}}\n', at="nothing/here.py")
check(no_config.get("ok") is False, "找不到 config.py 时 ok=false（插件据此走兜底，不报错）")

# ── 4. 找不到 config.py 时的路径解析 ────────────────────────────────
print("\n找不到 config.py")

empty_dir = tempfile.mkdtemp(prefix="ok-probe-empty-")
check(mod._resolve_config_path(empty_dir) is None, "目录里没有 config.py 时返回 None（不抛异常）")

print("\n" + ("失败 %d 项" % len(failures) if failures else "全部通过"))
sys.exit(1 if failures else 0)

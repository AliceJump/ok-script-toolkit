# -*- coding: utf-8 -*-
"""项目约定文件（ok-script-toolkit.json）与启动钩子的行为测试。

覆盖：文件缺席/损坏/类型不对时的容错、钩子声明的过滤、钩子的执行顺序、
**单个钩子失败不阻断后续与启动**。
不依赖 ok 框架，可直接跑：
    python python/tests/test_run_executor_project_config.py
"""
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("run_executor_under_test", ROOT / "run_executor.py")
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


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


# ── 1. 文件缺席：返回空 dict，不抛异常 ──────────────────────────────
print("load_project_config")
with tempfile.TemporaryDirectory() as tmp:
    check(mod.load_project_config(tmp) == {}, "文件不存在时返回空 dict（纯增量，不影响启动）")

# ── 2. 文件损坏 / 顶层不是对象：同样容错 ────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    write(os.path.join(tmp, mod.PROJECT_CONFIG_FILE), "{ 这不是 json")
    check(mod.load_project_config(tmp) == {}, "JSON 语法错误时返回空 dict，不抛异常")

with tempfile.TemporaryDirectory() as tmp:
    write(os.path.join(tmp, mod.PROJECT_CONFIG_FILE), "[1, 2, 3]")
    check(mod.load_project_config(tmp) == {}, "顶层不是对象时返回空 dict")

# ── 3. 正常读取 ──────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    write(
        os.path.join(tmp, mod.PROJECT_CONFIG_FILE),
        json.dumps({"executor": {"startupHooks": {"beforeConfigImport": ["a.b:c"]}}}),
    )
    loaded = mod.load_project_config(tmp)
    check(
        loaded.get("executor", {}).get("startupHooks", {}).get("beforeConfigImport") == ["a.b:c"],
        "正常文件按原样读出",
    )

# ── 4. startup_hooks 的过滤 ─────────────────────────────────────────
print("\nstartup_hooks")
check(mod.startup_hooks({}, "beforeConfigImport") == [], "整份配置为空时返回 []")
check(
    mod.startup_hooks({"executor": {"startupHooks": {"beforeConfigImport": "不是列表"}}}, "beforeConfigImport") == [],
    "声明的不是列表时返回 []，不抛异常",
)
check(
    mod.startup_hooks({"executor": {}}, "beforeConfigImport") == [],
    "没有 startupHooks 段时返回 []",
)

mixed = {
    "executor": {
        "startupHooks": {
            "beforeConfigImport": [
                "src.patches.pre_config_patch:install_pre_config_patch",
                "缺少冒号",
                "冒号:太多:了",
                "",
                123,
            ]
        }
    }
}
kept = mod.startup_hooks(mixed, "beforeConfigImport")
check(
    kept == ["src.patches.pre_config_patch:install_pre_config_patch"],
    f"非法项被丢掉、合法项保留（实际 {kept}）—— 声明文件是手写的，容忍笔误比严格校验有用",
)

# ── 5. run_startup_hooks：按顺序执行 ────────────────────────────────
print("\nrun_startup_hooks")
with tempfile.TemporaryDirectory() as tmp:
    pkg = "hookorderpkg"
    write(os.path.join(tmp, pkg, "__init__.py"), "")
    write(
        os.path.join(tmp, pkg, "hooks.py"),
        "CALLS = []\n\n\ndef first():\n    CALLS.append('first')\n\n\ndef second():\n    CALLS.append('second')\n",
    )
    sys.path.insert(0, tmp)
    try:
        done = mod.run_startup_hooks(
            [f"{pkg}.hooks:first", f"{pkg}.hooks:second"], "测试"
        )
        calls = sys.modules[f"{pkg}.hooks"].CALLS
    finally:
        sys.path.remove(tmp)
    check(done == 2, "返回成功数 2")
    check(calls == ["first", "second"], "**按声明顺序**依次执行 —— 顺序错会复刻出错误的启动序列")

# ── 6. 单个钩子失败不阻断后续 ──────────────────────────────────────
print("\n失败不阻断")
with tempfile.TemporaryDirectory() as tmp:
    pkg = "hookfailpkg"
    write(os.path.join(tmp, pkg, "__init__.py"), "")
    write(
        os.path.join(tmp, pkg, "hooks.py"),
        "CALLS = []\n\n\ndef boom():\n    raise RuntimeError('boom')\n\n\ndef after():\n    CALLS.append('after')\n",
    )
    sys.path.insert(0, tmp)
    try:
        raised = None
        done = None
        try:
            done = mod.run_startup_hooks(
                [f"{pkg}.hooks:boom", f"{pkg}.hooks:after"], "测试"
            )
        except Exception as e:  # noqa: BLE001
            raised = e
        calls = sys.modules[f"{pkg}.hooks"].CALLS
    finally:
        sys.path.remove(tmp)
    check(raised is None, "异常被吞掉 —— 一个可选钩子跑不起来不能让执行器起不来")
    check(done == 1, "成功数只算跑通的")
    check(calls == ["after"], "**后续钩子照样执行**（前一个炸了不影响后面的）")

# ── 7. 模块/函数不存在时跳过而不是炸 ───────────────────────────────
print("\n目标不存在")
raised = None
try:
    done = mod.run_startup_hooks(["不存在的模块:也不存在的函数"], "测试")
except Exception as e:  # noqa: BLE001
    raised = e
check(raised is None, "模块不存在时不抛异常")
check(done == 0, "返回 0")

print("\n" + ("全部通过" if not failures else f"失败 {len(failures)} 项"))
sys.exit(1 if failures else 0)

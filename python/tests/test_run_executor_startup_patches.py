# -*- coding: utf-8 -*-
"""install_project_startup_patches / project_patch_module_path 的行为测试。

覆盖：模块路径推导、项目没有补丁时静默跳过、补丁装成功、补丁抛异常时不阻断启动。
不依赖 ok 框架，可直接跑：
    python python/tests/test_run_executor_startup_patches.py

背景（2026-09-20 实测）：执行器过去**从不调用**目标项目的启动补丁入口，
于是同一份项目代码"自己跑没事、用插件跑就崩" —— ok-end-field 的
`Mouse.py` 会抛 `ctypes.ArgumentError: expected LP_POINT instance instead of
pointer to POINT`，因为 ok 库 `win32_gdi` 在 import 时污染了全局
`user32.GetCursorPos.argtypes`，而项目补丁里的 `win32_gdi_point_patch` 正是修它的。
"""
import importlib.util
import os
import sys
from pathlib import Path

from _test_tmp import make_tmp_tempdir

# 测试放在 tests/ 子目录，被测脚本在上一级 python/。加 .. 而不是 .，
# 这样测试文件不会被随插件发布的 `python/*.py` 通配打包收进去。
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


# ── 1. 模块路径推导 ──────────────────────────────────────────────────
print("project_patch_module_path")

check(
    mod.project_patch_module_path("src.config") == "src.patches.startup_patches",
    "src.config -> src.patches.startup_patches（带 src/ 包的常见形态）",
)
check(
    mod.project_patch_module_path("config") == "patches.startup_patches",
    "config -> patches.startup_patches（config.py 直接放根目录的项目）",
)
check(
    mod.project_patch_module_path("myproj.app.config") == "myproj.app.patches.startup_patches",
    "多级包名只砍掉最后一段",
)

# ── 2. 项目没有补丁：静默跳过，不抛异常 ──────────────────────────────
print("\n[2] 项目没有补丁")
with make_tmp_tempdir("ok-executor-startup-patches") as tmp:
    pkg = "nopatchpkg"
    write(os.path.join(tmp, pkg, "__init__.py"), "")
    sys.path.insert(0, tmp)
    try:
        result = mod.install_project_startup_patches(f"{pkg}.config")
    finally:
        sys.path.remove(tmp)
    check(result is False, "返回 False（而不是抛异常）—— ok-infinity-nikki / ok-gm 就是这种情况")

# ── 3. 补丁模块存在但没有入口函数 ────────────────────────────────────
print("\n[3] 补丁模块缺入口函数")
with make_tmp_tempdir("ok-executor-startup-patches") as tmp:
    pkg = "noentrypkg"
    write(os.path.join(tmp, pkg, "__init__.py"), "")
    write(os.path.join(tmp, pkg, "patches", "__init__.py"), "")
    write(os.path.join(tmp, pkg, "patches", "startup_patches.py"), "OTHER = 1\n")
    sys.path.insert(0, tmp)
    try:
        result = mod.install_project_startup_patches(f"{pkg}.config")
    finally:
        sys.path.remove(tmp)
    check(result is False, "没有 install_startup_patches() 时返回 False，不抛异常")

# ── 4. 正常安装：入口被真正调用 ──────────────────────────────────────
print("\n[4] 正常安装")
with make_tmp_tempdir("ok-executor-startup-patches") as tmp:
    pkg = "patchokpkg"
    write(os.path.join(tmp, pkg, "__init__.py"), "")
    write(os.path.join(tmp, pkg, "patches", "__init__.py"), "")
    write(
        os.path.join(tmp, pkg, "patches", "startup_patches.py"),
        "CALLS = []\n\n\ndef install_startup_patches():\n    CALLS.append('installed')\n",
    )
    sys.path.insert(0, tmp)
    try:
        result = mod.install_project_startup_patches(f"{pkg}.config")
        imported = sys.modules.get(f"{pkg}.patches.startup_patches")
    finally:
        sys.path.remove(tmp)
    check(result is True, "返回 True")
    check(
        imported is not None and imported.CALLS == ["installed"],
        "项目的 install_startup_patches() 确实被调用了 —— 这是本修复的核心",
    )

# ── 5. 补丁自身抛异常：必须吞掉，不能拖垮执行器 ──────────────────────
print("\n[5] 需要 config 参数的项目补丁")
with make_tmp_tempdir("ok-executor-startup-patches") as tmp:
    pkg = "patchconfigpkg"
    write(os.path.join(tmp, pkg, "__init__.py"), "")
    write(os.path.join(tmp, pkg, "patches", "__init__.py"), "")
    write(
        os.path.join(tmp, pkg, "patches", "startup_patches.py"),
        "CALLS = []\n\n\ndef install_startup_patches(config):\n    CALLS.append(config)\n",
    )
    runtime_config = {"gui": None, "locale": "zh_CN"}
    sys.path.insert(0, tmp)
    try:
        result = mod.install_project_startup_patches(f"{pkg}.config", runtime_config)
        imported = sys.modules.get(f"{pkg}.patches.startup_patches")
    finally:
        sys.path.remove(tmp)
    check(result is True, "需要 config 的项目补丁安装成功")
    check(imported is not None and imported.CALLS == [runtime_config], "传入同一份运行配置")

# ── 6. 补丁自身抛异常：必须吞掉，不能拖垮执行器 ──────────────────────
print("\n[5] 补丁抛异常时不阻断启动")
with make_tmp_tempdir("ok-executor-startup-patches") as tmp:
    pkg = "patchfailpkg"
    write(os.path.join(tmp, pkg, "__init__.py"), "")
    write(os.path.join(tmp, pkg, "patches", "__init__.py"), "")
    write(
        os.path.join(tmp, pkg, "patches", "startup_patches.py"),
        "def install_startup_patches():\n    raise RuntimeError('boom')\n",
    )
    sys.path.insert(0, tmp)
    try:
        raised = None
        result = None
        try:
            result = mod.install_project_startup_patches(f"{pkg}.config")
        except Exception as e:  # noqa: BLE001
            raised = e
    finally:
        sys.path.remove(tmp)
    check(
        raised is None,
        "异常必须被吞掉 —— 一个可选补丁装不上，绝不能让整个执行器起不来",
    )
    check(result is False, "返回 False 表示没装上")

# ── 6. 破坏性对照：证明"调用了入口"这条断言不是空过 ──────────────────
print("\n[6] 破坏性对照")
with make_tmp_tempdir("ok-executor-startup-patches") as tmp:
    pkg = "controlpkg"
    write(os.path.join(tmp, pkg, "__init__.py"), "")
    write(os.path.join(tmp, pkg, "patches", "__init__.py"), "")
    write(
        os.path.join(tmp, pkg, "patches", "startup_patches.py"),
        "CALLS = []\n\n\ndef install_startup_patches():\n    CALLS.append('installed')\n",
    )
    sys.path.insert(0, tmp)
    try:
        # 对照：只 import 模块、不调入口 —— 模拟修复前的行为
        importlib.import_module(f"{pkg}.patches.startup_patches")
        imported = sys.modules[f"{pkg}.patches.startup_patches"]
        check(
            imported.CALLS == [],
            "对照：仅 import 模块不会触发安装 —— 修复前执行器就停在这一步",
        )
        mod.install_project_startup_patches(f"{pkg}.config")
        check(imported.CALLS == ["installed"], "真实现会真正调用入口")
    finally:
        sys.path.remove(tmp)


print("\n" + ("全部通过" if not failures else f"失败 {len(failures)} 项"))
sys.exit(1 if failures else 0)

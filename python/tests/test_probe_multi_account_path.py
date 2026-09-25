# -*- coding: utf-8 -*-
"""probe_task_schemas.resolve_run_dir / collect_multi_account 沙箱路径的回归测试。

背景（2026-09-23）：探针把多账户存储的沙箱路径**写死**成
`<project>/.vscode/ok-script-toolkit/configs/account_scoped_overrides.json`，
而沙箱根目录是**宿主相关**的：
  * VS Code  → `<project>/.vscode/ok-script-toolkit`
  * JetBrains → `<project>/.idea/ok-script-toolkit`（见宿主传的 OK_TOOLKIT_RUN_DIR）

于是 JetBrains 宿主拿到一个既不存在、也永远不会被读写的 storePath，
多账户概要里的「打开数据位置」指向空气。

约定与 `run_executor.py` / `account_store.py` 对齐：宿主经 `OK_TOOLKIT_RUN_DIR`
传入；**不设时退回 VS Code 的历史默认值**（VS Code 侧当前不给探针设该变量，
退回默认才能让既有输出逐字不变）。

跑法：python python/tests/test_probe_multi_account_path.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

import probe_task_schemas as probe  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
        print(f"  FAIL  {message}")
    else:
        print(f"  ok    {message}")


RUN_DIR_ENV = "OK_TOOLKIT_RUN_DIR"
_saved_env = os.environ.get(RUN_DIR_ENV)


def set_run_dir(value):
    if value is None:
        os.environ.pop(RUN_DIR_ENV, None)
    else:
        os.environ[RUN_DIR_ENV] = value


def restore_env():
    set_run_dir(_saved_env)


print("resolve_run_dir —— 沙箱根目录按宿主解析")

print("\n[1] 未设 OK_TOOLKIT_RUN_DIR → VS Code 历史默认值（既有行为必须逐字不变）")
with tempfile.TemporaryDirectory() as proj:
    set_run_dir(None)
    expected = os.path.join(proj, ".vscode", "ok-script-toolkit")
    check(probe.resolve_run_dir(proj) == expected,
          f"应退回 {expected!r}，实际 {probe.resolve_run_dir(proj)!r}")

print("\n[2] 设了绝对路径 → 原样采用（JetBrains 形态）")
with tempfile.TemporaryDirectory() as proj:
    jetbrains = os.path.join(proj, ".idea", "ok-script-toolkit")
    set_run_dir(jetbrains)
    check(probe.resolve_run_dir(proj) == os.path.abspath(jetbrains),
          f"应取 env 值，实际 {probe.resolve_run_dir(proj)!r}")

print("\n[3] 设了相对路径 → 绝对化")
with tempfile.TemporaryDirectory() as proj:
    set_run_dir(os.path.join(".idea", "ok-script-toolkit"))
    resolved = probe.resolve_run_dir(proj)
    check(os.path.isabs(resolved), f"必须绝对化，实际 {resolved!r}")
    check(resolved.endswith(os.path.join(".idea", "ok-script-toolkit")),
          f"尾部应保留 env 给的相对段，实际 {resolved!r}")

print("\n[4] 空白值视为未设（宿主可能传空串）")
with tempfile.TemporaryDirectory() as proj:
    set_run_dir("   ")
    expected = os.path.join(proj, ".vscode", "ok-script-toolkit")
    check(probe.resolve_run_dir(proj) == expected,
          f"空白应退回默认值，实际 {probe.resolve_run_dir(proj)!r}")

print("\n[4b] main 在 chdir 前把项目参数绝对化")
with tempfile.TemporaryDirectory() as proj:
    relative_proj = os.path.relpath(proj)
    captured = []
    saved_argv = sys.argv
    saved_chdir = os.chdir
    saved_load_po_catalog = probe.load_po_catalog
    saved_load_qt_translator = probe.load_qt_translator

    class ChdirReached(Exception):
        pass

    def capture_chdir(path):
        captured.append(path)
        raise ChdirReached

    try:
        sys.argv = ["probe_task_schemas.py", relative_proj]
        os.chdir = capture_chdir
        probe.load_po_catalog = lambda *_args: {}
        probe.load_qt_translator = lambda *_args: None
        try:
            probe.main()
        except ChdirReached:
            pass
        check(captured == [os.path.abspath(relative_proj)],
              f"chdir 应收到绝对项目路径，实际 {captured!r}")
    finally:
        probe.load_qt_translator = saved_load_qt_translator
        probe.load_po_catalog = saved_load_po_catalog
        os.chdir = saved_chdir
        sys.argv = saved_argv

restore_env()


print("\ncollect_multi_account —— storePath 必须跟随宿主沙箱")

print("\n[5] 无数据文件时提前返回：storePath 指向宿主沙箱（JetBrains）")
with tempfile.TemporaryDirectory() as proj:
    set_run_dir(os.path.join(proj, ".idea", "ok-script-toolkit"))
    broken = []
    info = probe.collect_multi_account(proj, [], broken, [])
    expected = os.path.join(proj, ".idea", "ok-script-toolkit",
                            "configs", "account_scoped_overrides.json")
    check(info["storePath"] == expected,
          f"storePath 应为 {expected!r}，实际 {info['storePath']!r}")
    check(info["available"] is False, "无数据文件时 available 应为 False")
    check(isinstance(info["hasStoreModule"], bool), "hasStoreModule 应是布尔")
    check(".vscode" not in info["storePath"],
          "JetBrains 宿主的 storePath 不应再出现 .vscode")

print("\n[6] 自定义 config_folder 用于项目回退，沙箱仍使用 configs")
with tempfile.TemporaryDirectory() as proj:
    set_run_dir(os.path.join(proj, ".idea", "ok-script-toolkit"))
    os.makedirs(os.path.join(proj, "src"), exist_ok=True)
    with open(os.path.join(proj, "src", "config.py"), "w", encoding="utf-8") as fh:
        fh.write("config = {'config_folder': 'custom-configs'}\n")
    os.makedirs(os.path.join(proj, "custom-configs"), exist_ok=True)
    with open(os.path.join(proj, "custom-configs", "account_scoped_overrides.json"),
              "w", encoding="utf-8") as fh:
        json.dump({"account_registry": {"acc1": {"username": "A"}}, "accounts": {}}, fh)
    info = probe.collect_multi_account(proj, [], [], [])
    check(info["available"] is True, "自定义目录中的项目侧文件应使 available=True")
    check(info["storePath"] == os.path.join(
        proj, ".idea", "ok-script-toolkit", "configs", "account_scoped_overrides.json"),
        f"storePath 应使用沙箱 configs 目录，实际 {info['storePath']!r}")
    check(info.get("accountCount") == 1,
          f"应从项目侧文件读出账号数 1，实际 {info.get('accountCount')!r}")

print("\n[7] 沙箱文件存在 → 优先读沙箱（执行器 copytree 后的正常状态）")
with tempfile.TemporaryDirectory() as proj:
    run_dir = os.path.join(proj, ".idea", "ok-script-toolkit")
    set_run_dir(run_dir)
    os.makedirs(os.path.join(run_dir, "configs"), exist_ok=True)
    with open(os.path.join(run_dir, "configs", "account_scoped_overrides.json"),
              "w", encoding="utf-8") as fh:
        json.dump({"account_registry": {"a": {}, "b": {}}, "accounts": {"a": {}, "b": {}}}, fh)
    info = probe.collect_multi_account(proj, [], [], [])
    check(info["available"] is True, "沙箱文件存在时 available 应为 True")
    check(info.get("accountCount") == 2,
          f"应读出沙箱里的 2 个账号，实际 {info.get('accountCount')!r}")
    check(info.get("overrideAccounts") == 2,
          f"应读出 2 个有覆盖的账号，实际 {info.get('overrideAccounts')!r}")

restore_env()


print("\n[8] 破坏性对照：退回「硬编码 .vscode」后，JetBrains 断言必须变红")
_saved_resolver = probe.resolve_run_dir
try:
    def hardcoded(project_dir):
        return os.path.join(project_dir, ".vscode", "ok-script-toolkit")

    probe.resolve_run_dir = hardcoded
    with tempfile.TemporaryDirectory() as proj:
        set_run_dir(os.path.join(proj, ".idea", "ok-script-toolkit"))
        info = probe.collect_multi_account(proj, [], [], [])
        check(info["storePath"] != os.path.join(
            proj, ".idea", "ok-script-toolkit", "configs", "account_scoped_overrides.json"),
            "硬编码版必然给不出 .idea 路径 —— 对照必须红（若这里绿了，说明测试立论失效）")
        check(".vscode" in info["storePath"],
              f"硬编码版应回落 .vscode，实际 {info['storePath']!r}")
finally:
    probe.resolve_run_dir = _saved_resolver
    restore_env()


print("\n[9] 测试自身的守卫：恢复后必须回到正确行为（防桩泄漏）")
with tempfile.TemporaryDirectory() as proj:
    set_run_dir(None)
    check(probe.resolve_run_dir(proj) == os.path.join(proj, ".vscode", "ok-script-toolkit"),
          "恢复后应回到默认值")
restore_env()

print()
if failures:
    print(f"FAILED: {len(failures)} 项")
    sys.exit(1)
print("ALL OK")

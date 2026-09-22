# -*- coding: utf-8 -*-
"""apply_config_sandbox 的行为测试。

覆盖：启用/未启用、目录创建、devices.json 桥接、绝对/相对路径、失败回退。
不依赖 ok 框架，可直接跑：python python/tests/test_run_executor_sandbox.py
"""
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

from _test_tmp import make_tmp_tempdir

# 测试放在 tests/ 子目录，被测脚本在上一级 python/。加 .. 而不是 .，
# 这样测试文件不会被随插件发布的 `python/*.py` 通配打包收进去。
ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("run_executor_under_test", ROOT / "run_executor.py")
mod = importlib.util.module_from_spec(SPEC)
# run_executor 顶层只做 import + 常量定义，import 时不会启动任何东西。
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)

failures = []


def check(condition, message):
    if condition:
        print(f"  ok    {message}")
    else:
        print(f"  FAIL  {message}")
        failures.append(message)


def run_in(project_dir, run_dir=None, config_folder=None):
    """在 project_dir 作为 cwd 的环境下调用，模拟执行器的真实工作目录。

    config_folder 模拟「项目 config.py 声明了自定义配置目录名」的场景 ——
    执行器是在 import config 之后才调用 apply_config_sandbox 的，此时 config
    dict 里已带项目自己的 config_folder 值。
    """
    saved_cwd = os.getcwd()
    saved_env = os.environ.get("OK_TOOLKIT_RUN_DIR")
    try:
        os.chdir(project_dir)
        if run_dir is None:
            os.environ.pop("OK_TOOLKIT_RUN_DIR", None)
        else:
            os.environ["OK_TOOLKIT_RUN_DIR"] = run_dir
        config = {}
        if config_folder:
            config["config_folder"] = config_folder
        returned = mod.apply_config_sandbox(config)
        return config, returned
    finally:
        os.chdir(saved_cwd)
        if saved_env is None:
            os.environ.pop("OK_TOOLKIT_RUN_DIR", None)
        else:
            os.environ["OK_TOOLKIT_RUN_DIR"] = saved_env


print("apply_config_sandbox")

# ── 1. 未设置环境变量：不改 config，返回空串（回退旧行为）──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    os.makedirs(os.path.join(project, "configs"))
    config, returned = run_in(project, run_dir=None)
    print("\n[1] 未启用（无 OK_TOOLKIT_RUN_DIR）")
    check(returned == "", "返回空串")
    check("config_folder" not in config, "不改 config_folder")
    check("screenshots_folder" not in config, "不改 screenshots_folder")

# ── 2. 启用：config_folder / screenshots_folder 指向沙箱，目录被创建 ──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    os.makedirs(os.path.join(project, "configs"))
    run_dir = os.path.join(project, ".vscode", "ok-script-toolkit")
    config, returned = run_in(project, run_dir=run_dir)
    print("\n[2] 启用沙箱")
    check(returned != "", "返回非空沙箱根")
    expected_cfg = os.path.join(run_dir, "configs")
    expected_shot = os.path.join(run_dir, "screenshots")
    check(config.get("config_folder") == expected_cfg,
          f"config_folder == {expected_cfg}")
    check(config.get("screenshots_folder") == expected_shot,
          f"screenshots_folder == {expected_shot}")
    check(os.path.isdir(expected_cfg), "configs 沙箱目录已创建")
    check(os.path.isdir(expected_shot), "screenshots 沙箱目录已创建")

# ── 3. 改道后绝不写项目 configs/：原 configs 内容原样不变 ──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    src_configs = os.path.join(project, "configs")
    os.makedirs(src_configs)
    with open(os.path.join(src_configs, "DailyTask.json"), "w", encoding="utf-8") as f:
        json.dump({"关卡": "伊利昂之围"}, f)
    run_dir = os.path.join(project, ".vscode", "ok-script-toolkit")
    run_in(project, run_dir=run_dir)
    print("\n[3] 项目 configs/ 不被触碰")
    remaining = sorted(os.listdir(src_configs))
    check(remaining == ["DailyTask.json"], "项目 configs/ 无新增文件")
    with open(os.path.join(src_configs, "DailyTask.json"), "r", encoding="utf-8") as f:
        check(json.load(f) == {"关卡": "伊利昂之围"}, "项目配置内容未变")

# ── 4. devices.json 桥接：拷进沙箱，项目侧保持原样 ──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    src_configs = os.path.join(project, "configs")
    os.makedirs(src_configs)
    devices = {"selected_hwnd": 123456, "pc_full_path": "D:/game/game.exe"}
    with open(os.path.join(src_configs, "devices.json"), "w", encoding="utf-8") as f:
        json.dump(devices, f)
    run_dir = os.path.join(project, ".vscode", "ok-script-toolkit")
    config, _ = run_in(project, run_dir=run_dir)
    print("\n[4] devices.json 桥接")
    sandbox_devices = os.path.join(config["config_folder"], "devices.json")
    check(os.path.isfile(sandbox_devices), "沙箱内出现 devices.json")
    with open(sandbox_devices, "r", encoding="utf-8") as f:
        check(json.load(f) == devices, "沙箱内内容与项目侧一致（窗口能连上）")
    with open(os.path.join(src_configs, "devices.json"), "r", encoding="utf-8") as f:
        check(json.load(f) == devices, "项目侧 devices.json 未被改动")
    check(sorted(os.listdir(src_configs)) == ["devices.json"], "项目 configs/ 仍只有原文件")

# ── 5. 项目侧没有 devices.json 时不报错、不创建 ──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    os.makedirs(os.path.join(project, "configs"))
    run_dir = os.path.join(project, ".vscode", "ok-script-toolkit")
    config, _ = run_in(project, run_dir=run_dir)
    print("\n[5] 无 devices.json（如从未连接过游戏）")
    check(not os.path.exists(os.path.join(config["config_folder"], "devices.json")),
          "沙箱内不生成 devices.json")

# ── 6. 相对路径也能工作（落到 os.getcwd() 下）──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    os.makedirs(os.path.join(project, "configs"))
    config, returned = run_in(project, run_dir=os.path.join(".vscode", "rel-run"))
    print("\n[6] 相对路径")
    check(returned != "", "相对路径也返回非空")
    check(config["config_folder"].startswith(project), "落在项目目录下")
    check(os.path.isdir(config["config_folder"]), "目录已创建")

# ── 7. 幂等：连续调用两次结果一致 ──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    os.makedirs(os.path.join(project, "configs"))
    run_dir = os.path.join(project, ".vscode", "ok-script-toolkit")
    first, _ = run_in(project, run_dir=run_dir)
    second, _ = run_in(project, run_dir=run_dir)
    print("\n[7] 幂等")
    check(first == second, "两次调用 config 值一致")

# ── 8. 项目 configs/ 整目录拷进沙箱：任务初始值跟项目配置走 ──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    src_configs = os.path.join(project, "configs")
    os.makedirs(src_configs)
    task_cfg = {"关卡": "伊利昂之围", "自动目标": True}
    with open(os.path.join(src_configs, "DailyTask.json"), "w", encoding="utf-8") as f:
        json.dump(task_cfg, f)
    run_dir = os.path.join(project, ".vscode", "ok-script-toolkit")
    config, _ = run_in(project, run_dir=run_dir)
    print("\n[8] 项目 configs 拷入沙箱")
    sandbox_task = os.path.join(config["config_folder"], "DailyTask.json")
    check(os.path.isfile(sandbox_task), "沙箱内出现任务配置文件")
    with open(sandbox_task, "r", encoding="utf-8") as f:
        check(json.load(f) == task_cfg, "沙箱内任务配置与项目侧一致")
    # 幂等：项目侧文件更新后再次启动，沙箱视图跟随刷新
    task_cfg2 = {**task_cfg, "自动目标": False}
    with open(os.path.join(src_configs, "DailyTask.json"), "w", encoding="utf-8") as f:
        json.dump(task_cfg2, f)
    run_in(project, run_dir=run_dir)
    with open(sandbox_task, "r", encoding="utf-8") as f:
        check(json.load(f) == task_cfg2, "重复启动时沙箱视图随项目配置刷新")
    with open(os.path.join(src_configs, "DailyTask.json"), "r", encoding="utf-8") as f:
        check(json.load(f) == task_cfg2, "项目侧文件仍未被沙箱改写")

# ── 9. 项目自定义 config_folder 名：从那里拷，而不是写死的 configs ──
with make_tmp_tempdir("ok-executor-sandbox") as tmp:
    project = os.path.join(tmp, "proj")
    src_configs = os.path.join(project, "my_cfgs")
    os.makedirs(src_configs)
    with open(os.path.join(src_configs, "WeeklyTask.json"), "w", encoding="utf-8") as f:
        json.dump({"boss": "test"}, f)
    run_dir = os.path.join(project, ".vscode", "ok-script-toolkit")
    config, _ = run_in(project, run_dir=run_dir, config_folder="my_cfgs")
    print("\n[9] 自定义 config_folder 名")
    check(os.path.isfile(os.path.join(config["config_folder"], "WeeklyTask.json")),
          "沙箱内容来自项目声明的配置目录")

print("\n" + ("全部通过" if not failures else f"失败 {len(failures)} 项"))
sys.exit(1 if failures else 0)

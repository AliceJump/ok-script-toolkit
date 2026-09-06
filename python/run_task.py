# -*- coding: utf-8 -*-
"""在 ok-script 项目目录下运行单个任务（headless，不启动 GUI）。

用法（在项目目录下）:
    python run_task.py --task TaskClassName --task-module module.path --config-module src.config -- [额外参数]

参数覆盖通过环境变量 OK_LANG_HINTS_INJECT 传入:
    {"module.path::TaskClassName": {"key": value, ...}}

注入原理：猴子补丁 BaseTask.load_config —— 任务加载配置后、on_create() 前，
把插件侧 params 覆盖进 self.config（仅内存，不写 configs/*.json，不污染项目配置）。
参考 ok-end-field src/patches 的 monkey-patch 模式（functools.wraps + 类方法替换 + 幂等）。

运行期控制：宿主通过 stdin 按行发送 pause / resume / overlay_on / overlay_off 命令
（pause/resume 与 ok-script GUI 的 og.executor.pause() / executor.start() 一致，
参考 task.unpause() 的实现；overlay_* 调用框架 _OverlayConfigMixin.set_overlay_setting，
对运行中的任务即时开/关 Win32GdiOverlay）。
命令生效后向 stdout 打印 OK_TOOLKIT_PAUSED / OK_TOOLKIT_RESUMED /
OK_TOOLKIT_OVERLAY_ON / OK_TOOLKIT_OVERLAY_OFF 标记行，
宿主据此同步任务启动器 UI；异常打印 OK_TOOLKIT_ERROR:<err>。

调试浮层：环境变量 OK_TOOLKIT_USE_OVERLAY=1 时把 config['use_overlay'] 置真，
ok-script（ok/__init__.py _create_ok_config / HeadlessApp.get_overlay_view）据此
创建 Win32GdiOverlay，任务内 draw_boxes 的识别框会绘制到游戏窗口上。
"""
import argparse
import functools
import json
import os
import sys
import threading
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# 命令执行结果标记行（宿主按行扫描 stdout）
MARKER_PAUSED = "OK_TOOLKIT_PAUSED"
MARKER_RESUMED = "OK_TOOLKIT_RESUMED"
MARKER_OVERLAY_ON = "OK_TOOLKIT_OVERLAY_ON"
MARKER_OVERLAY_OFF = "OK_TOOLKIT_OVERLAY_OFF"
MARKER_ERROR = "OK_TOOLKIT_ERROR:"


def _emit(line: str) -> None:
    print(line, flush=True)


def _executor():
    """og.executor 在 OK(config) 初始化后才被赋值（ok/__init__.py og.executor = task_executor）。"""
    from ok import og

    return getattr(og, "executor", None)


def _apply_command(command: str) -> None:
    executor = _executor()
    if executor is None:
        raise RuntimeError("task executor is not ready")
    if command == "pause":
        # executor.pause()：置 paused 标志并唤醒执行循环；任务在下一次取 frame 时挂起。
        # 已处于暂停时返回 None（幂等），同样回标记让宿主同步状态。
        executor.pause()
        _emit(MARKER_PAUSED)
    elif command == "resume":
        # executor.start()：executor.paused=False 并补正 pause_end_time，与 task.unpause() 一致。
        executor.start()
        _emit(MARKER_RESUMED)
    elif command in ("overlay_on", "overlay_off"):
        # og.app 是 OK(config) 初始化出的 App/HeadlessApp 实例；set_overlay_setting
        # 置 ok_config['use_overlay'] 并懒创建（get_overlay_view）/关闭 Win32GdiOverlay，
        # 任务后续 draw_boxes 即时生效，无需重启进程。
        from ok import og

        app = getattr(og, "app", None)
        if app is None:
            raise RuntimeError("app is not ready")
        app.set_overlay_setting("boxes", command == "overlay_on")
        _emit(MARKER_OVERLAY_ON if command == "overlay_on" else MARKER_OVERLAY_OFF)
    else:
        raise ValueError(f"unknown command: {command}")


def _handle_command(command: str) -> None:
    """执行命令；executor 尚未就绪（OK 还在初始化）时短暂等待重试。"""
    deadline = time.monotonic() + 120
    while True:
        try:
            _apply_command(command)
            return
        except RuntimeError:
            if time.monotonic() >= deadline:
                _emit(f"{MARKER_ERROR}task executor did not start within 120s")
                return
            time.sleep(0.2)
        except Exception as e:  # noqa: BLE001 — 回传给宿主展示
            _emit(f"{MARKER_ERROR}{e}")
            return


def start_stdin_command_listener() -> None:
    """后台线程按行读取 stdin 命令；EOF（宿主关闭或进程退出）时自然结束。"""

    def listen() -> None:
        try:
            for line in sys.stdin:
                command = line.strip().lower()
                if command in ("pause", "resume", "overlay_on", "overlay_off"):
                    _handle_command(command)
        except Exception:
            # stdin 被关闭等场景直接退出线程，不影响任务运行
            pass

    threading.Thread(target=listen, name="ok-toolkit-stdin", daemon=True).start()


def apply_inject_patch(inject: dict) -> None:
    """把 inject={module::ClassName: {key: value}} 覆盖进目标任务配置。"""
    if not inject:
        return
    from ok.task.task import BaseTask

    original = BaseTask.load_config

    @functools.wraps(original)
    def patched_load_config(self, *args, **kwargs):
        original(self, *args, **kwargs)
        task_key = f"{self.__class__.__module__}::{self.__class__.__name__}"
        overrides = inject.get(task_key)
        if isinstance(overrides, dict):
            for key, value in overrides.items():
                if key in self.config:
                    # Config.__setitem__ 会立即写回 configs/*.json；直接调用 dict
                    # 基类实现，确保覆盖仅对当前进程生效。
                    dict.__setitem__(self.config, key, value)

    BaseTask.load_config = patched_load_config


def main():
    parser = argparse.ArgumentParser(description="运行 ok-script 单个任务（headless）")
    parser.add_argument("--task", required=True, help="任务类名")
    parser.add_argument("--task-module", required=True, help="任务模块路径")
    parser.add_argument("--config-module", default="src.config", help="config 模块路径，如 src.config 或 config")
    args, extra_args = parser.parse_known_args()
    if extra_args and extra_args[0] == "--":
        extra_args = extra_args[1:]

    # 读参数覆盖（环境变量 -> 不炸）
    inject = {}
    raw_inject = os.environ.get("OK_LANG_HINTS_INJECT", "")
    if raw_inject:
        try:
            inject = json.loads(raw_inject)
        except Exception:
            inject = {}

    sys.path.insert(0, ".")

    # 参数注入补丁（必须在 import 任务前装好）
    apply_inject_patch(inject)

    config_module = __import__(args.config_module, fromlist=["config"])
    config = config_module.config

    # 过滤任务注册表：只保留目标任务，避免 TaskManager 加载其他
    # 有导入问题的任务（如 ok-end-field 的 characters 包问题）导致整体失败
    # 注意：不能直接把 trigger_tasks 清空——若目标任务本身是 trigger 任务，
    # OK.get_task 会先查 onetime_tasks 再查 trigger_tasks，清空会导致找不到。
    config = dict(config)
    config["check_mutex"] = False
    # ok-script 2.x：config['gui']={'type':'qt'}（如 ok-wuthering-waves）会让 OK 创建
    # 完整 Qt App 并安装 QtEventDispatcher，headless 下没有事件循环，
    # communicate.window/overlay 信号全部排队丢失，浮层收不到窗口更新。置 None
    # 强制 resolve_ui_config 返回 None → HeadlessApp（同步分发）。
    config["gui"] = None
    # 调试浮层开关（宿主经 OK_TOOLKIT_USE_OVERLAY 传入）；_create_ok_config 会
    # 从 config 里读取该键，HeadlessApp 据此懒创建 Win32GdiOverlay。
    if os.environ.get("OK_TOOLKIT_USE_OVERLAY", "").strip().lower() in ("1", "true", "yes"):
        config["use_overlay"] = True
    if config.get("use_overlay"):
        print("[toolkit] 调试浮层已开启（游戏窗口置前时显示识别框/边框）", flush=True)
    task_name = args.task
    task_module = args.task_module
    config["onetime_tasks"] = [
        t for t in config.get("onetime_tasks", []) if t[0] == task_module and t[1] == task_name
    ]
    config["trigger_tasks"] = [
        t for t in config.get("trigger_tasks", []) if t[0] == task_module and t[1] == task_name
    ]

    # 只把显式透传参数交给 ok-script，避免辅助脚本自身参数与框架 argparse 冲突。
    saved_argv = sys.argv[:]
    sys.argv = [saved_argv[0], *extra_args]

    from ok import run_task

    # stdin 命令监听（pause/resume）；og.executor 由 OK(config) 初始化时赋值，
    # 命令到达早于初始化完成时在 _handle_command 内等待。
    start_stdin_command_listener()

    try:
        run_task(config, task=task_name)
    finally:
        sys.argv = saved_argv


if __name__ == "__main__":
    main()

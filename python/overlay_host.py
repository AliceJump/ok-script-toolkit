# -*- coding: utf-8 -*-
"""常驻浮层宿主：headless 初始化 ok-script 并让 Win32GdiOverlay 一直存活。

工具箱“连接游戏”成功后由插件拉起本进程；无需启动任务即可：
  - 看到浮层边框（游戏窗口置前时）；
  - Alt+右键点两个角框选游戏区域，归一化坐标自动复制到剪贴板。

stdin 收到 quit / exit 或 EOF 时退出。启动完成后向 stdout 打印就绪标记行
OK_TOOLKIT_OVERLAY_HOST_READY。
"""
import os
import shutil
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

READY_MARKER = "OK_TOOLKIT_OVERLAY_HOST_READY"


def main():
    if len(sys.argv) < 2:
        print("missing project_dir", file=sys.stderr)
        sys.exit(1)
    project_dir = sys.argv[1]
    sys.path.insert(0, project_dir)
    os.chdir(project_dir)

    # 沙箱 configs（与 probe_task_schemas 相同，避免读写用户配置）
    temp_dir = tempfile.TemporaryDirectory(prefix="ok-overlay-host-")
    temp_config_folder = os.path.join(temp_dir.name, "configs")
    source_config_path = os.path.join(project_dir, "configs")
    if os.path.isdir(source_config_path):
        shutil.copytree(source_config_path, temp_config_folder, dirs_exist_ok=True)

    import ok.util.file as ok_file
    import ok.util.config as ok_config_mod
    from ok.util.config import Config

    original_get_relative_path = ok_file.get_relative_path

    def sandboxed_get_relative_path(*files):
        if files and os.path.normcase(str(files[0])) == "configs":
            return os.path.normpath(os.path.join(temp_config_folder, *files[1:]))
        return original_get_relative_path(*files)

    ok_file.get_relative_path = sandboxed_get_relative_path
    ok_config_mod.get_relative_path = sandboxed_get_relative_path
    Config.config_folder = temp_config_folder

    try:
        from src.config import config
    except Exception:
        from config import config

    from ok import OK, og

    cfg = dict(config)
    cfg["use_gui"] = False
    # ok-script 2.x：config['gui']={'type':'qt'}（如 ok-wuthering-waves）会让 OK 创建
    # 完整 Qt App 并安装 QtEventDispatcher，headless 下没有事件循环，
    # communicate.window 信号全部排队丢失，浮层永远收不到窗口更新。置 None 强制
    # resolve_ui_config 返回 None → HeadlessApp（同步分发）。
    cfg["gui"] = None
    cfg["check_mutex"] = False
    cfg["custom_tasks"] = False
    cfg["config_folder"] = temp_config_folder
    # 常驻宿主不需要 OCR 模型（省显存/内存）；游戏窗口由 DeviceManager 自动探测
    cfg.pop("ocr", None)
    cfg["use_overlay"] = True

    ok = None
    try:
        ok = OK(cfg)
        og.app.set_overlay_setting("boxes", True)
        print(READY_MARKER, flush=True)
        # 阻塞在 stdin 上：插件关闭管道（kill）或发送 quit 时退出
        for line in sys.stdin:
            if line.strip().lower() in ("quit", "exit"):
                break
    finally:
        if ok is not None:
            ok.quit()
        temp_dir.cleanup()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        sys.exit(1)

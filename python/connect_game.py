# -*- coding: utf-8 -*-
"""连接游戏窗口：按项目 windows 配置搜索窗口，并写入 configs/devices.json 的
selected_exe / selected_hwnd / pc_full_path（DeviceManager 启动时原生优先选中该窗口，
见 hwnd_window.py 的 find_hwnd(selected_hwnd=...)；窗口失效时自动回退普通搜索）。

这样工具箱建立一次连接后，后续所有任务进程（以及项目 GUI）无需重新探测即复用
同一窗口连接。

游戏未运行时自动启动：复用框架 ok.util.process.execute 拉起 devices.json
pc_full_path 记录的游戏（与 StartController.start_device 同源），然后轮询等待
窗口出现再连接。pc_full_path 在每次连接成功后回写，因此首次成功后即可始终自动启动。

用法:
    python connect_game.py <project_dir>               # 连接（未运行则自动启动）
    python connect_game.py <project_dir> --disconnect  # 断开（清除选中）

输出(最后一行 JSON):
    {"ok": true, "hwnd": N, "pid": N, "title": "...", "exe": "...", "windows": N, "started": bool}
    {"ok": true, "disconnected": true}
    {"ok": false, "error": "..."}
"""
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# DeviceManager 里 Config("devices", ...) 的默认键，保持文件结构一致
DEVICES_DEFAULTS = {
    "preferred": "",
    "pc_full_path": "",
    "capture": "windows",
    "selected_exe": "",
    "selected_hwnd": 0,
    "interaction": "",
}

# 自动启动后等待游戏窗口的上限（秒）；受扩展侧 exec 超时约束
WAIT_WINDOW_MAX_SECONDS = 150


def _plain(value):
    """过滤 AST 提取产生的 <ref:...>/<call:...> 标记，只保留可用的字面量。"""
    if isinstance(value, str) and value.startswith("<"):
        return None
    return value


def _extract_start_timeout(config_path):
    """AST 读取项目 config.py 顶层 start_timeout（框架启动等待的超时秒数）。"""
    import ast

    if not config_path:
        return 0
    try:
        with open(config_path, encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=config_path)
    except (OSError, SyntaxError):
        return 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values):
            if (isinstance(key, ast.Constant) and key.value == "start_timeout"
                    and isinstance(value, ast.Constant) and isinstance(value.value, int)):
                return value.value
    return 0


def _emit_error(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        _emit_error("缺少 project_dir 参数")
    project_dir = sys.argv[1]
    disconnect = "--disconnect" in sys.argv[2:]

    sys.path.insert(0, project_dir)
    os.chdir(project_dir)

    # 项目窗口匹配配置（AST 解析 config.py，不导入项目代码）
    from probe_window_config import _extract_config_dict_keys, _resolve_config_path

    config_path = _resolve_config_path(project_dir)
    win = _extract_config_dict_keys(config_path) if config_path else {}
    exe = win.get("exe")
    if isinstance(exe, str):
        exe = [exe]
    exe_names = [e for e in (exe or []) if _plain(e)]
    title = _plain(win.get("title")) if isinstance(win.get("title"), str) else None
    hwnd_class = _plain(win.get("hwnd_class")) if isinstance(win.get("hwnd_class"), str) else None
    top_hwnd_class = _plain(win.get("top_hwnd_class")) if isinstance(win.get("top_hwnd_class"), str) else None

    from ok.util.config import Config

    devices = Config("devices", DEVICES_DEFAULTS, folder=os.path.join(project_dir, "configs"))

    if disconnect:
        devices["selected_hwnd"] = 0
        devices["selected_exe"] = ""
        devices.save_file()
        print(json.dumps({"ok": True, "disconnected": True}, ensure_ascii=False))
        return

    from ok.util.window import find_hwnd

    def search():
        return find_hwnd(
            title, exe_names or None, 0, 0,
            class_name=hwnd_class, top_hwnd_class=top_hwnd_class,
        )

    if not exe_names and not title:
        _emit_error("config.py 的 windows 配置中缺少可用的 exe/title，无法定位游戏窗口")

    name, hwnd, exe_full_path, _rx, _ry, _rw, _rh, hwnds = search()
    started = False

    if not hwnd or hwnd <= 0:
        # 游戏未运行：自动启动。exe 路径与框架 StartController.start_device 同源
        # （devices.json 的 pc_full_path，由项目 GUI/上次连接记录）。
        from ok.util.process import execute, WINDOWS_START_METHOD_START

        exe_path = devices.get("pc_full_path")
        if not exe_path or str(exe_path).lower() == "none" or not os.path.isfile(str(exe_path)):
            _emit_error("游戏未运行，且没有可用的游戏路径（configs/devices.json 的 pc_full_path）。"
                        "请先手动运行一次游戏并连接，或在该文件中填写游戏完整路径。")
        if not execute(str(exe_path), start_method=WINDOWS_START_METHOD_START):
            _emit_error(f"游戏启动失败：{exe_path}")
        started = True

        timeout = _extract_start_timeout(config_path) or 120
        # 完整启动链路（启动器→反作弊→游戏窗口）常超过项目 start_timeout，
        # 自动启动等待至少 120s（上限受扩展侧 exec 超时约束）
        wait_seconds = min(max(int(timeout), 120), WAIT_WINDOW_MAX_SECONDS)
        deadline = time.time() + wait_seconds
        while True:
            time.sleep(2)
            name, hwnd, exe_full_path, _rx, _ry, _rw, _rh, hwnds = search()
            if hwnd and hwnd > 0:
                break
            if time.time() >= deadline:
                _emit_error(f"游戏已启动，但 {wait_seconds}s 内未检测到游戏窗口，请稍后重试连接")

    import win32process

    _thread_id, pid = win32process.GetWindowThreadProcessId(hwnd)
    row = next((r for r in hwnds if r and r[0] == hwnd), None)
    window_title = (row[6] if row else "") or name or ""

    devices["selected_hwnd"] = int(hwnd)
    devices["selected_exe"] = exe_full_path or (exe_names[0] if exe_names else "")
    # 与框架 update_pc_device 一致：回写游戏完整路径，供后续自动启动复用
    if exe_full_path and exe_full_path != devices.get("pc_full_path"):
        devices["pc_full_path"] = exe_full_path
    devices.save_file()

    print(json.dumps({
        "ok": True,
        "hwnd": int(hwnd),
        "pid": int(pid),
        "title": window_title,
        "exe": exe_full_path or "",
        "windows": len(hwnds),
        "started": started,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)

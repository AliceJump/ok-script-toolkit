# -*- coding: utf-8 -*-
"""连接游戏窗口：按项目 windows 配置搜索窗口，并写入 configs/devices.json 的
selected_exe / selected_hwnd（DeviceManager 启动时原生优先选中该窗口，
见 hwnd_window.py 的 find_hwnd(selected_hwnd=...)；窗口失效时自动回退普通搜索）。

这样工具箱建立一次连接后，后续所有任务进程（以及项目 GUI）无需重新探测即复用
同一窗口连接。

用法:
    python connect_game.py <project_dir>               # 连接（搜索并选中）
    python connect_game.py <project_dir> --disconnect  # 断开（清除选中）

输出(最后一行 JSON):
    {"ok": true, "hwnd": N, "pid": N, "title": "...", "exe": "...", "windows": N}
    {"ok": true, "disconnected": true}
    {"ok": false, "error": "..."}
"""
import json
import os
import sys

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


def _plain(value):
    """过滤 AST 提取产生的 <ref:...>/<call:...> 标记，只保留可用的字面量。"""
    if isinstance(value, str) and value.startswith("<"):
        return None
    return value


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 project_dir 参数"}, ensure_ascii=False))
        sys.exit(1)
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

    if not exe_names and not title:
        print(json.dumps({
            "ok": False,
            "error": "config.py 的 windows 配置中缺少可用的 exe/title，无法定位游戏窗口",
        }, ensure_ascii=False))
        sys.exit(1)

    from ok.util.window import find_hwnd

    name, hwnd, exe_full_path, _rx, _ry, _rw, _rh, hwnds = find_hwnd(
        title, exe_names or None, 0, 0,
        class_name=hwnd_class, top_hwnd_class=top_hwnd_class,
    )
    if not hwnd or hwnd <= 0:
        print(json.dumps({"ok": False, "error": "未找到匹配的游戏窗口（游戏未启动或窗口配置不匹配）"},
                         ensure_ascii=False))
        sys.exit(1)

    import win32gui

    _thread_id, pid = win32gui.GetWindowThreadProcessId(hwnd)
    row = next((r for r in hwnds if r and r[0] == hwnd), None)
    window_title = (row[6] if row else "") or name or ""

    devices["selected_hwnd"] = int(hwnd)
    devices["selected_exe"] = exe_full_path or (exe_names[0] if exe_names else "")
    devices.save_file()

    print(json.dumps({
        "ok": True,
        "hwnd": int(hwnd),
        "pid": int(pid),
        "title": window_title,
        "exe": exe_full_path or "",
        "windows": len(hwnds),
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)

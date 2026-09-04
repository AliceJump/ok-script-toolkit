"""
Capture game window screenshot using ok-script's capture_by_bitblt.

Thin wrapper around the ok-script framework's built-in capture methods.
Finds the game window via ok.util.window.find_hwnd, then captures using
ok.device.capture_methods.bitblt_utils.capture_by_bitblt.

Usage:
    python capture_game_window.py <output_path> [--config-json <json>] [--project-dir <dir>]
    python capture_game_window.py <output_path> --exe-names Endfield.exe --hwnd-class UnityWndClass
    python capture_game_window.py <output_path> --config-json '{"exe":["Endfield.exe"],"hwnd_class":"UnityWndClass"}'
"""

import sys
import os
import json
import importlib.util

import cv2
import win32gui
from ok.util.window import find_hwnd
from ok.device.capture_methods.bitblt_utils import BitBltCtxDummy, capture_by_bitblt, clean_up_bitblt

_ctx = BitBltCtxDummy()


def load_screenshot_processor(project_dir):
    """从项目的 config.py 动态加载 screenshot_processor 函数。

    复用 probe_window_config 的路径解析逻辑定位 config.py，
    先解析 main.py 的 import，再 fallback 到 src/config.py 或 config.py。

    返回 callable 或 None。
    """
    try:
        from probe_window_config import _resolve_config_path
        config_path = _resolve_config_path(project_dir)
    except ImportError:
        # fallback: 直接尝试常见路径
        for candidate in (
            os.path.join(project_dir, 'src', 'config.py'),
            os.path.join(project_dir, 'config.py'),
        ):
            if os.path.isfile(candidate):
                config_path = candidate
                break
        else:
            return None

    if not config_path or not os.path.isfile(config_path):
        return None

    try:
        if project_dir not in sys.path:
            sys.path.insert(0, project_dir)
        spec = importlib.util.spec_from_file_location('project_config', config_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        processor = getattr(mod, 'config', {}).get('screenshot_processor')
        if callable(processor):
            print(f"Loaded screenshot_processor: {processor.__name__}")
            return processor
    except Exception as e:
        print(f"Failed to load screenshot_processor: {e}", file=sys.stderr)
    return None


def capture(output_path, exe_names=None, hwnd_class=None, processor=None):
    """Find game window and capture a single frame.

    Uses ok-script's find_hwnd for window discovery and
    capture_by_bitblt for the actual screenshot.

    Returns the output path on success, raises on failure.
    """
    global _ctx

    result = find_hwnd(None, exe_names or [], 0, 0, class_name=hwnd_class)
    title, hwnd = result[0], result[1]
    if not hwnd:
        raise RuntimeError("No matching window found")

    print(f"Found: {title!r} (hwnd={hwnd})")

    # Client area size (excludes title bar / borders)
    cl, ct, cr, cb = win32gui.GetClientRect(hwnd)
    w, h = cr - cl, cb - ct
    if w <= 0 or h <= 0:
        raise RuntimeError(f"Invalid client size: {w}x{h}")

    # Offset from window origin to client area origin (skips title bar)
    wx, wy = win32gui.ClientToScreen(hwnd, (0, 0))
    wleft, wtop, _, _ = win32gui.GetWindowRect(hwnd)
    ox, oy = wx - wleft, wy - wtop

    clean_up_bitblt(_ctx)
    frame = capture_by_bitblt(_ctx, hwnd, w, h, ox, oy, True)
    if frame is None:
        raise RuntimeError("capture_by_bitblt returned None")

    # 应用项目配置的 screenshot_processor（如遮挡 UID）
    if processor:
        try:
            frame = processor(frame.copy())
        except Exception as e:
            print(f"screenshot_processor error: {e}", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    cv2.imwrite(output_path, frame)
    return output_path


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Capture game window screenshot")
    parser.add_argument("output_path", help="Output image path")
    parser.add_argument("--exe-names", nargs="+", default=None, help="Executable names to match")
    parser.add_argument("--hwnd-class", default=None, help="Window class name")
    parser.add_argument("--config-json", default=None, help="JSON config from probe_window_config")
    parser.add_argument("--project-dir", default=None, help="Project root dir (loads screenshot_processor from src/config.py)")
    parser.add_argument("title_regex", nargs="?", default=None, help=argparse.SUPPRESS)

    args = parser.parse_args()

    exe_names = args.exe_names
    hwnd_class = args.hwnd_class

    if args.config_json:
        try:
            cfg = json.loads(args.config_json)
            exe_names = exe_names or cfg.get("exe")
            hwnd_class = hwnd_class or cfg.get("hwnd_class")
        except json.JSONDecodeError as exc:
            print(f"Invalid config JSON: {exc}", file=sys.stderr)

    # 从项目 config 加载 screenshot_processor
    processor = None
    if args.project_dir:
        processor = load_screenshot_processor(args.project_dir)

    print(f"Searching: exe={exe_names}, class={hwnd_class}")

    try:
        capture(args.output_path, exe_names, hwnd_class, processor=processor)
    except Exception as exc:
        print(f"Capture failed: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Saved: {args.output_path}")


if __name__ == "__main__":
    main()

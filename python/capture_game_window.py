"""
Capture game window screenshot using ok-script's capture methods.

Thin wrapper around the ok-script framework's built-in capture methods.
Finds the game window via ok.util.window.find_hwnd, then captures with
Windows Graphics Capture (WGC) when available, falling back to BitBlt.

WGC is preferred because it reads the compositor's texture for the window
rather than the window DC, so it is not subject to the monitor DPI
virtualization that shifts the DC's coordinate space. Both paths return the
window's client area size, so the two stay interchangeable. Note that a
borderless window straddling two monitors still reports the combined size
from either path -- that is the window's real size, not a capture bug.

Usage:
    python capture_game_window.py <output_path> [--config-json <json>] [--project-dir <dir>]
    python capture_game_window.py <output_path> --exe-names Endfield.exe --hwnd-class UnityWndClass
    python capture_game_window.py <output_path> --config-json '{"exe":["Endfield.exe"],"hwnd_class":"UnityWndClass"}'
    python capture_game_window.py <output_path> --method bitblt
    python capture_game_window.py <output_path> --method foreground

--method foreground activates the window and reads the desktop DC. It is the
escape hatch for launcher/login screens where PrintWindow and WGC return blank
or stale frames. It steals focus, so auto never falls back to it.
"""

import sys
import os
import json
import importlib.util
import threading
import time
import ctypes

_SCRIPT_STARTED = time.perf_counter()
_PROTOCOL_STDOUT = sys.stdout
if '--serve' in sys.argv:
    # 项目和框架的普通 print 全部留在日志管道，stdout 只传截图结果。
    sys.stdout = sys.stderr


def _log_timing(stage, started):
    print(f"capture.timing.{stage}_ms={(time.perf_counter() - started) * 1000:.1f}",
          file=sys.stderr, flush=True)


def _set_process_dpi_awareness():
    """Declaring DPI awareness must happen before any Win32 window/DC call.

    ok-script's main process calls SetProcessDpiAwareness(2) inside OK.__init__.
    This script is a standalone process and never builds an OK instance, so without
    the same call the process stays DPI-unaware: GetClientRect/GetWindowRect return
    virtualized logical coordinates while BitBlt reads the physical pixel buffer.
    The mismatch makes the capture stop at the top-left (96/DPI) fraction of the
    frame, e.g. only 1536x864 of a 1920x1080 window at 125% scaling.
    """
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_DPI_AWARE
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()  # fallback for older Windows
    except Exception:
        pass


# Must run before win32gui / cv2 grab any window metrics.
_set_process_dpi_awareness()

import cv2
import win32api
import win32con
import win32gui
from ok.util.window import find_hwnd
from ok.device.capture_methods.bitblt_utils import (
    BitBltCtxDummy,
    capture_by_bitblt,
    capture_desktop_by_bitblt,
    clean_up_bitblt,
    clean_up_desktop_bitblt,
)

_ctx = BitBltCtxDummy()
_desktop_ctx = BitBltCtxDummy()
_REUSE_WGC = False
_wgc_session = None
_log_timing('imports', _SCRIPT_STARTED)


def _get_scaling_ratios(hwnd):
    """Return (monitor_scaling, window_scaling), same units ok-script uses.

    Mirrors ok.util.window.get_window_bounds (monitor DPI / 96) and
    bitblt_utils.composite_hwnds (GetDpiForWindow / 96).
    """
    monitor_scaling = 1.0
    try:
        # Use ctypes, not win32api: pywin32 returns a handle object that
        # GetDpiForMonitor cannot marshal.
        monitor = ctypes.windll.user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
        dpi_x = ctypes.c_uint()
        dpi_y = ctypes.c_uint()
        ctypes.windll.shcore.GetDpiForMonitor(monitor, 0, ctypes.byref(dpi_x), ctypes.byref(dpi_y))
        if dpi_x.value:
            monitor_scaling = dpi_x.value / 96.0
    except Exception as e:
        print(f"monitor dpi lookup failed: {e}", file=sys.stderr)

    window_scaling = monitor_scaling
    try:
        dpi = ctypes.windll.user32.GetDpiForWindow(hwnd)
        if dpi:
            window_scaling = dpi / 96.0
    except Exception as e:
        print(f"GetDpiForWindow failed: {e}", file=sys.stderr)

    return monitor_scaling, window_scaling


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


class _StubHwndWindow:
    """Minimal stand-in for ok.device.capture_methods.hwnd_window.HwndWindow.

    WindowsGraphicsCaptureMethod only reads a handful of attributes; this process
    has no device manager or App instance to build a real one from.
    """

    def __init__(self, hwnd, width, height):
        self.hwnd = hwnd
        self.width = width
        self.height = height
        self.exists = True
        self.app_exit_event = threading.Event()
        self.capture_target_signature = (hwnd, width, height)
        self.hwnds = []  # empty: skips composite_hwnds entirely
        self.contexts = {}
        self.x = 0
        self.y = 0
        self.window_width = width
        self.window_height = height
        self.real_width = 0
        self.real_height = 0
        self.real_x_offset = 0
        self.real_y_offset = 0
        self.scaling = 1.0

    def __str__(self):
        return f"StubHwndWindow(hwnd={self.hwnd}, {self.width}x{self.height})"


def _capture_wgc(hwnd, width, height, attempts=4, timeout=1.5):
    """Capture one frame with Windows Graphics Capture. Returns None on failure.

    WGC reports the window content size through item.Size, which includes the
    window border and title bar. WindowsGraphicsCaptureMethod.crop_image trims the
    frame down to hwnd_window.width/height, so the stub target is kept at the client
    size to trim the border off and stay consistent with what BitBlt returns.
    If the content is smaller than the client area the target falls back to the
    content size, because crop_image would then slice with negative indices.
    """
    try:
        from ok.util.window import windows_graphics_available
        if not windows_graphics_available():
            print("WGC unavailable on this system", file=sys.stderr)
            return None
        from ok.device.capture_methods.windows_graphics import WindowsGraphicsCaptureMethod
    except Exception as e:
        print(f"WGC unavailable: {e}", file=sys.stderr)
        return None

    global _wgc_session
    key = hwnd, width, height
    if _wgc_session is not None and _wgc_session[0] != key:
        _close_wgc_session()
    if _REUSE_WGC and _wgc_session is not None:
        _, stub, method = _wgc_session
    else:
        stub = _StubHwndWindow(hwnd, width, height)
        method = None
    frame = None
    # get_frame() 本身会等待首帧；不能把框架的 4 秒等待重复四次。
    # 使用框架已有的退出事件取消请求，不在另一个线程关闭仍在读帧的 D3D 对象。
    deadline = time.monotonic() + timeout
    cancel = threading.Timer(timeout, stub.app_exit_event.set)
    cancel.daemon = True
    cancel.start()
    try:
        if method is None:
            method = WindowsGraphicsCaptureMethod(stub)
        if not method.connected():
            return None
        for attempt in range(attempts):
            if stub.app_exit_event.is_set() or time.monotonic() >= deadline:
                break
            content = getattr(method, 'last_size', None)
            if content is not None:
                cw, ch = int(content.Width), int(content.Height)
                if cw >= width and ch >= height:
                    stub.width, stub.height = width, height  # trim border/title bar
                else:
                    stub.width, stub.height = cw, ch  # content smaller: do not trim
            frame = method.get_frame()
            if frame is not None:
                if _REUSE_WGC:
                    _wgc_session = key, stub, method
                return frame
            if attempt + 1 < attempts:
                stub.app_exit_event.wait(min(0.05, max(0, deadline - time.monotonic())))
    except Exception as e:
        print(f"WGC capture failed: {e}", file=sys.stderr)
    finally:
        cancel.cancel()
        if not (_REUSE_WGC and frame is not None and not stub.app_exit_event.is_set()):
            stub.app_exit_event.set()
            if method is not None:
                if _wgc_session is not None and _wgc_session[2] is method:
                    _wgc_session = None
                try:
                    method.close()
                except Exception:
                    pass
    return frame if frame is not None else None


def _close_wgc_session():
    global _wgc_session
    if _wgc_session is not None:
        _, stub, method = _wgc_session
        _wgc_session = None
        stub.app_exit_event.set()
        try:
            method.close()
        except Exception:
            pass


def _capture_bitblt(hwnd, w, h, ox, oy):
    """Capture one frame with BitBlt + PrintWindow. Returns None on failure."""
    global _ctx

    # DPI virtualization compensation. This process is per-monitor aware, so w/h/ox/oy
    # are physical pixels. If the game window itself is DPI-unaware, its DC is a
    # logical buffer: capture at the logical size and scale back up, otherwise BitBlt
    # reads past the buffer and the right/bottom edges come back blank or stretched.
    m_scaling, w_scaling = _get_scaling_ratios(hwnd)
    ratio = 1.0
    if 0 < w_scaling < m_scaling:
        ratio = m_scaling / w_scaling

    cap_w = max(1, int(round(w / ratio)))
    cap_h = max(1, int(round(h / ratio)))
    cap_ox = int(round(ox / ratio))
    cap_oy = int(round(oy / ratio))

    print(f"bitblt client={w}x{h} offset={ox},{oy} monitor_scaling={m_scaling:.2f} "
          f"window_scaling={w_scaling:.2f} ratio={ratio:.2f} capture={cap_w}x{cap_h}")

    try:
        frame = capture_by_bitblt(_ctx, hwnd, cap_w, cap_h, cap_ox, cap_oy, True)
    finally:
        clean_up_bitblt(_ctx)
    if frame is None:
        return None
    if ratio != 1.0:
        frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_LINEAR)
    return frame


def _activate_window(hwnd):
    """Bring the window to the foreground and verify it actually got there.

    Mirrors ok-end-field's active_and_send_mouse_delta(only_activate=True)
    (src/interaction/Mouse.py): restore/show the window, then SetForegroundWindow,
    and if Windows refuses it, nudge Alt to lift the foreground-lock restriction.
    Note the Alt key must always be released again, otherwise every later
    keypress in the system turns into an Alt combo.
    """
    try:
        if not win32gui.IsWindow(hwnd):
            print("activate: invalid hwnd", file=sys.stderr)
            return False
        if win32gui.GetForegroundWindow() == hwnd:
            return True

        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            time.sleep(0.15)
        if not win32gui.IsWindowVisible(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
            time.sleep(0.15)
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.05)

        try:
            win32gui.SetForegroundWindow(hwnd)
        except win32gui.error:
            win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
            try:
                time.sleep(0.01)
                win32gui.SetForegroundWindow(hwnd)
            finally:
                win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)

        time.sleep(0.15)
        return win32gui.GetForegroundWindow() == hwnd
    except Exception as e:
        print(f"activate failed: {e}", file=sys.stderr)
        return False


def _capture_foreground(hwnd, width, height):
    """Capture the screen pixels at the window's client area.

    For windows that refuse background capture: PrintWindow and WGC come back
    blank or stale on launcher/login screens, while the desktop DC always shows
    what is really on screen. Requires the window in front and unobscured, which
    is why this is opt-in (--method foreground) and never used by auto -- it
    steals focus.
    """
    global _desktop_ctx

    if not _activate_window(hwnd):
        print("foreground capture: window did not reach the foreground", file=sys.stderr)
        return None

    time.sleep(0.25)  # let the compositor settle after activation
    cx, cy = win32gui.ClientToScreen(hwnd, (0, 0))
    print(f"foreground capture at screen ({cx},{cy}) size {width}x{height}")

    # Pin the window above everything else so always-on-top overlays (GeForce
    # Experience, Steam, Discord) cannot land in the shot. Restored afterwards,
    # unless the window was already topmost before we touched it.
    was_topmost = False
    try:
        ex_style = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
        was_topmost = bool(ex_style & win32con.WS_EX_TOPMOST)
        win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                              win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
        time.sleep(0.1)
    except Exception as e:
        print(f"could not pin window on top: {e}", file=sys.stderr)

    try:
        return capture_desktop_by_bitblt(_desktop_ctx, width, height, cx, cy)
    finally:
        if not was_topmost:
            try:
                win32gui.SetWindowPos(hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                                      win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
            except Exception:
                pass
        clean_up_desktop_bitblt(_desktop_ctx)


def capture(output_path, exe_names=None, hwnd_class=None, processor=None, method='auto'):
    """Find game window and capture a single frame.

    Uses ok-script's find_hwnd for window discovery, then WGC (preferred,
    falls back to BitBlt when method='auto').

    Returns the output path on success, raises on failure.
    """
    started = time.perf_counter()
    result = find_hwnd(None, exe_names or [], 0, 0, class_name=hwnd_class)
    _log_timing('find_window', started)
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

    frame = None
    if method not in ('auto', 'wgc'):
        _close_wgc_session()
    if method == 'foreground':
        started = time.perf_counter()
        frame = _capture_foreground(hwnd, w, h)
        _log_timing('foreground', started)
        if frame is not None:
            print(f"captured via foreground: {frame.shape[1]}x{frame.shape[0]}")
    else:
        if method in ('auto', 'wgc'):
            started = time.perf_counter()
            frame = _capture_wgc(hwnd, w, h, timeout=1.5 if method == 'auto' else 3.0)
            _log_timing('wgc', started)
            if frame is not None:
                print(f"captured via WGC: {frame.shape[1]}x{frame.shape[0]}")
        if frame is None and method in ('auto', 'bitblt'):
            started = time.perf_counter()
            frame = _capture_bitblt(hwnd, w, h, ox, oy)
            _log_timing('bitblt', started)
            if frame is not None:
                print(f"captured via BitBlt: {frame.shape[1]}x{frame.shape[0]}")
    if frame is None:
        raise RuntimeError(f"no capture method produced a frame (method={method})")

    # BitBlt and the desktop DC hand back BGRA; ok-script's get_frame drops the
    # alpha channel too, so trim it to keep output identical across methods.
    if len(frame.shape) == 3 and frame.shape[2] == 4:
        frame = frame[:, :, :3]

    # 应用项目配置的 screenshot_processor（如遮挡 UID）
    if processor:
        started = time.perf_counter()
        try:
            frame = processor(frame.copy())
        except Exception as e:
            print(f"screenshot_processor error: {e}", file=sys.stderr)
        finally:
            _log_timing('processor', started)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    started = time.perf_counter()
    if not cv2.imwrite(output_path, frame):
        raise RuntimeError("Screenshot file could not be written")
    _log_timing('save', started)
    return output_path


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Capture game window screenshot")
    parser.add_argument("output_path", help="Output image path")
    parser.add_argument("--exe-names", nargs="+", default=None, help="Executable names to match")
    parser.add_argument("--hwnd-class", default=None, help="Window class name")
    parser.add_argument("--config-json", default=None, help="JSON config string (legacy)")
    parser.add_argument("--config-file", default=None, help="Path to JSON config file")
    parser.add_argument("--project-dir", default=None, help="Project root dir (loads screenshot_processor from src/config.py)")
    parser.add_argument("--method", default="auto", choices=("auto", "wgc", "bitblt", "foreground"),
                        help="auto=WGC then BitBlt; foreground=activate the window and read the screen")
    parser.add_argument("title_regex", nargs="?", default=None, help=argparse.SUPPRESS)

    args = parser.parse_args()

    exe_names = args.exe_names
    hwnd_class = args.hwnd_class

    if args.config_file:
        try:
            with open(args.config_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            exe_names = exe_names or cfg.get("exe")
            hwnd_class = hwnd_class or cfg.get("hwnd_class")
        except Exception as exc:
            print(f"Invalid config file: {exc}", file=sys.stderr)
    elif args.config_json:
        try:
            cfg = json.loads(args.config_json)
            exe_names = exe_names or cfg.get("exe")
            hwnd_class = hwnd_class or cfg.get("hwnd_class")
        except json.JSONDecodeError as exc:
            print(f"Invalid config JSON: {exc}", file=sys.stderr)

    # 从项目 config 加载 screenshot_processor
    processor = None
    if args.project_dir:
        started = time.perf_counter()
        processor = load_screenshot_processor(args.project_dir)
        _log_timing('load_project_config', started)

    print(f"Searching: exe={exe_names}, class={hwnd_class}, method={args.method}")

    try:
        capture(args.output_path, exe_names, hwnd_class, processor=processor, method=args.method)
    except Exception as exc:
        print(f"Capture failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        _log_timing('total', _SCRIPT_STARTED)

    print(f"Saved: {args.output_path}")


def _project_sources(project_dir):
    """记录本次实际导入的本地源码；变更后由宿主重新启动解释器，避免旧模块缓存。"""
    from probe_window_config import _resolve_config_path
    root = os.path.normcase(os.path.abspath(project_dir))
    environments = tuple(os.path.join(root, name) + os.sep for name in ('.venv', 'venv'))
    paths = {_resolve_config_path(project_dir)}
    for loaded in list(sys.modules.values()):
        filename = getattr(loaded, '__file__', None)
        if not filename:
            continue
        filename = os.path.normcase(os.path.abspath(filename))
        # 虚拟环境是解释器依赖，不属于项目源码；避免逐张 stat 数千个第三方库文件。
        if filename.startswith(environments):
            continue
        try:
            if os.path.commonpath((root, filename)) == root:
                paths.add(filename)
        except ValueError:
            pass
    return {filename: _source_signature(filename) for filename in paths if filename}


def _source_signature(filename):
    try:
        stat = os.stat(filename)
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return None


def serve():
    """串行处理截图请求，复用导入和 WGC 会话；每张图读取新帧和当前配置。"""
    global _REUSE_WGC
    _REUSE_WGC = True
    sources = {}
    for line in sys.stdin:
        request = json.loads(line)
        response = {'capture_response': request['id'], 'ok': False}
        if any(_source_signature(filename) != signature for filename, signature in sources.items()):
            _close_wgc_session()
            response['restart'] = True
            print(json.dumps(response), file=_PROTOCOL_STDOUT, flush=True)
            return
        started = time.perf_counter()
        try:
            project_dir = request.get('project_dir')
            processor = load_screenshot_processor(project_dir) if project_dir else None
            _log_timing('load_project_config', started)
            config = request.get('window_config') or {}
            capture(request['output_path'], config.get('exe'), config.get('hwnd_class'),
                    processor=processor, method=request.get('method', 'auto'))
            response['ok'] = True
            if project_dir:
                sources = _project_sources(project_dir)
        except Exception as exc:
            response['error'] = str(exc)
        finally:
            _log_timing('request', started)
        print(json.dumps(response), file=_PROTOCOL_STDOUT, flush=True)
    _close_wgc_session()


if __name__ == "__main__":
    if '--serve' in sys.argv:
        serve()
    else:
        main()

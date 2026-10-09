from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

HOTKEY_ID = 0x4F4B
WM_HOTKEY = 0x0312
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_NOREPEAT = 0x4000
VK_S = 0x53


def main() -> int:
    if sys.platform != "win32":
        print("UNSUPPORTED", flush=True)
        return 3

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    register_hot_key = user32.RegisterHotKey
    register_hot_key.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
    register_hot_key.restype = wintypes.BOOL
    unregister_hot_key = user32.UnregisterHotKey
    unregister_hot_key.argtypes = [wintypes.HWND, ctypes.c_int]
    unregister_hot_key.restype = wintypes.BOOL
    get_message = user32.GetMessageW
    get_message.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    get_message.restype = ctypes.c_int

    modifiers = MOD_CONTROL | MOD_ALT | MOD_NOREPEAT
    if not register_hot_key(None, HOTKEY_ID, modifiers, VK_S):
        print(f"ERROR register_hotkey {ctypes.get_last_error()}", flush=True)
        return 2

    print("READY", flush=True)
    message = wintypes.MSG()
    try:
        while True:
            result = get_message(ctypes.byref(message), None, 0, 0)
            if result == -1:
                print(f"ERROR get_message {ctypes.get_last_error()}", flush=True)
                return 4
            if result == 0:
                return 0
            if message.message == WM_HOTKEY and message.wParam == HOTKEY_ID:
                print("TRIGGER", flush=True)
    finally:
        unregister_hot_key(None, HOTKEY_ID)


if __name__ == "__main__":
    raise SystemExit(main())

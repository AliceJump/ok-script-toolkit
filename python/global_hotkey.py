from __future__ import annotations

import argparse
import ctypes
import sys
import threading
from ctypes import wintypes

HOTKEY_ID = 0x4F4B
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_NOREPEAT = 0x4000
VK_S = 0x53
SYNCHRONIZE = 0x00100000
INFINITE = 0xFFFFFFFF


def start_parent_watch(parent_pid: int, message_thread_id: int, user32: ctypes.WinDLL) -> None:
    if parent_pid <= 0:
        return

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    open_process = kernel32.OpenProcess
    open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    open_process.restype = wintypes.HANDLE
    wait_for_single_object = kernel32.WaitForSingleObject
    wait_for_single_object.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    wait_for_single_object.restype = wintypes.DWORD
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    post_thread_message = user32.PostThreadMessageW
    post_thread_message.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    post_thread_message.restype = wintypes.BOOL

    handle = open_process(SYNCHRONIZE, False, parent_pid)
    if not handle:
        return

    def wait_for_parent() -> None:
        try:
            wait_for_single_object(handle, INFINITE)
            post_thread_message(message_thread_id, WM_QUIT, 0, 0)
        finally:
            close_handle(handle)

    threading.Thread(target=wait_for_parent, name="ok-hotkey-parent-watch", daemon=True).start()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    if sys.platform != "win32":
        print("UNSUPPORTED", flush=True)
        return 3

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    register_hot_key = user32.RegisterHotKey
    register_hot_key.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
    register_hot_key.restype = wintypes.BOOL
    unregister_hot_key = user32.UnregisterHotKey
    unregister_hot_key.argtypes = [wintypes.HWND, ctypes.c_int]
    unregister_hot_key.restype = wintypes.BOOL
    get_message = user32.GetMessageW
    get_message.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    get_message.restype = ctypes.c_int
    get_current_thread_id = kernel32.GetCurrentThreadId
    get_current_thread_id.restype = wintypes.DWORD

    modifiers = MOD_CONTROL | MOD_ALT | MOD_NOREPEAT
    if not register_hot_key(None, HOTKEY_ID, modifiers, VK_S):
        print(f"ERROR register_hotkey {ctypes.get_last_error()}", flush=True)
        return 2

    start_parent_watch(args.parent_pid, get_current_thread_id(), user32)
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

"""Read the IDE's command pipe without blocking Windows runtime startup."""

import codecs
import os


def _windows_pipe_reader(stream):
    """Return available bytes, b'' when idle, or None at EOF for a Windows pipe.

    Blocking TextIO/FileIO reads on Windows can retain a CRT file lock while
    native libraries initialize new threads. Only read bytes already present in
    the IDE's pipe; waiting for commands must not keep that lock held.
    """
    if os.name != "nt":
        return None
    try:
        fd = stream.fileno()
    except (AttributeError, OSError, ValueError):
        return None

    import ctypes
    from ctypes import wintypes
    import msvcrt

    handle = msvcrt.get_osfhandle(fd)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetFileType.argtypes = (wintypes.HANDLE,)
    kernel.GetFileType.restype = wintypes.DWORD
    if kernel.GetFileType(handle) != 3:  # FILE_TYPE_PIPE
        return None
    kernel.PeekNamedPipe.argtypes = (
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    )
    kernel.PeekNamedPipe.restype = wintypes.BOOL

    def read_available():
        available = wintypes.DWORD()
        if not kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
            error = ctypes.get_last_error()
            if error in (109, 232, 233):  # pipe closed/disconnected
                return None
            raise ctypes.WinError(error)
        if not available.value:
            return b""
        return os.read(fd, min(available.value, 65536)) or None

    return read_available


def iter_command_lines(stream, cancel):
    """Yield complete commands, retaining split UTF-8 characters and CRLF lines."""
    read_available = _windows_pipe_reader(stream)
    if read_available is None:
        for line in stream:
            if cancel.is_set():
                return
            yield line
        return

    decoder = codecs.getincrementaldecoder(stream.encoding or "utf-8")()
    pending = ""
    while not cancel.is_set():
        chunk = read_available()
        if chunk is None:
            pending += decoder.decode(b"", final=True)
            if pending:
                yield pending
            return
        if not chunk:
            cancel.wait(0.025)
            continue
        pending += decoder.decode(chunk)
        while "\n" in pending and not cancel.is_set():
            line, pending = pending.split("\n", 1)
            yield line.rstrip("\r") + "\n"

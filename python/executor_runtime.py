"""Adapt the framework's runtime lifecycle to the IDE's process protocol."""

import threading
import time


def start_framework_runtime(ok, cancel=None, timeout=None):
    """Initialize project services and connect through the native controller once.

    ``start_runtime`` owns startup events, overlays and device discovery. It may
    already schedule the controller because of the project's automatic startup
    setting or CLI task. Observe that request rather than starting twice. When
    automatic startup is off, starting the IDE executor corresponds to pressing
    Start in the project's UI, after runtime initialization.

    Run bootstrap on a thread created before project services import native
    libraries. The protocol owner remains responsive to cancellation and timeout,
    even if a project startup subscriber or device backend stops responding.
    """
    runtime_start = getattr(ok, "start_runtime", None)
    if not callable(runtime_start):
        raise RuntimeError("ok-script start_runtime API is unavailable; update ok-script")
    if ok.exit_event.is_set() or (cancel is not None and cancel.is_set()):
        return False

    controller = ok.headless_app.start_controller
    original_start = controller.start
    original_do_start = controller.do_start
    requested = threading.Event()
    runtime_done = threading.Event()
    controller_done = threading.Event()
    outcome = {}

    def observe_start(*args, **kwargs):
        requested.set()
        return original_start(*args, **kwargs)

    def observe_do_start(*args, **kwargs):
        try:
            outcome["started"] = bool(original_do_start(*args, **kwargs))
            return outcome["started"]
        except Exception as error:
            outcome["error"] = error
            raise
        finally:
            controller_done.set()

    def bootstrap():
        try:
            if cancel is not None and cancel.is_set():
                return
            runtime_start()
            if (not requested.is_set() and not ok.exit_event.is_set()
                    and not (cancel is not None and cancel.is_set())):
                controller.start()
        except Exception as error:
            outcome["error"] = error
        finally:
            runtime_done.set()

    controller.start = observe_start
    controller.do_start = observe_do_start
    if timeout is None:
        timeout = float(ok.config.get("start_timeout", 60)) + 15
    deadline = time.monotonic() + timeout
    try:
        threading.Thread(target=bootstrap, name="ok-toolkit-runtime", daemon=True).start()
        while True:
            if cancel is not None and cancel.is_set():
                return False
            if ok.exit_event.is_set():
                return False
            if "error" in outcome:
                raise outcome["error"]
            if runtime_done.is_set() and controller_done.is_set():
                return outcome.get("started", False)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                stage = "runtime" if not runtime_done.is_set() else "device/controller"
                raise TimeoutError(f"ok-script startup timed out at {stage}")
            controller_done.wait(min(0.1, remaining))
            if controller_done.is_set() and not runtime_done.is_set():
                runtime_done.wait(min(0.1, remaining))
    finally:
        controller.start = original_start
        controller.do_start = original_do_start


def copy_config_containers(value):
    """Copy mutable declarations while retaining classes, callbacks and options."""
    if type(value) is dict:
        return {key: copy_config_containers(item) for key, item in value.items()}
    if type(value) is list:
        return [copy_config_containers(item) for item in value]
    if type(value) is tuple:
        return tuple(copy_config_containers(item) for item in value)
    return value

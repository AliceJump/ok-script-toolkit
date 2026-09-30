"""Regression coverage for project services, native autostart and startup failure."""

import os
import sys
import threading
import unittest
from concurrent.futures import Future
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from executor_runtime import copy_config_containers, start_framework_runtime


class ProjectRuntime:
    """A service-dependent task like NTE's OpenVINO-backed auto combat."""

    def __init__(self, automatic=False, cli_task=False):
        self.events = []
        self.model = Future()
        self.config = {"start_timeout": 1}
        self.exit_event = threading.Event()
        self.automatic = automatic
        self.cli_task = cli_task
        self.controller_calls = []
        self.worker = None
        self.headless_app = SimpleNamespace(start_controller=SimpleNamespace(
            start=self.schedule, do_start=self.connect,
        ))

    def start_runtime(self):
        self.events.append("initialize_overlay")
        self.events.append("start_success")
        self.model.set_result("detector")
        if self.automatic or self.cli_task:
            self.headless_app.start_controller.start(3 if self.cli_task else None)
        else:
            self.events.append("refresh_devices")

    def schedule(self, task=None):
        self.controller_calls.append(task)
        self.worker = threading.Thread(
            target=lambda: self.headless_app.start_controller.do_start(task), daemon=True,
        )
        self.worker.start()

    def connect(self, task=None):
        self.events.append("connect_device")
        # The old executor called do_start directly. Without runtime startup,
        # this Future never completes, even if capture and sound input work.
        self.events.append(self.model.result(timeout=0.1))
        self.events.append("combat_task")
        return True


class LifecycleTests(unittest.TestCase):
    def test_model_service_precedes_task_and_core_refresh_is_preserved(self):
        runtime = ProjectRuntime()
        self.assertTrue(start_framework_runtime(runtime))
        self.assertEqual(runtime.controller_calls, [None])
        self.assertEqual(runtime.events, [
            "initialize_overlay", "start_success", "refresh_devices",
            "connect_device", "detector", "combat_task",
        ])

    def test_old_shortcut_blocks_on_the_unstarted_project_model(self):
        runtime = ProjectRuntime()
        with self.assertRaises(TimeoutError):
            runtime.connect()
        self.assertFalse(runtime.model.done())

    def test_framework_autostart_and_cli_task_are_not_started_twice(self):
        for kwargs, expected in (({"automatic": True}, None), ({"cli_task": True}, 3)):
            with self.subTest(kwargs=kwargs):
                runtime = ProjectRuntime(**kwargs)
                original_start = runtime.headless_app.start_controller.start
                original_do_start = runtime.headless_app.start_controller.do_start
                self.assertTrue(start_framework_runtime(runtime))
                self.assertEqual(runtime.controller_calls, [expected])
                self.assertEqual(runtime.events.count("start_success"), 1)
                self.assertEqual(runtime.headless_app.start_controller.start, original_start)
                self.assertEqual(runtime.headless_app.start_controller.do_start, original_do_start)

    def test_project_service_failure_is_reported_before_starting_tasks(self):
        runtime = ProjectRuntime()
        def fail():
            raise RuntimeError("project model failed")
        runtime.start_runtime = fail
        with self.assertRaisesRegex(RuntimeError, "project model failed"):
            start_framework_runtime(runtime)
        self.assertEqual(runtime.controller_calls, [])

    def test_failed_connection_is_not_ready(self):
        runtime = ProjectRuntime()
        runtime.headless_app.start_controller.do_start = lambda task=None: False
        self.assertFalse(start_framework_runtime(runtime))

    def test_blocked_backend_times_out_and_can_be_cancelled(self):
        for cancel_first in (False, True):
            with self.subTest(cancel=cancel_first):
                runtime = ProjectRuntime()
                release = threading.Event()
                runtime.headless_app.start_controller.do_start = lambda task=None: release.wait(2)
                cancel = threading.Event()
                if cancel_first:
                    cancel.set()
                try:
                    if cancel_first:
                        self.assertFalse(start_framework_runtime(runtime, cancel=cancel, timeout=0.1))
                    else:
                        with self.assertRaisesRegex(TimeoutError, "device/controller"):
                            start_framework_runtime(runtime, timeout=0.1)
                finally:
                    release.set()
                    if runtime.worker:
                        runtime.worker.join(2)

    def test_blocked_startup_subscriber_times_out(self):
        runtime = ProjectRuntime()
        release = threading.Event()
        runtime.start_runtime = lambda: release.wait(2)
        try:
            with self.assertRaisesRegex(TimeoutError, "at runtime"):
                start_framework_runtime(runtime, timeout=0.1)
        finally:
            runtime.exit_event.set()
            release.set()

    def test_missing_runtime_api_reports_an_error(self):
        runtime = ProjectRuntime()
        runtime.start_runtime = None
        with self.assertRaisesRegex(RuntimeError, "start_runtime API"):
            start_framework_runtime(runtime)

    def test_launched_game_can_finish_two_native_waits_within_their_budgets(self):
        for start_exe in (True, False):
            with self.subTest(start_exe=start_exe):
                runtime = ProjectRuntime()
                runtime.config = {"start_timeout": 60, "windows": {"start_exe": start_exe}}
                entered = threading.Event()
                release = threading.Event()
                def connect(task=None):
                    entered.set()
                    return release.wait(2)
                runtime.headless_app.start_controller.do_start = connect
                calls = 0
                timer = None
                def after_two_waits():
                    nonlocal calls, timer
                    calls += 1
                    if calls == 1:
                        return 0
                    self.assertTrue(entered.wait(1))
                    if timer is None:
                        timer = threading.Timer(0.05, release.set)
                        timer.start()
                    # Window ready after 50 seconds, capture ready after 40 more.
                    return 90
                try:
                    with patch("executor_runtime.time", SimpleNamespace(monotonic=after_two_waits)):
                        if start_exe:
                            self.assertTrue(start_framework_runtime(runtime))
                        else:
                            with self.assertRaises(TimeoutError):
                                start_framework_runtime(runtime)
                finally:
                    release.set()
                    if timer is not None:
                        timer.cancel()
                        timer.join(2)
                    if runtime.worker:
                        runtime.worker.join(2)

    def test_config_copy_preserves_project_declarations_and_callable_objects(self):
        callback = lambda: None
        option = SimpleNamespace(name="Hotkeys")
        project = {"gui": {"type": "qt"}, "windows": {"capture_method": ["WGC"]},
                   "scene": ("scene", "Scene"), "callback": callback, "global_configs": [option]}
        runtime = copy_config_containers(project)
        runtime["windows"]["capture_method"].append("BitBlt")
        runtime["gui"]["type"] = "headless"
        self.assertEqual(project["windows"]["capture_method"], ["WGC"])
        self.assertEqual(project["gui"]["type"], "qt")
        self.assertIs(runtime["callback"], callback)
        self.assertIs(runtime["global_configs"][0], option)


if __name__ == "__main__":
    unittest.main()

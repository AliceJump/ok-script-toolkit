"""Exercise the entry point's import boundary and command/readiness ordering."""

import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import threading
from contextlib import ExitStack, redirect_stdout
from types import ModuleType, SimpleNamespace
from unittest.mock import patch
import unittest

from _test_tmp import make_tmp_tempdir

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("executor_session_test", ROOT / "run_executor.py")
executor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor)


class SessionTests(unittest.TestCase):
    def test_import_time_configs_and_commands_use_initialized_isolated_runtime(self):
        with make_tmp_tempdir("ok-executor-session") as tmp:
            project = Path(tmp) / "project"
            source = project / "settings-data"
            source.mkdir(parents=True)
            (project / "src").mkdir()
            (source / "Early.json").write_text('{"value": "project"}', encoding="utf-8")
            (source / "Global.json").write_text('{"value": "global-project"}', encoding="utf-8")
            module_name = "executor_session_fixture"
            declaration = (
                "from ok.util.config import Config\n"
                "early = Config('Early', {'value': 'default'})\n"
                "global_value = Config('Global', {'value': 'global-default'})\n"
                "config = {'config_folder': 'settings-data', 'gui': {'type': 'qt'}, "
                "'windows': {'capture_method': ['WGC']}}\n"
            )
            (project / "src" / "config.py").write_text(declaration, encoding="utf-8")
            (project / (module_name + ".py")).write_text(declaration, encoding="utf-8")
            before = {p.name: p.read_bytes() for p in source.iterdir()}
            events = []
            commands = []
            instances = []

            file_module = ModuleType("ok.util.file")
            config_module = ModuleType("ok.util.config")
            file_module.get_relative_path = lambda *parts: os.path.join(os.getcwd(), *parts)
            file_module.read_json_file = lambda name: json.loads(Path(name).read_text(encoding="utf-8"))
            config_module.get_relative_path = file_module.get_relative_path

            class Config(dict):
                config_folder = "configs"
                def __init__(self, name, defaults):
                    self.config_file = config_module.get_relative_path(self.config_folder, name + ".json")
                    super().__init__(defaults)
                    if Path(self.config_file).exists():
                        self.update(file_module.read_json_file(self.config_file))
                def save_file(self):
                    Path(self.config_file).write_text(json.dumps(self), encoding="utf-8")
            config_module.Config = Config

            class NativeController:
                def start(self):
                    threading.Thread(target=lambda: self.do_start(None), daemon=True).start()
                def do_start(self, task):
                    events.append("native-controller")
                    return True

            class OK:
                def __init__(self, config):
                    instances.append(self)
                    self.config = config
                    self.exit_event = threading.Event()
                    self.task_executor = SimpleNamespace(
                        paused=False, current_task=None, trigger_tasks=[], onetime_tasks=[],
                        onetime_task_queue=[], get_all_tasks=lambda: [],
                    )
                    self.device_manager = SimpleNamespace()
                    self.headless_app = SimpleNamespace(start_controller=NativeController(), ok_config={})
                    self.headless_app.set_overlay_setting = lambda *args: None
                    modules["ok"].og = SimpleNamespace(app=self.headless_app)
                    events.append("framework-init")
                    config["windows"]["capture_method"].append("native-choice")
                def start_runtime(self):
                    events.append("native-runtime")
                    fixture = sys.modules[module_name]
                    if fixture.early["value"] != "project":
                        raise AssertionError("import-time baseline was replaced by defaults")
                    if fixture.global_value["value"] != "plugin-global":
                        raise AssertionError("global snapshot was not ready before imports")
                    self.argv = sys.argv[:]
            modules = {name: ModuleType(name) for name in ("ok", "ok.util", "task_visibility")}
            modules.update({"ok.util.file": file_module, "ok.util.config": config_module})
            modules["ok"].OK = OK
            modules["task_visibility"].install_all_registered_tasks = lambda locale: None

            def reader(inbox, cancel):
                # A host can send an update while connecting. It must be applied
                # only after the framework and its controller have completed.
                inbox.put("params {}")
            def handle(instance, line):
                commands.append(line)
                events.append("command")
                self.assertIn("native-runtime", events)
                self.assertIn("native-controller", events)
                self.assertIn(executor.MARKER_READY, events)
                instance.exit_event.set()

            with ExitStack() as stack:
                saved_cwd = os.getcwd()
                stack.callback(os.chdir, saved_cwd)
                os.chdir(project)
                stack.enter_context(patch.dict(sys.modules, modules))
                stack.callback(sys.modules.pop, module_name, None)
                stack.enter_context(patch.dict(os.environ, {
                    "OK_TOOLKIT_RUN_DIR": str(Path(tmp) / "sandbox"),
                    "OK_TOOLKIT_TRIGGERS": "[]",
                    "OK_TOOLKIT_USE_OVERLAY": "0",
                    "OK_TOOLKIT_GCONFIG": '{"Global": {"value": "plugin-global"}}',
                }))
                stack.enter_context(patch.object(sys, "argv", ["plugin-helper.py", "--config-module", module_name]))
                for member in ("install_override_patch", "install_trigger_persistence_patch",
                               "install_override_save_patch", "install_project_startup_patches"):
                    stack.enter_context(patch.object(executor, member))
                stack.enter_context(patch.object(executor, "start_stdin_listener", reader))
                stack.enter_context(patch.object(executor, "handle_command", handle))
                stack.enter_context(patch.object(executor, "_emit", events.append))
                stack.enter_context(patch.object(executor, "shutdown", side_effect=SystemExit))
                stack.enter_context(redirect_stdout(io.StringIO()))
                with self.assertRaises(SystemExit):
                    executor.main()
                self.assertEqual(commands, ["params {}"])
                self.assertEqual(instances[0].argv, [str(project / "main.py"), "--headless"])
                self.assertEqual(sys.argv[0], "plugin-helper.py")
                self.assertEqual(sys.modules[module_name].config["gui"], {"type": "qt"})
                self.assertEqual(sys.modules[module_name].config["windows"]["capture_method"], ["WGC"])
            self.assertEqual(before, {p.name: p.read_bytes() for p in source.iterdir()})

    def test_import_failure_is_structured_and_never_reports_ready(self):
        with make_tmp_tempdir("ok-executor-session") as tmp, ExitStack() as stack:
            saved_cwd = os.getcwd()
            stack.callback(os.chdir, saved_cwd)
            os.chdir(tmp)
            stack.enter_context(patch.dict(os.environ, {"OK_TOOLKIT_RUN_DIR": str(Path(tmp) / "sandbox")}))
            stack.enter_context(patch.object(sys, "argv", ["plugin-helper.py"]))
            stack.enter_context(patch.object(executor, "install_config_path_patch", side_effect=ImportError("broken framework")))
            output = []
            stack.enter_context(patch.object(executor, "_emit", output.append))
            shutdown = stack.enter_context(patch.object(executor, "shutdown", side_effect=SystemExit))
            with self.assertRaises(SystemExit):
                executor.main()
            self.assertTrue(any(line.startswith(executor.MARKER_ERROR) for line in output))
            self.assertNotIn(executor.MARKER_READY, output)
            self.assertEqual(shutdown.call_args.args, (None, 1))


if __name__ == "__main__":
    unittest.main()

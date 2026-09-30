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
        self.run_session()

    def test_computed_folder_is_seeded_before_import_and_overlay_is_initialized_once(self):
        self.run_session(
            folder=os.path.join("settings", "runtime"),
            prefix="import os\nbase = 'settings'\n",
            expression="os.path.join(base, 'runtime')",
            overlay=True,
        )

    def test_runtime_only_folder_is_reconciled_before_framework_construction(self):
        self.run_session(
            folder="runtime-settings",
            prefix="def config_dir():\n    return 'runtime-settings'\n",
            expression="config_dir()",
            import_time=False,
        )

    def test_runtime_folder_is_isolated_before_import_time_config_writes(self):
        self.run_session(
            folder="runtime-settings",
            prefix="def config_dir():\n    return 'runtime-settings'\n",
            expression="config_dir()",
            explicit_folder=True,
        )

    def test_later_variable_reassignment_does_not_change_captured_config_folder(self):
        self.run_session(
            prefix="CONFIG_DIR = 'settings-data'\n",
            expression="CONFIG_DIR",
            suffix="CONFIG_DIR = 'later-settings'\n",
            explicit_folder=True,
        )

    def test_prerequisite_hook_runs_before_framework_import(self):
        self.run_session(pre_hook=True)

    def run_session(self, *, folder="settings-data", prefix="", expression="'settings-data'",
                    import_time=True, overlay=False, explicit_folder=False, suffix="", pre_hook=False):
        with make_tmp_tempdir("ok-executor-session") as tmp:
            project = Path(tmp) / "project"
            source = project / folder
            source.mkdir(parents=True)
            (project / "src").mkdir()
            (source / "Early.json").write_text('{"value": "project"}', encoding="utf-8")
            (source / "Global.json").write_text('{"value": "global-project"}', encoding="utf-8")
            module_name = "executor_session_fixture"
            config_declaration = (
                f"config = {{'config_folder': {expression}, 'gui': {{'type': 'qt'}}, "
                "'windows': {'capture_method': ['WGC']}}\n"
            )
            folder_argument = ", folder=config['config_folder']" if explicit_folder else ""
            early_declaration = (
                f"early = Config('Early', {{'value': 'default', 'added': True}}{folder_argument})\n"
                f"global_value = Config('Global', {{'value': 'global-default'}}{folder_argument})\n"
                if import_time else ""
            )
            declaration = (
                prefix + "from ok.util.config import Config\n"
                "from ok.util.file import get_relative_path\n" +
                (config_declaration + early_declaration if explicit_folder else
                 early_declaration + config_declaration) + suffix
            )
            # The selected module must win over the conventional src.config.
            (project / "src" / "config.py").write_text(
                "config = {'config_folder': 'wrong-folder'}\n", encoding="utf-8",
            )
            (project / (module_name + ".py")).write_text(declaration, encoding="utf-8")
            if pre_hook:
                (project / "executor_prerequisite.py").write_text(
                    "import os\ndef prepare():\n    os.environ['OK_TEST_PREPARED'] = '1'\n",
                    encoding="utf-8",
                )
                (project / "ok-script-toolkit.json").write_text(json.dumps({
                    "executor": {"startupHooks": {"beforeConfigImport": ["executor_prerequisite:prepare"]}},
                }), encoding="utf-8")
            before = {p.name: p.read_bytes() for p in source.iterdir()}
            events = []
            commands = []
            instances = []
            overlay_settings = []

            file_module = ModuleType("ok.util.file")
            config_module = ModuleType("ok.util.config")
            file_module.get_relative_path = lambda *parts: os.path.join(os.getcwd(), *parts)
            file_module.read_json_file = lambda name: json.loads(Path(name).read_text(encoding="utf-8"))
            config_module.get_relative_path = file_module.get_relative_path

            class Config(dict):
                config_folder = "configs"
                def __init__(self, name, defaults, folder=None):
                    self.config_file = config_module.get_relative_path(
                        self.config_folder if folder is None else folder, name + ".json",
                    )
                    super().__init__(defaults)
                    if Path(self.config_file).exists():
                        self.update(file_module.read_json_file(self.config_file))
                    self.save_file()
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
                    self.headless_app.set_overlay_setting = lambda *args: overlay_settings.append(args)
                    self.headless_app.sync_overlay_source = lambda: events.append("overlay-sync")
                    modules["ok"].og = SimpleNamespace(app=self.headless_app)
                    fixture = sys.modules[module_name]
                    self.early = fixture.early if import_time else Config('Early', {'value': 'default', 'added': True})
                    self.global_value = fixture.global_value if import_time else Config('Global', {'value': 'global-default'})
                    self.store_path = fixture.get_relative_path(fixture.config["config_folder"], "Early.json")
                    events.append("framework-init")
                    config["windows"]["capture_method"].append("native-choice")
                def start_runtime(self):
                    events.append("native-runtime")
                    if self.early["value"] != "project":
                        raise AssertionError("import-time baseline was replaced by defaults")
                    if self.global_value["value"] != "plugin-global":
                        raise AssertionError("global snapshot was not ready before imports")
                    if not file_module.read_json_file(self.early.config_file).get("added"):
                        raise AssertionError("reconciliation overwrote an import-time config migration")
                    self.early["value"] = "plugin-write"
                    self.early.save_file()
                    if self.headless_app.ok_config["use_overlay"]:
                        events.append("native-overlay")
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
                stack.callback(sys.modules.pop, "executor_prerequisite", None)
                stack.enter_context(patch.dict(os.environ, {
                    "OK_TOOLKIT_RUN_DIR": str(Path(tmp) / "sandbox"),
                    "OK_TOOLKIT_TRIGGERS": "[]",
                    "OK_TOOLKIT_USE_OVERLAY": "1" if overlay else "0",
                    "OK_TOOLKIT_GCONFIG": '{"Global": {"value": "plugin-global"}}',
                    "OK_TEST_PREPARED": "",
                }))
                if pre_hook:
                    original_install = executor.install_config_path_patch
                    def prerequisite_framework_import(*args):
                        if os.environ.get("OK_TEST_PREPARED") != "1":
                            raise ImportError("framework import requires the prerequisite environment")
                        return original_install(*args)
                    stack.enter_context(patch.object(executor, "install_config_path_patch", prerequisite_framework_import))
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
                self.assertIn(executor.MARKER_READY, events)
                self.assertEqual(commands, ["params {}"])
                self.assertEqual(overlay_settings, [])
                self.assertEqual(events.count("native-overlay"), int(overlay))
                self.assertEqual(events.count("overlay-sync"), 1)
                self.assertLess(events.index("native-controller"), events.index("overlay-sync"))
                self.assertLess(events.index("overlay-sync"), events.index(executor.MARKER_READY))
                self.assertIn(executor.MARKER_OVERLAY_ON if overlay else executor.MARKER_OVERLAY_OFF, events)
                self.assertEqual(Path(instances[0].store_path), Path(tmp) / "sandbox" / "configs" / "Early.json")
                self.assertEqual(instances[0].argv, [str(project / "main.py"), "--headless"])
                self.assertEqual(sys.argv[0], "plugin-helper.py")
                self.assertEqual(sys.modules[module_name].config["gui"], {"type": "qt"})
                self.assertEqual(sys.modules[module_name].config["windows"]["capture_method"], ["WGC"])
            self.assertEqual(before, {p.name: p.read_bytes() for p in source.iterdir()})

    def test_overlay_commands_still_apply_the_setting_after_startup(self):
        app = SimpleNamespace(set_overlay_setting=lambda *args: settings.append(args))
        settings = []
        modules = {"ok": SimpleNamespace(og=SimpleNamespace(app=app))}
        with patch.dict(sys.modules, modules), patch.object(executor, "_emit") as emit:
            executor._set_overlay(True)
            executor._set_overlay(False)
        self.assertEqual(settings, [("boxes", True), ("boxes", False)])
        self.assertEqual([call.args[0] for call in emit.call_args_list], [
            executor.MARKER_OVERLAY_ON, executor.MARKER_OVERLAY_OFF,
        ])

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

# -*- coding: utf-8 -*-
"""The schema probe and account gateway share one project/store resolver."""

import os
import sys
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _test_tmp import make_tmp_tempdir  # noqa: E402
from project_runtime import (  # noqa: E402
    RUN_DIR_ENV,
    account_store_modules,
    detect_config_folder,
    load_account_store_module,
)
import account_store  # noqa: E402


def write(path, contents):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as stream:
        stream.write(contents)


with make_tmp_tempdir("ok-project-runtime") as root:
    write(os.path.join(root, "src", "config.py"), "config = {'config_folder': 'settings-data'}\n")
    assert detect_config_folder(root) == "settings-data"

    custom = os.path.join(root, "src", "tasks", "custom", "account_scope_store.py")
    write(custom, "def load_overrides():\n    return {}\n\ndef set_account_task_overrides(*args):\n    pass\n")
    candidates = account_store_modules(root)
    assert candidates[:2] == [
        "src.tasks.account.account_scope_store", "src.tasks.account_scope_store",
    ]
    assert "src.tasks.custom.account_scope_store" in candidates
    loaded = load_account_store_module(root)
    assert os.path.samefile(loaded.__file__, custom)

with make_tmp_tempdir("ok-project-runtime") as root:
    write(os.path.join(root, "config.py"), "config = {'config_folder': 'root-data'}\n")
    assert detect_config_folder(root) == "root-data"

with make_tmp_tempdir("ok-project-runtime") as root:
    write(os.path.join(root, "src", "config.py"), "config = {'config_folder': 'wrong-folder'}\n")
    write(os.path.join(root, "custom", "settings.py"), (
        "import os\n"
        "base = 'settings'\n"
        "config = {'config_folder': os.path.join(base, 'runtime')}\n"
        "raise RuntimeError('config discovery must not import the project')\n"
    ))
    assert detect_config_folder(root, "custom.settings") == os.path.join("settings", "runtime")
    assert detect_config_folder(root, "missing.settings") == "configs"
    write(os.path.join(root, "package_config", "__init__.py"), "config = {'config_folder': 'package-data'}\n")
    assert detect_config_folder(root, "package_config") == "package-data"

with make_tmp_tempdir("ok-project-runtime") as root:
    write(os.path.join(root, "config.py"), (
        "CONFIG_DIR = 'settings-data'\n"
        "config = {'config_folder': CONFIG_DIR}\n"
        "CONFIG_DIR = 'later-settings'\n"
    ))
    assert detect_config_folder(root, "config") == "settings-data"

with make_tmp_tempdir("ok-project-runtime") as root:
    write(os.path.join(root, "src", "config.py"), "config = {'config_folder': missing_name}\n")
    assert detect_config_folder(root) == "configs"

with make_tmp_tempdir("ok-project-runtime") as root:
    sandbox = os.path.join(root, ".idea", "ok-script-toolkit")
    output = StringIO()
    fake_store = SimpleNamespace(load_overrides=lambda: {})
    with (
        patch.dict(os.environ, {RUN_DIR_ENV: sandbox}),
        patch.object(account_store.sys, "argv", ["account_store.py", root, "get"]),
        patch.object(account_store.os, "chdir"),
        patch.object(account_store, "initialize_sandbox_account_file") as initialize,
        patch.object(account_store, "apply_sandbox_redirect") as redirect,
        patch.object(account_store, "load_account_store_module", return_value=fake_store),
        redirect_stdout(output),
    ):
        account_store.main()
    assert initialize.call_args.args == (os.path.abspath(root), sandbox)
    assert redirect.call_args.args == (sandbox,)
    assert '"ok": true' in output.getvalue()

print("Shared project paths and account store discovery: OK")

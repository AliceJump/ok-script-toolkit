# -*- coding: utf-8 -*-
"""Project-level paths and account store discovery shared by both IDE adapters.

The schema probe and the account editor must agree about the project's config
folder and which account store module is writable. Keep that decision here so
the VS Code and JetBrains packages ship one implementation.
"""

import ast
import importlib
import os
import sys


ACCOUNT_STORE_FALLBACK_MODULES = (
    "src.tasks.account.account_scope_store",
    "src.tasks.account_scope_store",
)
RUN_DIR_ENV = "OK_TOOLKIT_RUN_DIR"
LEGACY_RUN_DIR_PARTS = (".vscode", "ok-script-toolkit")


def resolve_run_dir(project_dir):
    """Resolve the host's sandbox, retaining the VS Code fallback for old callers."""
    configured = os.environ.get(RUN_DIR_ENV, "").strip()
    return os.path.abspath(configured) if configured else os.path.join(project_dir, *LEGACY_RUN_DIR_PARTS)


def _config_path_value(node, constants):
    """Resolve strings and path joins without executing project code."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return constants.get(node.id)
    if isinstance(node, ast.Call) and ast.unparse(node.func) == "os.path.join" and not node.keywords:
        parts = [_config_path_value(arg, constants) for arg in node.args]
        if parts and all(isinstance(part, str) for part in parts):
            return os.path.join(*parts)
    return None


def detect_config_folder(project_dir, config_module=None):
    """Read the selected module's config path before importing the project.

    Runtime-only expressions retain the default here; the executor reconciles
    them with the imported config before constructing the framework.
    """
    modules = (config_module,) if config_module else ("src.config", "config")
    for module in modules:
        module_path = os.path.join(project_dir, *module.split("."))
        candidate = module_path + ".py"
        if not os.path.isfile(candidate):
            candidate = os.path.join(module_path, "__init__.py")
        try:
            with open(candidate, encoding="utf-8") as stream:
                tree = ast.parse(stream.read(), filename=candidate)
        except (OSError, SyntaxError):
            continue
        constants = {}
        for node in tree.body:
            if isinstance(node, ast.Assign):
                value = _config_path_value(node.value, constants)
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        constants[target.id] = value
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                if (
                    isinstance(key, ast.Constant)
                    and key.value == "config_folder"
                ):
                    folder = _config_path_value(value, constants)
                    if folder is not None:
                        return folder
    return "configs"


def account_store_modules(project_dir):
    """Find account store modules in the project, retaining the legacy order."""
    names = list(ACCOUNT_STORE_FALLBACK_MODULES)
    source_dir = os.path.join(project_dir, "src")
    if not os.path.isdir(source_dir):
        return names
    for directory, subdirs, files in os.walk(source_dir):
        subdirs[:] = sorted(name for name in subdirs if not name.startswith(".") and name != "__pycache__")
        if "account_scope_store.py" not in files:
            continue
        relative = os.path.relpath(os.path.join(directory, "account_scope_store.py"), project_dir)
        module = ".".join(os.path.splitext(relative)[0].split(os.sep))
        if module not in names:
            names.append(module)
    return names


def load_account_store_module(project_dir):
    """Import the first store exposing the shared read/write interface."""
    root = os.path.realpath(project_dir)
    if root not in sys.path:
        sys.path.insert(0, root)
    errors = []

    def load_candidates(names):
        for name in names:
            try:
                module = importlib.import_module(name)
                module_path = getattr(module, "__file__", None)
                if not module_path or os.path.normcase(os.path.commonpath((root, os.path.realpath(module_path)))) != os.path.normcase(root):
                    raise ImportError("account store is outside the target project")
                if not all(callable(getattr(module, member, None)) for member in (
                    "load_overrides", "set_account_task_overrides",
                )):
                    raise AttributeError("missing account store read/write interface")
                return module
            except Exception as exc:  # noqa: BLE001 - report every candidate to the caller
                errors.append(f"{name}: {type(exc).__name__}: {exc}")
        return None

    found = load_candidates(ACCOUNT_STORE_FALLBACK_MODULES)
    if found is not None:
        return found
    # The common project layouts need no walk. Discover a moved store only if both
    # historical locations fail, keeping account edits responsive in large projects.
    found = load_candidates(account_store_modules(root)[len(ACCOUNT_STORE_FALLBACK_MODULES):])
    if found is not None:
        return found
    raise RuntimeError("account store module not found: " + " | ".join(errors))

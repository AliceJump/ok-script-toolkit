# -*- coding: utf-8 -*-
"""多账户存储的命令行网关：复用项目自己的 account_scope_store 做读写。

宿主（VS Code 插件）不直接写 account_scoped_overrides.json —— 注册表同步、线程锁、
原子写都在 store 里，这里按 CLI 转调，保证写入格式与项目 GUI / 任务运行时零漂移。
必须在项目目录、用项目 Python 运行（store 依赖 ok 包与项目源码）。

存储位置与执行器一致：传 --run-dir 时 get_relative_path("configs") 改道沙箱
（与 run_executor 的 install_config_path_patch 同手法，store 在导入期固定路径，
patch 必须先于 store import）。不传 --run-dir 则读写项目 configs（仅诊断用途）。

用法：
  python account_store.py <project_dir> get --run-dir <run_dir>
  python account_store.py <project_dir> set_list --text <json 字符串> --run-dir <run_dir>
  python account_store.py <project_dir> set_override --account <名> --task <类名> --values <json> --run-dir <run_dir>
  python account_store.py <project_dir> clear_override --account <名> --task <类名> --run-dir <run_dir>

输出（最后一行 JSON）：{"ok": true, ...} / {"ok": false, "error": "..."}
"""
import argparse
import importlib
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# 约定模块路径候选（ok-end-field / ok-gf2 实例；AP 若同构会被第一个候选或后续条目命中）
STORE_MODULES = (
    "src.tasks.account.account_scope_store",
    "src.tasks.account_scope_store",
)


def apply_sandbox_redirect(run_dir: str) -> None:
    """把 get_relative_path("configs", ...) 改道沙箱（必须在 store import 前调用）。

    ok.util.file 一定存在（store 本身依赖它）；ok.util.config 是老版本可能没有的
    副本引用点，缺了就只 patch 主模块（防御性，不让副本 patch 失败拖垮整个 get）。
    """
    import ok.util.file as ok_file

    original = ok_file.get_relative_path
    sandbox_configs = os.path.join(os.path.abspath(run_dir), "configs")

    def patched(*files):
        if files and os.path.normcase(str(files[0])) == "configs":
            return os.path.normpath(os.path.join(sandbox_configs, *files[1:]))
        return original(*files)

    ok_file.get_relative_path = patched
    try:
        import ok.util.config as ok_config
        ok_config.get_relative_path = patched
    except Exception:  # noqa: BLE001 — 副本 patch 失败不影响主路径
        pass


def load_store_module(project_dir: str):
    """逐候选 import 项目的 account_scope_store；全部失败时把每个候选的错误带出来。"""
    sys.path.insert(0, project_dir)
    os.chdir(project_dir)
    errors = []
    for name in STORE_MODULES:
        try:
            return importlib.import_module(name)
        except Exception as e:  # noqa: BLE001 — 逐候选尝试，错误留痕
            errors.append(f"{name}: {type(e).__name__}: {e}")
    raise RuntimeError(
        "account store module not found（项目需有 src/**/account_scope_store.py，且运行 Python "
        "能 import ok 包与项目源码）→ " + " | ".join(errors)
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_dir")
    parser.add_argument("command", choices=["get", "set_list", "set_override", "clear_override"])
    args, extra = parser.parse_known_args()
    kwargs = {}
    for i in range(0, len(extra) - 1, 2):
        kwargs[extra[i].lstrip("-")] = extra[i + 1]
    try:
        # patch 先于 store import：store 在模块导入期就用 get_relative_path 固定路径
        project_dir = args.project_dir
        sys.path.insert(0, project_dir)
        if kwargs.get("run-dir"):
            apply_sandbox_redirect(kwargs["run-dir"])
        store = load_store_module(project_dir)
        if args.command == "get":
            data = store.load_overrides()
            payload = {
                "account_list_text": data.get("account_list_text", ""),
                "registry": data.get("account_registry", {}),
                "accounts": data.get("accounts", {}),
            }
        elif args.command == "set_list":
            store.set_account_list_text(json.loads(kwargs["text"]))
            payload = {"saved": True}
        elif args.command == "set_override":
            store.set_account_task_overrides(
                kwargs["account"], kwargs["task"], json.loads(kwargs.get("values", "{}"))
            )
            payload = {"saved": True}
        else:
            store.remove_account_task_overrides(kwargs["account"], kwargs["task"])
            payload = {"cleared": True}
        print(json.dumps({"ok": True, **payload}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001 — 错误回传给宿主展示
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()

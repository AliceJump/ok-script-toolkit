# -*- coding: utf-8 -*-
"""多账户存储的命令行网关：复用项目自己的 account_scope_store 做读写。

宿主（VS Code 插件）不直接写 account_scoped_overrides.json —— 注册表同步、线程锁、
原子写都在 store 里，这里按 CLI 转调，保证写入格式与项目 GUI / 任务运行时零漂移。
必须在项目目录、用项目 Python 运行（store 依赖 ok 包与项目源码）。

用法：
  python account_store.py <project_dir> get
  python account_store.py <project_dir> set_list --text <json 字符串>
  python account_store.py <project_dir> set_override --account <名> --task <类名> --values <json>
  python account_store.py <project_dir> clear_override --account <名> --task <类名>

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


def load_store_module(project_dir: str):
    sys.path.insert(0, project_dir)
    os.chdir(project_dir)
    last_error = None
    for name in STORE_MODULES:
        try:
            return importlib.import_module(name)
        except Exception as e:  # noqa: BLE001 — 逐候选尝试
            last_error = e
    raise RuntimeError(f"account store module not found: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_dir")
    parser.add_argument("command", choices=["get", "set_list", "set_override", "clear_override"])
    args, extra = parser.parse_known_args()
    kwargs = {}
    for i in range(0, len(extra) - 1, 2):
        kwargs[extra[i].lstrip("-")] = extra[i + 1]
    try:
        store = load_store_module(args.project_dir)
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

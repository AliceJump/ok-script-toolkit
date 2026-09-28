# -*- coding: utf-8 -*-
"""多账户存储的命令行网关：复用项目自己的 account_scope_store 做读写。

宿主（VS Code 插件）不直接写 account_scoped_overrides.json —— 注册表同步、线程锁、
原子写都在 store 里，这里按 CLI 转调，保证写入格式与项目 GUI / 任务运行时零漂移。
必须在项目目录、用项目 Python 运行（store 依赖 ok 包与项目源码）。

存储位置与执行器一致：宿主传 OK_TOOLKIT_RUN_DIR 时 get_relative_path("configs") 改道沙箱
（与 run_executor 的 install_config_path_patch 同手法，store 在导入期固定路径，
patch 必须先于 store import）。沙箱文件缺失时，先从项目声明的 config_folder
复制一次账号文件；后续编辑均以沙箱为准。--run-dir 仍兼容旧调用方；两者都不传
时读写项目文件（仅诊断用途）。

用法：
  python account_store.py <project_dir> get --run-dir <run_dir>
  python account_store.py <project_dir> set_list --text <json 字符串> --run-dir <run_dir>
  python account_store.py <project_dir> set_override --account <名> --task <类名> --values <json> --run-dir <run_dir>
  python account_store.py <project_dir> clear_override --account <名> --task <类名> --run-dir <run_dir>

输出（最后一行 JSON）：{"ok": true, ...} / {"ok": false, "error": "..."}
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

from project_runtime import RUN_DIR_ENV, detect_config_folder, load_account_store_module

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ACCOUNT_FILE = "account_scoped_overrides.json"


def initialize_sandbox_account_file(project_dir: str, run_dir: str) -> None:
    """首次编辑时导入项目账号文件，不覆盖已有沙箱文件。"""
    source_folder = detect_config_folder(project_dir)
    source_configs = (
        source_folder if os.path.isabs(source_folder)
        else os.path.join(project_dir, source_folder)
    )
    source = os.path.join(source_configs, ACCOUNT_FILE)
    target_dir = os.path.join(os.path.abspath(run_dir), "configs")
    target = os.path.join(target_dir, ACCOUNT_FILE)
    if not os.path.isfile(source) or os.path.lexists(target):
        return
    os.makedirs(target_dir, exist_ok=True)
    # 先在目标目录写完整临时文件，再用硬链接的「目标必须不存在」语义发布。
    # 避免和正在运行的执行器/另一宿主同时初始化时相互覆盖或暴露半写入文件。
    fd, temporary = tempfile.mkstemp(prefix=".account-store-", suffix=".tmp", dir=target_dir)
    os.close(fd)
    try:
        shutil.copyfile(source, temporary)
        try:
            os.link(temporary, target)
        except FileExistsError:
            pass
        except OSError:
            # 某些文件系统不支持硬链接；仍用排他创建防止覆盖已有编辑。
            created = False
            try:
                with open(temporary, "rb") as input_file, open(target, "xb") as output_file:
                    created = True
                    shutil.copyfileobj(input_file, output_file)
            except FileExistsError:
                pass
            except Exception:
                if created:
                    os.unlink(target)
                raise
    finally:
        os.unlink(temporary)


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_dir")
    parser.add_argument("command", choices=["get", "set_list", "set_override", "clear_override", "set_map"])
    args, extra = parser.parse_known_args()
    kwargs = {}
    for i in range(0, len(extra) - 1, 2):
        kwargs[extra[i].lstrip("-")] = extra[i + 1]
    try:
        # patch 先于 store import：store 在模块导入期就用 get_relative_path 固定路径
        project_dir = os.path.abspath(args.project_dir)
        sys.path.insert(0, project_dir)
        run_dir = kwargs.get("run-dir") or os.environ.get(RUN_DIR_ENV, "").strip()
        if run_dir:
            initialize_sandbox_account_file(project_dir, run_dir)
            apply_sandbox_redirect(run_dir)
        os.chdir(project_dir)
        store = load_account_store_module(project_dir)
        if args.command == "get":
            data = store.load_overrides()
            payload = {
                "account_list_text": data.get("account_list_text", ""),
                "registry": data.get("account_registry", {}),
                "accounts": data.get("accounts", {}),
                "map_contents": data.get("map_contents", {}),
            }
        elif args.command == "set_list":
            store.set_account_list_text(json.loads(kwargs["text"]))
            payload = {"saved": True}
        elif args.command == "set_override":
            store.set_account_task_overrides(
                kwargs["account"], kwargs["task"], json.loads(kwargs.get("values", "{}"))
            )
            payload = {"saved": True}
        elif args.command == "set_map":
            # 每账号的地图 content（滑索/地图数据），文本经 JSON 传输还原
            store.set_account_map_content(kwargs["account"], json.loads(kwargs["content"]))
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

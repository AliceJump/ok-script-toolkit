# -*- coding: utf-8 -*-
"""全局配置组快照与 gparams 命令的行为测试。

覆盖：apply_global_group_snapshot 的 merge/无 env/坏 JSON/单组失败，
_apply_gparams 的写入/组不存在/坏 payload。
不依赖 ok 框架，可直接跑：python python/tests/test_run_executor_gconfig.py
"""
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

from _test_tmp import make_tmp_tempdir

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("run_executor_under_test", ROOT / "run_executor.py")
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)

failures = []


def check(condition, message):
    if condition:
        print(f"  ok    {message}")
    else:
        print(f"  FAIL  {message}")
        failures.append(message)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def with_env(env_key, env_value, fn=None):
    """临时设置环境变量执行 fn；fn 为 None 时返回装饰器（本测试未用到装饰形态）。"""
    def run_inner():
        saved = os.environ.get(env_key)
        os.environ[env_key] = env_value
        try:
            fn()
        finally:
            if saved is None:
                os.environ.pop(env_key, None)
            else:
                os.environ[env_key] = saved
    if fn is not None:
        run_inner()
        return None
    return run_inner


print("apply_global_group_snapshot")

# ── 1. merge 语义：已有键被覆盖、新键加入、无关键保留 ──
with make_tmp_tempdir("ok-executor-gconfig") as tmp:
    cfg_dir = os.path.join(tmp, "configs")
    write_json(os.path.join(cfg_dir, "Basic Options.json"),
               {"Auto Start Game When App Starts": False, "Trigger Interval": 1})
    with_env("OK_TOOLKIT_GCONFIG", json.dumps(
        {"Basic Options": {"Trigger Interval": 9, "新增键": True}},
        ensure_ascii=False), lambda: mod.apply_global_group_snapshot(cfg_dir))
    print("\n[1] 快照 merge 进沙箱组文件")
    data = read_json(os.path.join(cfg_dir, "Basic Options.json"))
    check(data["Trigger Interval"] == 9, "快照值覆盖项目值")
    check(data["Auto Start Game When App Starts"] is False, "无关键保留")
    check(data["新增键"] is True, "快照新键加入")

# ── 2. 组文件不存在时创建 ──
with make_tmp_tempdir("ok-executor-gconfig") as tmp:
    cfg_dir = os.path.join(tmp, "configs")
    os.makedirs(cfg_dir)
    with_env("OK_TOOLKIT_GCONFIG", json.dumps({"Notification": {"Discord Notification": True}}),
             lambda: mod.apply_global_group_snapshot(cfg_dir))
    print("\n[2] 组文件不存在时创建")
    check(read_json(os.path.join(cfg_dir, "Notification.json")) == {"Discord Notification": True},
          "新组文件以快照内容创建")

# ── 3. 无 env / 坏 JSON / 非 dict / 空快照：全部安静跳过 ──
with make_tmp_tempdir("ok-executor-gconfig") as tmp:
    cfg_dir = os.path.join(tmp, "configs")
    os.makedirs(cfg_dir)
    print("\n[3] 异常输入安静跳过")
    for label, value in [("无 env", None), ("坏 JSON", "{oops"), ("非 dict", "[1,2]"), ("空 dict", "{}")]:
        if value is None:
            os.environ.pop("OK_TOOLKIT_GCONFIG", None)
        else:
            os.environ["OK_TOOLKIT_GCONFIG"] = value
        mod.apply_global_group_snapshot(cfg_dir)
        check(os.listdir(cfg_dir) == [], f"{label}：不产生任何文件")
    os.environ.pop("OK_TOOLKIT_GCONFIG", None)

# ── 4. 单组写入失败不影响其他组 ──
with make_tmp_tempdir("ok-executor-gconfig") as tmp:
    cfg_dir = os.path.join(tmp, "configs")
    os.makedirs(os.path.join(cfg_dir, "坏目录占位.json"))  # 制造同名目录让一组写入失败
    with_env("OK_TOOLKIT_GCONFIG", json.dumps({
        "坏目录占位": {"k": 1},
        "Good Group": {"k": 2}}), lambda: mod.apply_global_group_snapshot(cfg_dir))
    print("\n[4] 单组失败不阻断其他组")
    check(read_json(os.path.join(cfg_dir, "Good Group.json")) == {"k": 2}, "其他组照常写入")

print("_apply_gparams")

# ── 5. 正常写入：走 Config.__setitem__ 语义，并记录触达的组 ──
class FakeConfig(dict):
    def __setitem__(self, key, value):
        dict.__setitem__(self, key, value)
        self.saved = getattr(self, "saved", 0) + 1


class FakeGlobalConfig:
    def __init__(self):
        self.configs = {}

    def get_config(self, name):
        if name == "Ghost Group":
            raise RuntimeError("Can not find global config Ghost Group")
        return self.configs.setdefault(name, FakeConfig())


executor = SimpleNamespace(global_config=FakeGlobalConfig())
mod._apply_gparams(executor, json.dumps({
    "Basic Options": {"Trigger Interval": 9},
    "Notification": {"SMTP Port": 465}}, ensure_ascii=False))
print("\n[5] gparams 正常写入")
check(dict(executor.global_config.configs["Basic Options"]) == {"Trigger Interval": 9},
      "组内键写入内存配置")
check(executor.global_config.configs["Notification"]["SMTP Port"] == 465, "多组依序写入")
check(executor.global_config.configs["Basic Options"].saved == 1, "写入走 __setitem__（落沙箱语义）")

# ── 6. 组不存在 / 坏 payload：raise（由 handle_command 转 MARKER_ERROR）──
print("\n[6] 异常路径")
try:
    mod._apply_gparams(executor, json.dumps({"Ghost Group": {"k": 1}}))
    check(False, "组不存在应 raise")
except RuntimeError:
    check(True, "组不存在 raise RuntimeError")
try:
    mod._apply_gparams(executor, "{oops")
    check(False, "坏 JSON 应 raise")
except ValueError:
    check(True, "坏 JSON raise ValueError")
try:
    mod._apply_gparams(executor, json.dumps({"Basic Options": [1, 2]}))
    check(False, "组 payload 非 dict 应 raise")
except ValueError:
    check(True, "组 payload 非 dict raise ValueError")

print("\n" + ("全部通过" if not failures else f"失败 {len(failures)} 项"))
sys.exit(1 if failures else 0)

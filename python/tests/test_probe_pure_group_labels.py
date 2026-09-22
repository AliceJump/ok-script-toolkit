# -*- coding: utf-8 -*-
"""probe_task_schemas.find_pure_group_labels 的回归测试。

背景：ok-gf2 的「自主循环跳过项」是纯分组标签 —— 它只作为
`default_config_group` 的键存在，自身不在 `default_config` 里。
但 `_init_default_config_group` 会把每个分组名也写进 `config_type`
（`{'sub_configs': {True: [...]}}`），于是它带着 type 元数据混进了字段列表。
前端 `buildField` 取不到值会落到 `buildText` 兜底分支，凭空渲染一个输入框。

跑法：python python/tests/test_probe_pure_group_labels.py
"""
import os
import sys
import tempfile
from unittest.mock import patch

# 测试放在 tests/ 子目录，被测脚本在上一级 python/。加 .. 而不是 .，
# 这样测试文件不会被随插件发布的 `python/*.py` 通配打包收进去。
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

from probe_task_schemas import collect_multi_account, find_pure_group_labels  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
        print(f"  FAIL  {message}")
    else:
        print(f"  ok    {message}")


print("find_pure_group_labels")

# 1) 真实的 ok-gf2 形状：「自主循环跳过项」只在分组里，不在 default_config。
print("\n[1] ok-gf2 真实形状")
groups = {
    "社区每日": ["用户名", "密码"],
    "活动自律": ["当前物资关卡名称"],
    "活动层": ["喝水", "吃饭"],
    "公共区/调度室": ["自主循环"],
    "自主循环跳过项": ["自动刷体力", "刷钱本", "竞技场"],
    "购买免费礼包": ["商店心愿单购买"],
    "自动刷体力": ["体力本"],
    "班组": ["尘烟"],
}
default_config = {
    "已确认启用游戏内全局自动功能": False,
    "当前物资关卡名称": "铸碑者的黎明",
    "体力本": "军备解析",
    "用户名": "",
    "密码": "",
    "喝水": "1.087-1.4-0.5",
    "吃饭": "1.0",
    "社区每日": False,
    "邮件": True,
    "活动自律": True,
    "活动层": True,
    "公共区/调度室": True,
    "自主循环": False,
    "购买免费礼包": True,
    "商店心愿单购买": True,
    "自动刷体力": True,
    "刷钱本": False,
    "竞技场": True,
    "班组": True,
    "尘烟": True,
}
pure = find_pure_group_labels(groups, default_config, {})
check(
    pure == {"自主循环跳过项"},
    f"只把「自主循环跳过项」判为纯标签，实际={sorted(pure)}",
)
for kept in ("活动层", "班组", "活动自律", "公共区/调度室", "自动刷体力", "社区每日", "购买免费礼包"):
    check(kept not in pure, f"有真实默认值的分组「{kept}」必须保留为字段")

# 2) 运行期 config 里有值 → 即使 default_config 没有也不算纯标签。
print("\n[2] 运行期 config 提供了值")
pure = find_pure_group_labels(groups, default_config, {"自主循环跳过项": True})
check(pure == set(), f"运行期有值时不再过滤，实际={sorted(pure)}")

# 3) 分组名与 default_config 完全不重叠（TestTask 那种极端情况）。
print("\n[3] 分组名全部无值")
pure = find_pure_group_labels(groups, {}, {})
check(pure == set(groups), f"全部无值时应全部判为纯标签，实际={sorted(pure)}")

# 4) 边界：空分组 / 空配置。
print("\n[4] 边界情况")
check(find_pure_group_labels({}, default_config, {}) == set(), "空分组返回空集合")
check(find_pure_group_labels(groups, {}, {}) == set(groups), "空 default_config 全量判定")
check(find_pure_group_labels({}, {}, {}) == set(), "全空返回空集合")

# 5) 值恰好为假值（False / "" / 0）时不能被误判为「没有值」。
print("\n[5] 假值也算「有值」")
falsy = {"开关": False, "文本": "", "数字": 0}
pure = find_pure_group_labels({"开关": [], "文本": [], "数字": []}, falsy, {})
check(pure == set(), f"False/空串/0 都算有值，实际={sorted(pure)}")

# 6) 无存储文件时仍应独立探测 store 模块，便于前端展示可初始化的空编辑器。
print("\n[6] 无数据文件时的 store 能力探测")


def fake_import(name):
    if name == "src.tasks.account.account_scope_store":
        return object()
    raise ImportError(name)


with tempfile.TemporaryDirectory() as project_dir:
    with patch("probe_task_schemas.importlib.import_module", side_effect=fake_import):
        multi_account = collect_multi_account(project_dir, [], [], [])
    check(multi_account["available"] is False, "无数据文件时 available=false")
    check(multi_account["hasStoreModule"] is True, "无数据文件仍报告 hasStoreModule=true")
    expected_store_path = os.path.join(
        project_dir, ".vscode", "ok-script-toolkit", "configs", "account_scoped_overrides.json"
    )
    check(multi_account["storePath"] == expected_store_path, "无数据文件仍返回沙箱存储路径")

print()
if failures:
    print(f"FAILED ({len(failures)} 项)")
    for item in failures:
        print(f"  - {item}")
    sys.exit(1)
print("ALL PASSED")

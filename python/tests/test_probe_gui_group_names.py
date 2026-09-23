# -*- coding: utf-8 -*-
"""probe_task_schemas.load_gui_group_names / group_display_name 的回归测试。

背景：项目自建配置页（src/gui/[Gg]lobal[Cc]onfig[Tt]ab.py）用
GLOBAL_CONFIG_GROUPS = {"中文分组名": ["config 名", ...]} 归组，并把**中文分组名**
传给 ConfigCard 当标题，于是 Qt GUI 标题的翻译链路是 tr("战斗配置") —— po 里的
msgid 是中文分组名（ja_JP: 戦闘設定、en_US: Battle Config）。探针此前拿英文
config 名（"Battle Config"）查 po 永远落空，配置分段显示英文原值。

跑法：python python/tests/test_probe_gui_group_names.py
"""
import os
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

from probe_task_schemas import group_display_name, load_gui_group_names  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
        print(f"  FAIL  {message}")
    else:
        print(f"  ok    {message}")


def write_project(root, gui_source):
    gui_dir = os.path.join(root, "src", "gui")
    os.makedirs(gui_dir, exist_ok=True)
    with open(os.path.join(gui_dir, "GlobalConfigTab.py"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(gui_source)


STUB_MODULES = ("src.core.BattleConfig", "src.core.global_config_store")


def stub_constant_modules():
    """把常量模块塞进 sys.modules，模拟探针主流程 import 项目后的状态。"""
    battle = types.ModuleType("src.core.BattleConfig")
    battle.BATTLE_CONFIG_NAME = "Battle Config"
    store = types.ModuleType("src.core.global_config_store")
    store.ZIP_LINE_CONFIG_NAME = "Zip Line Config"
    sys.modules["src.core.BattleConfig"] = battle
    sys.modules["src.core.global_config_store"] = store


def unstub_constant_modules():
    for name in STUB_MODULES:
        sys.modules.pop(name, None)


print("load_gui_group_names")

print("\n[1] 纯字面量映射（OK-AzurPromilia 形态）")
with tempfile.TemporaryDirectory() as root:
    write_project(root, 'GLOBAL_CONFIG_GROUPS = {\n'
                        '    "基础配置": ["Ensure Main Once Action Sleep"],\n'
                        '    "键位配置": ["Game Hotkey Config"],\n'
                        '}\n')
    mapping = load_gui_group_names(root)
    check(mapping == {
        "Ensure Main Once Action Sleep": "基础配置",
        "Game Hotkey Config": "键位配置",
    }, f"字面量映射应为 {{config 名: 中文分组名}}，实际 {mapping}")

print("\n[2] 常量引用（ok-end-field 形态，经 sys.modules 求值）")
with tempfile.TemporaryDirectory() as root:
    stub_constant_modules()
    try:
        write_project(root, 'from src.core.BattleConfig import BATTLE_CONFIG_NAME\n'
                            'from src.core.global_config_store import ZIP_LINE_CONFIG_NAME\n'
                            '\n'
                            'GLOBAL_CONFIG_GROUPS = {\n'
                            '    "战斗配置": [BATTLE_CONFIG_NAME],\n'
                            '    "滑索配置": [ZIP_LINE_CONFIG_NAME],\n'
                            '}\n')
        mapping = load_gui_group_names(root)
        check(mapping == {
            "Battle Config": "战斗配置",
            "Zip Line Config": "滑索配置",
        }, f"常量引用应求值为字符串值，实际 {mapping}")
    finally:
        unstub_constant_modules()

print("\n[3] 无 GUI 模块的项目（ok-gf2 等）返回空表")
with tempfile.TemporaryDirectory() as root:
    check(load_gui_group_names(root) == {}, "无约定文件应返回 {}")

print("\n[4] GLOBAL_CONFIG_GROUPS 不是字面量 Dict 时返回空表（静默跳过）")
with tempfile.TemporaryDirectory() as root:
    write_project(root, 'def _groups():\n'
                        '    return {"战斗配置": ["Battle Config"]}\n'
                        '\n'
                        'GLOBAL_CONFIG_GROUPS = _groups()\n')
    check(load_gui_group_names(root) == {}, "非字面量 Dict 应返回 {}")

print("\n[5] 常量模块不可 import 时只丢该条映射，其余保留")
with tempfile.TemporaryDirectory() as root:
    unstub_constant_modules()  # 确保 src.core.BattleConfig 不在 sys.modules 且不可 import
    write_project(root, 'from src.core.BattleConfig import BATTLE_CONFIG_NAME\n'
                        '\n'
                        'GLOBAL_CONFIG_GROUPS = {\n'
                        '    "战斗配置": [BATTLE_CONFIG_NAME],\n'
                        '    "键位配置": ["Game Hotkey Config"],\n'
                        '}\n')
    mapping = load_gui_group_names(root)
    check(mapping == {"Game Hotkey Config": "键位配置"},
          f"不可求值的条目应跳过，可求值的保留，实际 {mapping}")

print("\ngroup_display_name")

print("\n[6] 有映射：用中文分组名过 po（对齐 Qt GUI 标题链路）")
catalog = {"战斗配置": "戦闘設定", "Basic Options": "基础选项"}
gui_names = {"Battle Config": "战斗配置"}
check(group_display_name(catalog, gui_names, "Battle Config") == "戦闘設定",
      "Battle Config 应显示 ja_JP 译文 戦闘設定")

print("\n[7] 无映射：回退用 config 名过 po（框架内置组行为不变）")
check(group_display_name(catalog, {}, "Basic Options") == "基础选项",
      "框架组应沿用 config 名查 po")

print("\n[8] po 也没有：回退原值")
check(group_display_name({}, gui_names, "Battle Config") == "战斗配置",
      "po 未命中时显示 GUI 分组名原文")

print()
if failures:
    print(f"FAILED: {len(failures)} 项")
    sys.exit(1)
print("ALL OK")

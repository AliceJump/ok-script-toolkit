# -*- coding: utf-8 -*-
"""project_store 的回归测试：store 模块名从**项目自己的声明**推出来，不硬编码。

背景：项目自建全局配置 store（ok-end-field 的 src.core.global_config_store）过去被
写死在探针与执行器两处 —— 项目挪包改名，那批全局配置就整批静默消失。现在按项目
config 的 custom_tabs 链路推：

    config["custom_tabs"] → src.gui.GlobalConfigTab → from <store> import get_all_visible_configs

判据是**接口**（import 的是 get_all_visible_configs），不是模块名。

跑法：python python/tests/test_project_store.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

from _test_tmp import make_tmp_tempdir  # noqa: E402
from project_store import (  # noqa: E402
    LEGACY_STORE_MODULE,
    STORE_ENUM_ENTRY,
    declared_store_modules,
    declared_tab_modules,
    module_file,
    store_modules,
)

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
        print(f"  FAIL  {message}")
    else:
        print(f"  ok    {message}")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as stream:
        stream.write(text)


TAB_WITH_STORE = """\
from src.core.global_config_store import ZIP_LINE_CONFIG_NAME, get_all_visible_configs

GLOBAL_CONFIG_GROUPS = {"滑索配置": [ZIP_LINE_CONFIG_NAME]}
"""

print("module_file")
with make_tmp_tempdir("ok-project-store") as root:
    write(os.path.join(root, "src", "gui", "GlobalConfigTab.py"), TAB_WITH_STORE)
    check(module_file(root, "src.gui.GlobalConfigTab") is not None, "点分模块名 → 找得到文件")
    check(
        module_file(root, "src/gui/GlobalConfigTab.py") is not None,
        "相对路径写法 → 也找得到文件",
    )
    check(module_file(root, "src.gui.NoSuchTab") is None, "不存在的模块 → None")
    check(module_file(root, "") is None, "空模块名 → None（不能拿空值去拼路径）")

print("\ndeclared_tab_modules")
check(
    declared_tab_modules({"custom_tabs": [["a.B", "B"], ["a.B", "B"], ["c.D", "D"]]}) == ["a.B", "c.D"],
    "custom_tabs 保序去重",
)
check(
    declared_tab_modules({"custom_tabs": ["裸字符串", None, [], ["", "x"], ["ok.Tab", "Tab"]]}) == ["ok.Tab"],
    "畸形条目被跳过（只认 [模块名, 类名] 形态）",
)
check(declared_tab_modules({}) == [], "没有 custom_tabs → 空")
check(declared_tab_modules(None) == [], "config 为 None → 空")

print("\ndeclared_store_modules")
with make_tmp_tempdir("ok-project-store") as root:
    write(os.path.join(root, "src", "gui", "GlobalConfigTab.py"), TAB_WITH_STORE)
    config = {"custom_tabs": [["src.gui.GlobalConfigTab", "GlobalConfigTab"]]}
    check(
        declared_store_modules(config, root) == ["src.core.global_config_store"],
        "从 custom_tabs 声明的页里推出 store 模块",
    )

with make_tmp_tempdir("ok-project-store") as root:
    write(
        os.path.join(root, "src", "gui", "GlobalConfigTab.py"),
        "from ..core.my_store import get_all_visible_configs\n",
    )
    config = {"custom_tabs": [["src.gui.GlobalConfigTab", "GlobalConfigTab"]]}
    check(
        declared_store_modules(config, root) == ["src.core.my_store"],
        "相对导入按文件所在包解析（不能记成顶层 core.my_store）",
    )

with make_tmp_tempdir("ok-project-store") as root:
    write(
        os.path.join(root, "src", "gui", "GlobalConfigTab.py"),
        "from src.core.store import get_all_visible_configs as _all\n",
    )
    config = {"custom_tabs": [["src.gui.GlobalConfigTab", "GlobalConfigTab"]]}
    check(
        declared_store_modules(config, root) == ["src.core.store"],
        "`as` 别名也认（按本地名反查模块）",
    )

# 破坏性对照：证明判据是**接口**，不是「页面里随便有个 import 就算」。
with make_tmp_tempdir("ok-project-store") as root:
    write(
        os.path.join(root, "src", "gui", "GlobalConfigTab.py"),
        "from src.core.BattleConfig import BATTLE_CONFIG_NAME\n\nGLOBAL_CONFIG_GROUPS = {}\n",
    )
    config = {"custom_tabs": [["src.gui.GlobalConfigTab", "GlobalConfigTab"]]}
    check(
        declared_store_modules(config, root) == [],
        "对照：只 import 了别的符号 → 不认（否则会把任意模块当 store）",
    )

with make_tmp_tempdir("ok-project-store") as root:
    config = {"custom_tabs": [["src.gui.GlobalConfigTab", "GlobalConfigTab"]]}
    check(
        declared_store_modules(config, root) == [],
        "对照：声明的页文件不存在 → 空（不抛异常）",
    )

print("\nstore_modules 的兜底链")
with make_tmp_tempdir("ok-project-store") as root:
    write(os.path.join(root, "src", "gui", "GlobalConfigTab.py"), TAB_WITH_STORE)
    config = {"custom_tabs": [["src.gui.GlobalConfigTab", "GlobalConfigTab"]]}
    names = store_modules(config, root)
    check(names[0] == "src.core.global_config_store", "首选是项目声明出来的模块")

with make_tmp_tempdir("ok-project-store") as root:
    names = store_modules({}, root)
    check(
        names == [LEGACY_STORE_MODULE],
        "项目什么都没声明、也没导入过 → 退回历史默认名（老项目兼容）",
    )
    check(
        LEGACY_STORE_MODULE not in declared_store_modules({}, root),
        "但默认名只是兜底，不再由声明推导产出",
    )

print("\n接口常量")
check(STORE_ENUM_ENTRY == "get_all_visible_configs", "判定凭据是 store 的枚举入口")

print()
if failures:
    print(f"FAILED ({len(failures)} 项)")
    for item in failures:
        print(f"  - {item}")
    sys.exit(1)
print("ALL PASSED")

# -*- coding: utf-8 -*-
"""probe_task_schemas 的「Qt 翻译层」与「强制 headless」回归测试。

两个真实故障（2026-09-23 在 ok-gm / ok-wuthering-waves / ok-neverness-to-everness 上实测）：

1) ok-gm（ok-script==1.0.179）全局配置整片英文。
   探针只认 `ok.ui.qt.resources`，而 1.0.x 的资源模块是 `ok.gui.resources` ——
   import 失败被 `except Exception` 吞掉，Qt 层静默消失，框架文案（Basic Options /
   Auto Start Game When App Starts…）全部回落原文，与 GUI 不一致且无任何提示。

2) ok-ww / ok-nte（ok-script 2.0.x）整个探针报废：
   `RuntimeError: libshiboken: Please destroy the QCoreApplication singleton
   before creating a new QApplication instance.`
   两个独立成因叠加：
   a. 探针在 import 项目前建了 QCoreApplication，而项目的 `config['gui']` 让框架
      走 `self.app` -> `App.__init__` -> `init_app_config()` -> `QApplication(...)`；
   b. `cfg['use_gui'] = False` 对新式 config **无效** ——
      `resolve_ui_config()` 先看 `"gui" in config`，只改 use_gui 仍判定为 qt。

跑法：python python/tests/test_probe_qt_layer.py
"""
import contextlib
import io
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

import probe_task_schemas as probe  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
        print(f"  FAIL  {message}")
    else:
        print(f"  ok    {message}")


# ── 框架 resolve_ui_config() 的分支复刻 ────────────────────────────────────
#
# 照抄 ok/core/ui_config.py（ok-script 2.0.x）的判定顺序。测试环境不装 ok 包，
# 但"只改 use_gui 压不住 config['gui']"正是本次故障的不变量本身，必须能被断言。
# 只复刻与 UI 类型有关的分支（window_size / launch_mode 与探针无关）。
def fake_resolve_ui_config(config):
    """返回 'qt' / 'web' / None —— 与框架同序：先看 gui 键，再看 use_gui。"""
    if "gui" in config:
        raw_gui = config.get("gui")
        if raw_gui is None:
            return None
        return raw_gui.get("type")
    if config.get("use_gui"):
        return "qt"
    return None


# ── sys.modules 桩 ────────────────────────────────────────────────────────

STUB_PREFIXES = ("ok", "ok.ui", "ok.ui.qt", "ok.ui.qt.resources",
                 "ok.gui", "ok.gui.resources", "PySide6", "PySide6.QtCore")


class QtStub:
    """假的 PySide6.QtCore：记录 QCoreApplication 是否被碰过、QTranslator.load 结果。"""

    def __init__(self, load_result=True):
        self.load_result = load_result
        self.core_app_touched = []
        self.load_calls = []

    def build(self):
        stub = self
        core = types.ModuleType("PySide6.QtCore")

        class QCoreApplication:
            def __init__(self, *args, **kwargs):
                stub.core_app_touched.append(("__init__", args))
                raise AssertionError("探针不得创建 QCoreApplication")

            @staticmethod
            def instance():
                stub.core_app_touched.append(("instance", ()))
                return None

            @staticmethod
            def installTranslator(*args, **kwargs):
                stub.core_app_touched.append(("installTranslator", args))

            @staticmethod
            def translate(*args, **kwargs):
                stub.core_app_touched.append(("translate", args))
                return args[1] if len(args) > 1 else ""

        class QTranslator:
            def __init__(self, *args, **kwargs):
                self._parent = args[0] if args else None

            def load(self, locale, prefix):
                stub.load_calls.append((locale, prefix))
                return stub.load_result

            def translate(self, context, source):
                return source

        core.QCoreApplication = QCoreApplication
        core.QTranslator = QTranslator
        pyside = types.ModuleType("PySide6")
        pyside.QtCore = core
        pyside.__path__ = []
        core.__path__ = []
        return {"PySide6": pyside, "PySide6.QtCore": core}


def stub_modules(names):
    """注册空壳模块，连同全部父包（带 __path__），模拟"这个版本有这个模块"。

    父包必须一起造：importlib 导入 `ok.gui.resources` 时会逐级找 `ok` / `ok.gui`，
    缺父包会变成 ModuleNotFoundError —— 那样 [6] 就测不出"回退到旧路径"了。
    """
    for name in names:
        parts = name.split(".")
        for depth in range(1, len(parts) + 1):
            full = ".".join(parts[:depth])
            if full in sys.modules:
                continue
            module = types.ModuleType(full)
            module.__path__ = []
            sys.modules[full] = module


def clear_stubs():
    for name in STUB_PREFIXES:
        sys.modules.pop(name, None)


@contextlib.contextmanager
def probe_env(modules=(), load_result=True):
    """搭好 sys.modules 桩 + 捕获 stderr，退出时完整还原。"""
    saved = {name: sys.modules.get(name) for name in STUB_PREFIXES}
    clear_stubs()
    stub = QtStub(load_result=load_result)
    modules = tuple(modules)
    if "PySide6" in modules:
        sys.modules.update(stub.build())
    stub_modules([m for m in modules if m != "PySide6"])
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stderr(buffer):
            yield stub, buffer
    finally:
        clear_stubs()
        for name, module in saved.items():
            if module is not None:
                sys.modules[name] = module


print("force_headless —— 强制 headless 必须同时压住 gui 与 use_gui")

print("\n[1] 新式 config（config['gui']={'type':'qt'}，ok-ww / ok-nte 形态）")
cfg = {"use_gui": True, "gui": {"type": "qt"}, "gui_title": "ok-ww"}
returned = probe.force_headless(cfg)
check(returned is cfg, "应就地修改并返回同一个 dict")
check(cfg["use_gui"] is False, "use_gui 应被置 False")
check(cfg["gui"] is None, "gui 应被置 None（不是 del，键仍在）")
check(fake_resolve_ui_config(cfg) is None,
      f"改完后框架应判定为无 UI（HeadlessApp），实际 {fake_resolve_ui_config(cfg)!r}")

print("\n[2] 破坏性对照：只改 use_gui 压不住 config['gui']（修复前的行为）")
only_use_gui = {"use_gui": False, "gui": {"type": "qt"}}
check(fake_resolve_ui_config(only_use_gui) == "qt",
      "只改 use_gui 时框架仍判定为 qt —— 这正是 [1] 必须同时置 gui=None 的理由；"
      "若这里不再是 qt，说明框架判定顺序变了，本测试的立论需要复核")

print("\n[3] 老式 config（只有 use_gui，ok-gm / ok-ap / ok-end-field 形态）")
legacy = {"use_gui": True, "config_folder": "configs"}
probe.force_headless(legacy)
check(legacy.get("use_gui") is False, f"use_gui 应被置 False，实际 {legacy!r}")
check("gui" in legacy and legacy.get("gui") is None,
      f"应显式置 gui=None（键存在而非缺键），实际 {legacy!r}")
check(fake_resolve_ui_config(legacy) is None, "老式 config 改完后也应无 UI")

print("\n[4] 原 config 不被改动（探针用的是副本）")
original = {"use_gui": True, "gui": {"type": "qt"}}
copy = dict(original)
probe.force_headless(copy)
check(original == {"use_gui": True, "gui": {"type": "qt"}},
      f"调用方传副本时原 config 不应被污染，实际 {original!r}")


print("\nload_qt_translator —— 资源模块路径回退 + 绝不创建 QCoreApplication")

print("\n[5] 2.0.x 布局：ok.ui.qt.resources 可用")
with probe_env(modules=("PySide6", "ok.ui.qt.resources")) as (stub, err):
    translator = probe.load_qt_translator("zh_CN")
    check(translator is not None, "应加载成功")
    check(stub.load_calls == [("zh_CN", ":/i18n")],
          f"应从 :/i18n 加载该 locale，实际 {stub.load_calls!r}")
    check(stub.core_app_touched == [],
          f"不得碰 QCoreApplication，实际 {stub.core_app_touched!r}")
    check("probe]" not in err.getvalue(), f"成功时不应有告警，实际 {err.getvalue()!r}")

print("\n[6] 1.0.x 布局：只有 ok.gui.resources（ok-gm 形态，修复前整层丢失）")
with probe_env(modules=("PySide6", "ok.gui.resources")) as (stub, err):
    translator = probe.load_qt_translator("zh_CN")
    check(translator is not None, "旧版资源模块也应被认出来")
    check(stub.load_calls == [("zh_CN", ":/i18n")], f"实际 {stub.load_calls!r}")
    check(stub.core_app_touched == [], "不得碰 QCoreApplication")
    check("probe]" not in err.getvalue(), f"成功时不应有告警，实际 {err.getvalue()!r}")

print("\n[7] 破坏性对照：只认 2.0.x 路径时，1.0.x 布局必须加载失败")
saved_modules = probe.QT_RESOURCE_MODULES
try:
    probe.QT_RESOURCE_MODULES = ("ok.ui.qt.resources",)
    with probe_env(modules=("PySide6", "ok.gui.resources")) as (stub, err):
        translator = probe.load_qt_translator("zh_CN")
        check(translator is None, "只认新路径时旧布局必然加载不到 —— 对照必须红")
        check("probe]" in err.getvalue(),
              f"venv 有 PySide6 却认不出资源模块时必须留痕，实际 {err.getvalue()!r}")
finally:
    probe.QT_RESOURCE_MODULES = saved_modules

print("\n[8] 两个资源模块都没有，且 venv 无 PySide6（纯 headless/web 项目）→ 静默退回纯 po")
with probe_env(modules=()) as (stub, err):
    translator = probe.load_qt_translator("zh_CN")
    check(translator is None, "无 Qt 时应返回 None")
    check(err.getvalue() == "", f"无 Qt 的项目属正常情况，不应告警，实际 {err.getvalue()!r}")

print("\n[9] 该 locale 没有 .qm（en_US 是框架源语言）→ 静默退回纯 po")
with probe_env(modules=("PySide6", "ok.ui.qt.resources"), load_result=False) as (stub, err):
    translator = probe.load_qt_translator("en_US")
    check(translator is None, "load 失败应返回 None")
    check(stub.core_app_touched == [], "不得碰 QCoreApplication")
    check(err.getvalue() == "",
          f"源语言没有 .qm 是正常情况，不应告警，实际 {err.getvalue()!r}")

print("\n[10] 有资源模块但 import 不到 Qt（异常路径）→ 返回 None 且留痕")
with probe_env(modules=("ok.ui.qt.resources",)) as (stub, err):
    translator = probe.load_qt_translator("zh_CN")
    check(translator is None, "无 PySide6 时应返回 None")
    check("probe]" in err.getvalue(), f"该异常应留痕，实际 {err.getvalue()!r}")


print("\nqt_translate / translated —— 优先级 Qt(.qm) > po > 原文")


class FixedTranslator:
    def __init__(self, mapping):
        self.mapping = mapping

    def translate(self, context, source):
        return self.mapping.get(source, source)


print("\n[11] Qt 命中时压过 po")
probe._QT_TRANSLATOR = FixedTranslator({"Basic Options": "基本设置"})
try:
    check(probe.qt_translate("Basic Options") == "基本设置", "应取 Qt 层译文")
    check(probe.translated({"Basic Options": "PO 值"}, "Basic Options") == "基本设置",
          "Qt 层优先于 po")
finally:
    probe._QT_TRANSLATOR = None

print("\n[12] Qt 未命中（返回原文）时回落 po，po 再落空则回原文")
probe._QT_TRANSLATOR = FixedTranslator({})
try:
    check(probe.qt_translate("Basic Options") is None,
          "译文等于原文时应视为未命中（en_US 源语言场景）")
    check(probe.translated({"Basic Options": "PO 值"}, "Basic Options") == "PO 值",
          "Qt 未命中应回落 po")
    check(probe.translated({}, "Basic Options") == "Basic Options", "po 也落空应回原文")
finally:
    probe._QT_TRANSLATOR = None

print("\n[13] 未加载 Qt 层（_QT_TRANSLATOR is None）时行为退回纯 po")
check(probe.qt_translate("Basic Options") is None, "未加载应返回 None")
check(probe.translated({"Basic Options": "PO 值"}, "Basic Options") == "PO 值",
      "纯 po 行为不变")
check(probe.translated({}, "") == "", "空串原样返回")

print("\n[14] 资源模块表必须同时覆盖两代布局，且新布局在前")
check(tuple(probe.QT_RESOURCE_MODULES)[:2] == ("ok.ui.qt.resources", "ok.gui.resources"),
      "新布局优先（当前主流版本，少一次失败的 import），旧布局兜底；"
      f"实际 {tuple(probe.QT_RESOURCE_MODULES)!r}")

print("\n[15] 测试自身的守卫：桩必须真的生效")
# 防"空集包含于任何集合"式的恒真断言：若 fake_resolve_ui_config 永远返回 None，
# [2] 的对照就会恒过（实际是恒不过），这里显式证明它区分得开。
check(fake_resolve_ui_config({"gui": {"type": "web"}}) == "web",
      "对照函数应能识别 gui.type=web")
check(fake_resolve_ui_config({}) is None, "既无 gui 也无 use_gui 应为 None")
check(fake_resolve_ui_config({"use_gui": True}) == "qt", "仅有 use_gui=True 应为 qt")

print()
if failures:
    print(f"FAILED: {len(failures)} 项")
    sys.exit(1)
print("ALL OK")

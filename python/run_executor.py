# -*- coding: utf-8 -*-
"""常驻执行器：单一进程完成「连接游戏 + 多触发任务串连轮询」。

与已被删除的 run_task.py 的关键差异
----------------------------------
（`run_task.py` 已于 2026-09 删除：无任何调用方，且没接配置沙箱。这里保留差异说明，
是为了记住"为什么不能退回单任务一进程"。）

它走 `ok.run_task(config, task=<单个任务>)`，框架对触发任务会转调
`OK.run_trigger_task()` —— 它把 `executor.trigger_tasks` 收窄成单个任务并 disable
其余触发任务（见 ok/__init__.py）。于是旧实现每个任务各起一个进程，同一时刻只能跑
一个触发任务，无法做多触发任务轮询。

本脚本改为：`OK(config)` 初始化一次 → `start_controller.do_start(None)` → 全部触发任务
留在 `executor.trigger_tasks` 里，交给框架原生的 `TaskExecutor.execute()` 循环。
该循环的 `next_task()` 顺序是：onetime 队列 → 任一 enabled 的一次性任务 → 触发任务按
`trigger_task_index` 轮转，命中 `enabled and should_trigger()` 就执行，转满一圈后按全局
配置的 Trigger Interval 休眠。这正是 GUI 里多触发任务轮询的语义。

用法（在项目目录下）:
    python run_executor.py --config-module src.config [-- 框架额外参数]

运行期控制（stdin，按行）:
    trigger_enable  <module::Class>   触发任务入列（等价 GUI 的启用开关）
    trigger_disable <module::Class>   触发任务出列
    onetime_enqueue <module::Class>   一次性任务入队，执行一次后自动出队
    task_disable                      停掉当前正在执行的任务，轮询继续
    params          <json>            更新参数覆盖并即时应用到已加载任务
    pause / resume                    暂停 / 恢复执行器循环（全局）
    overlay_on / overlay_off          即时开 / 关调试浮层
    stop                              关闭执行器

启动环境变量:
    OK_TOOLKIT_TRIGGERS      启动即入列的触发任务 key，JSON 数组；集合是权威值，
                             未列出的触发任务一律置为未启用
    OK_LANG_HINTS_INJECT     参数覆盖 {"module::Class": {key: value}}（沿用旧脚本语义）
    OK_TOOLKIT_USE_OVERLAY=1 调试浮层（设备连上后由 _apply_startup_overlay 落地）

stdout 标记行（宿主按行扫描）:
    OK_TOOLKIT_EXECUTOR_CONNECTING   开始连接设备 / 启动游戏
    OK_TOOLKIT_EXECUTOR_READY        设备已连接、执行器循环已启动
    OK_TOOLKIT_STATE:<json>          执行器状态快照（变化时推送）
    OK_TOOLKIT_PAUSED / OK_TOOLKIT_RESUMED
    OK_TOOLKIT_OVERLAY_ON / OK_TOOLKIT_OVERLAY_OFF
    OK_TOOLKIT_ERROR:<err>
    OK_TOOLKIT_EXECUTOR_STOPPED      即将退出

不污染项目配置：触发任务的 `_enabled` 一律走 `dict.__setitem__` 只改内存 ——
框架原实现经 `Config.__setitem__` → `save_file()` 会把启用状态写回 configs/*.json。
参数覆盖同理（`apply_overrides_to`），并且额外用 `install_override_save_patch()` 兜住
一个漏洞：`Config.save_file()` 是整个字典 dump，任务自己写任意一个 config 键时会把
内存里的覆盖值一起写盘 —— 那个补丁在写盘前把被覆盖的键换回磁盘当前值。

游戏启动参数：执行器**不替框架处理** `config['windows']['args']`。启动参数属于目标项目
自己的事 —— 项目在 `main.py` 里怎么补，执行器就怎么补（经
`install_project_startup_patches()` 装同一套补丁）。工具箱的 `connect_game.py` 是插件
自己的启动实现，仍自己读 `windows.args`。

注意执行器走的是框架 `start_device()`，只有 ok-script 313b28e（2026-09-16）之后才原生
支持 `windows.args`；更早的框架版本上，需要启动参数的项目必须自己补这一环。

配置沙箱：调试插件绝不允许改动目标项目的 `configs/`。宿主经
`OK_TOOLKIT_RUN_DIR` 传入沙箱根目录（如 `<workspace>/.vscode/ok-script-toolkit`），
`config['config_folder']` 与 `config['screenshots_folder']` 一并改道，ok 框架的读写
全部落在沙箱内。任务因此读到的是默认值 —— 调试场景可接受。

`devices.json` 是唯一例外：工具箱的 connect_game.py 把连接结果写在
`<项目>/configs/devices.json`（`folder=` 硬指定，不受 config_folder 影响），
而执行器需要读到同一个窗口。故启动时把它**拷进沙箱**做桥接；此后执行器对它的
写入只落沙箱，项目侧文件保持原样。
"""
import argparse
import functools
import importlib
import json
import os
import sys
import threading
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

MARKER_CONNECTING = "OK_TOOLKIT_EXECUTOR_CONNECTING"
MARKER_READY = "OK_TOOLKIT_EXECUTOR_READY"
MARKER_STATE = "OK_TOOLKIT_STATE:"
MARKER_PAUSED = "OK_TOOLKIT_PAUSED"
MARKER_RESUMED = "OK_TOOLKIT_RESUMED"
MARKER_OVERLAY_ON = "OK_TOOLKIT_OVERLAY_ON"
MARKER_OVERLAY_OFF = "OK_TOOLKIT_OVERLAY_OFF"
MARKER_ERROR = "OK_TOOLKIT_ERROR:"
MARKER_STOPPED = "OK_TOOLKIT_EXECUTOR_STOPPED"

# 状态心跳间隔（秒）：快照无变化时不重复输出
STATE_HEARTBEAT = 0.5

_print_lock = threading.Lock()
_overrides = {}
_last_state = None

# 挂在任务 config 对象上的标记（见 apply_overrides_to / install_override_save_patch）
OVERRIDDEN_KEYS_ATTR = "_toolkit_overridden_keys"
SAVING_ATTR = "_toolkit_saving_config"

# _disk_config_value 的哨兵：磁盘上没有这个键（区别于「值就是 None」）
_MISSING = object()


def _emit(line: str) -> None:
    with _print_lock:
        print(line, flush=True)


def _note(message: str) -> None:
    """人可读的日志行（宿主原样展示在输出频道）。"""
    with _print_lock:
        print(f"[toolkit] {message}", flush=True)


def task_key(task) -> str:
    cls = task.__class__
    return f"{cls.__module__}::{cls.__name__}"


# ── 配置沙箱 ──────────────────────────────────────────────────────────

def apply_config_sandbox(config: dict) -> str:
    """把 ok 框架的配置读写改道到沙箱目录，避免污染目标项目的 configs/。

    必须在 `OK(config)` 之前调用：任务在 `OK()` 内部实例化，而 `Config.__init__`
    （ok/util/config.py）一执行就以 `Config.config_folder` 定下 `config_file` 路径，
    之后 `save_file()` 永远写它，再改就晚了。

    传导不需要我们插手 —— `OK.__init__`（ok/__init__.py）会执行
    `Config.config_folder = config["config_folder"]`。这里只要把值塞进 config。

    绝对路径可直接用：`get_relative_path`（ok/util/file.py）是
    `os.path.join(os.getcwd(), *files)`，传入绝对路径时按路径语义直接采用。
    相对路径会落到 `os.getcwd()`（= 项目根）下，这样也能工作。

    返回沙箱根目录（未启用时返回空串）。
    """
    run_dir = os.environ.get("OK_TOOLKIT_RUN_DIR", "").strip()
    if not run_dir:
        return ""
    run_dir = os.path.abspath(run_dir)
    config_folder = os.path.join(run_dir, "configs")
    screenshots_folder = os.path.join(run_dir, "screenshots")
    try:
        os.makedirs(config_folder, exist_ok=True)
        os.makedirs(screenshots_folder, exist_ok=True)
    except OSError as e:  # noqa: BLE001 — 建不出沙箱就退回旧行为，绝不因它起不来
        _note(f"配置沙箱创建失败，回退为不隔离：{e}")
        return ""

    config["config_folder"] = config_folder
    # 截图目录必须一起改道：ok 启动时会清空它（会真的删文件）。
    config["screenshots_folder"] = screenshots_folder

    # devices.json 是唯一需要桥接的：connect_game.py 用 `folder=` 硬写到项目
    # configs/ 下（不受 config_folder 影响），执行器要读到同一个窗口。拷一份进沙箱，
    # 此后执行器对它的写入只落沙箱，项目侧文件保持原样。
    source_devices = os.path.join(os.getcwd(), "configs", "devices.json")
    target_devices = os.path.join(config_folder, "devices.json")
    if os.path.isfile(source_devices):
        try:
            with open(source_devices, "r", encoding="utf-8") as src:
                payload = src.read()
            with open(target_devices, "w", encoding="utf-8") as dst:
                dst.write(payload)
        except OSError as e:  # noqa: BLE001 — 桥接失败只影响自动连游戏，不阻断启动
            _note(f"devices.json 桥接失败：{e}")

    _note(f"配置沙箱已启用：{config_folder}")
    return run_dir


# ── 目标项目自带的启动补丁 ────────────────────────────────────────────

# ok 系项目普遍用 `src/patches/` 做 monkey-patch（改框架行为、修上游 bug），
# 入口约定是 `src.patches.startup_patches.install_startup_patches()`，
# 由项目自己的 `main.py` 在 `OK(config)` 之前调用。
# 已确认采用该约定的项目：ok-end-field、OK-AzurPromilia。
PROJECT_PATCH_MODULE_SUFFIX = "patches.startup_patches"
PROJECT_PATCH_ENTRY = "install_startup_patches"


def project_patch_module_path(config_module_name: str) -> str:
    """由 config 模块名推出项目补丁模块路径。

    `src.config` -> `src.patches.startup_patches`；`config` -> `patches.startup_patches`。
    这样既支持带 src/ 包的项目，也支持 config.py 直接放根目录的项目。
    """
    package = config_module_name.rsplit(".", 1)[0] if "." in config_module_name else ""
    return f"{package}.{PROJECT_PATCH_MODULE_SUFFIX}" if package else PROJECT_PATCH_MODULE_SUFFIX


def install_project_startup_patches(config_module_name: str) -> bool:
    """安装**目标项目自带**的启动补丁。返回是否装成功。

    为什么必须做：插件此前**完全没调用**这个入口，于是同一份项目代码
    "自己跑没事、用插件跑就崩"。实测（2026-09-20，ok-end-field）：

        src/interaction/Mouse.py: user32.GetCursorPos(ctypes.byref(pt))
        ctypes.ArgumentError: expected LP_POINT instance instead of pointer to POINT

    这是 ok 库 `ok/ui/overlay/win32_gdi.py` 在 import 时污染了全局
    `user32.GetCursorPos.argtypes` 导致的；项目补丁里的 `win32_gdi_point_patch`
    专门根治它。不装补丁 → 一次性任务直接抛异常中断；装上 → 恢复正常
    （已实测：装完 `win32_gdi.POINT is wintypes.POINT` 为 True，
    标准 `wintypes.POINT` 调用成功）。

    时机对齐项目 `main.py`：**import config 之后、`OK(config)` 之前**。

    失败**绝不阻断启动**：项目没有补丁是正常的（ok-infinity-nikki / ok-gm 就没有），
    补丁自身出错也只记一行 —— 不能因为一个可选补丁让整个执行器起不来。
    """
    module_path = project_patch_module_path(config_module_name)
    try:
        module = importlib.import_module(module_path)
    except ModuleNotFoundError:
        _note(f"目标项目没有启动补丁（{module_path} 不存在），跳过")
        return False
    except Exception as e:  # noqa: BLE001 — 补丁模块自身导入失败也不能拖垮执行器
        _note(f"项目启动补丁模块导入失败（继续执行）：{type(e).__name__}: {e}")
        return False

    installer = getattr(module, PROJECT_PATCH_ENTRY, None)
    if not callable(installer):
        _note(f"{module_path} 里没有 {PROJECT_PATCH_ENTRY}()，跳过")
        return False

    try:
        installer()
    except Exception as e:  # noqa: BLE001 — 同上，补丁装不上就按"没打补丁"继续
        _note(f"项目启动补丁安装失败（继续执行）：{type(e).__name__}: {e}")
        return False

    _note("已安装目标项目的启动补丁")
    return True


# ── 猴子补丁 ──────────────────────────────────────────────────────────

def install_override_patch() -> None:
    """BaseTask.load_config 后把插件侧 params 覆盖进 self.config（仅内存）。

    参考 ok-end-field src/patches 的 monkey-patch 模式（functools.wraps + 类方法替换
    + 幂等）。Config.__setitem__ 会立即写回 configs/*.json，所以覆盖必须走
    dict.__setitem__ 的基类实现。
    """
    from ok.task.task import BaseTask

    if getattr(BaseTask, "_toolkit_override_patched", False):
        return

    original = BaseTask.load_config

    @functools.wraps(original)
    def patched_load_config(self, *args, **kwargs):
        original(self, *args, **kwargs)
        apply_overrides_to(self)

    BaseTask.load_config = patched_load_config
    BaseTask._toolkit_override_patched = True


def install_trigger_persistence_patch() -> None:
    """让 TriggerTask.enable/disable 只改内存里的 _enabled。

    框架原实现 `self.config['_enabled'] = True/False` 会经 Config.__setitem__ 落盘，
    把插件的启用状态固化进目标项目的 configs/*.json。插件的启用集合存在自己的
    .vscode/.idea 数据文件里，项目配置必须保持原样。
    """
    from ok.task.task import BaseTask, TriggerTask

    if getattr(TriggerTask, "_toolkit_memory_only_enabled", False):
        return

    def enable(self):
        dict.__setitem__(self.config, "_enabled", True)
        BaseTask.enable(self)

    def disable(self):
        dict.__setitem__(self.config, "_enabled", False)
        BaseTask.disable(self)

    TriggerTask.enable = enable
    TriggerTask.disable = disable
    TriggerTask._toolkit_memory_only_enabled = True

def apply_overrides_to(task) -> None:
    """把插件侧覆盖应用到任务内存配置上（只改内存，绝不落盘）。

    同时维护「哪些键是被覆盖的」这一信息（挂在 config 对象上），供
    install_override_save_patch() 在保存时把它们还原成磁盘值 —— 否则任务自己写
    任意一个 config 键触发 `Config.save_file()` 时，会把整个内存字典 dump 出去，
    把插件覆盖值一起写进项目的 configs/*.json（实测确认过）。
    """
    config = task.config
    overrides = _overrides.get(task_key(task))
    overrides = overrides if isinstance(overrides, dict) else {}

    overridden = getattr(config, OVERRIDDEN_KEYS_ATTR, None)

    # 本次不再覆盖的键：还原成磁盘原值（以前只能等执行器重启才恢复）
    if overridden:
        for key in [k for k in overridden if k not in overrides]:
            overridden.discard(key)
            if key in config:
                disk_value = _disk_config_value(config, key)
                if disk_value is not _MISSING:
                    dict.__setitem__(config, key, disk_value)

    if not overrides:
        return

    if overridden is None:
        overridden = set()
        try:
            setattr(config, OVERRIDDEN_KEYS_ATTR, overridden)
        except Exception:  # noqa: BLE001 — 挂不上标记就退化成「只改内存」
            overridden = None

    for key, value in overrides.items():
        if key not in config:
            continue
        dict.__setitem__(config, key, value)
        if overridden is not None:
            overridden.add(key)


def _disk_config_value(config, key):
    """读 config 对应文件里某个键的当前值（读不到返回 _MISSING）。"""
    try:
        from ok.util.file import read_json_file

        data = read_json_file(config.config_file)
    except Exception:  # noqa: BLE001
        return _MISSING
    if isinstance(data, dict) and key in data:
        return data[key]
    return _MISSING


def install_override_save_patch() -> bool:
    """保存任务配置时，把被覆盖的键还原成**磁盘当前值**，避免插件覆盖值落进项目配置。

    为什么需要
    ----------
    `Config.save_file()` 就是 `write_json_file(self.config_file, self)` —— 把整个
    内存字典 dump 出去。而任务自己会在运行中写自己的 config（真实项目里就有：
    `LauncherTask` 记上次账号路径、`DailyRoutineTask` 规范化日常项），那一下
    `Config.__setitem__` → `save_file()` 会把内存里被插件改过的键**一起写盘**。
    实测：注入覆盖 `自动目标=false` 后，任务写任意一个键 → 磁盘上 `自动目标` 也变成
    false；之后用户在插件里取消覆盖，任务读到的仍是 false（不是默认的 true），
    看起来像「取消没生效」。

    做法
    ----
    写盘前把被覆盖的键换成**磁盘当前值**（不是加载时的旧值，免得把任务自己写过的
    值回退），写完立刻换回内存里的覆盖值。磁盘上本来就没有这个键时，先从 payload
    里摘掉，写完再放回。

    用 `dict.__setitem__`/`dict.__delitem__` 是必须的：走 `Config.__setitem__` 会
    再次触发 `save_file()`，直接无限递归。

    返回是否真的安装了补丁。
    """
    from ok.util.config import Config

    if getattr(Config, "_toolkit_override_save_patched", False):
        return False
    Config._toolkit_override_save_patched = True

    original_save_file = Config.save_file

    @functools.wraps(original_save_file)
    def save_file(self):
        overridden = getattr(self, OVERRIDDEN_KEYS_ATTR, None)
        # 重入保护：还原过程中不会再走 Config.__setitem__，但任务可能并发保存
        if not overridden or getattr(self, SAVING_ATTR, False):
            return original_save_file(self)

        restore = {}
        removed = set()
        try:
            setattr(self, SAVING_ATTR, True)
            for key in list(overridden):
                if key not in self:
                    continue
                restore[key] = self[key]
                disk_value = _disk_config_value(self, key)
                if disk_value is _MISSING:
                    dict.__delitem__(self, key)
                    removed.add(key)
                else:
                    dict.__setitem__(self, key, disk_value)
            return original_save_file(self)
        finally:
            for key, value in restore.items():
                dict.__setitem__(self, key, value)
            for key in removed:
                # 内存里本来就没有这个键，摘掉就别再放回
                overridden.discard(key)
            setattr(self, SAVING_ATTR, False)

    Config.save_file = save_file
    return True


# ── 任务查找与状态切换 ────────────────────────────────────────────────

def find_task(executor, key: str):
    for task in executor.get_all_tasks():
        if task_key(task) == key:
            return task
    return None


def resolve_task(executor, key: str):
    if not key:
        raise ValueError("missing task key")
    task = find_task(executor, key)
    if task is None:
        raise ValueError(f"task not found: {key}")
    return task


def set_trigger_enabled(task, enabled: bool) -> None:
    """切换触发任务启用状态：走框架 enable()/disable() 语义，但不落盘。"""
    enabled = bool(enabled)
    if enabled == bool(task._enabled):
        dict.__setitem__(task.config, "_enabled", enabled)
        return
    try:
        if enabled:
            task.enable()
        else:
            task.disable()
    except Exception as e:  # noqa: BLE001 — 设备未就绪等场景仍要落到目标状态
        _note(f"触发任务 {task_key(task)} 状态切换异常：{type(e).__name__}: {e}")
    finally:
        task._enabled = enabled
        dict.__setitem__(task.config, "_enabled", enabled)


# ── 状态快照 ──────────────────────────────────────────────────────────

def snapshot(executor) -> dict:
    current = executor.current_task
    trigger_tasks = list(executor.trigger_tasks or [])
    return {
        "paused": bool(executor.paused),
        "current": task_key(current) if current is not None else None,
        "currentIsTrigger": bool(current is not None and current in trigger_tasks),
        "triggers": [
            {"key": task_key(task), "enabled": bool(task.enabled)}
            for task in trigger_tasks
        ],
        "onetimeQueue": [task_key(task) for task in list(executor.onetime_task_queue or [])],
    }


def emit_state(executor, force: bool = False) -> None:
    global _last_state
    encoded = json.dumps(snapshot(executor), ensure_ascii=False, sort_keys=True)
    if not force and encoded == _last_state:
        return
    _last_state = encoded
    _emit(MARKER_STATE + encoded)


def start_state_ticker(executor) -> None:
    def tick() -> None:
        while True:
            time.sleep(STATE_HEARTBEAT)
            try:
                emit_state(executor)
            except Exception:  # noqa: BLE001 — 执行器销毁中，忽略
                pass

    threading.Thread(target=tick, name="ok-toolkit-state", daemon=True).start()


# ── 命令处理 ──────────────────────────────────────────────────────────

def _set_overlay(enabled: bool) -> None:
    # og.app 是 OK(config) 初始化出的 HeadlessApp 实例；set_overlay_setting
    # 置 ok_config['use_overlay'] 并懒创建（get_overlay_view）/关闭 Win32GdiOverlay，
    # 任务后续 draw_boxes 即时生效，无需重启进程。
    from ok import og

    app = getattr(og, "app", None)
    if app is None:
        raise RuntimeError("app is not ready")
    app.set_overlay_setting("boxes", enabled)
    _emit(MARKER_OVERLAY_ON if enabled else MARKER_OVERLAY_OFF)


def _apply_startup_overlay(enabled: bool) -> None:
    """启动时把宿主的浮层开关**真正**落到框架上。

    为什么必须显式调用，而不是只设 `config['use_overlay'] = True`：
    在 headless 路径下这个配置项是**惰性**的 ——

    1. 唯一消费它的 `OK.initialize_overlay()` 只被 `OK.start_runtime()` 调用，而
       `start_runtime()` 只在 Qt（`ui/qt/MainWindow.py`）和 web（`ui/web/app.py`）
       两条路径触发，执行器两条都不走；
    2. `_create_ok_config()` 也只把它当 `Config('_ok', defaults)` 的**默认值**，而
       `Config.verify_config()` 对「已存在且类型正确」的键会保留磁盘值 ——
       `configs/_ok.json` 里历史留下的 `use_overlay` 还会再盖一层。

    所以「执行器启动时带上 OK_TOOLKIT_USE_OVERLAY=1」此前实际等于没设。
    `overlay_host.py` 之所以能出浮层，也是因为它在 `OK(cfg)` 之后显式调了
    `set_overlay_setting("boxes", True)`；这里做同一件事，只是放在设备连上之后，
    让 `sync_overlay_source()` 能绑到真实窗口。

    浮层失败不该拖垮执行器，所以异常只记一行日志。
    """
    if not enabled:
        return
    try:
        _set_overlay(True)
    except Exception as e:  # noqa: BLE001
        _note(f"调试浮层启用失败：{type(e).__name__}: {e}")


def _apply_params(executor, argument: str) -> None:
    """整体替换参数覆盖表，并即时应用到已加载的任务实例。

    宿主每次推送的是**全量**覆盖表，所以这里做替换而不是合并 —— 合并会让用户清掉的
    覆盖值一直留着。注意已注入过、本次被移除的 key 会保持上次的值直到执行器重启
    （重新读盘需要 task.load_config()，运行期调用风险大于收益）。
    """
    global _overrides
    if not argument:
        return
    try:
        parsed = json.loads(argument)
    except Exception as e:  # noqa: BLE001 — 回传给宿主展示
        raise ValueError(f"invalid params payload: {e}")
    if not isinstance(parsed, dict):
        raise ValueError("params payload must be an object")
    _overrides = {str(key): value for key, value in parsed.items() if isinstance(value, dict)}
    for task in executor.get_all_tasks():
        apply_overrides_to(task)


def _request_stop(ok) -> None:
    try:
        ok.task_executor.stop()
    except Exception:  # noqa: BLE001 — 兜底直接置退出事件
        ok.exit_event.set()


def handle_command(ok, line: str) -> None:
    executor = ok.task_executor
    verb, _, argument = line.strip().partition(" ")
    verb = verb.strip().lower()
    argument = argument.strip()
    if not verb:
        return
    try:
        if verb in ("trigger_enable", "trigger_disable"):
            task = resolve_task(executor, argument)
            if task not in executor.trigger_tasks:
                raise ValueError(f"not a trigger task: {argument}")
            set_trigger_enabled(task, verb == "trigger_enable")
        elif verb == "onetime_enqueue":
            task = resolve_task(executor, argument)
            if task not in executor.onetime_tasks:
                raise ValueError(f"not a one-time task: {argument}")
            # 与 StartController._mark_task_enabled 一致：置启用 + 清信息 + 入队
            task._enabled = True
            if hasattr(task, "info_clear"):
                task.info_clear()
            if not executor.enqueue_onetime_task(task):
                raise ValueError(f"failed to enqueue: {argument}")
        elif verb == "task_disable":
            executor.stop_current_task()
        elif verb == "params":
            _apply_params(executor, argument)
        elif verb == "pause":
            # executor.pause()：置 paused 标志并唤醒执行循环；任务在下一次取 frame
            # 时挂起。已处于暂停时返回 None（幂等），同样回标记让宿主同步状态。
            executor.pause()
            _emit(MARKER_PAUSED)
        elif verb == "resume":
            # executor.start()：executor.paused=False 并补正 pause_end_time。
            executor.start()
            _emit(MARKER_RESUMED)
        elif verb in ("overlay_on", "overlay_off"):
            _set_overlay(verb == "overlay_on")
        elif verb == "stop":
            _request_stop(ok)
            return
        else:
            raise ValueError(f"unknown command: {verb}")
    except Exception as e:  # noqa: BLE001 — 回传给宿主展示
        _emit(f"{MARKER_ERROR}{type(e).__name__}: {e}")
        return
    emit_state(executor, force=True)


def start_stdin_listener(ok) -> None:
    """后台线程按行读取 stdin 命令；EOF（宿主关闭或进程退出）时自然结束。"""

    def listen() -> None:
        try:
            for line in sys.stdin:
                if line.strip():
                    handle_command(ok, line)
        except Exception:  # noqa: BLE001 — stdin 关闭等场景直接退出线程
            pass

    threading.Thread(target=listen, name="ok-toolkit-stdin", daemon=True).start()


# ── 启动与退出 ────────────────────────────────────────────────────────

def read_overrides() -> None:
    global _overrides
    raw = os.environ.get("OK_LANG_HINTS_INJECT", "")
    if not raw:
        return
    try:
        parsed = json.loads(raw)
    except Exception:
        return
    if isinstance(parsed, dict):
        _overrides = {str(key): value for key, value in parsed.items() if isinstance(value, dict)}


def read_startup_triggers() -> set:
    raw = os.environ.get("OK_TOOLKIT_TRIGGERS", "")
    if not raw:
        return set()
    try:
        parsed = json.loads(raw)
    except Exception:
        return set()
    if not isinstance(parsed, list):
        return set()
    return {str(item) for item in parsed if isinstance(item, str)}


def shutdown(ok, code: int = 0) -> None:
    try:
        if ok is not None:
            ok.exit_event.set()
    except Exception:  # noqa: BLE001
        pass
    _emit(MARKER_STOPPED)
    sys.stdout.flush()
    # ok.quit() 在部分项目（SoundContext 等线程未退出）会永久阻塞，导致宿主只能强杀；
    # 标记已输出，直接退出进程。
    os._exit(code)


def main() -> None:
    parser = argparse.ArgumentParser(description="ok-script 常驻执行器（headless）")
    parser.add_argument("--config-module", default="src.config", help="config 模块路径，如 src.config 或 config")
    args, extra_args = parser.parse_known_args()
    if extra_args and extra_args[0] == "--":
        extra_args = extra_args[1:]

    read_overrides()
    sys.path.insert(0, ".")

    # 参数覆盖补丁必须在 import 任务前装好
    install_override_patch()
    install_trigger_persistence_patch()
    # 任务自己写盘时别把插件覆盖值一起带出去（Config.save_file 是整个字典 dump）
    install_override_save_patch()
    # 注：这里**不再**有 windows.args 启动参数补丁。执行器只用目标项目自己的补丁
    # （见 install_project_startup_patches），启动参数由项目在 src/patches/ 里自行处理。

    config_module = __import__(args.config_module, fromlist=["config"])
    config = dict(config_module.config)
    config["check_mutex"] = False
    # 调试插件绝不改动目标项目的 configs/：把框架读写整体改道到沙箱。
    # 必须在 OK(config) 之前 —— 任务是在 OK() 内部实例化的。
    apply_config_sandbox(config)
    # 目标项目自带的启动补丁（src/patches/startup_patches.py）。
    # 项目自己的 main.py 会在 OK(config) 之前调用它，执行器过去**漏了这一步** ——
    # 于是同一份代码"项目自己跑没事、用插件跑就崩"（典型：win32_gdi 污染
    # user32.GetCursorPos.argtypes，导致 Mouse.py 抛 ctypes.ArgumentError）。
    # 详见 install_project_startup_patches() 的说明。
    install_project_startup_patches(args.config_module)
    # ok-script 2.x：config['gui']={'type':'qt'} 会让 OK 创建完整 Qt App 并安装
    # QtEventDispatcher，headless 下没有事件循环，communicate.window/overlay 信号
    # 全部排队丢失，浮层收不到窗口更新。置 None 强制 HeadlessApp（同步分发）。
    config["gui"] = None
    # 浮层开关（宿主经 OK_TOOLKIT_USE_OVERLAY 传入）。注意这一项在 headless 下是
    # **惰性**的，真正生效要等设备连上后由 _apply_startup_overlay() 显式落下去。
    overlay_requested = os.environ.get("OK_TOOLKIT_USE_OVERLAY", "").strip().lower() in ("1", "true", "yes")
    if overlay_requested:
        config["use_overlay"] = True

    # 框架 OK.__init__ 会 parse_arguments() 解析 sys.argv，辅助脚本自身的参数不能带进去
    saved_argv = sys.argv[:]
    sys.argv = [saved_argv[0], *extra_args]
    ok = None
    try:
        from ok import OK

        _emit(MARKER_CONNECTING)
        ok = OK(config)
    except Exception as e:  # noqa: BLE001 — 初始化失败也要让宿主拿到结构化错误
        _emit(f"{MARKER_ERROR}{type(e).__name__}: {e}")
        shutdown(None, 1)
    finally:
        sys.argv = saved_argv

    executor = ok.task_executor
    enabled_keys = read_startup_triggers()
    # 插件的启用集合是权威值：未列出的触发任务一律关掉（项目 configs 里可能残留 true）
    for task in executor.trigger_tasks:
        wanted = task_key(task) in enabled_keys
        task._enabled = wanted
        dict.__setitem__(task.config, "_enabled", wanted)
    if enabled_keys:
        _note(f"启动即入列的触发任务：{len(enabled_keys)} 个")

    start_stdin_listener(ok)
    start_state_ticker(executor)

    try:
        started = ok.headless_app.start_controller.do_start(None)
    except Exception as e:  # noqa: BLE001
        _emit(f"{MARKER_ERROR}{type(e).__name__}: {e}")
        shutdown(ok, 1)
        return
    if not started:
        _emit(f"{MARKER_ERROR}executor failed to start")
        shutdown(ok, 1)
        return

    _emit(MARKER_READY)
    # 设备已连接、窗口已确定，这时才把浮层挂上去（见 _apply_startup_overlay 的说明）
    _apply_startup_overlay(overlay_requested)
    emit_state(executor, force=True)
    _note("执行器已就绪：设备已连接，触发任务按启用集合轮询")

    try:
        while not ok.exit_event.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        _request_stop(ok)
    finally:
        shutdown(ok, 0)


if __name__ == "__main__":
    main()

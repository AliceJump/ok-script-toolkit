# -*- coding: utf-8 -*-
"""测试临时目录的统一根。

背景（2026-09-22 实测）：测试先前把临时目录直接丢在系统临时目录**根部**且从不清理 ——
三天堆了 2671 个目录，另加 1194 个 `.bak`。散落导致既看不清、也没法"跑完一起删"。

布局（三端共用一个父目录，各自只清自己的子树，避免互相误删）::

    <系统临时目录>/ok-script-toolkit-tests/      <- base，统一根
      ├── kt/   Kotlin 测试（jetbrains 的 TestTmp）
      ├── py/   Python 测试（本模块）
      └── js/   Node 测试（scripts/test-tmp.js）

``base`` 来源：环境变量 ``OK_TEST_TMP_ROOT`` 优先（由 ``build.gradle.kts`` 的 ``test``
任务注入，与 Kotlin / Node 侧指向同一个路径），未设置时退回系统临时目录下的固定子目录。

清理：本模块在导入时挂一个 ``atexit`` 钩子，进程退出（含断言失败）时删掉 ``py/`` 整棵；
``base`` 随之空了就一并删掉。因此调用方**不需要**自己删 —— 用 :func:`test_tmp_dir`
拿到的目录，进程一结束就没了；想更早释放的话用 :func:`test_tmp_tempdir` 配 ``with``。

用法::

    from _test_tmp import test_tmp_dir, test_tmp_tempdir

    tmp = test_tmp_dir("ok-probe")                 # 拿到即用，退出时统一收走
    with test_tmp_tempdir("ok-executor") as tmp:   # 退出 with 即删，更早释放
        ...
"""
from __future__ import annotations

import atexit
import os
import shutil
import tempfile

#: 统一临时根的目录名。与 Kotlin 侧 TestTmp.ROOT_DIR_NAME 保持一致。
ROOT_DIR_NAME = "ok-script-toolkit-tests"

#: 本语言在统一根下的子目录名。与 Kotlin 侧 TestTmp.LANG_DIR_NAME 同构。
LANG_DIR_NAME = "py"

#: 环境变量名。与 Kotlin 侧 TestTmp.ROOT_ENV 保持一致。
ROOT_ENV = "OK_TEST_TMP_ROOT"

_cleanup_registered = False


def test_tmp_base() -> str:
    """返回（并确保存在）统一临时根（三端共用的父目录）。"""
    configured = os.environ.get(ROOT_ENV)
    base = configured if configured else os.path.join(tempfile.gettempdir(), ROOT_DIR_NAME)
    os.makedirs(base, exist_ok=True)
    return base


def test_tmp_dir() -> str:
    """返回（并确保存在）Python 测试的落盘目录 ``<base>/py``。"""
    path = os.path.join(test_tmp_base(), LANG_DIR_NAME)
    os.makedirs(path, exist_ok=True)
    _register_cleanup()
    return path


def _cleanup() -> None:
    """删掉 ``py/`` 整棵；``base`` 空了就一并删掉。"""
    base = test_tmp_base()
    target = os.path.join(base, LANG_DIR_NAME)
    # 防御：target 必须真的在 base 之下，绝不能因为某个空值把系统临时目录整个删掉。
    if os.path.commonpath([os.path.abspath(target), os.path.abspath(base)]) != os.path.abspath(base):
        return
    shutil.rmtree(target, ignore_errors=True)
    try:
        if not os.listdir(base):
            os.rmdir(base)
    except OSError:
        pass


def _register_cleanup() -> None:
    global _cleanup_registered
    if not _cleanup_registered:
        # atexit 在正常退出和 sys.exit 时都会跑，因此断言失败（脚本以 1 退出）也能清干净。
        atexit.register(_cleanup)
        _cleanup_registered = True


def make_tmp_dir(prefix: str) -> str:
    """新建一个独占的测试临时目录，落在 ``<base>/py`` 下。返回绝对路径。"""
    return tempfile.mkdtemp(prefix=f"{prefix}-", dir=test_tmp_dir())


def make_tmp_tempdir(prefix: str) -> tempfile.TemporaryDirectory:
    """落在 ``<base>/py`` 下的 ``TemporaryDirectory``：``with`` 退出即删，比等进程结束更早释放。"""
    return tempfile.TemporaryDirectory(prefix=f"{prefix}-", dir=test_tmp_dir())

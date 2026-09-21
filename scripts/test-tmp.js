'use strict';

/**
 * 测试临时目录的统一根（Node / VS Code 扩展侧测试）。
 *
 * 背景（2026-09-22 实测）：测试先前把临时目录直接丢在系统临时目录**根部**且从不清理 ——
 * 三天堆了 2671 个目录。散落导致既看不清、也没法"跑完一起删"。
 *
 * 布局（三端共用一个父目录，各自只清自己的子树，避免互相误删）：
 *
 *     <系统临时目录>/ok-script-toolkit-tests/      <- base，统一根
 *       ├── kt/   Kotlin 测试（jetbrains 的 TestTmp）
 *       ├── py/   Python 测试（python/tests/_test_tmp.py）
 *       └── js/   Node 测试（本模块）
 *
 * base 来源：环境变量 `OK_TEST_TMP_ROOT` 优先（由 jetbrains/build.gradle.kts 的 test
 * 任务注入，与 Kotlin / Python 侧指向同一个路径），未设置时退回系统临时目录下的固定子目录。
 *
 * 清理：本模块挂 `process.on('exit')`，进程退出（含断言失败 / process.exit(1)）时
 * 删掉 `js/` 整棵；base 随之空了就一并删掉。调用方**不需要**自己删。
 *
 * 用法：
 *
 *     const { makeTmpDir } = require('./test-tmp');
 *     const dir = makeTmpDir('ok-vscode-stub');
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 统一临时根的目录名。与 Kotlin 侧 TestTmp.ROOT_DIR_NAME 保持一致。 */
const ROOT_DIR_NAME = 'ok-script-toolkit-tests';

/** 本语言在统一根下的子目录名。 */
const LANG_DIR_NAME = 'js';

/** 环境变量名。与 Kotlin 侧 TestTmp.ROOT_ENV 保持一致。 */
const ROOT_ENV = 'OK_TEST_TMP_ROOT';

let cleanupRegistered = false;

/** 返回（并确保存在）统一临时根（三端共用的父目录）。 */
function testTmpBase() {
  const configured = process.env[ROOT_ENV];
  const base = configured && configured.trim() ? configured : path.join(os.tmpdir(), ROOT_DIR_NAME);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/** 返回（并确保存在）Node 测试的落盘目录 `<base>/js`。 */
function testTmpDir() {
  const dir = path.join(testTmpBase(), LANG_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  registerCleanup();
  return dir;
}

/** 删掉 `js/` 整棵；base 空了就一并删掉。 */
function cleanup() {
  const base = path.resolve(testTmpBase());
  const target = path.join(base, LANG_DIR_NAME);
  // 防御：target 必须真的在 base 之下，绝不能因为某个空值把系统临时目录整个删掉。
  if (!path.resolve(target).startsWith(base + path.sep)) return;
  fs.rmSync(target, { recursive: true, force: true });
  try {
    if (fs.readdirSync(base).length === 0) fs.rmdirSync(base);
  } catch {
    /* ignore */
  }
}

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  // exit 在正常结束与 process.exit(n) 时都会触发，因此断言失败也能清干净。
  process.on('exit', cleanup);
}

/** 新建一个独占的测试临时目录，落在 `<base>/js` 下。返回绝对路径。 */
function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(testTmpDir(), `${prefix}-`));
}

module.exports = {
  ROOT_DIR_NAME,
  LANG_DIR_NAME,
  ROOT_ENV,
  testTmpBase,
  testTmpDir,
  makeTmpDir,
};

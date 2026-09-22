#!/usr/bin/env node
/**
 * 列表值控件的「显示同步」回归测试。
 *
 * 症状（用户报告）：在 VS Code 侧修改**列表值**类型的配置键，点确认后
 * **磁盘已落盘，但界面上显示的摘要仍是旧值**。
 *
 * 根因：`buildList` 的摘要是一段**静态文本**，而编辑发生在**独立弹窗**里 ——
 * 确认只调 `setValue()` 写模型，没有任何人重画摘要。
 * 对比 `buildMultiSelection`（`<select>` 自身就是控件）与 `buildStructuredList`
 * （`textarea` 自身持值），它们天然同步 —— 所以只有 list 有这个毛病。
 *
 * 用 jsdom 跑真实的 控件 → 弹窗 → 确认 链路，而不是只测某个纯函数。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const repoRoot = path.resolve(__dirname, '..');
const fieldsSource = fs.readFileSync(path.join(repoRoot, 'media', 'console', 'fields.js'), 'utf-8');

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

/** 建一个装着 fields.js 的 jsdom 环境（IIFE 需要 globalThis.TaskLauncherCore.t）。 */
function setupWindow() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.TaskLauncherCore = { t: key => key };
  window.eval(fieldsSource);
  assert.ok(window.TaskLauncherFields, 'fields.js 应把 buildField 挂到 globalThis.TaskLauncherFields');
  return window;
}

const window = setupWindow();

/** 建一个 list 类型控件，返回 { container, summary, modify, config } */
function buildListField(options) {
  const field = {
    key: options.key,
    displayKey: options.displayKey || options.key,
    type: {
      type: 'list',
      options_available: options.available,
      options_available_labels: options.labels,
      allow_duplication: options.allowDup === true,
    },
    value: options.value,
  };
  const config = {};
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  window.TaskLauncherFields.buildField(container, field, config, () => {});
  return {
    container,
    config,
    summary: () => container.querySelector('.list-editor__summary').textContent,
    modify: () => container.querySelector('.list-editor__modify'),
  };
}

function clickDialogOption(label) {
  const buttons = [...window.document.querySelectorAll('.list-dialog__option')];
  const target = buttons.find(button => button.textContent === label);
  assert.ok(target, `弹窗里应有选项「${label}」，实际：${buttons.map(b => b.textContent).join('/')}`);
  target.click();
}

function clickDialogConfirm() {
  const buttons = [...window.document.querySelectorAll('.list-dialog__footer button')];
  const confirm = buttons.find(button => button.textContent === 'confirm');
  assert.ok(confirm, '弹窗底部应有确认按钮');
  confirm.click();
}

// ── 1. 初始摘要 ──────────────────────────────────────────────────────
console.log('初始摘要');
{
  const f = buildListField({
    key: 'stage_list',
    available: ['a', 'b', 'c'],
    labels: ['甲', '乙', '丙'],
    value: ['a'],
  });
  check(f.summary() === '甲', `只有一项时直接显示该项（实际：${JSON.stringify(f.summary())}）`);
}

// ── 2. 核心回归：确认后摘要必须刷新 ──────────────────────────────────
console.log('\n确认后摘要刷新');
{
  const f = buildListField({
    key: 'stage_list',
    available: ['a', 'b', 'c'],
    labels: ['甲', '乙', '丙'],
    value: ['a'],
  });

  f.modify().click();
  check(
    window.document.querySelector('.list-dialog__backdrop') !== null,
    '点「修改」后弹窗打开',
  );

  clickDialogOption('乙');
  clickDialogConfirm();

  check(
    JSON.stringify(f.config.params.stage_list) === JSON.stringify(['a', 'b']),
    '确认后模型已更新（这一步修复前就是对的 —— 所以问题只出在显示）',
  );
  check(
    f.summary() === '甲, 乙',
    `**摘要必须跟着刷新成新值**（实际：${JSON.stringify(f.summary())}）—— 修复前这里仍是「甲」`,
  );
}

// ── 3. 移除后摘要也要刷新 ────────────────────────────────────────────
console.log('\n移除项后摘要刷新');
{
  const f = buildListField({
    key: 'stage_list',
    available: ['a', 'b', 'c'],
    labels: ['甲', '乙', '丙'],
    value: ['a', 'b'],
  });
  check(f.summary() === '甲, 乙', '初始两项');

  f.modify().click();
  // 选中第一行再点「移除」
  window.document.querySelector('.list-dialog__row').click();
  const removeButton = [...window.document.querySelectorAll('.list-dialog__actions button')]
    .find(button => button.textContent === 'removeItem');
  removeButton.click();
  clickDialogConfirm();

  check(
    f.summary() === '乙',
    `移除后摘要应只剩一项（实际：${JSON.stringify(f.summary())}）`,
  );
}

// ── 4. 自由编辑模式（无 options_available）同样要刷新 ────────────────
console.log('\n自由编辑模式');
{
  const f = buildListField({
    key: 'free_list',
    available: undefined,
    labels: undefined,
    value: ['x'],
  });
  check(f.summary() === 'x', '初始显示 x');

  f.modify().click();
  const addInput = window.document.querySelector('.list-dialog__add-row input[type="text"]');
  assert.ok(addInput, '自由编辑模式应有文本添加输入框');
  addInput.value = 'y';
  // 添加按钮初始 disabled，靠 input 事件启用 —— 只改 .value 不派发事件它仍是禁用的
  addInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  const addButton = window.document.querySelector('.list-dialog__add-row button');
  assert.ok(addButton && !addButton.disabled, '填入内容后添加按钮应可用');
  addButton.click();
  clickDialogConfirm();

  check(
    f.summary() === 'x, y',
    `自由编辑模式确认后摘要也要刷新（实际：${JSON.stringify(f.summary())}）`,
  );
}

// ── 5. 破坏性对照：证明这条断言不是空过 ──────────────────────────────
//
// 把 apply 换回"只写模型、不刷新摘要"的旧写法，摘要会停在旧值 ——
// 也就是用户看到的现象。这里用一份就地改造过的源码验证该因果。
console.log('\n破坏性对照');
{
  const brokenSource = fieldsSource.replace(
    /items = value;\s*setValue\(value\);\s*renderSummary\(\);/,
    'setValue(value);',
  );
  check(brokenSource !== fieldsSource, '对照源码确实被改动了（替换命中）');

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.TaskLauncherCore = { t: key => key };
  w.eval(brokenSource);

  const container = w.document.createElement('div');
  w.document.body.appendChild(container);
  const config = {};
  w.TaskLauncherFields.buildField(
    container,
    {
      key: 'stage_list',
      displayKey: 'stage_list',
      type: { type: 'list', options_available: ['a', 'b'], options_available_labels: ['甲', '乙'] },
      value: ['a'],
    },
    config,
    () => {},
  );

  container.querySelector('.list-editor__modify').click();
  const optionYi = [...w.document.querySelectorAll('.list-dialog__option')]
    .find(button => button.textContent === '乙');
  optionYi.click();
  [...w.document.querySelectorAll('.list-dialog__footer button')]
    .find(button => button.textContent === 'confirm')
    .click();

  const staleSummary = container.querySelector('.list-editor__summary').textContent;
  check(
    JSON.stringify(config.params.stage_list) === JSON.stringify(['a', 'b']),
    '对照：模型照样更新了',
  );
  check(
    staleSummary === '甲',
    `对照：摘要停在旧值「甲」—— 这正是用户报告的现象（实际：${JSON.stringify(staleSummary)}）`,
  );
}

console.log('\n' + (failures.length ? `失败 ${failures.length} 项` : '全部通过'));
process.exit(failures.length ? 1 : 0);

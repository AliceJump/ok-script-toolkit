/**
 * 全局 UI 一致性审计（docs/design-system.md 第 11/12 条）。
 *
 * 这是一个**静态结构审计**，不启动 webview：它校验「有没有接上共享设计层」以及
 * 「有没有绕过 token 自己造视觉」。这类问题此前都是人肉 review 才发现的
 * （例如某面板 4px 圆角、某面板 rgba(0,0,0,.55) 黑块、某面板忘了引 shared）。
 *
 * 校验项：
 *   1. 每个面板 HTML 必须按 顺序 引入 shared/tokens.css → shared/controls.css → 自身样式；
 *   2. 每个面板宿主必须调用 applySharedAssets（否则占位符留在 HTML 里，样式静默失效）；
 *   3. 面板 CSS 不得出现 hex/rgb 字面量、不得直引 --vscode-*（唯一例外是 shared/tokens.css）；
 *   4. 面板 CSS 的圆角/字号不得写裸 px（必须走 radius / font token）；
 *   5. 面板 CSS 里用到的 var(--x) 必须在 shared 或本文件内有定义（防拼写漂移）。
 *
 * 例外：canvas 绘图色（如标注框描边）属于**图像内容**而非 UI 主题，不受第 3 条约束。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mediaDir = path.join(root, 'media');
const sharedDir = path.join(mediaDir, 'shared');

/** 面板目录 → 宿主源文件（用于校验 applySharedAssets 调用） */
const PANEL_HOST = {
  console: 'src/consolePanel.ts',
  templatePanel: 'src/templatePanel.ts',
  templateAssetPanel: 'src/templateAssetPanel.ts',
  tempScreenshots: 'src/tempScreenshotPanel.ts',
  annotationPanel: 'src/annotationPanel.ts',
  characterManager: 'src/characterPanel.ts',
};

const read = (p) => fs.readFileSync(p, 'utf8');
/** 去掉注释后再做字面量扫描（注释里举例说明旧写法是允许的） */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const sharedTokens = stripComments(read(path.join(sharedDir, 'tokens.css')));
const sharedControls = stripComments(read(path.join(sharedDir, 'controls.css')));
const sharedAll = sharedTokens + '\n' + sharedControls;

const panels = fs.readdirSync(mediaDir).filter((name) => {
  const dir = path.join(mediaDir, name);
  return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'index.html'));
});

assert(panels.length >= 6, `面板数量异常：${panels.join(', ')}`);
console.log(`1. 发现 ${panels.length} 个面板：${panels.join(', ')}`);

for (const panel of panels) {
  const dir = path.join(mediaDir, panel);
  const html = read(path.join(dir, 'index.html'));

  console.log(`2. [${panel}] 共享层引入顺序与宿主接线`);
  const iTokens = html.indexOf('__SHARED_TOKENS_URI__');
  const iControls = html.indexOf('__SHARED_CONTROLS_URI__');
  const iStyle = html.indexOf('__STYLE_URI__');
  assert(iTokens >= 0, `${panel}/index.html 未引入 shared/tokens.css`);
  assert(iControls >= 0, `${panel}/index.html 未引入 shared/controls.css`);
  assert(iTokens < iControls, `${panel}: tokens.css 必须在 controls.css 之前`);
  assert(iControls < iStyle, `${panel}: 面板自身样式必须排在共享层之后（否则覆盖不生效）`);

  const hostRel = PANEL_HOST[panel];
  assert(hostRel, `${panel} 未登记宿主源文件（新增面板请补 PANEL_HOST）`);
  const host = read(path.join(root, hostRel));
  assert(host.includes('applySharedAssets'), `${hostRel} 未调用 applySharedAssets（占位符不会被替换）`);
  assert(host.includes('__STYLE_URI__'), `${hostRel} 未注入面板样式 URI`);

  // 收紧 localResourceRoots 的面板必须显式放行 media/shared
  const rootsLine = host.match(/localResourceRoots:\s*\[([\s\S]*?)\]/g) || [];
  const narrowed = rootsLine.filter((block) => !block.includes('extensionUri'));
  if (narrowed.length) {
    assert(host.includes('sharedResourceRoot'),
      `${hostRel} 的 localResourceRoots 未放行 extensionUri，必须加 sharedResourceRoot(...)`);
  }
}

for (const panel of panels) {
  const dir = path.join(mediaDir, panel);
  const cssFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
  for (const file of cssFiles) {
    const rel = `media/${panel}/${file}`;
    const css = stripComments(read(path.join(dir, file)));

    console.log(`3. [${rel}] 无字面量色 / 无直引 --vscode-*`);
    const literals = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
    assert(literals.length === 0, `${rel} 仍有硬编码颜色：${literals.join(', ')}（改用 tokens）`);
    const vscodeVars = [...new Set(css.match(/--vscode-[a-z-]+/g) || [])];
    assert(vscodeVars.length === 0,
      `${rel} 直引了 VS Code 变量：${vscodeVars.join(', ')}（唯一允许处是 media/shared/tokens.css）`);

    console.log(`4. [${rel}] 圆角/字号走 scale`);
    const rawRadius = css.match(/border-radius:\s*\d+px/g) || [];
    assert(rawRadius.length === 0, `${rel} 有裸 px 圆角：${rawRadius.join(', ')}（改用 --radius-*）`);
    const rawFont = css.match(/font-size:\s*\d+px/g) || [];
    assert(rawFont.length === 0, `${rel} 有裸 px 字号：${rawFont.join(', ')}（改用 --font-*）`);

    console.log(`5. [${rel}] var() 全部有定义`);
    const defined = new Set();
    for (const src of [sharedAll, css]) {
      for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
    }
    // VS Code 主题变量由宿主提供，不算未定义
    const missing = [...new Set((css.match(/var\((--[a-z0-9-]+)/g) || []).map((v) => v.slice(4)))]
      .filter((name) => !defined.has(name) && !name.startsWith('--vscode-'));
    assert(missing.length === 0, `${rel} 使用了未定义的变量：${missing.join(', ')}`);
  }
}

console.log('6. shared/tokens.css 仍是唯一直引 --vscode-* 的文件');
const offenders = [];
for (const panel of panels) {
  const dir = path.join(mediaDir, panel);
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.css')) continue;
    if (stripComments(read(path.join(dir, file))).includes('--vscode-')) offenders.push(`media/${panel}/${file}`);
  }
}
for (const file of fs.readdirSync(sharedDir)) {
  if (!file.endsWith('.css') || file === 'tokens.css') continue;
  if (stripComments(read(path.join(sharedDir, file))).includes('--vscode-')) offenders.push(`media/shared/${file}`);
}
assert(offenders.length === 0, `以下文件直引了 --vscode-*：${offenders.join(', ')}`);

console.log('\n全部通过');

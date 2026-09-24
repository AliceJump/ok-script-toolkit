# ok-script-toolkit · 全局 UI 统一设计规范

> 本文件是全项目 UI 的唯一权威规范。所有 webview 面板（console / templatePanel /
> templateAssetPanel / tempScreenshots / annotationPanel / characterManager）必须遵循。
> 实现真源：`media/shared/tokens.css`（Design Tokens）+ `media/shared/controls.css`（共享控件），
> **页面只负责组合这些类，不得自行重定义视觉规则。**

## 0. 核心要求

> **不是把每个页面分别做得好看，而是让整个 UI 看起来像由同一套设计系统设计出来的。**

---

## 1. 统一设计语言

必须建立并遵循统一 Design System，覆盖：页面背景 / 容器背景 / 卡片 / 按钮 / 输入框 /
下拉框 / Checkbox·Radio·Switch / Tab / 标签 / 列表 / 分隔线 / 图标 / Tooltip /
Dialog·Modal / 状态提示 / Loading / 空状态 / 错误状态。同类组件必须使用同一种视觉语言。

## 2. 统一颜色体系

统一颜色层级（页面背景 > 一级容器 > 控件面 > Hover/Active），不得按组件单独定义颜色。

| 语义 | Token | 说明 |
|---|---|---|
| 页面背景 | `--bg-page` | 最底层 |
| 一级容器 | `--bg-container` / `--bg-container-raised` | 面板 / 卡片 |
| 控件面（真按钮） | `--bg-control` | Button / IconButton 的**默认**底色（配描边） |
| 行级面（组头、折叠标题行） | `--bg-row` | 行级可点击区的极浅底色——默认可识别但不与按钮同权重 |
| Hover / Active | `--bg-control-hover` / `--bg-control-active` / `--bg-row-hover` / `--surface-hover` | 交互态 |
| 边框 | `--border` / `--border-strong` | 常规 / 聚焦 |
| 主文字 | `--text-primary` | |
| 次要文字 | `--text-muted` | |
| 禁用文字 | `--text-disabled` | |
| 语义色 | `--ok` / `--run` / `--warn` / `--pause` / `--err` | 禁止另造色值 |

**禁止**：页面/组件直引 `--vscode-*` 变量（仅 `tokens.css` 允许）、硬编码 hex/rgba。

## 3. 所有可点击控件统一表现

可点击控件**默认状态**即须有明确可点击表现：

- ❌ 默认只是普通文字 / ❌ 默认与容器融为一体 / ❌ 只有 Hover 后才出现背景
- ✅ 默认即有底色，Hover 是**增强**，不承担「让用户第一次发现这是按钮」的职责

**两类控件分层**（避免整屏层层方块）：

| 类别 | 用法 | 默认态 |
|---|---|---|
| 真按钮 | 动作类：保存/同步/重置/启用/关闭/图标按钮 | `background: var(--bg-control)` + `border: 1px solid var(--border)` |
| 行级可点击区 | 组头、折叠标题行、列表内的可点击行 | `background: var(--bg-row)`（极浅色调）+ **无描边**，Hover 用 `--bg-row-hover` |

同类按钮须一致：高度（`--control-h-sm/md/lg`）、内边距（`--space-*`）、字体、圆角
（`--radius-*`）、边框、背景、图标尺寸、图标与文字间距、Hover/Active/Focus/Disabled。

## 4. 统一尺寸体系

- 间距：`--space-xs(4) / sm(6) / md(10) / lg(14) / xl(20)`
- 控件高度：`--control-h-sm(24) / md(30) / lg(34)`
- 圆角：`--radius-sm(5) / md(8) / lg(11) / pill`
- 字号：`--font-xs(11) / sm(12) / md(13) / lg(15)`；字重仅 `--weight-regular(400)` / `--weight-medium(500)`

禁止无依据的 32/35/38/30px 按钮高度混用，禁止 4/6/10/不圆的圆角混用。

## 5. 统一 Typography

字体继承 `--vscode-font-family`；层级：页面标题 / Section 标题（`.panel-section-title`）/
正文 / 辅助文字（`.panel-hint`） / Label / Button Text / Caption / Error·Warning Text。
字重仅 400 / 500。

## 6. 统一圆角、边框和阴影

- Border Radius：仅 `--radius-sm/md/lg/pill`
- Border Width：`--border-width`（1px）；Border Color：`--border` / `--border-strong`
- Shadow：仅 `--shadow`，且仅用于浮层（抽屉 / 弹窗 / 悬浮卡）

## 7. 统一交互状态

所有交互组件遵循：`Default / Hover / Active / Focus / Disabled / Loading`。
`Focus` 必须用 `--border-strong` 或 outline 呈现；`Disabled` 统一 `opacity: .45` + `not-allowed`。

## 8. 同功能必须使用同组件

保存 / 取消 / 删除 / 添加 / 编辑 / 刷新 / 设置 / 关闭 / 确认 → 复用共享 Button·IconButton；
输入框 → 统一 Input；下拉 → 统一 Select；弹窗 → 统一 Dialog；标签 → 统一 Tag；
提示 → 统一 Toast·Alert；开关 → 统一 Switch。**优先复用现有组件，而不是复制 CSS。**

## 9. 统一布局

页面边距、内容最大宽度、Section 间距、Header 高度、Toolbar 高度（`.panel-toolbar`）、
卡片间距、Dialog 布局、操作区布局保持一致；跨页面切换应感觉属于同一应用。

## 10. 不允许局部「特立独行」

消除：按钮特别大 / 没有边框 / Hover 才出现背景 / 不同圆角 / 不同字体 / 不同颜色体系 /
同功能不同外观 / 相同组件多套实现。无明确 UX 理由不得为单页面创造特殊样式。

## 11. 设计系统资产

```
media/shared/tokens.css      Colors · Typography · Spacing · Radius · Border · Shadow · Sizes
media/shared/controls.css    Button(主/次/迷你/幽灵/图标) · Input · Select · Checkbox/Switch
                             · Tag · Card · Toolbar · SectionTitle · Empty/Broken/Hint · Divider
                             · 可点击性硬规范（[role=button]、真按钮/行级区分层清单）
```

新增面板接入方式（**三步，缺一步样式就静默失效**）：

1. `index.html` 按顺序引入 `__SHARED_TOKENS_URI__` → `__SHARED_CONTROLS_URI__` → 面板自身样式
   （顺序即层叠优先级：面板可以覆盖共享层）；
2. 宿主 `buildHtml` 用 `applySharedAssets(webview, extensionUri, html)` 替换两个占位符
   （`src/webviewHtml.ts`，唯一实现；不要在面板里再抄一份 `asWebviewUri` 组装）；
3. `localResourceRoots` 若没有放行整个 `extensionUri`，必须补 `sharedResourceRoot(extensionUri)`
   （收紧到 `media/<面板>` 的面板否则加载不到 shared 资源）。

**自动审计**：`node scripts/test_design_system.js` —— 校验上面三步 + 面板 CSS 无字面量色 /
无 `--vscode-*` 直引 / 圆角字号走 scale / `var()` 全部有定义。
例外：canvas 绘图色（标注框描边等）属于**图像内容**而非 UI 主题，不受色值约束。

## 12. 最终验收标准（全局 UI Audit 清单）

1. 所有页面使用同一套设计语言
2. 同类组件视觉一致
3. 所有可点击控件默认状态即可识别
4. Hover 不再承担「显示这是按钮」的职责
5. 没有裸文字按钮
6. 没有与容器完全融为一体的按钮
7. 颜色、字体、间距、圆角、边框、阴影统一
8. 相同功能复用相同组件
9. 不存在只在某一个页面使用的无必要特殊样式
10. 从任意页面切换到另一个页面，都应明显感觉属于同一个完整的产品

---

## 落地进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| S1 | 建立 `media/shared/{tokens,controls}.css`；console 接入（视觉零变化，4 个 jsdom 测试守护）；宿主 `localResourceRoots` 放行 | ✅ 已完成 |
| S2 | templatePanel / templateAssetPanel 迁移 | ✅ 已完成 |
| S3 | tempScreenshots / annotationPanel 迁移 | ✅ 已完成 |
| S4 | characterManager 迁移（token 别名化 + 基础控件去重 + 标签页/圆角/字号 scale 化） | ✅ 已完成 |
| S5 | 全局 Audit：`scripts/test_design_system.js` 静态审计已就位；剩 i18n 硬编码清理、真实主题截图人工复核 | 🔄 进行中 |

**六个面板全部接入共享层**（2026-09-23，`feat/sidebar-styling`）：
`console` / `templatePanel` / `templateAssetPanel` / `tempScreenshots` / `annotationPanel` /
`characterManager` —— 全部走同一套 token 与控件层。收口成果（自动审计断言）：

| 指标 | 迁移前 | 迁移后 |
|---|---|---|
| 面板 CSS 直引 `--vscode-*` | 6 个文件、共 40+ 处 | **0**（唯一允许处 = `media/shared/tokens.css`） |
| 面板 CSS 字面量色（hex/rgb） | 6 个文件 | **0**（canvas 绘图色除外，见上） |
| 裸 px 圆角 / 字号 | 17 处 / 多处 | **0**（`--radius-*` / `--font-*`） |
| 工具条按钮 | 各自一套 `padding/border/background` | 共享 `.mini-btn` / `.icon-btn` / `.mini-btn.is-active` |

**迁移踩到的坑（已修）**：`src/webviewHtml.ts` 顶层 `import vscode` 会让 `scripts/`
下的纯函数单测崩在 `Cannot find module 'vscode'` —— 改为类型导入 + 函数体内延迟
`require`，纯函数保持可独立测试。

**已完成的具体整改**（console）：
- 「⚙ 参数」按钮：移除 `--warn` 黄色警示语义，全部状态中性化（默认 = 控件面 + 描边；
  已修改 = 描边强化；打开中 = 控件面加深）
- 可点击元素规范（分层，2026-09-23 定案）：
  - **真按钮** = `--bg-control` + 描边 → 分组折叠按键 / `.btn-mini` / 图标按钮 / 危险按钮
  - **行级可点击区** = `--bg-row` 极浅色调 + 无描边 → 启动设置折叠头 / 任务分组头 /
    kind 级组头 / 卡片头 / 未选中分段 tab / 游戏状态行
  - 首版曾把 `--bg-control` 一刀切应用到全部可点击元素，导致侧栏成为层层方块墙
    （用户反馈「好丑」）——按钮与行头是两种权重，不可同色同框
- `[hidden]` 兜底、折叠状态持久化（uiState）、i18n 六语言键对等

**其他面板的具体整改**：
- 缩略图/tile 上的悬浮按钮（`templatePanel.open-btn`、`templateAssetPanel.actions`、
  `tempScreenshots` 卡片操作）**由「仅 hover 可见」改为常驻可见**，底色改控件面 + 描边，
  去掉了 `rgba(0,0,0,.55)+#fff`（浅色主题下是黑块）
- 模态遮罩/投影统一走 `--scrim` / `--shadow-sm` / `--shadow-lg`
- `annotationPanel` 工具条 ↔ 模态按钮改用共享 `.mini-btn`；`characterManager` 移除本地
  `:root` token 定义（保留短别名指向共享 token）、基础 `button/input` 声明去重、标签页
  改为「未选中浅底色 / 选中控件面」

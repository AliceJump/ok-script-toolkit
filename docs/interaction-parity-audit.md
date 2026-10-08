# 双端交互差异核对

[简体中文](interaction-parity-audit.md) | [English](interaction-parity-audit.en.md)

核对日期：2026-10-08。VS Code 主仓提交 `8bca7fd`，JetBrains 子仓提交 `aadd024`，两端源码版本为 `1.24.0`。

本表比较上述基线源码实际注册的页面，覆盖入口、布局、选中、按钮、点击、编辑、保存、提示与快捷键。这里保留改动前的差异；随后按用户指定的 VS Code 基准对齐标注管理与预览，结果见文末。开始核对前的试改已撤回。

这是源码核对，未启动两个 IDE 做交互或截图验收。源码明确没有的入口写为“当前页面无对应入口”；不能据此推断整个插件没有任何实现。主题、缩放、焦点与键盘的实际表现仍需真实 IDE 验证。共享 Python、数据格式或测试通过，也不代表交互一致。

## 1. 实际入口与页面组织

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 01 | 侧边入口 | 三个活动栏容器：工具、模板、临时截图；模板容器中同时放资源预览与标注管理 | 四个独立工具窗口：标注管理、资源预览、临时截图、任务，默认均在右侧 | 相同资源功能的分组与切换路径不同；左/右停靠本身属于宿主布局差异 |
| 02 | 任务主导航 | 页面内侧栏：任务、游戏、配置、账号 | 顶部页签：任务、配置、运行、工具 | 分类与顺序都不同，不只是控件形状不同 |
| 03 | 游戏连接与浮层 | 游戏页包含连接、断开、浮层开关；顶部另有游戏状态条 | 运行页中的游戏卡包含连接、断开、浮层开关 | 同一操作要进入不同类别 |
| 04 | 其他工具入口 | 游戏页提供角色管理入口；资源与截图另在活动栏容器中 | 工具页集中放独立编辑器/工具窗口入口 | 找角色、资源、截图的路径不同 |
| 05 | 执行器操作位置 | 顶部常驻执行器状态条与启动、暂停、停止按钮 | 底部常驻执行器条，含日志图标按钮 | 同一组运行操作的位置不同 |

来源：[主仓注册](../package.json)、[VS Code 任务页面](../media/console/index.html)、[JetBrains 注册](../jetbrains/src/main/resources/META-INF/plugin.xml)、[JetBrains 任务页面](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskLauncherToolWindowFactory.kt)。

## 2. 资源预览卡片：用户指出的直接差异

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 06 | Template / Rect / Point 切换 | 三个并排按钮，当前模式按钮突出显示 | 下拉框选择模式 | 一端直接可见三个模式，另一端需要打开下拉框 |
| 07 | 插入、复制、原图按钮 | 每张缩略图右下角常驻三个按钮，直接操作该卡片 | 顶部工具栏的插入、复制、打开按钮，通过 `selectedValue` 操作选中项；卡片内无按钮 | 直接点目标卡片按钮，与先选目标再点顶部按钮，两条操作路径不同 |
| 08 | 选中反馈与目标 | 卡片无用于这些按钮的列表选中态；每个按钮闭包绑定自身资源 | `JBList` 单选；渲染器按选中态改变背景、文字和边框 | 另一端有持续选中项，顶部按钮依赖它；操作目标的表达方式不同 |
| 09 | 单击/双击判定 | 卡片单击延迟插入，双击复制；统一使用 500 ms；卡片按钮立即执行 | 同样单击插入、双击复制，但等待系统 `awt.multiClickInterval`，不可用时才是 500 ms；插入还要求当前选中项与点击项相同 | 单击/双击结果大体相同，但时序与选中依赖不同 |
| 10 | 网格与卡片规格 | CSS 自适应网格，最小列宽 118 px；缩略图区域 96 px；名称靠左 | `JList.HORIZONTAL_WRAP`，固定格宽为 120 加缩放边距；缩略图 72 加宿主缩放；名称居中，10 pt 粗体，按字符截短 | 排列密度、空间利用、标题对齐和截断方式不同；数值来自源码，非实测像素 |
| 11 | 计数、空态、缩略图状态 | 展示筛选数/总数、加载成功/失败数；无资源、无匹配有明确文字 | 当前预览组件只有工具栏、搜索和列表；加载结果异常回退为空集合，没有同等计数、空态和失败统计控件 | 空列表与加载失败更难从页面区分；这里未判断全部底层错误处理 |

来源：[VS Code 卡片](../media/templatePanel/app.js)、[卡片样式](../media/templatePanel/style.css)、[共享按钮样式](../media/shared/controls.css)、[点击判定](../media/shared/thumbnailActions.js)、[JetBrains 实际预览](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/PreviewCardToolWindows.kt)、[网格规格](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/ThumbGridPolicy.kt)、[JetBrains 点击判定](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/ThumbnailActions.kt)。

重要定位：JetBrains 注册的是 `CardResourcePreviewToolWindowFactory`，宽屏编辑器也实例化 `UnifiedResourcePreview`。旧 `TemplateGalleryPanel` 中确有右下角 `ThumbnailActions`，但当前这两个预览入口使用的是 `PreviewCardRenderer`，后者没有卡片按钮。不能用旧组件的实现或测试证明当前页面已经一致。

## 3. 原图与标注管理列表

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 12 | 打开标注编辑 | 单击原图卡片立即打开编辑器 | 单击选择原图；双击打开，或先选中再点顶部编辑按钮 | 同一个单击动作的含义不同 |
| 13 | 查看、交换、删除 | 原图卡片右下角三个常驻按钮，直接绑定图片 | 顶部查看、交换、删除按钮，操作当前选中图片；卡片中没有这些按钮 | 用户指出的选中式/右下角按钮差异在这里同样存在 |
| 14 | 顶部工具栏职责 | 导入、截图、前台选项、发布、搜索、计数；单图动作留在卡片 | 前台选项、刷新、导入、截图、编辑、查看、交换、删除、发布；搜索在下一行 | 全局动作和单图动作混放程度不同；工具栏拥挤程度与查找路径不同 |
| 15 | 交换目标选择与确认 | Webview 内缩略图目标选择浮层，最终通过宿主警告消息确认 | `SwapTargetDialog` 选择缩略图，`Messages.showYesNoDialog` 最终确认 | 目标与缩放确认语义相同，弹窗位置、控件与关闭方式不同 |

来源：[VS Code 原图页面](../media/templateAssetPanel/index.html)、[卡片事件](../media/templateAssetPanel/app.js)、[主仓交换流程](../src/templateAssetPanel.ts)、[JetBrains 原图面板](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/UnifiedPublishToolWindows.kt)、[卡片装饰器](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/PreviewCardToolWindows.kt)、[交换选择器](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/SwapTargetDialog.kt)。

## 4. 统一标注编辑器

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 16 | 编辑器载体 | 编辑器区域的 Webview 标签页 | `UnifiedAnnotationDialog` 原生对话框 | 工作空间、切回代码和关闭入口不同 |
| 17 | 保存与取消 | 编辑动作提交后立即请求保存工作文件；没有整场编辑的保存/取消按钮 | 编辑保存在会话中，点击保存才整体写回；取消放弃本次会话改动 | 是否已经落盘、关闭是否保留修改的预期不同；两端保存都不等于发布 |
| 18 | 模式和工具布局 | 模式按钮、历史选项、绘制/坐标/删除、撤销重做与图片导航在同一工具栏 | 模式是单选圆钮；模式/历史选项一行，绘制/坐标等另一行 | 模式控件、排列顺序与工具栏高度不同 |
| 19 | 创建后的参数输入 | 新建弹层能输入名称与 X/Y/W/H；Point 隐藏 W/H | 绘制后只弹名称输入，尺寸由绘制决定 | 一端能直接校准坐标，另一端需要回到画布调整 |
| 20 | 双击现有标注 | 打开名称和坐标/尺寸编辑弹层 | `editName` 只修改名称 | 同一双击动作可编辑的内容不同 |
| 21 | 标注显隐 | 每行可见性复选框；还有全部显示、全部隐藏、仅当前按钮 | `syncRows` 只生成名称选择按钮；当前对话框无对应显隐入口 | 处理重叠标注的操作能力不同 |
| 22 | 删除按钮和 D | 删除按钮/D 切换删除模式，随后点击目标删除；Delete 可删除选中项 | 删除按钮直接删选中项；只有 Delete 绑定，当前页面未绑定 D 删除模式 | 同名按钮点击后的状态与下一步不同 |
| 23 | 快捷键可配置性 | `okScriptToolkit.annotationKeybindings` 可配置；页面从宿主消息读取绑定 | `installKeys` 固定绑定 M/R/C、Ctrl+Z/Y/C/V、Delete | 用户自定义快捷键的能力不同；不能用 IDE 普通快捷键设置推断画布绑定可配置 |
| 24 | 方向键与切图 | 有选中标注时方向键微调，Shift 步长 10，否则步长 1；无选中项时默认左右键切图 | 当前 `installKeys` 无微调/切图方向键绑定；切图使用按钮 | 精确微调和连续图片操作的键盘路径不同 |
| 25 | 坐标复制框调整 | 坐标框有移动、缩放手柄，调整后更新/复制坐标 | `coordRect` 创建后可复制与显示；当前统一画布没有该框的拖动/手柄分支 | 临时坐标框是否能复用调整不同；JetBrains 临时截图画布另有手柄，不能算作这里已实现 |
| 26 | 颜色与光标读数 | 底部显示 RGB 色块、绝对/相对坐标；右键标注可触发颜色复制 | 底部为状态文字；当前统一画布无 RGB 色块/颜色复制入口，右键按下直接忽略 | 画面取色与读数入口不同 |
| 27 | 标注侧栏多选 | 点击名称选择；Ctrl/Meta/Shift 点击名称可切换多选 | 侧栏名称按钮总是 `selectOnly`；修饰键多选只接在画布上 | 相同修饰键在列表上的作用不同 |
| 28 | 冲突区位置 | 冲突区位于右侧标注列表标题下方、标注行之前 | 冲突面板放在列表区域底部；有独立内部滚动区 | 同样提供逐项选择当前/外部版本和应用按钮，但操作位置不同 |

来源：[VS Code 工具栏](../media/annotationPanel/index.html)、[画布/弹层/键盘](../media/annotationPanel/app.js)、[冲突界面](../media/annotationPanel/conflict.js)、[快捷键设置](../package.json)、[JetBrains 对话框](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/UnifiedAnnotationUi.kt)、[冲突面板](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/AnnotationConflictPanel.kt)。对 JetBrains 缺少入口的判断依据是实际 `createCenterPanel`、`syncRows`、`installKeys` 与 `installMouse`，没有把旧编辑器或其他画布算进来。

## 5. 任务、参数与账号

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 29 | 参数入口 | 卡片上的参数按钮打开该任务抽屉；卡片主体不负责选中并加载详情 | 单击卡片主体选中任务并加载详情 | 参数按钮式与主从选中式并存 |
| 30 | 参数布局与关闭 | 参数覆盖抽屉；可点关闭、遮罩或 Escape 收起 | 列表与详情持久分栏，窄于 560 时上下分栏，较宽时左右分栏 | 一端临时覆盖内容，另一端持续占用空间；关闭路径不同 |
| 31 | 任务信息呈现 | 名称、触发/一次性文字标签、运行文字状态、类名/模块和说明 | 名称与说明为主要文字；任务性质用外框色、状态用内框色，类型/状态/类名在 tooltip 中 | 技术信息的可见程度、颜色承担的含义不同 |
| 32 | 启动/触发控件 | 启动按钮有图标加文字；触发复选框有启用文字 | 启动是无文字且无边框的图标按钮；触发为无文字复选框 | 操作辨识、默认可点击表现与文字提示不同 |
| 33 | 同步默认/恢复默认 | 快照图标按钮位于各任务卡片头部 | 操作移到当前选中任务详情页脚 | 必须先选中任务，再到详情操作；与卡片就地操作不同 |
| 34 | 任务摘要提示 | 鼠标进入或控件获得焦点后展示；空间不足时不显示左侧浮层 | 鼠标悬停 800 ms 后弹宿主摘要窗口 | 等待时间、位置及键盘触发入口不同；实际焦点表现未实测 |
| 35 | 账号列表与映射编辑 | 独立账号导航页内展示账号列表、覆盖编辑与映射区域 | 配置页打开非模态账号窗口，内含列表/覆盖/映射三个页签 | 层级、页面切换与保持上下文的方式不同；账号窗口不是阻塞 IDE 的模态窗口 |
| 36 | 账号覆盖表单 | 选择账号和目标后，页面中直接呈现可编辑字段 | 账号窗口先显示覆盖摘要，再通过编辑按钮打开参数编辑流程 | 一端直接编辑，另一端多一层进入表单的动作 |

来源：[VS Code 任务卡](../media/console/taskCard.js)、[任务抽屉和账号页面](../media/console/console.js)、[参数表单](../media/console/configPanel.js)、[JetBrains 任务卡](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskCardList.kt)、[任务窗口](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskLauncherToolWindowFactory.kt)、[账号窗口](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/AccountEditorDialog.kt)。

## 6. 临时截图

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 37 | 控件分布 | 粘贴、截图、前台选项、清空在顶部；轮播/坐标在画面下方工具条 | 粘贴、截图、清空、轮播、坐标、前台选项集中在顶部 | 同样的控件需要在不同位置寻找 |
| 38 | 单图辅助操作 | 卡片右下角发送/删除；当前页面没有同等单图右键菜单 | 同样有卡片右下角发送/删除，另外有右键发送/删除菜单 | 这里右下角按钮已经一致，右键入口仍不同 |
| 39 | 清空确认 | 页面内确认条，含取消/确认 | 原生 `JOptionPane` 确认对话框 | 确认的位置、焦点与关闭方式不同 |

来源：[VS Code 截图页面](../media/tempScreenshots/index.html)、[截图事件](../media/tempScreenshots/app.js)、[JetBrains 截图窗口](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/TempScreenshotToolWindowFactory.kt)。跨 Webview 拖拽还受 VS Code 宿主限制，页面源码也提示可能不可用；本次未在 IDE 中验证跨面板拖入，不能把两个拖拽实现的存在视为行为等价。

## 7. 角色、效果、多语言与问题

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 40 | 效果 ID 复制 | 点每张效果卡的 ID 即复制 | 先选效果，再点顶部复制按钮；或右键复制 | 又一处直接操作与选中式操作差异 |
| 41 | 效果来源跳转 | 每张效果卡有打开定义按钮 | 顶部打开来源按钮、双击效果行，或右键菜单 | 操作所在位置与单双击语义不同 |
| 42 | 效果使用关系 | 每卡显示前 8 条使用关系；关系可点击切回对应角色 | 列表渲染摘要只展示前 3 条及更多数量；当前效果行没有逐条关系点击控件 | 展示量和从效果回到角色的路径不同 |
| 43 | 多语言/问题来源 | 多语言表点角色名跳来源；每条问题有打开来源按钮 | 多语言表和问题表都用双击行跳来源 | 来源入口的可发现性和点击次数不同 |
| 44 | 新增/修改表单 | 页面内遮罩浮层、错误区、保存/取消；可点遮罩或 Escape 关闭 | 原生技能、强化、效果对话框与平台消息 | 编辑能力大体对应，但弹层范围、布局、取消与错误位置不同 |

来源：[VS Code 角色页面](../media/characterManager/index.html)、[角色交互](../media/characterManager/app.js)、[JetBrains 角色面板](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/CharacterManagerPanel.kt)、[原生编辑对话框](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/CharacterDialogs.kt)。

## 8. 约定来源、引导与控件体系

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 45 | 项目约定与个人覆盖来源 | 可搜索 QuickPick 列表；每个有覆盖的条目带恢复按钮 | 原生滚动对话框，展示来源/值及恢复按钮 | 搜索、浏览方式与窗口载体不同，恢复覆盖含义对应 |
| 46 | 使用引导 | 宿主 walkthrough，步骤与命令入口 | 独立编辑器标签页里的引导面板，按钮跳工具窗口/编辑器 | 引导载体与导航路径不同 |
| 47 | 视觉组件体系 | 全局 CSS token 与共享控件；卡片操作常用文字图标，24 px 控件，圆角和边框走统一资源 | Swing/宿主控件；任务主题对象只覆盖部分页面，资源用列表选中色、截图用 `ThumbnailActions`、任务启动另用无边框图标 | 两端及 JetBrains 内部都存在多套卡片/动作呈现方式；仅要求读取 IDE 主题并不能消除这些差异 |

来源：[VS Code 来源列表](../src/conventionSources.ts)、[JetBrains 来源对话框](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/ShowConventionSourcesAction.kt)、[walkthrough 注册](../package.json)、[JetBrains 引导](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/GettingStartedEditor.kt)、[共享控件](../media/shared/controls.css)、[JetBrains 任务主题](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskLauncherTheme.kt)。

## 9. 全局配置、列表参数与发布

| 编号 | 对照项 | VS Code | JetBrains | 用户可感知的差异 |
| --- | --- | --- | --- | --- |
| 48 | 全局配置布局 | 配置页逐组显示可折叠卡片，组头含说明、字段数、来源标签与快照动作 | 配置页使用原生设置页分组，展开后嵌入字段表单；同页还放账号摘要和项目设置 | 两端都有折叠与当前字段编辑，但内容分组、控件布局和相邻内容不同 |
| 49 | 列表参数编辑 | 参数页打开页面内列表编辑浮层，确认应用，取消/遮罩/Escape 关闭 | `ModifyListDialog` 原生对话框，确认应用，取消不修改 | 搜索可用项、添加、排序、移除的主要含义对应，弹层载体与关闭入口不同 |
| 50 | 发布资源选择与后续配置 | 宿主多选 QuickPick 选择可发布资源；路径、枚举等通过后续选择/输入与警告确认 | 原生 `PublishSelectionDialog` 复选框选择三类资源，后续使用原生输入/选择/确认对话框 | 发布步骤的载体、资源选项呈现与取消入口不同；两端都有先配置后写入的流程 |

来源：[VS Code 全局组](../media/console/console.js)、[列表参数](../media/console/fields.js)、[发布流程](../src/templateAssetPanel.ts)、[JetBrains 配置页](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskLauncherToolWindowFactory.kt)、[列表对话框](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/ModifyListDialog.kt)、[发布选择](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/UnifiedPublishToolWindows.kt)、[位置配置](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/PositionPublishFlow.kt)、[模板配置](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/TemplatePublishFlow.kt)。

## 已对应的行为与待验收项

已经对应、不能作为缺失功能重复计算的行为：两端都提供三类资源预览与表达式、单击插入/双击复制、带标注来源预览、原图导入/截图/交换/删除、统一发布、任务入队与触发启用、暂停/停止、当前参数自动保存、全局组编辑、账号覆盖、角色四页、临时截图发送/删除、轮播、坐标复制和可调整的临时截图坐标框。这里指源码有对应流程，不代表按钮位置、点击时序或真实运行都一致。

同时存在的宿主差异：QuickPick 与原生对话框、Webview 与 Swing、IDE 停靠和原生控件。是否保留这些差异需后续单独决定；本表未将它们自动视为合理，也未决定把一端整体照搬到另一端。

需要真实 IDE 继续核对：明暗主题、125%/150% 缩放、窄侧栏工具栏换行、按钮命中区域、键盘焦点顺序、屏幕阅读器信息、单击/双击时序、当前 Python 编辑器插入目标、跨面板拖拽、文件修改冲突、保存失败/取消/重试、游戏连接/执行器各状态，以及已安装插件是否与这组源码一致。这些不是本次已完成的验证。

既有 [功能与文档对齐表](feature-parity.md) 主要记录数据来源、写入范围、发布与功能链。其“统一”措辞和显隐等功能描述，不能替代本表对实际注册界面入口的核对；后续若调整既有结论，需要同步中英文文档并分别验证两端。

## 本轮按 VS Code 对齐的结果

上述 50 项保留为改动前的详细差异快照；本轮只处理标注管理与资源预览，任务、账号、角色和临时截图页面的其他差异仍在范围外。

| 原编号 | 本轮结果 |
| --- | --- |
| 06–11 | 三个并排模式按钮；真实等宽自适应卡片，缩略图区 96；右下角插入/复制/原图按钮直接绑定自身资源；单击延迟 500 ms、双击复制；增加筛选计数、空态和缩略图失败统计 |
| 12–14 | 原图单击进入编辑器页签；查看/交换/删除移到卡片右下角；顶部仅放全局操作、搜索与计数，外部变更自动刷新 |
| 16–18 | 原生编辑器页签取代整场模态会话，已完成编辑立即保存；模式按钮与工具同一换行工具栏 |
| 19–22 | 新建和双击均编辑名称及 X/Y/W/H，Point 隐藏 W/H；逐条显隐及全部显示/隐藏/仅选中；D/删除按钮切换点删模式，Delete 删除选中 |
| 23–25 | 可配置快捷键，R/C/D、Ctrl+Z/Y/C/V、Delete、左右切图、1/2/3 与 M；方向键移动 1 像素，Shift 为 10；坐标框支持移动和八向缩放，松开复制 |
| 26–28 | RGB 色块和绝对/相对坐标；右键复制标注名称（VS Code 的 copyColor 实际复制 category）；侧栏修饰键多选；冲突区移到标注行上方 |
| 50 | 无可发布标注时直接提示，发布选择只显示实际有数据的资源；后续配置保持先决策再写入 |

JetBrains PR #30 的极大图片缩放下限、画布最小尺寸阻止缩小、空发布对话框意见同时修复。保存失败保留草稿，重新打开仍以原始本地分支合并外部修改；成功保存接受当前源版本，自己的文件事件不清空撤销历史。

剩余宿主差异：绘图由 Webview/Swing 各自渲染，数值输入、交换目标、发布选择和确认使用各 IDE 原生容器；主题、DPI、焦点与拖拽仍需真实 IDE 验收。未将自动测试与打包成功当作两端实机验收。

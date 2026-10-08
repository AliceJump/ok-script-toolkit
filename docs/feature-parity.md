# 功能与文档对齐表

[简体中文](feature-parity.md) | [English](feature-parity.en.md)

历史功能补齐记录：2026-10-08。主仓基线 `aea8b14`，子仓 `main` 基线 `9eb4992`，版本均为 `1.23.0`。本轮在子仓 [PR #28](https://github.com/AliceJump/ok-script-toolkit-jetbrains/pull/28) 的 `0e846f0` 上继续修正，并同步调整主仓 `codex/complete-feature-parity` 分支。以下功能结论针对本轮 PR 代码，合并和发布之前不计入已发布版本。

当前交互改动由 [JetBrains PR #30](https://github.com/AliceJump/ok-script-toolkit-jetbrains/pull/30) 与 [主仓 PR #37](https://github.com/AliceJump/ok-script-toolkit/pull/37) 交付，版本 `1.24.0`。标注管理与资源预览按 VS Code 对齐。下面的 PR #28 基线及验证数字保留为历史记录，不代表当前 PR 的审阅状态。

## 当前功能核对

| 功能 | 两端实现与入口 |
|---|---|
| 语言、OCR、模板、效果引用提示 | `providers.ts` / `editor/OkEditorSupport.kt`，读取当前本地资源 |
| AST 任务列表、运行时 schema、参数、全局组、账号覆盖 | `consolePanel.ts` / `tasklauncher/`，共用主仓 Python 探针和账号接口 |
| 常驻执行器、入队、触发、暂停、停止、配置隔离 | 共用 `python/run_executor.py` 及辅助模块，宿主维护状态、日志和错误入口 |
| 项目约定、个人覆盖、配置来源 | `projectConfig.ts` / `ProjectConvention.kt`；Position 发布配置另提供路径来源及个人覆盖重置 |
| 统一 Template / Rect / Point 标注 | `annotationPanel.ts` / `UnifiedAnnotationUi.kt`；三份 COCO 工作文件共享原图 |
| 坐标、显隐、撤销重做、模式循环、复制粘贴 | 两端使用同一坐标契约，默认 M 循环模式，支持共享及分模式历史 |
| 外部修改与冲突 | `annotationMerge.ts` / `AnnotationSessionSync.kt`；保留双方修改，解决冲突并核对源版本后保存 |
| 原图管理 | 两端提供导入、截图、临时截图发送和拖入、搜索、编辑、原图查看、Template 标注交换、三类标注联动删除及外部变更刷新 |
| 统一发布 | 在标注管理选择 Template / Rect / Point；先完成全部配置，再执行写入，位置失败或拒绝覆盖时停止模板写入 |
| 模板与枚举发布 | 同一打包契约；目标、枚举路径、类名可配置；未配置路径时读取框架后备，覆盖前检查旧类名及项目引用 |
| Position 发布 | 统一 JSON / Python 输出，路径按个人偏好 → 项目约定 → 默认值；保护手写文件，明确确认自定义 JSON 覆盖 |
| 资源预览 | 侧栏和宽屏均有三模式图片卡片、名称或表达式搜索、单击插入、双击复制和带标注的来源查看；Template 使用运行时库，Rect / Point 使用当前工作标注 |
| `self.pos` 提示 | 两端读取当前 Rect / Point 声明，Rect 引用 `self.pos.<路径>.to_box()`，Point 引用 `self.pos.<路径>` |
| 角色、效果、截图、连接、浮层 | 两端保留现有功能入口，共用框架探针和执行器接口 |
| 使用引导 | 主仓原生 walkthrough / 子仓 `GettingStartedEditor.kt` |
| 语言与资源 | 六种语言；主仓宿主及 Webview、子仓两套 UI bundle 均使用外部资源 |

## 本轮补齐的实际差异

1. 子仓独立 CI 固定的旧主仓提交不含 Position Schema。改为 `aea8b14`，补充发布路径字段测试；共享 Python 无需改动。
2. 子仓模板卡片原本使用未发布标注，改为运行时库并保留真实图片、bbox 和当前模板别名。恢复插入、复制、原图查看和资源变化刷新；宽屏预览与侧栏共用同一实现。
3. 子仓统一原图入口补接查看、交换、删除、临时截图拖入、搜索和自动刷新。窄窗口工具栏会按可用宽度换行，全部动作保留可见高度；异步列表和缩略图拒绝旧回调。
4. 恢复子仓枚举路径、类名、框架路径后备和旧类名引用检查；发布先收集全部决策，取消配置和拒绝覆盖均阻止后续写入。
5. 两端 Position 个人路径支持留空重置，并拒绝绝对路径、越界、项目根目录本身及越界符号链接。主仓设置说明和两端发布文案补齐六语言外部资源。
6. 两端图片编号补上 `points.json` 占位；子仓临时截图发送使用实际项目根。原图删除统一清理三类工作标注，后续失败恢复图片和已改动文件，保留同名不同扩展名的资源。两端 Point 清理仅筛除目标图片与标注，保留其他无标注图片登记、小数坐标、原始 ID 和扩展字段；子仓模板读取失败时在清理其他来源之前退出。
7. 主仓 Webview 六套语言表迁出业务代码，补齐 19 个遗漏键及资源预览文案，纠正五语言触发模式与 ALL/ANY 说明沿用简体中文的问题。翻译检查读取 TypeScript 实际字面量值，正确处理换行和引号；新增覆盖实际 Webview 调用的检查。
8. 两端资源预览快捷键统一为 `Ctrl+Alt+T`；宽屏标题改为资源预览。移除未注册的旧文本窗口和预览中的旧发布链，主仓 Rect 卡片尺寸改为实际裁剪尺寸。
9. 更新本表及 [项目约定](project-config.md)、[配置读取](config-reads.md)、[位置资源契约](box-resources.md)，移除旧框运行时链和迁移描述。

## 有意保留的宿主差异

两端标注均在编辑器页签内操作，完成创建、编辑、拖动、删除、撤销或重做后立即保存工作文件；保存不等于发布。JetBrains 保存失败时显示错误与重试入口，并保留插件草稿供重新打开后恢复及合并外部修改。 卡片按钮、点击、显隐、删除模式、数值编辑、方向键微调与图片导航按 VS Code 对齐；输入与确认仍使用各 IDE 的宿主控件。

游戏如何加载发布文件由业务项目负责。插件提供当前声明、运行状态和日志入口，不增加业务参数迁移、历史键恢复或应用回执协议。操作契约详见位置资源文档。

## 验证与仓库状态

- 主仓最终 `npm test`、`npm run package` 通过；本机使用已安装 Python，避开 Windows 商店占位程序。
- 子仓 `gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration` 通过，487 个测试，0 失败、0 错误、0 跳过。
- 回归覆盖发布取消及写入顺序、路径覆盖重置、枚举引用检查、运行时模板与引用表达式、图片占位、三类标注删除与回滚、窄工具栏高度和旧缩略图回调。
- 主仓 388 个 Webview 键在六语言外部表中对等，413 处实际 Webview 字面量调用均有对应键；宿主翻译和子仓 UI bundle 同步检查。
- 最终 VSIX 与 JetBrains JAR 中 13 个 Python 脚本和约定 Schema 逐字节一致，语言资源齐全；打包产物不含 Agent 文件、测试或开发文档。
- `0e846f0` 的历史 CI 成功；旧审阅覆盖 `a9fd35f`，此前主动复审被限流。新提交的 CI 和审阅应按各 PR 当前 head 独立核对，历史结果不代表本轮改动已审阅。
- 本轮代码差异已补齐，主仓 PR 的 gitlink 指向子仓 PR 的配套提交。必须先合并子仓 PR #28，再确认或更新 gitlink 到子仓 `main` 可达的提交并核对主仓 CI，最后合并主仓；未合并代码不作为已发布功能。

没有执行真实 IDE 交互、真实游戏截图或业务项目运行验收，也未执行完整 Plugin Verifier API 兼容性检查；构建、结构和自动回归的成功不代替这些验收。

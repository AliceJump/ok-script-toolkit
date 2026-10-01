# 功能与文档对齐表

复核日期：2026-10-01。本地基线：主仓 `efc4ff9`、JetBrains 子仓 `4df0cee`，版本均为 `1.19.0`。本表依据当前代码入口与下列验证，不把设计计划、其他分支的改动或历史审查结论算作当前功能。

[简体中文](feature-parity.md) | [English](feature-parity.en.md)

## 1. 当前功能

“已有”表示两端有实际实现入口，不代表本轮已完成真实 IDE 或游戏验收。

| 功能 | VS Code | JetBrains | 对齐结论与证据 |
|---|---|---|---|
| 语言、OCR、模板、效果引用提示 | 已有 | 已有 | `src/providers.ts` / 子仓 `editor/OkEditorSupport.kt`；载体为 VS Code provider 与 IntelliJ 扩展点 |
| AST 任务列表与运行时 schema | 已有 | 已有 | 共用 `python/parse_config_tasks.py` / `python/probe_task_schemas.py`，宿主分别缓存与展示 |
| 常驻执行器、一次性入队、触发任务启用、暂停与停止 | 已有 | 已有 | `src/consolePanel.ts` / 子仓 `TaskRunnerService.kt`；执行核心共用 `python/run_executor.py` |
| 原生启动链与配置隔离 | 已有 | 已有 | 共用 `OK.start_runtime()`、原生启动控制器和沙箱；`python/executor_input.py` 使用 Windows 非阻塞命令管道 |
| 当前任务参数与全局配置组编辑 | 已有 | 已有 | `src/consolePanel.ts` / 子仓 `TaskLauncherService.kt`、`GlobalSnapshotRules.kt`；启动注入 `OK_TOOLKIT_GCONFIG`、运行中推送 `gparams` |
| 账号覆盖调试 | 已有 | 已有 | 共用 `python/account_store.py`；子仓 `AccountEditorDialog.kt`，不是只有 probe 元数据透传 |
| 项目约定与个人覆盖溯源 | 已有 | 已有 | `src/projectConfig.ts` / 子仓 `ProjectConvention.kt`、`ConventionSources.kt`；声明字段已接入，类型和来源规则需保持一致 |
| 运行时模板路径与枚举导出后备 | 已有 | 已有 | 模板库消费 `config.py`；枚举路径后备在 `templateAssetPanel.ts` / 子仓 `TemplateAssetToolWindowFactory.kt` 的导出入口读取 |
| 模板素材、导出、预览与原图定位 | 已有 | 已有 | `src/templateAssetPanel.ts`、`templatePanel.ts` / 子仓 `TemplateAssetToolWindowFactory.kt`、`TemplatesToolWindowFactory.kt` |
| 框资源编辑、发布与运行时画廊 | 已有 | 已有 | `src/boxPanels.ts`、`boxResourceStore.ts` / 子仓 `BoxWindows.kt`、`BoxCatalogService.kt`；COCO 工作文件与运行时位置表分开 |
| `self.pos` 框补全与 Hover | 已有 | 已有 | `src/providers.ts` / 子仓 `editor/OkEditorSupport.kt`；游戏中的加载仍由业务项目负责 |
| 缩略图动作与 Python 插入目标 | 已有 | 已有 | `src/pythonEditor.ts` / 子仓 `PythonEditorTarget.kt`；模板和框均复用最近 Python 编辑器，不再列为待办 |
| 标注编辑、撤销、复制、图片交换、显隐 | 已有 | 已有 | `src/annotationPanel.ts` / 子仓 `AnnotationDialog.kt`；共用 COCO 契约，保存时机仍有差异 |
| 临时截图、窗口采集、连接与浮层 | 已有 | 已有 | 两端调用共用 Python，宿主存储和界面各自实现 |

## 2. 保留的差异与范围

- **标注保存时机不同**：VS Code 改动即保存；JetBrains 在 `AnnotationDialog.doOKAction()` 中汇总保存，取消丢弃编辑。不能把后者写成自动保存，也不在本次文档整理中改变既有语义。
- **界面载体不同**：Webview 与 Swing，参数详情布局、键位设置和编辑器入口遵循各自 IDE。功能对齐不要求界面结构逐像素相同。
- **参数应用反馈有限**：快照保存、命令发送和业务运行应用是不同结果；当前没有统一的业务应用回执。不能据保存或发送成功宣称游戏已使用新值。
- **业务变化由当前声明决定**：删除参数、拆分任务、更换内部检测模板不自动产生插件适配或迁移需求。
- **本表不保证外部项目加载器**：框发布文件正确并不证明业务项目已经加载它；真实游戏运行需单独验证。

## 3. 文档状态修正

| 文档 | 已修正内容 |
|---|---|
| `AGENTS.md` | 合并原 `AGENT.md`，统一仓库定位、功能边界和文档语言规则 |
| `project-config.md` | 去掉“全局字段未接线”“框管理尚未读取”“配置导入前钩子仍被跳过”等过时描述 |
| `config-reads.md` | 补充 `boxes.runtime`，区分普通枚举设置访问器与导出入口后备，说明本文编号与设计图不同 |
| 子仓 `design-parity.md` | 全局配置注入、运行中推送和账号编辑改为当前已实现，不再按最初计划列为缺失 |
| 子仓 `parity-review.md` | 更新最近 Python 编辑器跟踪状态；旧条目明确保留历史基线，当前结论以本表为入口 |
| 子仓架构比较报告 | 保留历史分析，不把旧缺失清单或旧行数当作当前验收结果 |

除 Agent、skill 及技能配套说明外，文档均提供独立中文 `.md` 和英文 `.en.md`，同步维护内容；代码、API 和必要的原始界面文字不作为混写正文。

## 4. 验证与限制

本轮主仓验证通过：`test_box_resource.js`、`test_thumbnail_actions.js`、`test_project_config.js`、`test_coco_feature_path.js`、`test_run_executor_sandbox.py`、`test_run_executor_gconfig.py`。覆盖框资源、缩略图动作、配置优先级、模板路径、配置隔离及全局配置应用链。

JetBrains 的 `BoxResourceTest`、`GlobalSnapshotRulesTest`、`TaskConfigMergeTest`、`BundleParityTest` 共 45 个用例通过。全局 UI 静态审计覆盖 7 个面板并通过。文档检查确认 16 组双语文件、7 份中文 Agent/skill 说明，本地链接和编号章节无缺漏；两仓 `git diff --check` 通过。VSIX 构建与压缩包检查通过，未包含 Agent、skill 或开发文档。

没有在真实 IDE 中逐项操作，也没有启动游戏；源码中存在入口和自动测试通过不替代这些验收。

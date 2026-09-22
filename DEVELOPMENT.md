# 开发指南 / Development Guide

<div align="center">

[![简体中文](https://img.shields.io/badge/Language-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87%20%E2%9C%93-2EA043?style=for-the-badge)](DEVELOPMENT.md) [![English](https://img.shields.io/badge/Language-English-6E7681?style=for-the-badge)](DEVELOPMENT.en.md)

</div>

本文档面向扩展开发者，包含项目结构、本地构建安装和发布流程。

This document is for extension developers and covers the project structure, local build/installation, and release workflow.

---

## 项目结构

```text
src/                         VS Code 扩展宿主 TypeScript 源码（30 个模块，下列为入口与主要模块）
	projectConfig.ts           项目约定文件 ok-script-toolkit.json 的读盘侧（定位 + 缓存 + 个人偏好）
	projectConfigPure.ts       取值链纯逻辑（不依赖 vscode，可单测）：解析 + 优先级 + 来源层
	conventionSources.ts       「项目约定 vs 我的设置」溯源面板的数据源
	cocoFeaturePath.ts         运行时模板库路径的读盘侧（config.py 的 coco_feature_json 探测缓存）
	cocoFeaturePathPure.ts     同上，纯逻辑（优先级 + 候选过滤）
	extension.ts               入口：激活、文件监听与刷新派发、命令注册
	langData.ts                语言 JSON + gettext PO 数据源（幽灵注释/补全/hover）
	featureData.ts             模板库（COCO）解析 + 按模板名反查原图
	effectData.ts              效果 ID 映射（解析 effects.py）
	characterData.ts           角色/技能数据读写（含同步技能保护）
	characterPanel.ts          角色技能管理面板宿主侧
	consolePanel.ts            ok-script 控制台宿主侧（任务 + 游戏统一视图；schema 探测、常驻执行器、参数通道）
	toolboxConnect.ts          游戏连接 + 调试浮层共享宿主（connect_game.py / overlay_host.py、浮层互斥）
	providers.ts               补全 / hover / inlay 提供器
	templateAssetData.ts       模板素材数据（读写 <模板目录>/coco_annotations.json）
	templateAssetPanel.ts      模板素材面板宿主侧（含「保存到 assets」导出流程）
	saveToAssetsPure.ts        导出流程的纯逻辑（目标列表 + 枚举路径要不要问）
	templatePanel.ts           模板画廊面板
	annotationPanel.ts         标注编辑器面板（画框标注 + 框选复制归一化坐标）
	tempScreenshotStore.ts     临时截图存储（最多 10 张，按工作区隔离落盘）
	tempScreenshotPanel.ts     临时截图侧边栏视图（粘贴/截屏、0.1s 轮播、框选坐标）
	tempDrag.ts                跨 Webview 拖拽中介（临时截图 → 标注管理；VS Code 端实测无效，见下）
	screenshotCapture.ts       游戏窗口截图采集（窗口探测 + capture_game_window.py 调用）
	pngCrop.ts                 缩略图裁剪 + content-hash 磁盘缓存（配 pngCropWorker.ts）
	pngCropWorker.ts           缩略图裁剪的 Worker 线程
	assetPack.ts               「保存到 assets」的 PNG 打包（配 assetPackWorker.ts）
	assetPackWorker.ts         打包的 Worker 线程
	localization.ts            宿主文案与 Webview 字典（两层 i18n）
	webviewHtml.ts             Webview HTML 组装（nonce / CSP 这些**安全边界**收在一处）
	toolboxState.ts            工具箱连接状态持久化（同时写入项目 configs/devices.json）
media/                        每个外置 Webview 的 HTML/CSS/JS（宿主经 CSP + asWebviewUri 加载）
	icons/                     活动栏与视图图标（templates.svg、toolbox.svg、task.svg）
	annotationPanel/           标注编辑器
	tempScreenshots/           临时截图侧边栏
	templateAssetPanel/        模板素材管理
	templatePanel/             模板面板
	console/                   ok-script 控制台（任务 + 游戏）
	characterManager/          角色技能管理
python/                       随扩展发布的辅助脚本：任务发现、探测与执行（parse_config_tasks.py、probe_task_schemas.py、run_executor.py），以及模板素材面板的游戏窗口截图与配置探测（capture_game_window.py、probe_window_config.py）
	python/tests/              开发期 Python 回归测试（test_probe_pure_group_labels.py、test_run_executor_sandbox.py）；按 AGENT.md 打包规范不进 VSIX / JetBrains JAR
jetbrains/                    JetBrains 插件的**独立公开仓库**（git submodule），有自己的 README / CI / 发版流程
schemas/                      ok-script-toolkit.json 的 JSON Schema（编辑器补全与校验）
docs/                         设计文档（配置读取全景、项目约定文件设计、可直接复制的示例配置）
scripts/                      开发期生成与回归测试工具，不打入 VSIX
l10n/                         扩展宿主运行时本地化资源
package.nls*.json             扩展清单本地化资源
screenshots/                  README 用的演示 GIF（**VS Code 版界面**；子仓 README 不能复用）
out/                          TypeScript 编译产物（由构建生成）
```

每个外置 Webview 的 HTML、CSS 和 JavaScript 均放在同一功能目录中；宿主通过 CSP 限制和 `asWebviewUri()` 加载资源。

## 任务启动：常驻执行器模型

任务启动器**不是「一次启动 = 一个任务进程」**，而是**一个项目一个常驻执行器进程**：`python/run_executor.py` 只启动一次，连接一次游戏，之后由 ok-script 框架原生的 `TaskExecutor` 循环轮询全部已启用的触发任务；一次性任务以入队方式交给同一个进程执行。

- **为什么不能用 `ok.run_task(config, task=<单个任务>)` 跑触发任务**：框架会转调 `OK.run_trigger_task()`，把 `executor.trigger_tasks` 收窄成单个任务并 `disable()` 其余触发任务，多触发任务串连轮询直接失效。曾有一个只跑单任务的 `python/run_task.py` 走这条旧路径，**已于 2026-09 删除** —— 它既没有任何插件调用，又**没接配置沙箱**（手动跑会直接写目标项目的 `configs/`，违反「插件绝不改写被调试项目配置」这条红线）。要手动跑单个一次性任务，请改用常驻执行器的 stdin 命令 `onetime_enqueue <module::Class>`，那条路径有沙箱。
- **轮询在哪**：`ok/task/TaskExecutor.py` 的 `next_task()` —— onetime 队列 → 任一 enabled 的一次性任务 → 触发任务按 `trigger_task_index` 轮转，命中 `enabled and should_trigger()` 即执行。
- **stdin 命令**：`trigger_enable|trigger_disable <module::Class>`、`onetime_enqueue <module::Class>`、`task_disable`（停当前任务、轮询继续）、`params <全量 json>`、`pause|resume`、`overlay_on|off`、`stop`。
- **stdout 标记**：`OK_TOOLKIT_EXECUTOR_CONNECTING / _READY / _STOPPED`、`OK_TOOLKIT_STATE:<json>`（`current / currentIsTrigger / paused / triggers[] / onetimeQueue[]`，快照变化时推送）、沿用 `OK_TOOLKIT_PAUSED / RESUMED / OVERLAY_* / ERROR:`。
- **启用集合的权威来源**是启动环境变量 `OK_TOOLKIT_TRIGGERS`（JSON 数组）：未列出的触发任务一律置为未启用，避免项目 `configs/*.json` 里残留的 `_enabled: true` 把任务带起来。启用集合持久化在 VSCode 的 `.vscode/ok-script-toolkit-tasks.json` / JetBrains 的 `.idea/ok-script-toolkit-tasks.json` 的 `projects[<dir>].enabledTriggers`。
- **不污染项目配置**：触发任务的 `_enabled` 一律走 `dict.__setitem__(task.config, "_enabled", v)`；框架的 `TriggerTask.enable/disable` 会经 `Config.__setitem__` → `save_file()` 写回项目 `configs/*.json`，所以 `run_executor.py` 在导入任务前替换掉这两个方法。参数覆盖同理，只改内存。
- **任务类型**由 `python/parse_config_tasks.py` 的 AST 结果直接给出（每个条目带 `kind`），宿主不必等 schema 采集完成就能区分「触发任务勾选启用」与「一次性任务入队执行」。
- **注意 `enable_after_start`**：`do_start(None)` 会按框架约定自动启用项目里声明了 `enable_after_start` 的任务（例如 ok-neverness-to-everness 的 `LauncherTask`），所以刚启动执行器就可能看到有一次性任务在跑 —— 这是 GUI 的既有行为，不是 bug。
- **验证方式**（不需要真游戏）：用 `windows.start_exe=False` 的项目（如 `ok-neverness-to-everness`）跑
  `(sleep 40; echo stop) | OK_TOOLKIT_TRIGGERS='["<module::Class>"]' ./.venv/Scripts/python.exe -u <repo>/python/run_executor.py --config-module src.config`，
  确认输出 `CONNECTING → READY → STATE → STOPPED`；把 stdout 重定向到文件再 grep（管道里常拿不到内容）。

## 临时截图与归一化坐标

- **临时截图侧边栏**（`ok-script 临时截图`）是活动栏上的**独立容器**（`viewsContainers` 里注册 `okTempShots`，图标 `media/icons/tempShots.svg`），不属于模板容器。最多保留 10 张截图，超出后自动淘汰最早的一张；图片落在扩展 `globalStorage` 的按工作区哈希隔离子目录中。
- 支持 `Ctrl+V` 粘贴系统剪贴板图片、一键截取游戏窗口、拖入/粘贴图片文件。
- **导入到标注管理的可靠入口是卡片右上角的 `→` 按钮**（常驻可见）。VS Code 的跨 Webview 拖拽实测不可用：各 webview 是不同 origin 的 iframe，`dataTransfer` 被浏览器屏蔽，**drop 事件也不派发**，因此 `src/tempDrag.ts` 的宿主中继同样收不到。拖拽代码与 `text/plain` 二级通道保留，若后续 VS Code / Chromium 放开跨 origin DnD 即可直接生效。
- JetBrains 端（见下）**拖拽是能用的**：两个工具窗口同处一个 JVM，用自定义 `DataFlavor` 直接传文件路径。
- **0.1s 轮播**：点击「轮播 0.1s」后舞台按 100ms 间隔切换帧。**轮播与框选是相互独立的两条通道**：框选期间轮播继续播放，选框松手后保留在原位，便于对着运动中的目标（如带移动界限的按钮）反复比对与微调；归一化坐标只取比例，因此与当前显示的是哪一帧无关。
- **框选复制归一化坐标**：临时截图侧边栏的「框选坐标」模式与标注编辑器的「坐标 (C)」模式，都会在框选结束后把 `x,y,tox,toy`（左上 / 右下，均按图片宽高归一化到 0..1，保留 4 位小数）写入剪贴板。归一化与显示缩放无关，因此降采样预览与缩放视图下结果一致。
- **坐标框是可调的尺子，不是数据**：拖拽完成后框会保留在画布上，带 8 向手柄、可整体拖动（与模板标注框一致的交互）。**创建时与每次调整结束都会重新复制一次当前框的归一化坐标**；框本身不进入标注列表、不写 COCO、不落盘。点击图片的非交互部分（框体与手柄之外）即清除，退出坐标模式也会清除。

## JetBrains / PyCharm 版本

仓库的 `jetbrains/` 目录包含独立的 Kotlin + IntelliJ Platform 插件工程，当前最低支持 PyCharm / IntelliJ Platform 2025.1（需要 Python 支持）。首版已提供：

- `self.lang`、OCR `match`、模板名称和效果 ID 的补全与快速文档。
- Python / JSON 效果与语言值行内提示。
- 可搜索的原生模板工具窗口，可插入、复制表达式或打开来源图片。
- 项目级数据目录、locale、模板别名和提示开关设置。
- 标注编辑器（`AnnotationDialog`）：画框/删除/坐标模式、边缘 8 向手柄、拖动移框、
  缩放平移、撤销重做、Ctrl+C/V 复制粘贴、双击数值编辑、←/→ 跨图导航，
  改动在 OK 时统一写回 `coco_annotations.json`（Cancel 全部放弃）。
- 临时截图工具窗口（`ok-script Temp Shots`）：与 VS Code 端能力对齐（10 张上限、
  粘贴/截屏入列、0.1s 轮播、框选复制归一化坐标、缩略图拖到素材面板导入）。
  拖拽在这里**可用**——两个工具窗口同处一个 JVM，用自定义 `DataFlavor` 传路径；
  注意 `JPanel` 没有内置自动拖出，需在 `mouseDragged` 里手动 `exportAsDrag`。

构建与安装：

```bash
cd jetbrains
./gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration
```

Windows 使用 `gradlew.bat`。生成的 ZIP 位于 `jetbrains/build/distributions/`，可在 JetBrains IDE 的 **Settings / Plugins / Install Plugin from Disk...** 中安装。逐功能的对齐状态与剩余差异见 [`jetbrains/docs/parity-review.md`](https://github.com/AliceJump/ok-script-toolkit-jetbrains/blob/main/docs/parity-review.md)（2026-09-21 已按代码逐条重核，基线 v1.8.0）。

## 安装

打包安装（推荐）：

```bash
cd ok-script-toolkit
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

然后在 VS Code 中：`Ctrl+Shift+P` → **Extensions: Install from VSIX...** → 选择生成的 `ok-script-toolkit-<版本>.vsix`。

想直接改代码调试、不打包安装，见下面的「启动调试」。

## 启动调试

两端都随仓库提供了开箱可用的启动/调试入口。这些配置属于开发文件，**不会进打包产物**：
`.vscode/` 被 `.vscodeignore` 排除，`jetbrains/.run/` 也不参与 `buildPlugin`。

### 主仓库：VS Code 扩展

用 VS Code 打开本项目根目录，按 `F5` 启动扩展开发宿主，在宿主窗口打开任意 Python 文件即可看到效果。

| 入口 | 说明 |
|---|---|
| `F5` → **运行扩展（主仓库 VS Code 扩展）** | 先跑 `npm run compile`，再起扩展开发宿主 |
| **运行扩展·watch 热重载** | 后台跑 `npm run watch`，改 TS 后重载宿主窗口即生效 |

命令面板 → **Tasks: Run Task** 里有这四条（与 CI 的 `vscode` job 对齐）：

| 任务 | 等价命令 |
|---|---|
| `插件·编译（主仓库 VS Code 扩展）` | `npm run compile` |
| `插件·watch 编译（主仓库 VS Code 扩展）` | `npm run watch` |
| `插件·测试（主仓库 VS Code 扩展，等价 npm test）` | `npm test` |
| `插件·打包 VSIX（主仓库 VS Code 扩展）` | `npm run package`（内部先自动跑 `compile`） |

> `npm test` 里的 5 个 Python 测试靠 PATH 上的 `python`（CI 用 `setup-python` 3.13）。
> 本机 `python` 若是 Microsoft Store 的占位符，会以退出码 9009 直接失败 —— 换个真解释器即可。

`.vscode/` 只共享这三个文件（`launch.json` / `tasks.json` / `extensions.json`）——
`.gitignore` 里必须写成 `.vscode/*` 再加 `!` 放行，因为 git 无法在整目录被排除后
重新纳入其中的文件；`settings.json` 等仍保持本地不提交。

### 子仓库：JetBrains 插件

沙箱 IDE 由 Gradle 的 `runIde` 拉起；`build.gradle.kts` 里 `autoReload = true`，
重新构建后沙箱会自动加载新版本，不必重启沙箱。

**A. IntelliJ / PyCharm（`.run/` 配置已随仓库提供，Run/Debug 下拉框直接选）**

| 配置 | 用途 |
|---|---|
| `Run Plugin (runIde)` | 普通运行：起一个装着本插件的沙箱 IDE |
| `Debug Plugin 1 - start sandbox` | 等价 `runIde --debug-jvm`：沙箱 JVM 在 5005 等待调试器 |
| `Debug Plugin 2 - attach 5005` | 附加到上面那个 5005，下断点 |

顺序是先 **1** 后 **2**：跑 1 之后终端会停在
`Listening for transport dt_socket at address: 5005`，这时再跑 2 才连得上。

**B. 命令行 / VS Code**

```bash
cd jetbrains
./gradlew runIde              # 普通运行
./gradlew runIde --debug-jvm  # 调试：在 5005 等待调试器附加
```

VS Code 的 **Tasks: Run Task** 里同样有这几条（与 CI 的 `jetbrains` job 对齐）：

| 任务 | 等价命令 |
|---|---|
| `插件·运行沙箱 IDE（子仓库 JetBrains 插件）` | `./gradlew runIde` |
| `插件·调试沙箱 IDE（子仓库 JetBrains 插件，5005 等待附加）` | `./gradlew runIde --debug-jvm` |
| `插件·附加调试器 jdb（子仓库 JetBrains 插件，5005，无需扩展）` | `scripts/debug-attach-jdb.ps1` |
| `插件·编译（子仓库 JetBrains 插件）` | `./gradlew classes`（不打包、不跑测试，最快） |
| `插件·测试（子仓库 JetBrains 插件）` | `./gradlew test` |
| `插件·编译并打包（子仓库 JetBrains 插件）` | `./gradlew buildPlugin` |

**断点调试走「零扩展」那条路**：先跑「调试沙箱 IDE」并等到终端打印
`Listening for transport dt_socket`，再跑「附加调试器 jdb」——用 JDK 自带的 `jdb` 附加
（附加后**先输 `cont`**，沙箱才会继续启动）。

> 为什么不用 `launch.json` 的附加配置：**VS Code 内置调试类型里没有 JDWP**，
> `"type": "java"` 来自扩展 `vscjava.vscode-java-debug`，没装会报「无法识别此调试类型」。
> 因此 `.vscode/launch.json` 里那段 java 附加配置是**注释掉的**；装了该扩展再取消注释，
> 就能换回图形化调试器。

> 沙箱数据在 `jetbrains/.intellijPlatform/sandbox/`（已 gitignore）。
> `runIde` 首次会下载目标 IDE（PyCharm 2025.1），之后走本地缓存。

## 自动发布

- Pull Request 和 `main` 推送只运行 `CI`，同时测试并打包 VS Code 与 JetBrains 两端，不会发布。
- **发布的唯一触发方式是推送一个尚不存在的 `vX.Y.Z` 标签**。工作流不提供手动发布，也不会因 `main` 推送自动发布。
- `package.json`、`package-lock.json`、`jetbrains/gradle.properties` 与两个 README 的版本徽章必须完全一致；标签必须等于 `v<version>`。少同步或漏提交任何一处，Release 的 `validate` 都会失败。
- 标签工作流会测试两端，构建 VSIX 和 JetBrains ZIP，在同一个 GitHub Release 中上传两个安装包，然后按已配置的 Secret 发布两个 Marketplace。
- GitHub Release 使用仓库内置 `GITHUB_TOKEN`；Marketplace 所需 Secret 统一配置在父仓库 `AliceJump/ok-script-toolkit`，子仓库不保存发布凭据。

发布示例：

> 也可以直接跑一键脚本：`npm run release -- --minor`（等价 `sh scripts/release.sh --minor`，
> Windows 用 `scripts/release.ps1`），它会自动完成下面全部步骤；加 `--dry-run` 先预览。

```bash
# 一次更新 package.json、package-lock.json 和 JetBrains pluginVersion
npm run version:sync -- 0.6.0
npm test

# 先提交并推送子仓库版本
git -C jetbrains add .
git -C jetbrains commit -m "chore(release): prepare v0.6.0"
git -C jetbrains push origin main

# 再提交父仓库版本、README 徽章和新的子模块指针
# 注意 README.md 必须一起提交：version:sync 会改它的徽章，漏了就校验失败
git add package.json package-lock.json README.md jetbrains
git commit -m "chore(release): prepare v0.6.0"
git push origin main

# 只有这一步会触发发布
git tag -a v0.6.0 -m "Release v0.6.0"
git push origin v0.6.0
```

标签必须是首次推送的新标签；不要移动、覆盖或强制推送已发布标签。若构建失败，应修复代码、提升为新版本并推送新标签，而不是复用旧标签。

需要的仓库 Secrets：

| Secret | 获取方式 | 是否必需 |
|---|---|---|
| `VSCE_PAT` | Visual Studio Marketplace 发布 PAT | 可选；可改用 OIDC Trusted Publishing |
| `JETBRAINS_TOKEN` | JetBrains Marketplace 作者页 → My Tokens | 发布 JetBrains Marketplace 时必需 |
| `JETBRAINS_PRIVATE_KEY` | JetBrains 插件签名用 PEM 私钥全文或 Base64 | JetBrains Marketplace 发布时必需 |
| `JETBRAINS_PRIVATE_KEY_PASSWORD` | 生成私钥时设置的密码 | JetBrains Marketplace 发布时必需 |
| `JETBRAINS_CERTIFICATE_CHAIN` | 与私钥配套的 `chain.crt` 全文或 Base64 | JetBrains Marketplace 发布时必需 |

在 GitHub 仓库进入 **Settings → Secrets and variables → Actions → New repository secret**，逐项添加。缺少 Marketplace Secret 时，GitHub Release 仍会创建，对应商店发布会跳过；若设置了 JetBrains Token 但签名 Secret 不完整，工作流会失败以避免上传未签名插件。

启用 VS Marketplace OIDC 时，另在 **Actions → Variables → New repository variable** 添加 `VSCE_USE_OIDC=true`；只有完成 Marketplace Trusted Publishing policy 后才启用。

完整的 Token 获取、签名密钥生成和逐次发布步骤见 [RELEASING.md](RELEASING.md)。

---

# 开发指南

本文档面向扩展开发者，包含项目结构、本地构建安装和发布流程。

## 项目结构

```text
src/                         VS Code 扩展宿主 TypeScript 源码
media/
	icons/                     活动栏与视图图标（templates.svg、toolbox.svg、task.svg）
	annotationPanel/           标注编辑器 Webview（index.html、CSS、交互脚本）
	templateAssetPanel/        模板素材管理 Webview（index.html、CSS、交互脚本）
	templatePanel/             模板面板 Webview（index.html、CSS、交互脚本）
	taskLauncher/              任务启动器 Webview（index.html、CSS、组件脚本）
	characterManager/          角色技能管理 Webview（index.html、CSS、交互脚本）
	pngCropWorker.ts           Worker 线程：纯 JS PNG 解码、裁剪与缩放
python/                      随扩展发布的辅助脚本：任务发现、探测与执行（parse_config_tasks.py、probe_task_schemas.py、run_task.py），以及模板素材面板的游戏窗口截图与配置探测（capture_game_window.py、probe_window_config.py）
scripts/                     开发期生成与回归测试工具，不打入 VSIX
l10n/                        扩展宿主运行时本地化资源
package.nls*.json            扩展清单本地化资源
out/                         TypeScript 编译产物（由构建生成）
```

每个外置 Webview 的 HTML、CSS 和 JavaScript 均放在同一功能目录中；宿主通过 CSP 限制和 `asWebviewUri()` 加载资源。

## JetBrains / PyCharm 版本

仓库的 `jetbrains/` 目录包含独立的 Kotlin + IntelliJ Platform 插件工程，当前最低支持 PyCharm / IntelliJ Platform 2025.1（需要 Python 支持）。首版已提供：

- `self.lang`、OCR `match`、模板名称和效果 ID 的补全与快速文档。
- Python / JSON 效果与语言值行内提示。
- 可搜索的原生模板工具窗口，可插入、复制表达式或打开来源图片。
- 项目级数据目录、locale、模板别名和提示开关设置。

构建与安装：

```bash
cd jetbrains
./gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration
```

Windows 使用 `gradlew.bat`。生成的 ZIP 位于 `jetbrains/build/distributions/`，可在 JetBrains IDE 的 **Settings / Plugins / Install Plugin from Disk...** 中安装。详细状态和后续移植范围见 `jetbrains/README.md`。

## 安装

方式一（打包安装，推荐）：

```bash
cd ok-script-toolkit
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

然后在 VS Code 中：`Ctrl+Shift+P` → **Extensions: Install from VSIX...** → 选择生成的 `ok-script-toolkit-0.6.10.vsix`。

方式二（开发调试）：

用 VS Code 打开本项目根目录，按 `F5`（使用 `ok-script-toolkit/.vscode/launch.json` 的配置）启动扩展开发宿主，在宿主窗口打开任意 Python 文件即可看到效果。

## 自动发布

- Pull Request 和 `main` 推送只运行 `CI`，同时测试并打包 VS Code 与 JetBrains 两端，不会发布。
- **发布的唯一触发方式是推送一个尚不存在的 `vX.Y.Z` 标签**。工作流不提供手动发布，也不会因 `main` 推送自动发布。
- `package.json`、`package-lock.json` 和 `jetbrains/gradle.properties` 的版本必须完全一致；标签必须等于 `v<version>`。
- 标签工作流会测试两端，构建 VSIX 和 JetBrains ZIP，在同一个 GitHub Release 中上传两个安装包，然后按已配置的 Secret 发布两个 Marketplace。
- GitHub Release 使用仓库内置 `GITHUB_TOKEN`；Marketplace 所需 Secret 统一配置在父仓库 `AliceJump/ok-script-toolkit`，子仓库不保存发布凭据。

发布示例：

```bash
# 一次更新 package.json、package-lock.json 和 JetBrains pluginVersion
npm run version:sync -- 0.6.0
npm test

# 先提交并推送子仓库版本
git -C jetbrains add .
git -C jetbrains commit -m "chore(release): prepare v0.6.0"
git -C jetbrains push origin main

# 再提交父仓库版本和新的子模块指针
git add package.json package-lock.json jetbrains
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

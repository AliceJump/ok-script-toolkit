# 测试说明

`npm test` 全部在 Node 里跑，不需要 VS Code、显示器或网络：

- 纯逻辑单测（`scripts/test_*.js`，读 `out/`）：树模型、发布差异、发布预览、模板引用查找、悬停链接快照等。
- Webview 测试用 jsdom 加载 `media/*/index.html` 与脚本。
- 契约测试：`test_command_contract.js`（命令声明 / 注册 / NLS / 菜单 / when）、`verify:l10n`、设计系统审计。
- **激活冒烟测试** `test_activation_smoke.js`：用宽松的 `vscode` 模拟模块加载 `package.json` 的 `main`，调用 `activate()`，断言每个声明的命令都已注册、每个视图都有 provider。

## 局限

- 依赖里没有 `@vscode/test-electron`；它要下载 VS Code 并需要显示器（Linux 上要 xvfb），当前沙箱和 CI 都不具备，所以没有真实 Extension Host 集成测试，也**没有截图回归**。
- 模拟模块只验证“注册了”，不验证 UI 行为；webview 渲染、Python 执行器、真实游戏截图仍需人工验收。
- UI 截图（`/workspace/ok-toolkit-ui-shots/`）由 headless Chrome 渲染 webview HTML 得到，是视觉参考而非自动比对基线。

以后要上真集成测试：加 `@vscode/test-electron` + `@vscode/test-cli`，CI 用 `xvfb-run`，把冒烟测试里的断言搬进 `suite/extension.test.ts` 即可。

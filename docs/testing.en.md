# Testing

`npm test` runs entirely in Node — no VS Code, display or network:

- Pure unit tests (`scripts/test_*.js`, against `out/`): tree model, publish diff, publish preview, template reference finder, hover link snapshot, …
- Webview tests load `media/*/index.html` and scripts in jsdom.
- Contract tests: `test_command_contract.js` (declared / registered / NLS / menus / when), `verify:l10n`, design-system audit.
- **Activation smoke test** `test_activation_smoke.js`: loads `package.json` `main` with a permissive mocked `vscode` module, calls `activate()`, and asserts every declared command is registered and every view has a provider.

## Limitations

- `@vscode/test-electron` is not a dependency; it downloads VS Code and needs a display (xvfb on Linux), which this sandbox and CI lack. There is no real Extension Host integration test and **no screenshot regression**.
- The mock only proves registration, not UI behaviour; webview rendering, the Python executor and real game screenshots still need manual acceptance.
- UI screenshots (`/workspace/ok-toolkit-ui-shots/`) are headless-Chrome renders of webview HTML — visual reference, not an automated baseline.

To add real integration tests later: add `@vscode/test-electron` + `@vscode/test-cli`, run under `xvfb-run` in CI, and move the smoke assertions into `suite/extension.test.ts`.

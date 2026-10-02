# Development Guide

<div align="center">

[![简体中文](https://img.shields.io/badge/Language-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-6E7681?style=for-the-badge)](DEVELOPMENT.md) [![English](https://img.shields.io/badge/Language-English%20%E2%9C%93-2EA043?style=for-the-badge)](DEVELOPMENT.en.md)

</div>

This document is for extension developers and covers the project structure, local build/installation, and release workflow.

The shared runtime scripts, protocol, and host boundaries are documented in [Shared core](docs/shared-core.en.md); see [feature parity](docs/feature-parity.en.md) for current capabilities and limits.

---

## Project Structure

```text
src/                         VS Code extension host TypeScript source (entry points and major modules listed, not a complete inventory)
	projectConfig.ts           Read side of the project convention file ok-script-toolkit.json (locate + cache + personal preference)
	projectConfigPure.ts       Pure precedence-chain logic (no vscode dependency, unit-testable): parse + precedence + winning layer
	conventionSources.ts       Data source for the "Project Convention vs My Settings" tracing panel
	cocoFeaturePath.ts         Read side of the runtime template library path (cached probe of config.py's coco_feature_json)
	cocoFeaturePathPure.ts     Same, pure logic (precedence + candidate filtering)
	extension.ts               Entry point: activation, file watching & refresh dispatch, command registration
	langData.ts                Language JSON + gettext PO data source (inlay hints / completion / hover)
	featureData.ts             Template library (COCO) parsing + reverse lookup of source images by template name
	effectData.ts              Effect ID mapping (parses effects.py)
	effectProvider.ts          Effect ID hover provider (registered on JSON / JSONC data files only; the Python side goes through providers)
	characterData.ts           Character/skill data read-write (incl. synced-skill protection)
	characterPanel.ts          Character & skill manager panel host side
	consolePanel.ts            ok-script console host side (unified Tasks + Game view; schema probing, persistent executor, parameter channel)
	toolboxConnect.ts          Shared game connection + debug overlay host (connect_game.py / overlay_host.py, overlay mutual exclusion)
	providers.ts               Completion / hover / inlay providers
	labelEnumGuard.ts           Pre-write class-name guard for enum generation (pure function; keeps a personal override from breaking project imports)
	templateAssetData.ts       Template asset data (reads/writes <templates dir>/coco_annotations.json)
	templateAssetPanel.ts      Template asset panel host side (incl. the "save to assets" export flow)
	saveToAssetsPure.ts        Pure export-flow logic (target list + whether to prompt for the enum path)
	templatePanel.ts           Template gallery panel
	annotationPanel.ts         Annotation editor panel (draw/delete annotations + box-select normalized coords)
	annotationSwapPure.ts      Proportional remap for annotation swapping (pure: scale + clamp; one copy per host)
	tempScreenshotStore.ts     Temp screenshot store (up to 10, isolated per workspace on disk)
	tempScreenshotPanel.ts     Temp screenshot sidebar view (paste/screenshot, 0.1s carousel, box-select coords)
	tempDrag.ts                Cross-Webview drag relay (temp shots -> annotation manager; ineffective on VS Code side, see below)
	screenshotCapture.ts       Game window screenshot capture (window detection + capture_game_window.py call)
	pngCrop.ts                 Thumbnail cropping + content-hash disk cache (pairs with pngCropWorker.ts)
	pngCropWorker.ts           Worker thread for thumbnail cropping
	assetPack.ts               PNG packing for "save to assets" (pairs with assetPackWorker.ts)
	assetPackWorker.ts         Worker thread for packing
	localization.ts            Host strings and Webview dictionaries (two-layer i18n)
	webviewHtml.ts             Webview HTML assembly (nonce / CSP security boundaries live in one place)
	toolboxState.ts            Toolbox connection state (also written to the project's configs/devices.json)
media/                        Per-Webview HTML/CSS/JS (loaded by the host via CSP + asWebviewUri)
	icons/                     Activity bar & view icons (templates.svg, toolbox.svg, task.svg)
	annotationPanel/           Annotation editor
	tempScreenshots/           Temp screenshot sidebar
	templateAssetPanel/        Template asset management
	templatePanel/             Template panel
	console/                   ok-script console (Tasks + Game)
	characterManager/          Character skill management
python/                      Helper scripts shipped with the extension: task discovery, probing & execution (parse_config_tasks.py, probe_task_schemas.py, run_executor.py), plus game window capture & config probing for the template asset panel (capture_game_window.py, probe_window_config.py)
	python/tests/              Development-time Python regression tests (test_probe_*.py ×5 and test_run_executor_*.py ×4,
	                           9 in total, all wired into npm test; plus _test_tmp.py, the shared per-suite temp-dir infrastructure);
	                           excluded from VSIX / JetBrains JAR per AGENTS.md packaging rules
jetbrains/                    The JetBrains plugin's **separate public repository** (git submodule), with its own README / CI / release flow
schemas/                      JSON Schema for ok-script-toolkit.json (editor completion and validation)
docs/                         Design documents (config-reads overview, convention-file design, global UI design system, copy-pasteable example config)
scripts/                      Development-time generation & regression test tools, not included in VSIX
l10n/                         Extension host runtime localization resources
package.nls*.json             Extension manifest localization resources
screenshots/                  Demo GIFs for the README (**VS Code UI**; must NOT be reused in the sub-repo README)
out/                          TypeScript compilation output (generated by build)
```

Each externalized Webview's HTML, CSS, and JavaScript live in the same feature directory; the host loads resources via CSP restrictions and `asWebviewUri()`.

## Task Launcher: Persistent Executor Model

The task launcher is **not "one launch = one task process"** but rather **one persistent executor process per project**: `python/run_executor.py` starts only once, connects to the game once, and then the ok-script framework's native `TaskExecutor` polls all enabled trigger tasks in rotation; one-time tasks are enqueued to the same process.

- **Why you can't use `ok.run_task(config, task=<single task>)` for trigger tasks**: The framework calls `OK.run_trigger_task()`, narrowing `executor.trigger_tasks` to a single task and `disable()`-ing the rest, breaking multi-trigger chained polling. A single-task `python/run_task.py` used to cover that legacy path; it was **deleted in 2026-09** — nothing invoked it, and it **bypassed the config sandbox** (running it by hand wrote straight into the target project's `configs/`, violating the "the plugin never rewrites the debugged project's config" rule). To run one one-time task by hand, use the persistent executor's stdin command `onetime_enqueue <module::Class>` instead — that path is sandboxed.
- **Where polling happens**: `ok/task/TaskExecutor.py`'s `next_task()` — onetime queue → any enabled one-time task → trigger tasks rotate by `trigger_task_index`, executing when `enabled and should_trigger()` matches.
- **stdin commands**: `trigger_enable|trigger_disable <module::Class>`, `onetime_enqueue <module::Class>`, `task_disable` (stops current task, polling continues), `params <full json>`, `pause|resume`, `overlay_on|off`, `stop`.
- **stdout markers**: `OK_TOOLKIT_EXECUTOR_CONNECTING / _READY / _STOPPED`, `OK_TOOLKIT_STATE:<json>` (`current / currentIsTrigger / paused / triggers[] / onetimeQueue[]`, pushed on snapshot changes), reuses `OK_TOOLKIT_PAUSED / RESUMED / OVERLAY_* / ERROR:`.
- **The authoritative source for the enabled set** is the launch environment variable `OK_TOOLKIT_TRIGGERS` (JSON array): trigger tasks not listed are always set to disabled, preventing stale `_enabled: true` in `configs/*.json` from activating tasks. The enabled set is persisted in VSCode's `.vscode/ok-script-toolkit-tasks.json` / JetBrains's `.idea/ok-script-toolkit-tasks.json` under `projects[<dir>].enabledTriggers`.
- **No project config pollution**: Trigger tasks' `_enabled` always goes through `dict.__setitem__(task.config, "_enabled", v)`; the framework's `TriggerTask.enable/disable` would write back to project `configs/*.json` via `Config.__setitem__` → `save_file()`, so `run_executor.py` replaces both methods before importing tasks. Parameter overrides likewise only modify memory.
- **Task types** are provided directly by `python/parse_config_tasks.py`'s AST results (each entry has a `kind`), so the host can distinguish "trigger task toggle" from "one-time task enqueue" without waiting for schema collection.
- **Note `enable_after_start`**: `do_start(None)` automatically enables tasks declaring `enable_after_start` in the project (e.g., `LauncherTask` in ok-neverness-to-everness), so you may see one-time tasks running right after executor launch — this is existing GUI behavior, not a bug.
- **Verification** (no real game needed): Use a project with `windows.start_exe=False` (e.g., `ok-neverness-to-everness`) and run
  `(sleep 40; echo stop) | OK_TOOLKIT_TRIGGERS='["<module::Class>"]' ./.venv/Scripts/python.exe -u <repo>/python/run_executor.py --config-module src.config`,
  confirm output `CONNECTING → READY → STATE → STOPPED`; redirect stdout to a file then grep (content is often lost in pipes).

## Temp Screenshots & Normalized Coordinates

- **Temp screenshot sidebar** (`ok-script Temp Shots`) is an **independent container** in the activity bar (`viewsContainers` registers `okTempShots`, icon `media/icons/tempShots.svg`), separate from the template container. Holds up to 10 screenshots, auto-evicting the oldest when full; images are stored in the extension's `globalStorage` under a workspace-hash-isolated subdirectory.
- Supports `Ctrl+V` to paste system clipboard images, one-click game window capture, and drag/paste of image files.
- **The reliable entry point for importing to annotation management is the `→` button on the top-right of each card** (always visible). Cross-Webview drag-and-drop in VS Code is confirmed non-functional: each webview is an iframe with a different origin, `dataTransfer` is blocked by the browser, and **drop events are not dispatched**, so the host relay in `src/tempDrag.ts` also cannot receive them. The drag code and `text/plain` secondary channel are retained for future use if VS Code / Chromium opens cross-origin DnD.
- JetBrains side (see below) **drag works**: the two tool windows share the same JVM and use a custom `DataFlavor` to pass file paths directly.
- **0.1s carousel**: Clicking "Carousel 0.1s" cycles frames at 100ms intervals. **Carousel and box-select are independent channels**: the carousel keeps playing during box-select, and the selection box stays in place after release, making it easy to compare and fine-tune against moving targets (e.g., buttons with movement boundaries); normalized coordinates only capture ratios, so they are independent of which frame is displayed.
- **Box-select normalized coordinates**: Both the temp screenshot sidebar's "Box Select Coords" mode and the annotation editor's "Coords (C)" mode write `x,y,tox,toy` (top-left / bottom-right, normalized to 0..1 by image width/height, 4 decimal places) to the clipboard after box-select. Normalization is independent of display scaling, so results are consistent across downsampled previews and zoomed views.
- **The coordinate box is an adjustable ruler, not data**: After dragging, the box remains on the canvas with 8 directional handles and full drag support (same interaction as template annotation boxes). **Coordinates are re-copied on creation and after each adjustment**; the box itself never enters the annotation list, never writes COCO, and is never saved to disk. Click outside the box (beyond the frame and handles) to clear it; exiting coordinate mode also clears it.

## JetBrains / PyCharm Version

The `jetbrains/` directory contains a standalone Kotlin + IntelliJ Platform plugin project, currently requiring PyCharm / IntelliJ Platform 2025.1 or newer (with Python support). The initial version provides:

- Completion and quick documentation for `self.lang`, OCR `match`, template names, and effect IDs.
- Python / JSON effect and language value inline hints.
- Searchable native template tool window with insert, copy expression, or open source image.
- Project-level data directory, locale, template aliases, and hint toggle settings.
- Annotation editor (`AnnotationDialog`): draw/delete/coords modes, 8-way edge handles,
  drag-to-move, zoom/pan, undo/redo, Ctrl+C/V copy-paste, double-click value edit,
  ←/→ cross-image navigation; changes are written back to `coco_annotations.json` on OK
  (Cancel discards all).
- Temp shots tool window (`ok-script Temp Shots`): aligned with VS Code capabilities (10-shot limit,
  paste/screenshot enqueue, 0.1s carousel, box-select normalized coordinates, thumbnail drag to asset panel import).
  Drag **works here** — the two tool windows share the same JVM and use a custom `DataFlavor` to pass paths;
  note that `JPanel` has no built-in auto-drag-out, requiring manual `exportAsDrag` in `mouseDragged`.
- Follow-up parity work from main-repo v1.9.0 → v1.13.0 (Swing-side spec at
  [`jetbrains/docs/design-parity.md`](https://github.com/AliceJump/ok-script-toolkit-jetbrains/blob/main/docs/design-parity.en.md)):
  **global config takeover** (probe parses global config groups → parameter snapshots persisted →
  full snapshot injected via `OK_TOOLKIT_GCONFIG` at executor launch → live push via `gparams` while running),
  the health bar and the idle-state **run center** (current task / execution queue / trigger polling),
  and hover-only summaries on task rows and global config groups.

Build and install:

```bash
cd jetbrains
./gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration
```

Use `gradlew.bat` on Windows. The generated ZIP is at `jetbrains/build/distributions/` and can be installed via **Settings / Plugins / Install Plugin from Disk...** in a JetBrains IDE. For per-feature alignment status and remaining gaps, see [`jetbrains/docs/parity-review.md`](https://github.com/AliceJump/ok-script-toolkit-jetbrains/blob/main/docs/parity-review.en.md) (historical baseline; see [current feature parity](docs/feature-parity.en.md)).

## Installation

Packaged install (recommended):

```bash
cd ok-script-toolkit
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

Then in VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → select the generated `ok-script-toolkit-<version>.vsix`.

For modifying code and debugging without packaging, see the section below.

## Launch & Debug

Both editions ship with ready-to-use launch/debug configurations. These are development files and **do not enter the packaged output**:
`.vscode/` is excluded by `.vscodeignore`, and `jetbrains/.run/` does not participate in `buildPlugin`.

### Main repo: VS Code Extension

Open the project root in VS Code and press `F5` to launch the Extension Development Host. Open any Python file in the host window to see the effects.

| Entry | Description |
|---|---|
| `F5` → **Run Extension (Main repo VS Code extension)** | Runs `npm run compile` first, then launches the Extension Development Host |
| **Run Extension · watch hot-reload** | Runs `npm run watch` in the background; reload the host window after TS changes |

Command Palette → **Tasks: Run Task** offers these four (aligned with CI's `vscode` job):

| Task (label is in Chinese) | Equivalent command |
|---|---|
| `插件·编译（主仓库 VS Code 扩展）` | `npm run compile` |
| `插件·watch 编译（主仓库 VS Code 扩展）` | `npm run watch` |
| `插件·测试（主仓库 VS Code 扩展，等价 npm test）` | `npm test` |
| `插件·打包 VSIX（主仓库 VS Code 扩展）` | `npm run package` (automatically runs `compile` first) |

> The 9 Python tests inside `npm test` need a real `python` on PATH (CI uses `setup-python` 3.13);
> if your local `python` is the Microsoft Store alias it fails immediately with exit code 9009.

`.vscode/` only shares these three files (`launch.json` / `tasks.json` / `extensions.json`) —
`.gitignore` must use `.vscode/*` with `!` exceptions, since git cannot re-include files
after an entire directory is excluded; `settings.json` etc. remain local and uncommitted.

### Sub-repo: JetBrains Plugin

The sandbox IDE is launched by Gradle's `runIde`; `build.gradle.kts` sets `autoReload = true`,
so rebuilding auto-loads the new version without restarting the sandbox.

**A. IntelliJ / PyCharm (`.run/` configs ship with the repo, select from Run/Debug dropdown)**

| Config | Purpose |
|---|---|
| `Run Plugin (runIde)` | Normal run: launches a sandbox IDE with this plugin installed |
| `Debug Plugin 1 - start sandbox` | Equivalent to `runIde --debug-jvm`: sandbox JVM waits on port 5005 for a debugger |
| `Debug Plugin 2 - attach 5005` | Attaches to the above 5005, set breakpoints |

Run **1** first, then **2**: after running 1, the terminal will stop at
`Listening for transport dt_socket at address: 5005`, then run 2 to connect.

**B. CLI / VS Code**

```bash
cd jetbrains
./gradlew runIde              # Normal run
./gradlew runIde --debug-jvm  # Debug: waits on port 5005 for debugger attach
```

VS Code's **Tasks: Run Task** offers the same set (aligned with CI's `jetbrains` job):

| Task (label is in Chinese) | Equivalent command |
|---|---|
| `插件·运行沙箱 IDE（子仓库 JetBrains 插件）` | `./gradlew runIde` |
| `插件·调试沙箱 IDE（子仓库 JetBrains 插件，5005 等待附加）` | `./gradlew runIde --debug-jvm` |
| `插件·确保调试沙箱就绪（5005，未起则自动拉起）` | `scripts/debug-ensure-sandbox.ps1` (the `preLaunchTask` of the launch.json attach config) |
| `插件·附加调试器 jdb（子仓库 JetBrains 插件，5005，无需扩展）` | `scripts/debug-attach-jdb.ps1` |
| `插件·编译（子仓库 JetBrains 插件）` | `./gradlew classes` (fastest — no packaging, no tests) |
| `插件·测试（子仓库 JetBrains 插件）` | `./gradlew test` |
| `插件·编译并打包（子仓库 JetBrains 插件）` | `./gradlew buildPlugin` |

**Breakpoint debugging has two paths**:

1. **Graphical (one-key F5, requires the `vscjava.vscode-java-debug` extension)**: use the
   `附加到沙箱 IDE（子仓库 JetBrains 插件，5005）` config in launch.json. It chains a `preLaunchTask`
   (ensure sandbox ready): if the sandbox is not up, it spawns `runIde --debug-jvm` in a new window,
   polls until port 5005 listens, then attaches. After attaching the IDE is still suspended —
   **press Continue (F5) once** to let it finish booting.
2. **Zero-extension jdb**: run the debug sandbox IDE task and wait for
   `Listening for transport dt_socket`, then run the jdb task — it attaches with the `jdb` bundled with
   the JDK (type `cont` after attaching so the sandbox continues booting).

> Why `type: "java"` needs an extension: **VS Code has no built-in JDWP debug type**; `"type": "java"`
> comes from the `vscjava.vscode-java-debug` extension and reports "unrecognized debug type" when it
> is not installed — use the zero-extension jdb path in that case.

> Sandbox data is in `jetbrains/.intellijPlatform/sandbox/` (gitignored).
> `runIde` downloads the target IDE (PyCharm 2025.1) on first run, then uses local cache.

## Automated Release

- Pull Requests and `main` pushes run `CI` only; they do not publish directly.
- **The production entry point is `Actions → Prepare Release → Run workflow` in the parent repository.** It handles version calculation, release PRs in both repositories, squash merges, the parent gitlink, the final tag, and waiting for the downstream publishing pipeline.
- `Prepare Release` normally needs no input changes. If the parent, child, and gitlink are already synchronized but the current version tag is missing, it finishes that prepared version first; only an already-tagged current version is bumped (default `minor`, with `patch` / `major` available). An explicit `version` remains available for recovery or special targeting.
- The PR-only rulesets on both `main` branches are preserved: JetBrains and parent changes are always merged through release PRs with squash. Cross-repository writes and the final tag push use a GitHub App token (`RELEASE_APP_ID` + `RELEASE_APP_PRIVATE_KEY`).
- **The actual build/publish trigger remains the first push of a new `vX.Y.Z` tag.** The tag is pushed by the GitHub App, so the existing `.github/workflows/release.yml` starts normally; the orchestrator waits for that downstream run to finish.
- The tag workflow re-tests both editions, builds VSIX and JetBrains ZIP, attaches both to one GitHub Release, then publishes to Visual Studio Marketplace and JetBrains Marketplace when credentials are configured.
- GitHub Releases use the repository's built-in `GITHUB_TOKEN`; Marketplace credentials live only in the parent repository.

Additional one-click release configuration:

| Name | Type | Purpose |
|---|---|---|
| `RELEASE_APP_ID` | Actions Variable | Creates an installation token that can operate on both repositories |
| `RELEASE_APP_PRIVATE_KEY` | Actions Secret | GitHub App private key |

Install the GitHub App on both `ok-script-toolkit` and `ok-script-toolkit-jetbrains` and grant at least read/write access to Contents and Pull requests.

The legacy `npm run release`, `scripts/release.sh`, and `scripts/release.ps1` remain as local-flow references, but they push `main` directly and are rejected by the current rulesets. Use `Prepare Release` for production releases.

Tags are immutable release identifiers: never move, overwrite, or force-push a published tag. If the post-tag build fails, fix the code and release a new version instead of reusing the tag. If failure happens before the tag is created, rerun the orchestrator with the same explicit `version` to resume the two-repository synchronization.

Required repo Secrets:

| Secret | How to obtain | Required? |
|---|---|---|
| `RELEASE_APP_PRIVATE_KEY` | Release GitHub App private key | Required for one-click releases |
| `VSCE_PAT` | Visual Studio Marketplace publish PAT | Optional; can use OIDC Trusted Publishing instead |
| `JETBRAINS_TOKEN` | JetBrains Marketplace author page → My Tokens | Required for JetBrains Marketplace publishing |
| `JETBRAINS_PRIVATE_KEY` | PEM private key full text or Base64 for JetBrains plugin signing | Required for JetBrains Marketplace publishing |
| `JETBRAINS_PRIVATE_KEY_PASSWORD` | Password set when generating the private key | Required for JetBrains Marketplace publishing |
| `JETBRAINS_CERTIFICATE_CHAIN` | Matching `chain.crt` full text or Base64 | Required for JetBrains Marketplace publishing |

Configure Secrets under **Settings → Secrets and variables → Actions** and add `RELEASE_APP_ID` under **Variables**. When using VS Marketplace OIDC, also add `VSCE_USE_OIDC=true`.

See [RELEASING.md](RELEASING.en.md) for complete GitHub App, token, signing, and release instructions.

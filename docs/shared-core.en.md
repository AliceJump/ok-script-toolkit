# Shared Core for VS Code and JetBrains (v1.15)

[简体中文](shared-core.md) | [English](shared-core.en.md)

The parent repository maintains the protocol and Python runtime core. `jetbrains/` is an independent Git repository whose build tasks bundle the parent's Python scripts and JSON Schema. Both installation packages must contain **byte-identical** runtime scripts.

| Responsibility | Single maintenance location | How both hosts use it |
|---|---|---|
| Fast task registration parsing | `python/parse_config_tasks.py` | Start Python and show the AST task list first |
| Task parameters, global configuration, multi-account summary | `python/probe_task_schemas.py` | Read and cache the same JSON protocol; the complete probe determines the final task set |
| Project configuration directory, account store discovery, sandbox environment variables | `python/project_runtime.py` | Shared by the probe, account gateway, and executor; account store path changes belong here |
| Project-defined global configuration store discovery | `python/project_store.py` | The probe and executor share discovery from project declarations |
| Account reads and writes | `python/account_store.py` | Use the project's own store; hosts do not edit account files directly |
| Persistent execution, task visibility, parameter overrides | `python/run_executor.py`, `python/executor_runtime.py`, `python/executor_input.py`, `python/task_visibility.py` | Use the same commands and state protocol |
| Window discovery, connection, screenshots, overlay | Scripts including `python/probe_window_config.py` | Call the same scripts |
| Project convention file structure | `schemas/ok-script-toolkit.schema.json` | VS Code registers it directly; JetBrains reads it from JAR resources |

Hosts own IDE lifecycle, controls, Python processes, caches, and user data locations. VS Code uses TypeScript/Webview and `.vscode/`; JetBrains uses Kotlin/Swing and `.idea/`. These directories are intentionally isolated. All three runtime entry points (schema probe, account gateway, executor) receive an explicit `OK_TOOLKIT_RUN_DIR` from the host. The account gateway still accepts the legacy `--run-dir` argument for existing callers.

Task keys use `module::Class`. The first screen takes task membership from a fresh AST parse; cached data only supplies names and types. After a successful probe, runtime schema keys determine the final list. Probe failures must tell users that only stale cache or task names may be available; degraded results must not appear as a successful complete scan.

Each host still persists its own configuration snapshots, with the same semantics: inherit current values initially, use defaults for new keys later, retain old keys, and isolate by project root. Forms and IDE storage cannot share source code across languages. When changing these rules, verify both `src/consolePanel.ts` and the child's `TaskConfigMerge.kt` / `GlobalSnapshotRules.kt`. Asset and editor UIs also remain host implementations; they are not presented as shared Python core.

Before release, run parent `npm test` and `npm run package`, and child `gradlew test buildPlugin`. Check that the `python/*.py` file sets and contents match between the VSIX and JetBrains JAR. Parent version validation also checks both repositories' versions.

The executor initializes project services, overlays, and device discovery through `OK.start_runtime()`, then connects and starts tasks through native `StartController.start()`. If the framework has already initiated a connection through autostart settings or command-line tasks, the adapter waits for that result instead of starting again. Startup failure or timeout never sends READY; timeout prints thread stacks for diagnosis. Missing runtime startup APIs produce an explicit error requiring an ok-script update. For direct Windows game startup, the outer timeout covers the native controller's separate window-stability and device-readiness waits; a custom task that starts the game retains a single-stage budget.

On Windows, the stdin command pipe checks arrived bytes with `PeekNamedPipe` before reading and incrementally decoding. When idle, it only waits for cancellation instead of blocking in CRT pipe reads. Otherwise, NTE native-library initialization may block subsequent thread creation, leaving both an enqueued custom startup task and READY waiting for another input. Startup requires no trigger-task toggle. Split UTF-8 sequences, CRLF, multiple commands, and pipe closure retain the same protocol handling.

The configuration baseline is copied into the host sandbox before project import. Both framework Config paths and project paths obtained through `get_relative_path` are redirected, including custom directories and absolute paths. Environment preparation hooks run before the first framework import. Runtime-computed directories are copied and registered before Config first opens a file; checks after import do not overwrite sandbox writes already produced. Sandbox creation/copy failures and overlap with project configuration abort startup. Containers in the project configuration dictionary are also copied before adaptation; window, interaction, capture backend, and task registration declarations retain project values. Task commands received during startup are queued and handled by the main loop after connection completes.

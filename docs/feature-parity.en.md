# Feature and Documentation Parity

Verified: 2026-10-01. Local baseline: parent `efc4ff9`, JetBrains child `4df0cee`, both version `1.19.0`. This matrix uses current source entry points and the checks below, not design plans, other branches, or historical review conclusions.

[简体中文](feature-parity.md) | [English](feature-parity.en.md)

## 1. Current Features

“Present” means an actual implementation entry point exists in both hosts, not that real IDE/game acceptance was completed in this pass.

| Feature | VS Code | JetBrains | Parity and evidence |
|---|---|---|---|
| Language/OCR/template/effect reference hints | Present | Present | `src/providers.ts` / child `editor/OkEditorSupport.kt`; native host extension points |
| AST task list and runtime schemas | Present | Present | Shared `python/parse_config_tasks.py` / `python/probe_task_schemas.py`; host caches/UI |
| Persistent executor, one-time queues, triggers, pause/stop | Present | Present | `src/consolePanel.ts` / child `TaskRunnerService.kt`; shared `python/run_executor.py` |
| Native startup and configuration isolation | Present | Present | Shared `OK.start_runtime()`, native controller, sandbox; nonblocking Windows input in `python/executor_input.py` |
| Current task/global-group parameter editing | Present | Present | `src/consolePanel.ts` / child `TaskLauncherService.kt`, `GlobalSnapshotRules.kt`; startup `OK_TOOLKIT_GCONFIG`, runtime `gparams` |
| Account override debugging | Present | Present | Shared `python/account_store.py`; child `AccountEditorDialog.kt`, beyond probe metadata passthrough |
| Project conventions and personal provenance | Present | Present | `src/projectConfig.ts` / child `ProjectConvention.kt`, `ConventionSources.kt`; declared fields connected with corresponding type/provenance rules |
| Runtime template paths and enum export fallback | Present | Present | Template library consumes `config.py`; export entry points in `templateAssetPanel.ts` / child `TemplateAssetToolWindowFactory.kt` provide enum fallback |
| Template assets, export, previews, source navigation | Present | Present | `src/templateAssetPanel.ts`, `templatePanel.ts` / child `TemplateAssetToolWindowFactory.kt`, `TemplatesToolWindowFactory.kt` |
| Box editing, publication, runtime galleries | Present | Present | `src/boxPanels.ts`, `boxResourceStore.ts` / child `BoxWindows.kt`, `BoxCatalogService.kt`; separate COCO working files and runtime tables |
| `self.pos` completion/Hover | Present | Present | `src/providers.ts` / child `editor/OkEditorSupport.kt`; business projects still own game loading |
| Thumbnail actions and Python insertion target | Present | Present | `src/pythonEditor.ts` / child `PythonEditorTarget.kt`; templates/boxes reuse recent Python editors, no longer TODO |
| Annotation editing, undo, copy, image swapping, visibility | Present | Present | `src/annotationPanel.ts` / child `AnnotationDialog.kt`; common COCO contract, different save timing |
| Temporary screenshots, capture, connection, overlay | Present | Present | Shared Python calls; separate host storage and UI |

## 2. Remaining Differences and Boundaries

- **Annotation save timing:** VS Code saves on change; JetBrains aggregates writes in `AnnotationDialog.doOKAction()`, discarding edits on cancel. Do not describe this as autosave or change semantics during documentation work.
- **UI carriers:** Webview versus Swing. Parameter layouts, keymaps, and editor entry points follow their IDEs; parity does not require pixel-identical UI structure.
- **Application feedback:** snapshot persistence, command sending, and business runtime application are separate outcomes. No uniform business acknowledgement exists; save/send success does not prove game usage.
- **Business changes:** current declarations govern removed parameters, task splits, and internal detection templates; they do not automatically require plugin adaptation or migration.
- **External loaders:** correct published box files do not prove project loading; actual game execution requires separate validation.

## 3. Documentation Corrections

| Document | Correction |
|---|---|
| `AGENTS.md` | Merge former `AGENT.md`; consolidate scope, boundaries, language rules |
| `project-config.en.md` | Remove stale claims of unwired global fields, unread box management, and skipped pre-import hooks |
| `config-reads.en.md` | Add `boxes.runtime`; distinguish ordinary enum accessors from export fallback; clarify layer numbering |
| Child `design-parity.en.md` | Mark global injection/pushes and account editing implemented instead of original planned gaps |
| Child `parity-review.en.md` | Update recent Python editor tracking; retain historical baselines explicitly and use this matrix for current status |
| Child architecture report | Preserve historical analysis without treating old missing features/line counts as current acceptance |

All documents except Agent instructions, skills, and skill references have separate Chinese `.md` and English `.en.md` versions maintained together. Code, APIs, and necessary original UI labels are not mixed-language prose.

## 4. Validation and Limits

Parent checks passed: `test_box_resource.js`, `test_thumbnail_actions.js`, `test_project_config.js`, `test_coco_feature_path.js`, `test_run_executor_sandbox.py`, `test_run_executor_gconfig.py`, covering resources, thumbnail actions, precedence, template paths, isolation, and global configuration application.

JetBrains `BoxResourceTest`, `GlobalSnapshotRulesTest`, `TaskConfigMergeTest`, and `BundleParityTest` passed all 45 cases. The global UI static audit passed for 7 panels. Documentation checks confirmed 16 bilingual pairs and 7 Chinese Agent/skill references, without missing local links or numbered sections; both repositories passed `git diff --check`. VSIX build/archive checks passed with no Agent, skill, or development documents included.

No real IDE walkthrough or game execution was performed; source entry points and automated tests do not replace that acceptance.

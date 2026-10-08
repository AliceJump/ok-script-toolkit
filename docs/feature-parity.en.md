# Feature and Documentation Parity

[简体中文](feature-parity.md) | [English](feature-parity.en.md)

Verified on 2026-10-08. Main baseline: `aea8b14`; child `main` baseline: `9eb4992`; both versions: `1.23.0`. This round extends child [PR #28](https://github.com/AliceJump/ok-script-toolkit-jetbrains/pull/28) from `0e846f0` and updates the main host on `codex/complete-feature-parity`. Conclusions below describe this round's PR code, which is not released until merged and published.

Current interaction changes ship through [JetBrains PR #30](https://github.com/AliceJump/ok-script-toolkit-jetbrains/pull/30) and [parent PR #37](https://github.com/AliceJump/ok-script-toolkit/pull/37), version `1.24.0`. Annotation management and previews follow VS Code. The PR #28 baselines and validation counts below remain historical evidence, not current PR review status.

## Current Feature Audit

| Feature | Implementations and entry points |
|---|---|
| Language, OCR, Template and effect references | `providers.ts` / `editor/OkEditorSupport.kt`, reading current local resources |
| AST tasks, runtime schema, parameters, global groups, account overrides | `consolePanel.ts` / `tasklauncher/`, sharing main-repository Python probes and account interfaces |
| Resident executor, queue, triggers, pause, stop, config isolation | Shared `python/run_executor.py` and helpers; hosts expose state, logs and errors |
| Project conventions, personal overrides and provenance | `projectConfig.ts` / `ProjectConvention.kt`; Position publication settings expose path provenance and override reset |
| Unified Template / Rect / Point annotations | `annotationPanel.ts` / `UnifiedAnnotationUi.kt`; three COCO authoring files share source images |
| Coordinates, visibility, undo/redo, mode cycling, clipboard | Common coordinate contract, M to cycle modes, shared and per-mode histories |
| External edits and conflicts | `annotationMerge.ts` / `AnnotationSessionSync.kt`; preserve both edits and verify source revisions before saving resolved results |
| Source-image management | Import, capture, temporary screenshot send/drop, search, editing, source viewing, Template swaps, deletion across three authoring sources and external-change refresh |
| Unified publication | Select Template / Rect / Point in annotation management; gather all configuration before writes; Position failure or rejected overwrite prevents Template writes |
| Template and enum publication | Shared packing contract; destination, enum path and class settings; framework path fallback and old-class reference checks |
| Position publication | Unified JSON / Python output; personal → project → default paths; protection for handwritten files and explicit custom-JSON overwrite |
| Resource previews | Side and wide three-mode image cards, name/expression search, single-click insert, double-click copy and annotated source navigation; runtime Templates, current authoring Rect / Point |
| `self.pos` hints | Current Rect / Point declarations; Rect uses `self.pos.<path>.to_box()`, Point uses `self.pos.<path>` |
| Characters, effects, screenshots, connection and overlay | Existing host entry points using shared framework probes and executor interfaces |
| Getting started | Native main walkthrough / child `GettingStartedEditor.kt` |
| Localization and resources | Six languages; main host/Webview dictionaries and both child UI bundles use external resources |

## Differences Closed in This Round

1. The child CI's previous main pin lacked Position Schema fields. Pin `aea8b14` and test both publication-path fields. Shared Python requires no changes.
2. Child Template cards now read runtime resources rather than unpublished authoring data, preserving actual images, bbox and configured aliases. Restore insertion, copying, source navigation and resource-change refresh; side and wide previews share implementation.
3. Child unified image management connects viewing, swapping, deletion, temporary screenshot drops, search and automatic refresh. Narrow toolbars wrap and reserve visible height for every action; lists and thumbnails reject old asynchronous callbacks.
4. Restore child enum path/class configuration, framework fallback and old-class reference checks. All decisions precede writes; cancellation and rejected overwrites stop subsequent publication.
5. Position personal paths can be reset with empty input. Both reject absolute paths, traversal, the root itself and symlink escapes. Main settings descriptions and publication messages use six external language resources.
6. Both reserve image names from `points.json`; child screenshot sending uses the actual project root. Deletion clears all three authoring sources, restores image and modified files on later failure, and preserves same-stem resources with different extensions. Both hosts' Point cleanup filters only the selected image and its annotations, preserving unrelated empty image registrations, fractional coordinates, original IDs and extension fields. The child exits on Template read errors before cleaning secondary sources.
7. Move all six main Webview dictionaries out of business code; add 19 missing keys and resource-preview messages, and correct Simplified Chinese trigger-mode and ALL/ANY hints in the other five languages. Translation checks read actual TypeScript literal values, including escaped newlines and quotes, and cover real Webview calls.
8. Match `Ctrl+Alt+T` resource-preview shortcuts and wide-preview titles. Remove unregistered text windows and old preview publishing code; main Rect cards report actual crop dimensions.
9. Update this matrix, [Project Conventions](project-config.en.md), [Configuration Reads](config-reads.en.md) and [Position Resource Contract](box-resources.en.md), replacing historical runtime-box and migration descriptions.

## Deliberate Host Differences

Both hosts edit annotations in an editor tab and save authoring files after completed creation, editing, dragging, deletion, undo or redo. Saving does not publish resources. JetBrains exposes save errors and a retry action, preserving a plugin draft for recovery and external-change reconciliation when reopened. Card actions, clicks, visibility, delete mode, numeric editing, arrow-key nudging and image navigation follow VS Code; inputs and confirmation use each IDE’s host controls.

Business projects load published files. The plugin provides current declarations, runtime state and log entry points without business parameter migration, historical-key recovery or application acknowledgement protocols. See the position-resource contract for operation details.

## Verification and Repository State

- Final main `npm test` and `npm run package` passed, using installed Python rather than the Windows Store placeholder.
- Child `gradlew test buildPlugin verifyPluginStructure verifyPluginConfiguration` passed: 487 tests, zero failures, errors or skips.
- Regression coverage includes cancellation/write ordering, path reset, enum references, runtime Templates/reference expressions, image reservations, deletion/rollback across three sources, narrow-toolbar height and stale thumbnail callbacks.
- All six external main Webview dictionaries have 388 matching keys; 413 actual literal UI calls are covered. Host translations and child UI bundles are checked as well.
- Final VSIX and JetBrains JAR contain 13 byte-identical Python scripts and the same convention Schema, with complete language resources and no Agent files, tests or developer documentation.
- Historical CI passed at `0e846f0`; old review coverage was `a9fd35f`, and a previous manual re-review was rate-limited. Verify new CI and review coverage against each PR's current head; historical results do not cover this round's changes.
- Confirmed code differences are closed, and the main PR gitlink pins the companion child PR commit. Merge child PR #30 first, then confirm or update the gitlink to a commit reachable from child `main` and verify main CI before merging the main PR. Unmerged code is not released functionality.

No actual IDE interaction, game screenshot or business-project runtime acceptance was performed. Full Plugin Verifier API compatibility was not run; build, structure checks and automated regression do not replace those checks.

# Project Convention File (`ok-script-toolkit.json`) Design

[简体中文](project-config.md) | [English](project-config.en.md)

This file helps the developer plugin discover **current local project interfaces and resource entry points**; see [Developer Plugin Scope and User Experience](developer-tool-scope.en.md). It does not contain business parameter migration tables. When projects remove or transfer parameters, the plugin follows current declarations instead of restoring or transferring old debug values.

> Status: **existing fields connected in both hosts** (local source verification, 2026-10-08). Companion artifacts: `schemas/ok-script-toolkit.schema.json` and `docs/ok-script-toolkit.example.json`.
>
> | Scope | Status |
> |---|---|
> | Executor (`load_project_config` / `executor.startupHooks`) | ✅ `13f754b` |
> | VS Code loader + `labelEnum` | ✅ `df41a85` |
> | JetBrains loader + `labelEnum` | ✅ `core/ProjectConventionConfig.kt` + `core/ProjectConvention.kt` |
> | Screenshot shortcut (§6.4) | ✅ Both hosts |
> | `templates.directory` (formerly unused setting in §8.1) | ✅ Both hosts |
> | Project convention vs my settings provenance panel (§3) | ✅ Both hosts |
> | `i18n` / `characters` / `effects` | ✅ Both hosts |
> | `templates.cocoAnnotations` (including `config.py` facts) | ✅ Both hosts |

> **Companion reading:** [Runtime Configuration Read Paths](config-reads.en.md) covers **all** runtime configuration reads: six actual layer combinations, each setting's purpose, invariants, and troubleshooting. This document covers only the project convention file layer; the companion also covers IDE settings and the `config.py` probe.

## 1. Problems to Solve

The plugin currently stores **project conventions** in **IDE user settings**. Both hosts have fields with matching names and meanings (18 in VS Code / 19 in JetBrains, with 17 overlapping), but:

1. **They do not travel with projects:** changing machines or colleagues requires configuration again.
2. **Each host stores a copy:** using two IDEs requires entering values twice and can cause disagreement.
3. **Defaults are guesses:** `assets/lang`, `i18n`, `ok_templates`, and `src/data/effects.py` only fit standard layouts.
4. **Some project facts are never read:** values are declared in `config.py`, but the plugin guesses from names.

The fourth problem is most serious. Enum paths for ok-end-field and ok-infinity-nikki are declared, or should be declared, in `config.py`, while the plugin relies on regexes assembled from `featureAliases` to guess from code.

## 2. Design Principles

> **Read facts already declared in project `config.py` first. `ok-script-toolkit.json` covers only what `config.py` lacks or does not consistently declare.**

This keeps the convention file small and avoids maintaining one fact twice.

### Evidence: `config.py` Survey of Five ok Projects

| Project | `config_folder` | `screenshots_folder` | `template_tab.label_enum_relative_path` | `generate_label_enum` | `template_matching.coco_feature_json` |
|---|---|---|---|---|---|
| ok-end-field | ✓ | ✓ | ✓ | ✓ | ✓ |
| OK-AzurPromilia | ✓ | ✓ | ✓ | ✓ | ✓ |
| ok-gf2 | ✓ | ✓ | ✓ | ✓ | ✓ |
| ok-infinity-nikki | ✓ | ✓ | **✗** | **✗** | ✓ |
| ok-gm | ✓ | ✓ | **✗** | **✗** | ✓ |

Three categories follow:

- **5/5 declare** `config_folder`, `screenshots_folder`, and `coco_feature_json`: no need to duplicate them in the convention file; read `config.py` (`config_folder` already works this way).
- **3/5 declare** `label_enum_relative_path`: cannot rely on it.
- **0/5 declare** enum class names or reference aliases: the convention file must declare them.

The last two justify `labelEnum`. ok-infinity-nikki and ok-gm lack even `template_tab`, although `src/data/FeatureList.py` exists.

## 3. Value Precedence

```text
① Built-in defaults (fallback)
      ↑ overridden by
② Facts declared in project config.py
      ↑ overridden by
③ ok-script-toolkit.json (committed team defaults)
      ↑ overridden by
④ Personal preferences (IDE settings) ← highest
```

The purpose of **④ highest**: the project file gives team defaults; explicitly changed personal values win.

⚠️ **Side effect:** once someone changes a value, the project declaration for that setting stops applying indefinitely, hiding later team changes. Implement these mitigations together:

1. Show whether a value comes from project conventions or personal overrides.
2. Provide Restore project convention, clearing the personal override back to ③.

> ✅ **VS Code mitigation implemented:** `src/conventionSources.ts` and `okScriptToolkit.showConventionSources` (QuickPick, with a `discard` icon on overridden rows).
>
> Two requirements:
>
> - **The resolution chain produces provenance; UI does not recompute it.** `projectConfigPure.resolveSetting()` returns `{ value, layer }`. Independent provenance logic eventually disagrees with actual values, yielding misleading UI. Derive `overridden` from `layer === 'personal'`, not value comparison.
> - **Restore clears populated values in all three scopes**: workspace folder / workspace / user. Clearing one scope leaves effective overrides behind; writing `undefined` indiscriminately leaves empty entries. First use `inspect()` to find populated scopes.
>
> This is a command because **VS Code's settings UI is not extensible**: `contributes.configuration` supports static descriptions, not dynamic provenance or buttons.
>
> Add each newly connected setting to `conventionSources()`. `scripts/test_convention_sources.js` checks keys against `package.json`, catching typos that silently break restoration.
>
> The panel's `declared` value is **not read separately from the config object**. Clear personal preferences and run the same chain again; a `builtin` result means no declaration. This gives displayed and effective values identical normalization, so `./lang` becomes `lang` in both.
>
> ✅ **JetBrains counterpart implemented:** pure `core/ConventionSources.kt` and `ui/ShowConventionSourcesAction.kt` (`AnAction` + `DialogWrapper`). `ProjectConvention` yields the same `{ value, layer }`; registration lives in `conventionSourceRows()`.

Every layer is optional. Missing layers fall through; if all are absent, behavior remains unchanged. **A missing file preserves existing behavior: this is additive.**

### ⚠️ Implementation Trap: Explicit Settings vs Defaults in Layer ④

Both hosts encountered this real, silent failure. IDE settings have nonempty defaults:

- VS Code: `okScriptToolkit.featureAliases` in `package.json` defaults to `["fL","FeatureList","Labels"]`.
- JetBrains: `SettingsState.init` initializes the same list.

Simply reading IDE settings always returns a value, so ④ always wins and **③ never applies**. The UI looks normal while project settings have no effect.

| Host | Correct criterion |
|---|---|
| VS Code | `getConfiguration().inspect('featureAliases')`, using `workspaceFolderValue ?? workspaceValue ?? globalValue`; unset only when all are `undefined` |
| JetBrains | Empty state defaults (empty list means unset). Legacy defaults use `featureAliasesTouched` to distinguish initialization from an identical user-entered value, with a one-time migration |
| JetBrains scalar settings | Nonempty `SettingsState` defaults such as `ok_templates` / `assets/lang` cannot use emptiness. Track `overriddenKeys`; `OkScriptToolkitConfigurable.apply()` records only actual changes, `init` seeds legacy users once, and resolution checks membership first |

**General rule:** any nonempty-default setting needs a signal of actual user changes before joining the chain, or ④ permanently masks ③. Check defaults before wiring.

⚠️ Record changes **before assignment in `apply()`**; after assignment the old value is lost. Unconditionally recording keys means merely opening settings and clicking Apply silently overrides every project convention.

> **Known tradeoff:** JetBrains settings UI alone maintains `overriddenKeys`. Direct edits to `ok-script-toolkit.xml` are not recorded, so those keys remain unset and project conventions apply. This is acceptable because manual XML editing is unsupported.

> **Both mitigations are complete** (see §3). Adding groups increases the surface of hidden team changes, so **update the provenance registries with every new group**: VS Code `conventionSources()` and JetBrains `conventionSourceRows()`. Tests check keys against `package.json` in VS Code and registry contents/order in JetBrains.

## 4. File Shape

- Name: **`ok-script-toolkit.json`**, visible, without a leading dot, intended for commits.
- Location: **root of the project being debugged**.
- Format: **plain JSON**, not JSONC.
  - Neither host needs parser changes; the child's bare `ObjectMapper()` rejects comments by default.
  - Schema `description` provides hover documentation from one maintained source.
- Associate the schema through `contributes.jsonValidation` for completion and validation.

**Boundary:** the plugin **reads only**, never silently writes this file.

## 5. Fields

### Included in the Convention File

| Group | Field | Declared in config.py? | Fallback |
|---|---|---|---|
| `labelEnum` | `path` | 3/5 | IDE `labelEnumPath` → `template_tab.label_enum_relative_path` → empty (no enum generation) |
| | `name` | **0/5** | IDE `labelEnumName` → path basename (existing behavior) |
| | `aliases` | **0/5** | IDE `featureAliases` → `["fL","FeatureList","Labels"]` |
| `executor.startupHooks` | `beforeConfigImport` | **No such information** | Statically identify direct `patches.*` calls in `main.py` before config import |
| | `afterConfigImport` | **No such information** | Try convention `src.patches.startup_patches:install_startup_patches` |
| `templates` | `directory` | No (plugin convention) | IDE setting → `ok_templates` |
| | `cocoAnnotations` | **6/6** | `template_matching.coco_feature_json` → two discovery candidates |
| `position` | `jsonPath` | Plugin publishing convention | Personal preference → project convention → `src/scene/positions.json` |
| | `pythonDirectory` | Plugin publishing convention | Personal preference → project convention → `src/scene` |
| `i18n` | `enabled` / `langDirectory` / `poDirectory` / `poDomains` | No | IDE settings → built-ins |
| `characters` | `projectPath` / `masterFile` / `skillsDirectory` / `localeFile` / `avatarTemplateRegex` | No | IDE settings → built-ins |
| `effects` | `file` | No | IDE setting → `src/data/effects.py` |

**Wiring status:** current Schema fields are connected in both hosts. Unified annotation management and resource previews replace separate box windows. `self.pos` completion and previews read current Rect / Point authoring data; publishing uses `position.jsonPath` / `position.pythonDirectory`. Publishing settings expose the source and let users change or clear personal path overrides. See [Position Resource Contract](box-resources.en.md).

**⚠️ Files named `coco_annotations.json` can mean different things.** Wrong wiring silently selects the wrong file:

| File | Meaning | Readers/writers | Path source |
|---|---|---|---|
| `assets/coco_annotations.json` (or config.py location) | Framework **runtime template library** | `featureData` / `OkProjectDataService` read and watch | `templates.cocoAnnotations` → config.py → two conventions |
| `<template directory>/coco_annotations.json` | Asset panel **annotation working file** | `templateAssetData` / `TemplateAssetDataService` read/write | `templates.directory`, **unaffected by** `cocoAnnotations` |
| `<template directory>/points.json` | Point COCO authoring data | Unified editor writes; resource previews and `self.pos` hints read | `templates.directory` |
| `<template directory>/boxes.json` | Rect COCO authoring data | Unified editor writes; resource previews and `self.pos` hints read | `templates.directory` |
| `src/scene/positions.json` or a custom path | Published normalized Position data | Explicit publication writes it; business projects provide game loading | `position.jsonPath`, personal preference first |
| `ScreenRatio.py` / `PositionMap.py` | Published Python position data and parser | Explicit publication writes them, protecting existing handwritten files | `position.pythonDirectory`, personal preference first |

`templates.cocoAnnotations` consumes project facts without personal preferences. Position publication has personal overrides and does not read legacy `boxes_json`; `boxes.runtime` has been removed from the current Schema and plugin entry points. Saving annotations does not publish Position data or modify business-project loaders.

**Choose normalization by field type**; wrong choices fail silently:

| Type | Helper | Reason |
|---|---|---|
| Relative paths (directories/data files) | `relPathResolved` | Used in globs or directory-segment comparisons; `assets\lang` / `./assets/lang` otherwise miss |
| Absolute paths (`characters.projectPath`) | `textResolved` | Normalization strips the leading POSIX slash |
| Regex (`characters.avatarTemplateRegex`) | `textResolved` | Normalization changes `\d` to `/d` and strips trailing `/`, breaking regex |
| Boolean | `boolResolved` | Handwritten `"enabled": "false"` is a truthy string without a guard |
| String arrays | `listResolved` | Empty means undeclared, allowing restoration of project conventions |

### ⚠️ `labelEnum.path` Is a Module Path; Consumers Add `.py`

`labelEnum.path` has the same shape as `label_enum_relative_path`: a module path such as `src/data/FeatureList` without `.py`. Framework `_normalize_label_enum_relative_path()` in `ok/ui/qt/tasks/TemplateTab.py` actively strips `.py` before saving; ok-end-field, OK-AzurPromilia, and ok-gf2 declare `src/data/FeatureList`.

Consumers generating files or absolute paths need a **file path**. Writing the module path directly creates extensionless `FeatureList`, which Python cannot import and breaks the project.

Each host provides one explicit conversion: VS Code pure `labelEnumPath()` / setting accessor `labelEnumPathSetting()`; child `LabelEnumConvention.filePathOr()`. **Do not assemble suffixes at call sites**; accept existing `.py` without duplication. Both layers share `normalizeLabelEnumFile`. The old implementation normalized only project declarations and returned personal preferences unchanged, generating extensionless files from module-path input.

### ⚠️ `labelEnum.name` Is a Code Contract

Most fields control only plugin reads. `labelEnum.path` / `name` determine **written file location and class name**, while project code imports by name:

```python
from src.data.feature_list import FeatureList      # 10 occurrences in OK-AzurPromilia
```

Changing the class to `MyEnum` can prevent the entire project from running, not merely change local display. Personal overrides can break the project.

**Allow changes, but confirm before overwriting an existing file**, in both hosts.

| Step | Implementation |
|---|---|
| Pure, testable criterion | VS Code `src/labelEnumGuard.ts`; child `core/LabelEnumGuard.kt` |
| IO/dialog | VS Code `templateAssetPanel.confirmLabelEnumRename()`; child `ui/TemplatePublishFlow` |
| Tests | `scripts/test_label_enum_guard.js`, including 5 destructive comparisons |

Three invariants:

1. **No file → no prompt:** new generation cannot invalidate an old name.
2. **Same old/new class name → no prompt:** regeneration on every save should not create noise.
3. **Existing file with unrecognizable class → prompt:** the path may point to an ordinary module whose contents would be deleted.

Report impact by scanning project `**/*.py` for old-class imports. `importsName` handles `from a import X`, `(A, X)`, `X as fL`, and `import a.X`. **Prefer false positives over missed references**, including commented imports. This informs confirmation, not automatic decisions.

**Validate class changes, not path changes.** Changing paths leaves the old module intact, so old imports still work (without new labels). Renaming inside the same file immediately breaks references. Only class changes need this guard.

### 🧹 Related Fix: Global Last-Saved Path in `globalState`

The personal `labelEnumPath` formerly lived in `context.globalState['okScriptToolkit.lastEnumFilePath']`. It is now **deprecated in favor of a real IDE setting** because:

1. It was global while consumers resolved against current roots. A path entered for project A could silently generate nonexistent directory trees in B through `mkdirSync(dir, { recursive: true })`.
2. It was invisible in settings/provenance, leaving users unable to see remembered values.
3. Restore project convention clears IDE scopes, not `globalState`, producing the prohibited provenance/effective-value disagreement.

The chain becomes `IDE setting > project convention > fallback`, like `featureAliases`. Change path now writes an **IDE setting** at workspace-folder scope, or globally only without a workspace. Remembered-path convenience remains visible, editable, and traceable.

> **No migration:** the old global value may itself be wrong. Copying it would preserve the bug. Fall back to the correct project convention and ask again on the first save.

### Excluded from the Convention File

- **Personal preferences:** `displayLocale`, `enableInlayHints`, `enableTemplateGallery`, `annotationKeybindings`, and **screenshot shortcuts** (§6.4).
- **Machine-specific:** `okScriptPython`, `captureMethod`, `okScriptProjectPath`.

Committing these would impose one person's machine/preferences on colleagues.

## 6. Host Change Checklist

### Additions (Corresponding Logic in Both Hosts)

| Host | File | Responsibility |
|---|---|---|
| VS Code | `src/projectConfig.ts` | Find/parse `ok-script-toolkit.json`, expose accessors with defaults |
| JetBrains | `core/ProjectConventionConfig.kt` | Same |

### Precedence Changes (Add a Layer to Existing Accessors)

| Host | File | Fields |
|---|---|---|
| VS Code | `src/langData.ts` | `langDirectory`, `poDirectory`, `poDomains`, `enablePoData` |
| | `src/characterPanel.ts` | `characterMasterFile`, `characterSkillsDirectory`, `characterLocaleFile`, `characterAvatarTemplateRegex` |
| | `src/characterData.ts`, `src/effectData.ts`, `src/extension.ts`, `src/taskLauncher.ts` | `effectsFile`, `poDirectory` |
| JetBrains | `settings/OkScriptToolkitSettings.kt` | All accessors: insert project layer before `ifBlank { default }`; `overriddenKeys` distinguishes explicit scalar/boolean/list values from defaults |
| | `core/OkProjectDataService.kt`, `core/OkDataChangeService.kt`, `ui/CharacterManagerPanel.kt`, `tasklauncher/TaskLauncherToolWindowFactory.kt` | Consumers already use setting accessors; change the accessors themselves |

> **Host symmetry:** `projectConfigPure.ts` ↔ `core/ProjectConvention.kt` (pure objects + resolution); `projectConfig.ts` ↔ `settings/OkScriptToolkitSettings.kt` (disk + personal preferences); `conventionSources.ts` ↔ `core/ConventionSources.kt` (registry). Change both sides; identical JSON must yield identical normalization results.

### `labelEnum` Implementation

| Host | File | Change |
|---|---|---|
| VS Code | `src/providers.ts:25` | `featureAliases()` reads `labelEnum.aliases` |
| | `src/templatePanel.ts:23` | Same |
| | `src/templateAssetData.ts:50,519,573` | Configurable `TEMPLATE_FOLDER`; `enumFile` defaults to `labelEnum.path`; class comes from `labelEnum.name`, **not inferred from filename** |
| | `src/templateAssetPanel.ts:202` | Input defaults through `labelEnumPathSetting()`; validate class rename before overwrite |
| JetBrains | `settings/OkScriptToolkitSettings.kt:65` | Same aliases change |
| | `editor/OkEditorSupport.kt:76,120`, `ui/TemplatesToolWindowFactory.kt` | Same |
| | `core/TemplateAssetDataService.kt:495,510` | Same enum path/class sources |

> **Actual implementation scope (code is authoritative; do not audit only by the table):**
>
> - **`aliases`:** both hosts connected through one entry each, `providers.featureAliases()` and `OkScriptToolkitSettings.featureAliases()`. Other consumers benefit automatically.
> - **`name`:** generation uses `labelEnum.name`, falling back to filename only when absent. Both have `labelEnumName` personal overrides and existing-file class-change guards (§5).
> - **`path`:** generation defaults use explicit module-to-file conversion (§5); personal persistence moved from `globalState` to IDE `labelEnumPath` (§5).
> - **`templates.directory`:** both connected, including the formerly dead VS Code setting (§8.1). Consumers use `projectConfig.templatesDirectory(projectDir)` / `OkScriptToolkitSettings.okTemplatesDirectory()`, including watcher globs and `thumbSourceSubdir()` source detection. Both normalize names first through `normalizeRelPath`.
> - **Later wiring completed:** `templates.cocoAnnotations` including `template_matching.coco_feature_json`, `position.jsonPath` / `position.pythonDirectory`, and `i18n` / `characters` / `effects`. During export, both hosts probe `template_tab.label_enum_relative_path` if personal preferences and project conventions supply no enum path. This fallback belongs to the export entry point, not ordinary setting accessors.
> - **This does not make every interaction prompt-free:** export targets, path changes, and overwrite confirmations retain their current workflows.

### Executor (`python/run_executor.py`)

| Change | Location |
|---|---|
| Read `executor.startupHooks.beforeConfigImport`, call sequentially **before** `import config` | Before `config_module = __import__(...)` in `main()` |
| Read `executor.startupHooks.afterConfigImport`, retain convention discovery if absent | Existing `install_project_startup_patches()` call |

> This chain is implemented and fixes previously skipped pre-import hooks. ok-end-field's `pre_config_patch` / `qfluent_mute_promo_patch` must run before config import. The plugin follows project declarations or safe static entry discovery; business parameter changes do not introduce migration logic.

### 6.4 Screenshot Shortcut (Not Project Configuration)

**Goal:** screenshot → annotation template management. Target **template asset management** (`openTemplateAssets` / `ShowTemplateAssetsAction`), whose own screenshot action saves and refreshes assets, rather than temporary screenshots (`showTempScreenshots` / `ShowTempShotsAction`).

**IDE scope:** keybindings are personal. Project configuration would impose them on colleagues. VS Code and IntelliJ already have native keymap editors; do not invent another system.

| Host | Approach |
|---|---|
| VS Code | Add `okScriptToolkit.screenshotToTemplate` to `contributes.commands`, with a default in `contributes.keybindings` and no `when` restriction; users edit Keyboard Shortcuts |
| JetBrains | Add `AnAction` and a default keybinding under `plugin.xml` actions; users edit Settings → Keymap |

Open the annotation template management panel and invoke its screenshot action. **Reuse existing `handleScreenshot`; do not add capture implementation.**

## 7. Migration and Compatibility

- **Missing file → unchanged behavior**; no one-time migration.
- Keep all IDE settings; their role changes from sole source to personal override.
- Document full (ok-end-field) and minimal (ok-infinity-nikki) examples.

## 8. Related Findings Outside This Design

1. **VS Code `okScriptToolkit.okTemplatesDirectory` was unused:** `templateAssetData.ts` hardcoded `ok_templates`, while the child read the setting in 10 places. **✅ Fixed:** both use `templates.directory` accessors. Removed `TemplateAssetDataService.load/cocoPath` default `templatesDir: String = "ok_templates"`, which would allow silent bypasses.
2. **Previously unread `label_enum_relative_path` now supplies an export fallback**, through parent `templateAssetPanel.ts` and child `TemplatePublishFlow.kt`, consuming the same probe field.
3. **VS Code lacks a JSONC parser**, supporting the plain-JSON decision (§4).

## 9. Open Questions

1. ~~Is `captureMethod` project convention or machine-specific?~~ **Decided:** machine-specific, excluded (§5), alongside `okScriptPython` / `okScriptProjectPath`. It varies by hardware, drivers, and window behavior.
2. A Generate project configuration command? The design is read-only except explicit writes; **not implemented**.
3. If `characters.projectPath` points elsewhere, does that repository's convention file participate? **Observed: no.** Both hosts read all `characters.*`, including the project path itself, from the **current workspace** (`charactersMasterFileSetting()` etc. use `loadProjectConfig()` without a root). The path determines data location, not configuration source.

   ⚠️ **Templates do the opposite:** `TemplateAssetData` explicitly passes its own root via `templatesDirectory(this.rootDir)` because data can come from another repository. This is **unresolved inconsistency**, not a settled decision:

   - If `characters.masterFile` describes the other repository's layout, read that repository's file, like templates.
   - If it describes where to find character data while debugging the current project, the current behavior is correct.

   Establish the meaning before unifying; both interpretations are coherent. Do not change one host alone.

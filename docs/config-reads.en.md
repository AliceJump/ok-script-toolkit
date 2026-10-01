# Runtime Configuration Read Paths

[简体中文](config-reads.md) | [English](config-reads.en.md)

> **Summary:** configuration is classified by actual read entry points; not every field uses all four layers. This document explains each setting's purpose, resolution rules, and where changes take effect.
>
> Related documents:
>
> - [Project convention design](project-config.en.md): `ok-script-toolkit.json` design and fields.
> - [`docs/ok-script-toolkit.example.json`](ok-script-toolkit.example.json): copyable example.
> - [`schemas/ok-script-toolkit.schema.json`](../schemas/ok-script-toolkit.schema.json): editor completion/validation.
> - Source entry points: parent `src/projectConfig.ts` / `src/projectConfigPure.ts`, child `core/ProjectConvention.kt` / `settings/OkScriptToolkitSettings.kt`.

---

## 0. Six Types by Actual Layer Combination

⚠️ Four layers are a pool of possible sources, not a mandatory path. Classify by actual combinations so each type has a clear boundary.

| Type | Actual layers | Settings | Count | Meaning | Entry point |
|---|---|---|---|---|---|
| **A** | **① ② ④** | Enum 3 + template directory 1 + i18n 4 + characters 5 + effects 1 | **14** | Team conventions plus personal overrides; no `config.py` in ordinary accessors | `projectConfig.ts` `xxxSetting()`; child `OkScriptToolkitSettings.xxx()` |
| **B** | **② ③ ④** | `templates.cocoAnnotations`, `boxes.runtime` | **2** | Project convention or `config.py`; no personal preferences | `cocoFeaturePath.ts` / `boxResourcePure.ts`; child `core/CocoFeaturePath.kt` / `core/BoxRuntimePath.kt` |
| **C** | **③** | `windows.{exe, title, hwnd_class, args}` | **4**, plus 2 unused fields (§9) | `config.py` only; interactive title-regex fallback | `python/probe_window_config.py` |
| **D** | **① ④** | `displayLocale` / `enableInlayHints` / `annotationKeybindings` / `enableTemplateGallery` / `okScriptProjectPath` / `okScriptPython` / `captureMethod` | **7**, 6 per host | Personal/machine preferences; no project files | `getConfiguration().get()`; child `SettingsState` |
| **E** | Independent discovery (`okScriptProjectPath` → detection) | Project root resolution | **2 paths** | Where to find the project | Parent `resolveProjectDir()`; child `core/ProjectDirResolution.kt` |
| **F** | **② ④** | `executor.startupHooks.{before,after}ConfigImport` | **2** | Convention + built-in fallback; no IDE setting; executor only | `python/run_executor.py` |

The order reflects proximity to the project: conventions + personal values → project only → `config.py` only → personal only → finding the project → executor only.

> **Enum export has an additional project-fact fallback.** Ordinary `labelEnumPath` accessors read personal settings, conventions, and empty fallback. Export entry points probe `template_tab.label_enum_relative_path` when the first two supply no path. Both hosts implement this (§9.4). In this document, ① means personal settings, ② conventions, ③ project facts, ④ built-ins; numbering differs from the diagram in `project-config.en.md`.

---

### 2.1 Enum `labelEnum` (3 Settings)

| IDE key | Convention field | Purpose | Fallback | Normalization |
|---|---|---|---|---|
| `featureAliases` | `labelEnum.aliases` | How code references the enum; recognize `fL.account_switch` etc. for completion, hover, inlay hints | `["fL","FeatureList","Labels"]` | List; empty means undeclared |
| `labelEnumPath` | `labelEnum.path` | Where Save to assets writes the enum; empty skips generation | `''` | Relative path + **`.py` suffix** |
| `labelEnumName` | `labelEnum.name` | Generated class name; imports such as `from src.data.feature_list import FeatureList` make it a **code contract** | File basename | Plain text |

**Notes:**

- `config.py` never declares aliases. Without them, imports such as `FeatureList as PL` defeat guessing from `fL`/`FeatureList`.
- Project paths are module paths (`src/data/FeatureList`, without `.py`, like `label_enum_relative_path`); IDE input expects file paths. Both layers share normalization: preserve existing `.py`, otherwise add it. Do not assemble paths at consumers.
- Wrong personal path/name overrides can cause project-wide `ImportError`. Both hosts validate before overwriting: no prompt for absent files or unchanged names; otherwise scan old-name imports and report affected files for confirmation (`src/labelEnumGuard.ts` / `core/LabelEnumGuard.kt`).
- Change path writes settings relative to the project root, preserving remembered values in both hosts. **Empty clears the override and restores conventions.**

### 2.2 Template Assets `templates.directory` (1 Setting)

| IDE key | Convention field | Purpose | Fallback | Normalization |
|---|---|---|---|---|
| `okTemplatesDirectory` | `templates.directory` | Asset panel working directory relative to root, containing PNGs and its own `coco_annotations.json`; also controls thumbnail-cache source classification and watcher globs | `ok_templates` | Relative path |

There are **9 call sites**:

| Location | Use |
|---|---|
| `extension.ts` ×5 | Watcher globs, change ownership (`rel.startsWith(...)`), inject directory into `pngCrop` |
| `featureData.ts` | Index PNGs and `coco_annotations.json` in the directory |
| `templateAssetData.ts` | Panel data root |
| `templateAssetPanel.ts` ×2 | Save to assets output directory and import-dialog title |

`pngCrop.ts` does **not** read configuration itself; tests require it in pure Node with an empty `vscode` stub. Hosts inject the name through `setTemplatesDirName()`, like `setCropLogger`.

⚠️ Normalize and escape directory segments before putting them in globs; names may contain `[` or `*`. Otherwise watchers silently miss changes despite a normal-looking UI.

### 2.3 i18n (4 Settings)

| IDE key | Convention field | Purpose | Fallback | Normalization |
|---|---|---|---|---|
| `langDirectory` | `i18n.langDirectory` | Language JSON (e.g. character names), for hover/completion/inlay values | `assets/lang` | Relative path |
| `poDirectory` | `i18n.poDirectory` | gettext `<locale>/LC_MESSAGES/*.po`, merged with language JSON; launcher also localizes schemas from it | `i18n` | Relative path |
| `enablePoData` | `i18n.enabled` | Whether `.po` is a data source; disabled uses JSON only | `true` | Strict boolean |
| `poDomains` | `i18n.poDomains` | Domain whitelist, excluding UI/general task domains such as `ok.po` by default | `["ocr"]` | List |

**Notes:**

- Different names `enablePoData` / `i18n.enabled` are intentional: personal data-source preference versus project layout.
- Guard boolean types: `"enabled": "false"` is a truthy string without validation and prevents disabling.
- Language JSON, PO, and effect-file watcher paths all require segment escaping.

### 2.4 Characters and Skills `characters` (5 Settings)

| IDE key | Convention field | Purpose | Fallback | Normalization |
|---|---|---|---|---|
| `characterProjectPath` | `characters.projectPath` | Character/skill data root; may be another repository | `''` (current project) | **Plain text; absolute paths must not be normalized** |
| `characterMasterFile` | `characters.masterFile` | Master JSON, including IDs and English slugs | `assets/data/characters.json` | Relative to character root |
| `characterSkillsDirectory` | `characters.skillsDirectory` | Skill JSON directory | `assets/data/character_skills` | Relative path |
| `characterLocaleFile` | `characters.localeFile` | Localized character names | `assets/lang/characters.json` | Relative path |
| `characterAvatarTemplateRegex` | `characters.avatarTemplateRegex` | Extract character identifiers from templates such as `battle_icon_1011` | `^battle[_-]?icon[_-]?` | **Plain regex text; never path-normalize** |

**Notes:**

- An empty character project path legitimately means the current project. Plain-text resolution preserves absolute POSIX leading slashes.
- Never normalize the regex: `normalizeRelPath` replaces `\d` with `/d` and removes trailing `/`, yielding valid syntax that never matches.
- Invalid handwritten regexes fall back to built-ins (`new RegExp` in try/catch), not a broken whole panel.
- All five fields read the **current workspace** convention file (`loadProjectConfig()` without a root). `characters.projectPath` selects data location, not config source. See open questions in [project convention design](project-config.en.md).

### 2.5 Effects `effects` (1 Setting)

| IDE key | Convention field | Purpose | Fallback | Normalization |
|---|---|---|---|---|
| `effectsFile` | `effects.file` | `EffectType` + `EFFECT_DESCRIPTIONS`; hover/completion/inlays for `EffectType.XXX` or `"effect_id": "XXX"` | `src/data/effects.py` | Relative path |

Parsed data maps effect ID → description/category, both from that file. Adding effects needs only project-file changes, not plugin changes.

### 2.6 Executor-Only `executor.startupHooks`

| Convention field | Purpose | Reader |
|---|---|---|
| `executor.startupHooks.beforeConfigImport` | Sequential `module:function` calls **before** `import config` | Shared `python/run_executor.py` only |
| `executor.startupHooks.afterConfigImport` | Calls **after** config import; absent declarations use `src.patches.startup_patches:install_startup_patches` | Same |

Neither host directly reading this is intentional, not a parity gap. Hook names have no universal convention, so declare them explicitly (e.g. ok-end-field's pre-import `pre_config_patch` / `qfluent_mute_promo_patch`). Optional hook failures are logged without preventing executor startup.

---

## 3. Type B · ② ③ ④: Project-Owned (2 Settings)

| Convention field | Purpose | Resolution |
|---|---|---|
| `templates.cocoAnnotations` | Framework **runtime template library** for hints/indexing | Convention → `template_matching.coco_feature_json` → `assets/coco_annotations.json`, then `ok_tasks/assets/coco_annotations.json` |
| `boxes.runtime` | **Runtime box table** for galleries/completion/Hover; game loading belongs to the business project | Convention → top-level `boxes_json` → `src/scene/boxes.json` |

No personal preference layer or provenance-panel entry: these describe project facts, not machine preferences.

**Two invariants:**

1. A usable preferred file excludes discovery candidates, preventing duplicate names with silent first-wins behavior after relocation.
2. `config.py` values are resolved to absolute paths without normalization; convention values are normalized first.

> A real fix: ok-infinity-nikki declared `assets/coco_detection.json`, while old hardcoded discovery searched `coco_annotations.json`, leaving the library empty.

⚠️ Same filename, different resource:

| File | Meaning | Path source |
|---|---|---|
| `assets/coco_annotations.json` (or config.py location) | Framework runtime library | `templates.cocoAnnotations` |
| `<template directory>/coco_annotations.json` | Asset-panel annotation working file | `templates.directory`, unaffected by `cocoAnnotations` |

---

## 4. Type C · ③: `config.py` Only (Window Matching, 4 Settings)

No IDE/convention layers. Unavailable usable configuration falls back **interactively** to a window-title regex.

Of the seven outputs below, `coco_feature_json` is an **intermediate layer** in type B, not a terminal setting; `top_hwnd_class` / `capture_method` have unused consumers described in §9.

**Script:** `python/probe_window_config.py`, safe AST parsing **without importing project code**. Callers: parent `src/screenshotCapture.ts` `probeWindowConfig()`, child `core/ScreenshotCapture.kt`, and Python `connect_game.py` / `capture_game_window.py` importing probe helpers. Child `core/OkProjectDataService` uses the same probe for template paths; the instance probe is on `ScreenshotCapture`, while `detectPythonPath` / `detectProjectDir` belong to the service itself.

Window and template matching share a probe because each Python process costs roughly hundreds of milliseconds and reads the same file/AST. Locate `config.py` through imports in `main.py` / `run.py` / `run_task.py`, then fall back to `src/config.py` / `config.py`.

**Outputs (last-line JSON):**

| Key | Purpose | Consumer |
|---|---|---|
| `exe` | Game process names for window discovery | Both screenshot hosts; `connect_game.py` |
| `title` | Window-title regex | Same |
| `hwnd_class` | Window class | Same |
| `top_hwnd_class` | Top-level class for embedded windows | See §9 |
| `args` (`windows.args`) | Game startup arguments such as `-start=xxx_launcher` | `connect_game.py` only; framework `start_device()` uses Launch with DX11, not `windows.args`. Projects formerly patched this in `main.py`, which the plugin does not execute, so it reads/passes arguments itself |
| `capture_method` | Project-declared capture backend | See §9 |
| `coco_feature_json` | Runtime template path | Intermediate layer in §3 |

**Static parsing boundaries (`_extract_value`):**

- Supports `os.path.join("assets", "coco_annotations.json")`, pathlib `Path("a") / "b"`, and `re.compile("...")`.
- Variables return `None`; AST cannot statically evaluate them, so callers fall back.
- Only `join` with `func.value.attr == "path"` matches, excluding `str.join`.

**Lazy discovery + background refresh:** synchronous consumers treat unprobed values as undeclared (existing behavior), launching discovery in the background. After discovery, invalidate snapshots, rebuild watchers, and broadcast. On config changes, **reprobe → refresh data → rebuild watchers**, avoiding reads with stale paths.

---

## 5. Type D · ① ④: Personal/Machine Settings (7 Total, 6 per Host)

IDE settings plus their own defaults only; neither conventions nor `config.py` participate. `annotationKeybindings` exists only in the parent; `enableTemplateGallery` only in the child.

| IDE key | Purpose | Why outside project resolution | Default |
|---|---|---|---|
| `displayLocale` | Inlay language; `auto` follows IDE | UI preference | `auto` |
| `enableInlayHints` | Inline language values/effect descriptions | UI preference | `true` |
| `annotationKeybindings` | `drawBbox` / `copyCoords` / `deleteMode` / `undo` / `redo` / `copy` / `paste` / `deleteSelected` / `prevImage` / `nextImage` | UI preference | See `package.json` |
| `enableTemplateGallery` | Template asset gallery view | UI preference | `true` |
| `okScriptProjectPath` | Root containing project `src/config.py` | Machine paths differ | Empty, auto-discovery |
| `okScriptPython` | Python for tasks/scripts | Machine-specific | Empty; prefer target `.venv/Scripts/python.exe` |
| `captureMethod` | `auto` / `wgc` / `bitblt` / `foreground` | WGC availability depends on OS/GPU | `auto` |

**Intentional host differences:**

| Key | Parent | Child | Reason |
|---|---|---|---|
| `annotationKeybindings` | ✅ | ❌ | Child uses native IntelliJ keymap |
| `enableTemplateGallery` | ❌ | ✅ | Parent gallery is always enabled |

---

## 6. Type E · Independent Project Discovery (2 Paths)

This finds a project rather than resolves a value. Start with `okScriptProjectPath` in layer ①, then filesystem discovery (`src/config.py`); neither ② nor ③ applies.

### 6.1 Main Project: `resolveProjectDir()`

One implementation replaces formerly copied task-launcher/screenshot implementations, avoiding different directories in UI and scripts:

```text
okScriptProjectPath (expand ~, remove trailing slash)
  → detect whether a workspace root has src/config.py or config.py
    → '' (empty)
```

### 6.2 Character Data Root: `characterPanel`

Intentionally separate: character data may live in another project.

```text
characterProjectPath (resolution chain)
  → okScriptProjectPath
    → workspace folder with assets/data/characters.json or assets/data/character_skills
      → first workspace
```

Child counterpart: `core/ProjectDirResolution.kt` (setting first, validate config.py).

---

## 7. Type F · ② ④: Executor Only (2 Settings)

Convention declarations plus built-in fallback; no IDE setting or `config.py`. Kept separately because shared `python/run_executor.py`, not hosts, reads it.

| Convention field | Purpose | Reader |
|---|---|---|
| `executor.startupHooks.beforeConfigImport` | Sequential `module:function` calls before config import | Shared executor only |
| `executor.startupHooks.afterConfigImport` | Post-import calls; otherwise `src.patches.startup_patches:install_startup_patches` | Same |

No direct host consumption is intentional. Names cannot be inferred universally; declare pre-import hooks like `pre_config_patch` / `qfluent_mute_promo_patch`. Optional patch failures log without preventing startup.

---

## 8. Read Invariants

Check all eight before modifying configuration reads; violations fail silently.

1. Personal preferences deliberately win: team defaults apply until explicitly overridden.
2. Distinguish explicit settings from defaults: VS Code `inspect()`, child `overriddenKeys`. `get()` alone makes ① always win over ②.
3. Normalize relative paths, **never absolute paths/regexes**. `path.join`, segment comparisons, globs imply normalization; `new RegExp`, `path.resolve`, `File()` do not.
4. Empty arrays/strings/whitespace fall back, rather than pinning an empty value, enabling convention restoration.
5. Resolution produces provenance: `{ value, layer }` from `resolveSetting()`, overrides from `layer === PERSONAL`, never value comparisons. `declared` reruns the same chain with personal preferences cleared.
6. Do not normalize `config.py` values, which may be absolute or built with `os.path.join`. A usable preferred file excludes discovery candidates.
7. Unprobed lazy values return undeclared; discovered values invalidate snapshots/rebuild watchers.
8. All consumers use accessors, not manual paths/type checks. Add each new setting to `conventionSources()` / `conventionSourceRows()` for provenance/restoration.

**Complete checklist for a new resolved setting:**

| Host | Changes |
|---|---|
| VS Code | ① `package.json` configuration ② six `package.nls*.json` files ③ pure `xxxResolved()` with `{value, layer}` ④ `xxxSetting()` using `ideSetting()` ⑤ provenance registry ⑥ six `l10n/bundle.l10n*.json` files |
| JetBrains | ① `SettingsState` field ② `KEY_*` constant ③ `personal(KEY_X)` ④ configurable `recordIfChanged` + UI + `reset()` ⑤ `ConventionPersonal` + registry ⑥ six `OkScriptToolkitBundle*.properties` files |

Guards: parent `scripts/test_convention_sources.js` checks `package.json` keys and every `ideSetting` consumer; child `OverrideKeyParityTest` enforces declaration = consumption = change-tracking sets, including counts.

---

## 9. Known Inconsistencies and Open Questions

These retain the initial audit record. Item 4 is implemented in both export entry points; ordinary accessors/provenance do not directly include that probe layer. Other rows record historical risks, not failures reproduced in this pass.

| # | Observation | Kind | Recommendation |
|---|---|---|---|
| 1 | Probe extracts `windows.capture_method` with no host consumers | Unused extraction | Connect it or remove extraction; prefer removal because capture method is machine-specific (§5) |
| 2 | `player_id` exists only in probe docstring | Stale comment | Update docstring |
| 3 | Parent parses `top_hwnd_class`, but capture JSON sends only exe/title/hwnd_class | Unused field | `connect_game.py` probes it independently; pass it through or remove from `WindowConfig` |
| 4 | Initial audit lacked the `labelEnum.path` project-fact layer; 4/7 projects declared it | Former missing layer | All four sources can participate at export. Support slash `src/data/FeatureList` and framework-normalized dotted `src.data.FeatureList` (framework strips `.py` and converts `/` to `.`) |
| 5 | `template_tab.generate_label_enum` is not consumed (framework default False; 4/7 projects True) | Missing layer | Overlaps empty path = no generation. Decide precedence before wiring; existing policy gives personal choice priority |
| 6 | Template and character roots differ for convention reads | Unresolved | Templates accept an optional root; characters read current workspace. Clarify semantics first; see [project convention design](project-config.en.md) |
| 7 | Historical `featureAliasesTouched` plus `overriddenKeys` mechanisms coexist | Legacy | Do not confuse them when changing aliases |

---

## 10. Source Index Across Hosts

| Responsibility | VS Code | JetBrains |
|---|---|---|
| Pure parsing/resolution/provenance | `src/projectConfigPure.ts` | `core/ProjectConvention.kt` |
| Disk/cache/personal normalization | `src/projectConfig.ts` (`ideSetting()` / `setIdeSetting()`) | `core/ProjectConventionConfig.kt` + `settings/OkScriptToolkitSettings.kt` |
| Pure provenance rows | `src/conventionSources.ts` `conventionSources()` | `core/ConventionSources.kt` `conventionSourceRows()` |
| Provenance UI | `okScriptToolkit.showConventionSources` QuickPick | `ui/ShowConventionSourcesAction.kt` DialogWrapper |
| Clear overrides | `clearOverride()` for populated scopes | `clearOverridden(key)`, reversible |
| Runtime template path | `src/cocoFeaturePath.ts` + `cocoFeaturePathPure.ts` | `core/CocoFeaturePath.kt` |
| Enum class guard | `src/labelEnumGuard.ts` | `core/LabelEnumGuard.kt` |
| config.py AST probe | Shared `python/probe_window_config.py` | Same |
| Normalization helpers | `relPathResolved` / `textResolved` / `boolResolved` / `listResolved` | `normalizeRelPath` / `textOrNull` / type guards / `isNotBlank` filtering |

These are corresponding independent implementations. Change both; identical JSON must produce identical normalization results.

---

## 11. Troubleshooting Ineffective Configuration Changes

Follow this order; each step can independently disprove a cause:

1. Identify the type (§0). Type D does not read project files; type C reads only `config.py`, so convention edits cannot affect it.
2. Check provenance. Personal source means ① overrides ②; restore project conventions.
3. Check normalization of `assets\lang` / `./assets/lang`. A skipped consumer can silently miss otherwise normal-looking values.
4. Check watchers: unescaped/non-normalized glob names prevent refresh after template/language changes.
5. Check whether undeclared was mistaken for pinned empty. Empty lists/strings fall through; expressing an intentional absence requires another mechanism.
6. Check lazy config.py discovery. Before probing it is undeclared; expressions such as `os.path.join(variable, ...)` cannot be statically parsed and fall back.
7. Check that both hosts changed; one host's implementation does not update the other.

---

## 12. Two Global Configuration Sources (Probe)

Projects declare which of two independent chains applies; the plugin does not assume paths.

| Source | Project declaration | Probe read |
|---|---|---|
| **Framework** (`source: framework`) | `config.py` `"global_configs": [option, ...]` registers framework GlobalConfig | `ok.task_executor.global_config.get_all_visible_configs()` |
| **Project store** (`source: project_store`) | GUI page in `custom_tabs` (e.g. `src.gui.GlobalConfigTab`) imports `get_all_visible_configs` from a store | Statically resolve declared store module → import → `get_all_visible_configs()` |

Both merge into one `globalConfigGroups` array, distinguished by `source`.

`python/project_store.py` derives the store module from `custom_tabs` → page file → imported module exposing `get_all_visible_configs`. The criterion is the **interface**, not the module name, allowing project moves/renames without plugin changes. Declarations and already imported modules take precedence; legacy `src.core.global_config_store` remains the last candidate. Re-exported enumeration functions are collected once.

> Previously, probe/executor hardcoding silently lost groups after project path changes. Regression test: `python python/tests/test_project_store.py`.

Executor `resolve_group_config()` uses the same `project_store.store_modules(config, cwd)` candidates with `get_global_config(name)`, so runtime `gparams` recognizes the same groups.

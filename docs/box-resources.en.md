# Position Resource Contract (Rect / Point)

[简体中文](box-resources.md) | [English](box-resources.en.md)

Verified against current local implementations on 2026-10-08. Both hosts use unified annotation management and resource previews. This document describes the current data and operation contracts; see [Feature Parity](feature-parity.en.md) for entry points and verification status.

## Authoring and Published Files

| Resource | Authoring file | Published output | Preview and reference source |
|---|---|---|---|
| Template | `<templates.directory>/coco_annotations.json` | Images and COCO library in `assets` or `ok_tasks/assets`, with optional enum | Runtime library resolved by `templates.cocoAnnotations` |
| Rect | `<templates.directory>/boxes.json` | Unified Position JSON or Python output | Current Rect authoring data |
| Point | `<templates.directory>/points.json` | Combined with Rect in one Position output | Current Point authoring data |

The authoring directory defaults to `ok_templates`. All three types share source images. Importing, capturing, and sending temporary screenshots add images without creating annotation records for unedited images. Numeric image names reserve registrations in all three authoring files, including records whose images are missing.

The current Schema does not include legacy `boxes.runtime`, and publication does not read `config.py`'s `boxes_json`. Business projects load published files and establish `self.pos`. The plugin does not modify business loaders or migrate historical business position tables.

## COCO Annotations and Names

All authoring files use `images`, `annotations`, and `categories`. Names belong to `categories.name`; `image_id` and `category_id` connect each annotation to its image and name.

| Type | `annotations.bbox` | Validation |
|---|---|---|
| Template / Rect | Pixel rectangle `[x, y, w, h]` | Positive width/height and fully inside the source image |
| Point | Pixel point `[x, y, 0, 0]` | Zero width/height and inside the image boundary |

Rect / Point names contain at least two Python identifier segments separated by dots, such as `screen.main_viewport` or `panels.esc.mail`. Python keywords, generated reserved members, and double-underscore members are rejected. Ordinary prefixes such as `panels` are not reserved for a particular business project.

Names are unique within each resource type. Rect and Point may have the same name during editing; publication reports duplicate names and parent/child path collisions because one Position attribute cannot hold both values.

Historical `version` / `boxes` and `version` / `points` authoring formats are not the current contract and are not automatically migrated on read. Invalid current sources expose errors and prevent publication and deletion; explicit editing follows the annotation editor's own recovery and save semantics.

## Annotation Management

The unified entry provides import, capture, temporary screenshot drops, filename or Template category search, editing, source-image viewing, Template annotation swaps, deletion, and publication. Swapping preserves the existing Template operation scope in both hosts; Rect / Point remain editable in the unified editor.

Template swaps between differently sized images scale and clamp coordinates, show image sizes and annotation counts before confirmation, and verify source annotations and image sizes again before saving.

Deleting a source image removes its records and annotations from all three authoring files while preserving other images and same-stem files with different extensions. Read failures stop deletion; later write failures restore the image and previously modified authoring sources. Published runtime resources remain until the next explicit publication updates them.

Internal saves, imports, and external file changes use one refresh channel. Open editing sessions retain local changes while reconciling external edits and conflicts; unresolved conflicts prevent overwriting sources. Management lists and thumbnails use the current model and reject stale asynchronous callbacks.

VS Code saves annotation edits immediately. JetBrains writes when the dialog's Save action is accepted; Cancel discards that session's changes. Both write authoring files only. Saving annotations does not publish them.

## Resource Previews and Code References

Side and wide previews support Template / Rect / Point modes and name/expression search. Cards use the actual current image and bbox; Point previews show bounded context around the point.

| Mode | Inserted and copied expression |
|---|---|
| Template | `<current template alias>.<name>`, defaulting to `fL` |
| Rect | `self.pos.<path>.to_box()` |
| Point | `self.pos.<path>` |

Single click inserts; double click copies. Buttons expose the same actions and annotated source previews. Without a Python editor, the reference is copied with an explanation. Template previews never fill an absent runtime library with unpublished authoring data. Rect / Point hints follow current authoring data without requiring publication first.

Both hosts use `Ctrl+Alt+T` for resource previews and `Ctrl+Alt+S` for capture into annotation management; macOS uses the corresponding `Cmd+Alt` combinations. Publication belongs to annotation management, with no separate publishing chain in previews.

## Unified Publication

Select Template / Rect / Point, then configure the selected resources. All configuration and cancellation decisions precede writes. Position failure or rejected overwrite stops subsequent Template writes. Templates retain existing packing and enum generation, including class-name and project-reference checks before overwriting enums.

Position JSON defaults to `src/scene/positions.json`. Python output defaults to `src/scene`, generating `ScreenRatio.py` and `PositionMap.py`. Resolution is personal IDE preference → `position.jsonPath` / `position.pythonDirectory` in `ok-script-toolkit.json` → built-in default. Publishing settings expose the source and let users change paths or clear personal overrides. Empty input restores project conventions.

Absolute paths, traversal, the project root itself, and symlink escapes are rejected. Existing handwritten Python modules and custom JSON targets require explicit overwrite confirmation; regenerated plugin outputs follow existing replacement rules. Empty position sets and invalid sources preserve published outputs. Publication writes a complete snapshot of the selected Rect / Point resources. Selecting only one type warns before writing that unselected positions will be removed from that output.

JSON output contract:

```json
{
  "version": 2,
  "positions": [
    { "path": "panels.esc.mail", "coordinates": [0.25, 0.5] },
    { "path": "screen.main_viewport", "coordinates": [0.1, 0.2, 0.9, 0.8] }
  ]
}
```

Points normalize to `[x / width, y / height]`; rectangles normalize to `[x / width, y / height, (x+w) / width, (y+h) / height]`. Outputs sort by path and round to six decimals; authoring files retain pixels. Position reference images should be actual full-screen captures. Business projects perform runtime screen adaptation.

## Implementation and Verification Entry Points

| Responsibility | VS Code | JetBrains |
|---|---|---|
| Annotation sessions and synchronization | `annotationPanel.ts`, `annotationMerge.ts` | `UnifiedAnnotationUi.kt`, `AnnotationSessionSync.kt` |
| Rect / Point authoring | `boxResourceStore.ts`, `pointResourceStore.ts` | `BoxCatalogService.kt`, `PointCatalogService.kt` |
| Source management and publication | `templateAssetPanel.ts`, `templateAssetData.ts` | `UnifiedPublishToolWindows.kt`, `TemplatePublishFlow.kt` |
| Resource cards | `templatePanel.ts` | `PreviewCardToolWindows.kt` |
| Position contract and publication | `positionResourcePure.ts`, `positionPublishStore.ts` | `PositionResource.kt`, `PositionPublisherService.kt`, `PositionPublishTargets.kt` |

Automated checks cover geometry, coordinates, conflict merging, overwrite protection, rollback, name reservation, deletion, and host reference contracts. Actual IDE, screenshot, and business-project runtime acceptance is tracked separately in Feature Parity. Automated success does not establish that a game loaded published files.

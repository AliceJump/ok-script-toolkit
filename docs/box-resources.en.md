# Box Resource Design

[简体中文](box-resources.md) | [English](box-resources.en.md)

Local status, 2026-10-01: both hosts have box editing, publication, runtime galleries, completion, and source preview entry points; see [feature parity](feature-parity.en.md). This document retains data contracts and implementation order. Section 1 describes the pre-change foundation; section 10 is not a current TODO list. Actual project `ScreenPosition` loading is outside this repository's acceptance.

Box management follows template management, with two resources. The annotation working copy is edited by the plugin only. The runtime copy is a published position table read by box management and `self.pos` completion. The game uses it only after the business project's `ScreenPosition` loads it; current ok-framework template matching still reads only `template_matching.coco_feature_json`. Reuse existing images, canvas, and visibility handling.

This document is an implementation reference. The real call in ok-neverness-to-everness (ok-nte) is `self.pos.screen.main_viewport.to_box()`, not `self.pos.main_viewport`; there is no `screen_pos`.

## 1. Existing Capabilities

The toolkit already separates two template paths.

| | Annotation resource | Runtime resource |
|---|---|---|
| File | `<templates.directory>/coco_annotations.json`; default directory `ok_templates` | `config.py`'s `template_matching.coco_feature_json`; otherwise probe `assets/coco_annotations.json` and `ok_tasks/assets/coco_annotations.json` |
| Readers/writers | Annotation management (asset panel) | Template gallery, completion, Hover; ok-framework template matching |
| Transfer | Explicit Export to assets; editing does not automatically write runtime files | |

The annotation editor (`AnnotationDialog` / `media/annotationPanel`) already supports selection, dragging, eight-direction resizing, add/delete, zoom, pan, undo, copy/paste, and image navigation. Memory uses pixel `xywh`; disk uses COCO `bbox`. `NormalizedBox` only serves coordinate copying: it is neither persisted nor ok-script's `Box`.

Previously, the editor had no annotation list or visibility controls. Hiding and deletion were the same operation.

The template gallery reads runtime COCO only. A click inserts `fL.<name>`. Region previews dynamically crop the source image with pixel bbox; cache keys combine image-content hash and bbox. Quick Documentation and Hover share that crop. JetBrains lookup entries show dimensions on the right; VS Code adds the image to documentation when resolving a completion entry.

This repository has no business Point resource or position table.

## 2. ok-nte pos / Box

The handwritten Python position table lives in `src/scene/`.

- `self.pos` is a `PositionMap`, created in `BaseNTETask`.
- `self.pos.screen` contains rectangles: currently `center`, `dialog_icon`, and `main_viewport`, using four screen-relative `(left, top, right, bottom)` values.
- `self.pos.panels.*` contains two-value click points, unpacked with `*self.pos.panels.esc.mail`. Calling `to_box()` on a point raises an error.
- `ScreenRatio.to_box()` calls `box_of_screen(..., hcenter=True)` to create a pixel `ok.Box` for the current captured frame. `hcenter` applies at call time and must not enter resources.
- A descriptor sets `Box.name` to `ScreenPosition.<field>` for debugging only. Search regions are not matched by that name.
- Approximately 73 task-private `box_of_screen(...)` calls explicitly remain outside the position table; box resources do not absorb them.
- Runtime does not depend on the IDE plugin.

## 3. Two Box Resources

| | Templates | Boxes |
|---|---|---|
| Annotation resource | `<template directory>/coco_annotations.json` | `<template directory>/boxes.json` |
| Runtime resource | `templates.cocoAnnotations` → `config.py` → discovery | `boxes.runtime` → `config.py`'s `boxes_json` → probe `src/scene/boxes.json` |
| Editing entry | Annotation management | Box resource management |
| Browsing / completion | Template management | Box management |
| Annotation-to-runtime transfer | Explicit export | Explicit publish |

The game loader does not read `ok-script-toolkit.json`. Plugin indexing gives conventions precedence over `config.py`, as with templates. If ok-nte declares neither, both use `src/scene/boxes.json`.

The `panels` prefix is reserved for existing click points and cannot be occupied by box paths.

## 4. Data Model

Templates and boxes have separate source annotations, both using exactly the same COCO format. Box names use `categories.name`; image links, dimensions, and pixel rectangles use standard fields:

```json
{
  "images": [
    { "id": 1, "file_name": "12.png", "width": 1920, "height": 1080 }
  ],
  "annotations": [
    { "id": 1, "image_id": 1, "category_id": 1, "bbox": [184, 112, 1544, 853], "area": 1317032, "iscrowd": 0 }
  ],
  "categories": [
    { "id": 1, "name": "screen.main_viewport", "supercategory": "" }
  ]
}
```

Source files no longer have a separate version/boxes model. VS Code templates and boxes share CocoAnnotationData and AnnotationController; JetBrains shares CocoAnnotationData and AnnotationDialog. Image registration, rectangle validation, swapping, atomic saves, and refresh notifications are shared too. Only source paths, name validation, and export differ. Both hosts can edit the same COCO source interchangeably.

Legacy version 1/version 2 box sources are compatibility inputs only. Reads do not alter disk. Before the first edited save, back up the original as `boxes.json.pre-coco.<uuid>.bak`, then write COCO. Missing image dimensions needed for conversion or corrupt sources stop saving and preserve all original data.

Runtime resources contain normalized geometry only (unchanged version 1). `to_box()` needs no image:

```json
{
  "version": 1,
  "boxes": [
    {
      "path": "screen.main_viewport",
      "rect": [0.095833, 0.103704, 0.900000, 0.893519]
    }
  ]
}
```

Rules:

- `path` is the attribute path following `self.pos.`: at least two segments, each a Python identifier. `screen.main_viewport` corresponds to `self.pos.screen.main_viewport`. One rule source (`boxResourcePure.boxPathError`) supplies the grammar sent through `config` for webview validation.
- `bbox` is a pixel `[x, y, w, h]`, identical in shape to template COCO: integers, width/height ≥ 1, wholly within source `width × height`. Editing, saving, and validation remain in pixels, never normalized coordinates.
- `images` registers dimensions for every referenced source image. Box saves register/refresh them from image headers; publish and previews read this table.
- Serialization shares template COCO serialization for sources. Runtime entries sort by path and retain six decimal places in rectangles.
- `image` is a filename in the template directory, aligned through existing filename normalization. Do not duplicate images or write cropped PNGs into the repository.
- Reference images must be full-screen screenshots. Packed crops in `assets/images` cannot be box source images.
- `to_box()` derives its debug name from path: leaves under `screen` become `ScreenPosition.<leaf>`. This is not a primary key.

Publishing projects box-source COCO into normalized runtime data. Empty or missing sources report no publishable boxes and do not overwrite existing runtime resources. This is the only normalization point in the normal workflow:

```text
left   = x / width
top    = y / height
right  = (x + w) / width
bottom = (y + h) / height
```

Publishing writes a complete snapshot: deleted annotations disappear from runtime after publication. Confirm first if existing runtime paths will be removed. Boxes with unreadable dimensions are not published and are reported explicitly. Editor saves write annotation resources only.

## 5. Images and Editor

Boxes reference the same source images used by annotation management. Box resource management does not import images, capture screenshots into the library, or package exports.

Share canvas, controller, and COCO storage. Template labels validate template names; box labels validate Python attribute paths. Both use `categories.name` and `annotations.bbox`. A missing source is an empty annotation set; the first save registers images/dimensions and creates it.

Generating boxes from templates takes the minimum enclosing pixel rectangle of selected annotations and writes a normal COCO annotation to the box source. A successful save immediately refreshes the resource list, open box editors, and occupied-path table. Internal saves and external changes use the same refresh channel; repeated file events do not reset an editor's undo history.

Image swapping changes ownership only for equal dimensions. Different dimensions use proportional mapping with template `annotationSwapPure`, clamped to target bounds; the confirmation explains scaling.

## 6. Visibility

Visibility is editor-session state: entry identifiers in a hidden set. It enters neither COCO, either box file, nor the undo stack.

The annotation list always shows all entries. Canvas rendering and hit testing use visible entries only.

| Action | Behavior |
|---|---|
| Show all | Clear the hidden set |
| Hide all | Hide every entry on the current image |
| Show current only | Keep only the selected entry visible |
| Checkbox | Update individual hidden entries |

Each image has its own hidden set for the current editing session, discarded when the dialog closes. New images default to fully visible. Templates, boxes, and points share this filter.

## 7. Preview, Completion, Generation

Box management follows template management: each box path has a **bbox-cropped resource thumbnail**. Annotation management and box resource management use source thumbnails; template management and box management use cropped thumbnails. Reuse template cropping, content-hash caches, asynchronous batch generation, and failure handling. Completion indexes runtime resources only. Insertion is `self.pos.screen.main_viewport.to_box()`; provide a separate copy-attribute-path action.

Previews do not enter runtime files. Look up annotation sources by path for `image` and pixel bbox, crop the original, and reuse the template cache keyed by content hash and bbox. Box edits naturally invalidate it. If no source matches, including runtime-only paths, documentation shows the path only.

Documentation follows templates: crop, expression, path, normalized rect, relative source-image path. JetBrains may add a short coordinate inlay; VS Code does not, consistent with no template ghost hints.

A single template generates a pixel union of selected annotations. Suggest `screen.<category name>` by default; any existing use on any image requires another name. Enclosing boxes from multiple templates require the same source image:

```text
left   = min(x)
top    = min(y)
right  = max(x + w)
bottom = max(y + h)

bbox = [left, top, right - left, bottom - top]
```

The result is a normal annotation box and reaches runtime only after publication.

## 8. Runtime Loading

Loading belongs in the business project's `ScreenPosition`, not the plugin; do not change `ok.Box`.

`ScreenRatio` implements only `__get__`. An instance attribute of the same name shadows the class descriptor. Use JSON for names present there; other names still use handwritten class attributes. `to_box()` continues calling `box_of_screen(..., hcenter=True)`.

The three existing rectangles can be imported into annotation resources once and bound to full-screen originals. Handwritten attributes remain valid before publication; plugin box management and completion read runtime JSON only.

## 9. Modules

| Location | Responsibility |
|---|---|
| `src/cocoAnnotationData.ts` / `src/annotationPanel.ts` | Shared VS Code COCO source data and annotation controller |
| `core/CocoAnnotationData.kt` / `ui/AnnotationDialog.kt` | Shared JetBrains COCO source data and annotation dialog |
| `src/annotationGeometry.ts` | Pixel rectangle validation shared by templates and boxes |
| `core/AnnotationGeometry.kt` / `core/CocoSource.kt` | Shared JetBrains pixel validation, source parsing, atomic writes, refresh notifications |
| `src/boxResourcePure.ts` / `src/boxResourceStore.ts` | Box name validation, legacy source import, runtime export |
| `core/BoxResource.kt` / `core/BoxAnnotationStore.kt` | JetBrains box naming, legacy import, runtime export adapters |
| `core/BoxRuntimePath.kt` and pure-module path functions | Runtime path precedence, following `CocoFeaturePath` |
| `boxes.runtime` in `schemas/ok-script-toolkit.schema.json` | Convention file; no personal preference layer |
| `boxes_json` in `python/probe_window_config.py` | Read runtime path from top-level `config.py` |
| Both annotation editors | Annotation list and visibility |
| Later: resource management, box management, completion, template generation | Continue in section 10 order, reusing these contracts |

## 10. Implementation Order

1. Data contract, path resolution, editor visibility.
2. Box resource management: browse by source image and edit with the existing editor.
3. Publish runtime files.
4. Box management cards and documentation previews.
5. `self.pos` completion and Hover.
6. Generate boxes from one template or enclose multiple templates on the same image.
7. ok-nte `ScreenPosition` loader. Manually remove the three corresponding class attributes after confirming rectangles.

## 11. Risks

- Editor changes must preserve template annotation saves. All entries default visible; visibility is outside undo.
- Older plugins cannot read COCO box sources; update both hosts together. Keep legacy-source backups in the annotation directory and runtime format unchanged.
- Annotating a crop produces coordinates relative to that crop, not the screen.
- JSON takes precedence over class attributes of the same name. After import/publication, remove corresponding handwritten attributes in the business project to avoid conflicting maintenance.
- The plugin must not include `hcenter` in `rect`.

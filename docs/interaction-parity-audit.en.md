# Cross-IDE interaction audit

[简体中文](interaction-parity-audit.md) | [English](interaction-parity-audit.en.md)

Audit date: 2026-10-08. VS Code parent commit `8bca7fd`; JetBrains submodule commit `aadd024`. Both source versions are `1.24.0`.

This report compares the pages actually registered in the baseline source, covering entry points, layout, selection, buttons, clicks, editing, saving, feedback, and shortcuts. It preserves pre-change behavior; the subsequent user-requested VS Code alignment for annotations and previews is recorded at the end. The initial experimental edits were reverted before this audit.

This is a source audit, without interactive or screenshot verification in either IDE. “No corresponding entry in the current page” does not mean that no implementation exists elsewhere in the plugin. Theme, scaling, focus, and keyboard behavior still need real IDE verification. Shared Python code, formats, or passing tests do not establish interaction parity.

## 1. Registered entry points and organization

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 01 | Sidebar entry points | Three activity bar containers: tools, templates, temporary screenshots; the templates container contains resource preview and annotation management | Four separate tool windows: annotation management, resource preview, temporary screenshots, and tasks; all initially docked right | Resource grouping and switching paths differ; left/right docking itself is a host layout difference |
| 02 | Task navigation | Internal side navigation: tasks, game, configuration, accounts | Top tabs: tasks, configuration, runner, tools | Categories and order differ, beyond widget appearance |
| 03 | Game connection and overlay | Game page contains connection/disconnection and overlay controls; game status also appears at the top | Game card on the runner page contains connection/disconnection and overlay controls | The same operation belongs to a different category |
| 04 | Other tools | Character manager entry on the game page; resources and screenshots use separate activity bar containers | Tools page collects entries to separate editors/tool windows | Finding characters, resources, and screenshots follows different paths |
| 05 | Executor controls | Persistent executor status and start/pause/stop controls at the top | Persistent executor bar at the bottom, including a log icon button | The same run controls occupy different positions |

Sources: [parent registration](../package.json), [VS Code task page](../media/console/index.html), [JetBrains registration](../jetbrains/src/main/resources/META-INF/plugin.xml), [JetBrains task page](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskLauncherToolWindowFactory.kt).

## 2. Resource preview cards: the reported discrepancy

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 06 | Template / Rect / Point modes | Three adjacent buttons, with the active mode highlighted | Mode combo box | All modes are immediately visible on one side; the other requires opening a dropdown |
| 07 | Insert, copy, source buttons | Three persistent buttons at the bottom right of every thumbnail, directly bound to that card | Insert/copy/open in the top toolbar operate through `selectedValue`; no buttons inside the card | Direct target-card actions versus selecting a target and then using the toolbar |
| 08 | Selection and target feedback | No list selection state used by these buttons; each button captures its resource | Single-selection `JBList`; renderer changes background, text, and border for selection | Persistent selection and toolbar dependence differ |
| 09 | Single/double-click timing | Delayed single-click insertion, double-click copy, fixed 500 ms window; card buttons execute immediately | Same basic gestures, using system `awt.multiClickInterval` or a 500 ms fallback; insertion also checks that selection still matches the clicked item | Gesture results broadly match, but timing and selection dependencies differ |
| 10 | Grid and card geometry | Responsive CSS grid, 118 px minimum column width, 96 px thumbnail area, left-aligned names | `JList.HORIZONTAL_WRAP`, fixed cell width of 120 plus scaled margins, scaled 72 thumbnail height, centered 10 pt bold names truncated by character count | Density, space usage, alignment, and truncation differ; values are source constants rather than measured screen pixels |
| 11 | Counts, empty/loading states | Filter/total counts, successful/failed thumbnail counts, explicit empty/no-match messages | Current preview component contains only toolbar, search, and list; failed loading results become an empty collection without equivalent count/empty/failure widgets | Empty data and loading failure are less distinguishable in this page; this does not assess every lower-level error path |

Sources: [VS Code cards](../media/templatePanel/app.js), [card styles](../media/templatePanel/style.css), [shared action styles](../media/shared/controls.css), [click handling](../media/shared/thumbnailActions.js), [registered JetBrains preview](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/PreviewCardToolWindows.kt), [grid policy](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/ThumbGridPolicy.kt), [JetBrains click handling](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/ThumbnailActions.kt).

The registered JetBrains factory is `CardResourcePreviewToolWindowFactory`; the wide editor also creates `UnifiedResourcePreview`. The older `TemplateGalleryPanel` contains bottom-right `ThumbnailActions`, but both current preview entries use `PreviewCardRenderer`, which does not contain card action buttons. The older component or its tests cannot establish parity for the active page.

## 3. Source images and annotation management

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 12 | Open annotation editor | Single-click source card opens the editor immediately | Single-click selects; double-click opens, or selection plus the top edit button | The same single click has a different meaning |
| 13 | Source, swap, delete actions | Three persistent bottom-right buttons bound to their image | Top toolbar source/swap/delete act on the selected image; no corresponding card buttons | The reported selection-versus-card-button discrepancy also exists here |
| 14 | Toolbar responsibilities | Import, capture, foreground option, publish, search, count; image-specific actions remain on cards | Foreground option, refresh, import, capture, edit, source, swap, delete, publish; search on the next row | Global and image actions are mixed differently, affecting toolbar density and discovery |
| 15 | Swap selection and confirmation | Thumbnail chooser inside the Webview, followed by host warning confirmation | `SwapTargetDialog` thumbnail chooser and `Messages.showYesNoDialog` confirmation | Target/scaling semantics match; popup placement, controls, and dismissal differ |

Sources: [VS Code source page](../media/templateAssetPanel/index.html), [card events](../media/templateAssetPanel/app.js), [parent swap flow](../src/templateAssetPanel.ts), [JetBrains source panel](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/UnifiedPublishToolWindows.kt), [card decorator](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/PreviewCardToolWindows.kt), [swap chooser](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/SwapTargetDialog.kt).

## 4. Unified annotation editor

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 16 | Editor surface | Webview tab in the editor area | Native `UnifiedAnnotationDialog` | Workspace, return-to-code, and closing paths differ |
| 17 | Save and cancel | Committed edits immediately request working-file saves; no save/cancel for the entire editing session | Edits remain in the session until save writes them together; cancel discards session changes | Expectations about disk persistence and closing differ; saving does not publish on either side |
| 18 | Mode/tool arrangement | Mode buttons, history options, draw/coordinates/delete, undo/redo, navigation in one toolbar | Radio buttons for modes; modes/history on one row, tools on another | Mode widgets, ordering, and toolbar height differ |
| 19 | New-shape input | Dialog accepts name and X/Y/W/H; Point hides W/H | Drawing prompts only for a name; drawing determines geometry | Direct numeric correction versus returning to the canvas |
| 20 | Double-click existing shape | Opens name and coordinate/size editor | `editName` only changes the name | The same gesture exposes different editable content |
| 21 | Annotation visibility | Per-row visibility checkboxes plus show-all/hide-all/only-current buttons | `syncRows` creates only name-selection buttons; no corresponding visibility entry in this dialog | Different facilities for overlapping annotations |
| 22 | Delete button and D | Button/D enables delete mode, then clicking a target deletes it; Delete removes selected items | Button immediately deletes selected items; Delete is bound, but D/delete mode is absent in this page | Same-name controls lead to different states and next steps |
| 23 | Shortcut configuration | `okScriptToolkit.annotationKeybindings` is configurable; bindings arrive in host messages | `installKeys` fixes M/R/C, Ctrl+Z/Y/C/V, and Delete | User customization differs; ordinary IDE shortcut settings do not establish configurable canvas bindings |
| 24 | Arrow keys and navigation | Selected shapes move by one pixel, or ten with Shift; without selection, default left/right bindings navigate images | No arrow-key nudge/image navigation in current `installKeys`; navigation uses buttons | Precision editing and image navigation keyboard paths differ |
| 25 | Coordinate-copy rectangle | Moving and resizing handles update/copy coordinates | `coordRect` can be created, displayed, and copied; no movement/handle branches for it in the unified canvas | Reusing and adjusting this temporary rectangle differs; JetBrains temporary screenshot handles are a separate canvas |
| 26 | Color and pointer readout | Bottom RGB swatch and absolute/relative coordinates; right-clicking a shape can request color copying | Bottom status text; no corresponding RGB swatch/color-copy entry in this canvas, and right-button presses are ignored | Color sampling/readout entry points differ |
| 27 | Sidebar multiselection | Name click selects; Ctrl/Meta/Shift name click toggles selection | Name buttons always use `selectOnly`; modifier selection is wired only in the canvas | The same modifier keys act differently in the list |
| 28 | Conflict panel position | Below the right-side list title, before annotation rows | At the bottom of the list region, with its own internal scroll area | Both offer local/external choices and apply, but in different positions |

Sources: [VS Code toolbar](../media/annotationPanel/index.html), [canvas/dialog/keyboard](../media/annotationPanel/app.js), [conflict UI](../media/annotationPanel/conflict.js), [shortcut settings](../package.json), [JetBrains dialog](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/UnifiedAnnotationUi.kt), [conflict panel](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/AnnotationConflictPanel.kt). Missing-entry findings use actual `createCenterPanel`, `syncRows`, `installKeys`, and `installMouse`, excluding older editors and other canvases.

## 5. Tasks, parameters, and accounts

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 29 | Parameter entry | Card parameter button opens the task drawer; card body does not select and load details | Card-body click selects the task and loads details | Explicit parameter-button flow versus master/detail selection |
| 30 | Parameter layout/dismissal | Overlay drawer; close button, backdrop, or Escape dismisses it | Persistent list/detail split, vertical below width 560 and horizontal at larger widths | Temporary overlay versus persistent space consumption and different dismissal paths |
| 31 | Task information | Name, textual trigger/onetime type, textual run status, class/module, and description | Primarily name/description; outer border encodes task kind, inner border state, type/state/class in tooltip | Technical information visibility and color semantics differ |
| 32 | Run/trigger controls | Run button with icon and text; trigger checkbox with enable text | Textless borderless run icon and textless trigger checkbox | Discovery, default clickable appearance, and labeling differ |
| 33 | Sync/reset defaults | Snapshot icon buttons in each task card header | Operations in the selected task detail footer | Select-then-detail operation versus actions on each card |
| 34 | Task summary popup | Mouse entry or control focus shows summary; left-side popup suppressed if space is insufficient | Host popup after an 800 ms mouse hover | Delay, position, and keyboard entry differ; real focus behavior is unverified |
| 35 | Account list/map editing | Dedicated accounts page containing list, override, and map areas | Configuration page opens a modeless account window with three tabs | Navigation hierarchy and context retention differ; the account window does not block the IDE modally |
| 36 | Account override form | Account/target choice directly renders editable fields on the page | Account window first shows a summary, then an edit button enters the parameter editing flow | An additional step to reach editable fields |

Sources: [VS Code task cards](../media/console/taskCard.js), [drawer/accounts](../media/console/console.js), [parameter form](../media/console/configPanel.js), [JetBrains task cards](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskCardList.kt), [task window](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskLauncherToolWindowFactory.kt), [account window](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/AccountEditorDialog.kt).

## 6. Temporary screenshots

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 37 | Control placement | Paste/capture/foreground/clear at the top; carousel/coordinate controls below the stage | Paste/capture/clear/carousel/coordinates/foreground together at the top | The same controls are found in different locations |
| 38 | Image actions | Bottom-right send/delete; no equivalent image context menu in this page | Same bottom-right send/delete plus a context menu | Bottom-right buttons already match here; context-menu entry differs |
| 39 | Clear confirmation | In-page confirmation bar with cancel/confirm | Native `JOptionPane` confirmation | Position, focus, and dismissal differ |

Sources: [VS Code screenshot page](../media/tempScreenshots/index.html), [events](../media/tempScreenshots/app.js), [JetBrains screenshot window](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/TempScreenshotToolWindowFactory.kt). Cross-Webview dragging is also subject to VS Code host limitations, as the source tooltip acknowledges. Cross-panel dragging was not tested; two implementations do not prove equivalent behavior.

## 7. Characters, effects, locales, and issues

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 40 | Copy effect ID | Click the ID on an effect card | Select an effect, then use the top copy button, or a context menu | Another direct-action versus selection-action discrepancy |
| 41 | Effect source navigation | Open-definition button on each effect card | Top source button, double-click effect row, or context menu | Action placement and click gestures differ |
| 42 | Effect usages | First eight usages per card, clickable to return to the corresponding character | Renderer shows the first three in a text summary plus additional count, without individual usage click controls | Information volume and navigation back to characters differ |
| 43 | Locale/issue source | Click character name in locale table; each issue has a source button | Double-click a row in both tables | Discovery and click count differ |
| 44 | Add/edit forms | In-page backdrop dialog, error area, save/cancel; backdrop click or Escape closes | Native skill/enhancement/effect dialogs and platform messages | Similar editing capabilities, different dialog scope, layout, cancellation, and error placement |

Sources: [VS Code character page](../media/characterManager/index.html), [interactions](../media/characterManager/app.js), [JetBrains character panel](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/CharacterManagerPanel.kt), [native edit dialogs](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/CharacterDialogs.kt).

## 8. Convention sources, onboarding, and controls

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 45 | Convention/override sources | Searchable QuickPick with revert buttons on overridden entries | Native scrolling dialog with values/sources and revert buttons | Search, browsing, and window surface differ; override-reset semantics correspond |
| 46 | Getting started | Host walkthrough with steps and command entries | Dedicated editor tab with buttons to tool windows/editors | Different onboarding surface and navigation |
| 47 | Visual component system | Shared CSS tokens/controls, textual action glyphs, 24 px action widgets, shared borders/radii | Swing/host controls; task theme covers some pages, resources use list selection colors, screenshots use `ThumbnailActions`, task run buttons are borderless | Multiple card/action presentations across IDEs and within JetBrains; inheriting the IDE theme alone does not remove these discrepancies |

Sources: [VS Code source picker](../src/conventionSources.ts), [JetBrains source dialog](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/ShowConventionSourcesAction.kt), [walkthrough registration](../package.json), [JetBrains onboarding](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/GettingStartedEditor.kt), [shared controls](../media/shared/controls.css), [JetBrains task theme](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskLauncherTheme.kt).

## 9. Global configuration, list parameters, and publishing

| ID | Item | VS Code | JetBrains | User-visible difference |
| --- | --- | --- | --- | --- |
| 48 | Global configuration layout | Collapsible group cards with description, field count, source tags, and snapshot actions | Native settings-style groups with embedded field forms; the same page also contains account summaries and project settings | Both provide folding and current-field editing, but grouping, widgets, and adjacent content differ |
| 49 | List parameter editor | In-page list dialog; confirmation applies, cancel/backdrop/Escape dismisses | Native `ModifyListDialog`; confirmation applies and cancellation leaves values unchanged | Available-item search, addition, ordering, and removal broadly correspond, while dialog surface and dismissal differ |
| 50 | Publish selection/configuration | Host multi-select QuickPick offers publishable resources; subsequent pickers/inputs/warnings configure paths and enums | Native `PublishSelectionDialog` with three resource checkboxes, followed by native input/selection/confirmation dialogs | Selection presentation, dialog surfaces, and cancellation entries differ; both configure before writing |

Sources: [VS Code global groups](../media/console/console.js), [list parameters](../media/console/fields.js), [publishing](../src/templateAssetPanel.ts), [JetBrains configuration page](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/TaskLauncherToolWindowFactory.kt), [list dialog](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/tasklauncher/ModifyListDialog.kt), [publish selection](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/UnifiedPublishToolWindows.kt), [position configuration](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/PositionPublishFlow.kt), [template configuration](../jetbrains/src/main/kotlin/com/alicejump/okscripttoolkit/ui/TemplatePublishFlow.kt).

## Corresponding behavior and remaining verification

Corresponding capabilities must not be counted again as missing: both sides expose three resource modes/expressions, single-click insertion/double-click copying, annotated source previews, source import/capture/swap/delete, unified publishing, task enqueue/trigger enable, pause/stop, automatic current-parameter saving, global configuration groups, account overrides, four character pages, temporary screenshot send/delete, carousel, coordinate copying, and adjustable coordinate rectangles in the temporary screenshot stage. This establishes source-level flows, not matching positions, timing, or verified operation.

Host differences also include QuickPick versus native dialogs, Webview versus Swing, docking, and native widgets. Whether to retain each requires a subsequent decision; this audit neither automatically excuses them nor chooses to copy one IDE wholesale.

Real IDE verification remains for light/dark themes, 125%/150% scaling, narrow-toolbar wrapping, button hit areas, keyboard focus order, screen-reader information, click timing, Python editor insertion target, cross-panel dragging, external-file conflicts, failed saves/cancellation/retry, game/executor states, and whether installed plugins match these commits. These checks were not performed here.

The existing [feature alignment table](feature-parity.en.md) focuses on sources, write scope, publishing, and capability flows. Its “unified” wording and visibility claims do not replace inspection of registered UI entries. Revising those conclusions later requires synchronized Chinese/English documentation and separate verification in both IDEs.

## Results of this round's VS Code alignment

The 50 rows above remain the detailed pre-change snapshot. This round covers annotation management and resource previews; other task, account, character and temporary screenshot differences remain outside this scope.

| Original rows | Result |
| --- | --- |
| 06–11 | Three visible mode buttons; equal-width responsive cards with a 96-unit thumbnail area; bottom-right insert/copy/source buttons bound to each resource; 500 ms single-click delay and double-click copy; filter counts, empty states and thumbnail failure counts |
| 12–14 | Single-click source cards open an editor tab; source/swap/delete actions sit at each card’s bottom right; global toolbar actions, search and counts; automatic external-change refresh |
| 16–18 | An editor tab replaces the modal session; completed edits save immediately; mode and tool buttons share one wrapping toolbar |
| 19–22 | Create and double-click dialogs edit names and X/Y/W/H, hiding W/H for Point; per-item visibility and show/hide/selected-only actions; D/delete button toggles click-to-delete and Delete removes selections |
| 23–25 | Configurable R/C/D, Ctrl+Z/Y/C/V, Delete, image arrows, 1/2/3 and M; arrow nudging by 1 pixel or 10 with Shift; movable coordinate box with eight resize handles and copy on release |
| 26–28 | RGB swatch and absolute/relative coordinates; right-click copies the annotation name (VS Code’s copyColor actually copies category); modifier selection in the list; conflicts above annotation rows |
| 50 | No empty publish dialog; only populated resource types are selectable; configuration decisions still precede writes |

JetBrains PR #30’s huge-image scale clamp, growing minimum canvas size and empty publish dialog findings are fixed together. Failed saves preserve a recoverable draft with the original local branch for external merges. Successful saves accept the source revision so the editor’s own file events do not erase undo history.

Remaining host differences: Webview/Swing drawing and native containers for numeric input, swap targets, publication selection and confirmation. Themes, DPI, focus and drag/drop still require actual IDE acceptance. Passing automated tests and packaging are not treated as that acceptance.

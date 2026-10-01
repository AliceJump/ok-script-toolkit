# ok-script-toolkit · Unified UI Design System

[简体中文](design-system.md) | [English](design-system.en.md)

> This is the authoritative UI specification for the entire project. All webview panels (console / templatePanel / templateAssetPanel / tempScreenshots / annotationPanel / characterManager / boxPanel) must follow it.
> Implementation sources: `media/shared/tokens.css` (design tokens) and `media/shared/controls.css` (shared controls).
> **Pages compose these classes; they must not independently redefine visual rules.**

## 0. Core Requirement

> **The whole UI must look like it comes from one design system, rather than separately decorated pages.**

This is a **developer IDE plugin**. Experience design serves local-code debugging, resource editing, and diagnosis. Follow [Developer Plugin Scope and User Experience](developer-tool-scope.en.md) for feature boundaries and priorities. Keep technical information accessible. Business parameter removal, transfer, and historical configuration migration are not required plugin adaptations. Visual consistency does not imply consumer-software configuration, account, and recovery workflows.

---

## 1. Shared Design Language

Establish and follow one design system for page/container backgrounds, cards, buttons, inputs, selects, Checkbox/Radio/Switch, tabs, tags, lists, separators, icons, tooltips, Dialog/Modal, status messages, loading, empty states, and errors. Components of the same kind must share a visual language.

## 2. Shared Color System

Use a shared hierarchy (page background > first-level container > control surface > Hover/Active). Do not define independent per-component colors.

| Meaning | Token | Notes |
|---|---|---|
| Page background | `--bg-page` | Bottom layer |
| First-level container | `--bg-container` / `--bg-container-raised` | Panels / cards |
| Control surface (actual buttons) | `--bg-control` | Default Button/IconButton background with border |
| Row surface (group/collapsible headings) | `--bg-row` | Very light clickable-row background: recognizable, lower visual weight than buttons |
| Hover / Active | `--bg-control-hover` / `--bg-control-active` / `--bg-row-hover` / `--surface-hover` | Interaction states |
| Border | `--border` / `--border-strong` | Regular / focused |
| Primary text | `--text-primary` | |
| Secondary text | `--text-muted` | |
| Disabled text | `--text-disabled` | |
| Semantic colors | `--ok` / `--run` / `--warn` / `--pause` / `--err` | Do not introduce other values |

**Prohibited:** direct `--vscode-*` references in pages/components (allowed only in `tokens.css`), or hardcoded hex/rgba.

## 3. Consistent Clickable Controls

Clickable controls must be recognizable in their **default state**:

- ❌ Plain text / blending into the container / background appearing only on hover.
- ✅ A visible default surface; hover enhances it instead of revealing clickability for the first time.

**Two control categories** avoid a screen filled with nested boxes:

| Category | Use | Default state |
|---|---|---|
| Actual buttons | Save/sync/reset/enable/close/icon actions | `background: var(--bg-control)` + `border: 1px solid var(--border)` |
| Clickable rows | Group headings, collapsible headings, clickable list rows | `background: var(--bg-row)` (very light) + **no border**; hover uses `--bg-row-hover` |

Buttons of the same kind share height (`--control-h-sm/md/lg`), padding (`--space-*`), font, radius (`--radius-*`), border, background, icon size, icon/text spacing, and Hover/Active/Focus/Disabled treatment.

## 4. Shared Size Scale

- Spacing: `--space-xs(4) / sm(6) / md(10) / lg(14) / xl(20)`.
- Control height: `--control-h-sm(24) / md(30) / lg(34)`.
- Radius: `--radius-sm(5) / md(8) / lg(11) / pill`.
- Font size: `--font-xs(11) / sm(12) / md(13) / lg(15)`; weights only `--weight-regular(400)` / `--weight-medium(500)`.

Do not mix arbitrary 32/35/38/30px button heights or 4/6/10/square corners without justification.

## 5. Shared Typography

Inherit `--vscode-font-family`. Hierarchy: page title / section title (`.panel-section-title`) / body / helper text (`.panel-hint`) / label / button text / caption / error/warning text. Weights are only 400 / 500.

## 6. Shared Radius, Borders, Shadows

- Radius: only `--radius-sm/md/lg/pill`.
- Border width: `--border-width` (1px); color: `--border` / `--border-strong`.
- Shadow: only `--shadow`, for floating layers (drawers, dialogs, hover cards) only.

## 7. Shared Interaction States

All interactive components follow `Default / Hover / Active / Focus / Disabled / Loading`. Focus uses `--border-strong` or an outline. Disabled uses `opacity: .45` and `not-allowed`.

## 8. Same Function, Same Component

Save/cancel/delete/add/edit/refresh/settings/close/confirm reuse shared Button/IconButton. Inputs use Input; selects use Select; dialogs use Dialog; tags use Tag; messages use Toast/Alert; toggles use Switch. **Reuse existing components before copying CSS.**

## 9. Shared Layout

Keep page margins, maximum content width, section spacing, header height, toolbar height (`.panel-toolbar`), card spacing, dialog layout, and action-area layout consistent. Moving between pages should feel like using one application.

## 10. No Unjustified Local Exceptions

Remove oversized buttons, missing borders, hover-only backgrounds, inconsistent radii/fonts/color systems, different appearances for the same action, and duplicate implementations of the same component. Do not invent special styles for one page without a clear UX reason.

## 11. Design System Assets

```text
media/shared/tokens.css      Colors · Typography · Spacing · Radius · Border · Shadow · Sizes
media/shared/controls.css    Button(primary/secondary/mini/ghost/icon) · Input · Select · Checkbox/Switch
                             · Tag · Card · Toolbar · SectionTitle · Empty/Broken/Hint · Divider
                             · Clickability rules ([role=button], actual-button/clickable-row categories)
```

Connect a new panel in **three steps; omitting any step silently breaks styling**:

1. In `index.html`, load `__SHARED_TOKENS_URI__` → `__SHARED_CONTROLS_URI__` → panel styles in that order. This is cascade precedence; panel styles may override the shared layer.
2. Host `buildHtml` replaces both placeholders using `applySharedAssets(webview, extensionUri, html)` in `src/webviewHtml.ts`, the only implementation. Do not copy `asWebviewUri` assembly into panels.
3. If `localResourceRoots` does not allow all of `extensionUri`, add `sharedResourceRoot(extensionUri)`. Restricting roots to `media/<panel>` otherwise blocks shared assets.

**Automated audit:** `node scripts/test_design_system.js` checks these steps, no literal colors or direct `--vscode-*` references in panel CSS, scaled radii/font sizes, and defined `var()` references. Canvas drawing colors (such as annotation outlines) are **image content**, not UI theme, and are exempt.

## 12. Final Acceptance (Global UI Audit)

1. Every page uses the same design language.
2. Components of the same kind look consistent.
3. Every clickable control is recognizable by default.
4. Hover does not reveal clickability for the first time.
5. No plain-text buttons.
6. No buttons completely blending into their containers.
7. Colors, fonts, spacing, radii, borders, and shadows are consistent.
8. The same function reuses the same component.
9. No unnecessary style unique to one page.
10. Switching between any two pages clearly feels like one complete product.

---

## Implementation Progress

2026-10-01 addendum: box panels/galleries share `media/boxPanel`, connected through `src/boxPanels.ts` and included in the static audit. The table and six-panel record below describe the 2026-09-23 migration baseline, not a reason to omit newer panels.

| Stage | Work | Status |
|---|---|---|
| S1 | Create `media/shared/{tokens,controls}.css`; connect console without visual changes, protected by 4 jsdom tests; allow host `localResourceRoots` | ✅ Complete |
| S2 | Migrate templatePanel / templateAssetPanel | ✅ Complete |
| S3 | Migrate tempScreenshots / annotationPanel | ✅ Complete |
| S4 | Migrate characterManager: token aliases, deduplicate basic controls, scale tabs/radii/fonts | ✅ Complete |
| S5 | Global audit: static `scripts/test_design_system.js` in place; hardcoded i18n cleanup and manual real-theme screenshot review remain | 🔄 In progress |

**All six panels use the shared layer** (2026-09-23, `feat/sidebar-styling`): `console` / `templatePanel` / `templateAssetPanel` / `tempScreenshots` / `annotationPanel` / `characterManager`. Automated audit assertions cover these results:

| Metric | Before | After |
|---|---|---|
| Direct `--vscode-*` in panel CSS | 6 files, 40+ references | **0**; only `media/shared/tokens.css` may use them |
| Literal hex/rgb colors in panel CSS | 6 files | **0**, except canvas drawing colors |
| Unscaled px radii / fonts | 17 / multiple occurrences | **0**, using `--radius-*` / `--font-*` |
| Toolbar buttons | Separate padding/border/background implementations | Shared `.mini-btn` / `.icon-btn` / `.mini-btn.is-active` |

**Migration issue, fixed:** top-level `import vscode` in `src/webviewHtml.ts` broke pure-function tests in `scripts/` with `Cannot find module 'vscode'`. Type-only import and lazy `require` inside functions keep pure functions independently testable.

**Completed console changes:**

- The parameter button no longer uses yellow `--warn` semantics. All states are neutral: default control surface plus border; modified stronger border; open darker control surface.
- Clickability categories, finalized 2026-09-23:
  - **Actual buttons:** `--bg-control` plus border for group-collapse buttons, `.btn-mini`, icon buttons, and destructive buttons.
  - **Clickable rows:** very light `--bg-row` without border for startup-settings headings, task/kind group headings, card headings, unselected segmented tabs, and game-status rows.
  - Applying `--bg-control` to everything initially made the sidebar a wall of nested boxes; users disliked it. Buttons and row headings carry different visual weights and must not use identical surfaces and borders.
- `[hidden]` fallback, persistent collapsed state (`uiState`), and i18n key parity in six languages.

**Other panel changes:**

- Floating actions on thumbnails/tiles (`templatePanel.open-btn`, `templateAssetPanel.actions`, `tempScreenshots` card actions) changed from hover-only to always visible, with control surfaces and borders. Removed `rgba(0,0,0,.55)+#fff`, which appeared as black blocks in light themes.
- Modal scrims/shadows use `--scrim` / `--shadow-sm` / `--shadow-lg`.
- `annotationPanel` toolbar/modal buttons use shared `.mini-btn`. `characterManager` removed local `:root` token definitions (keeping short aliases to shared tokens), deduplicated basic `button/input` declarations, and uses light unselected tabs / control-surface selected tabs.

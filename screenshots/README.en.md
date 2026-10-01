# Demo Assets

[简体中文](README.md) | [English](README.en.md)

The demo images referenced in the README are stored in this directory. All 6 are in place and enabled in the README:

| Filename | Size | Duration | README location |
|---|---|---|---|
| `hero.gif` | 1.24 MB | 23.6s | Top (before `## Features`) |
| `code-hints.gif` | 0.29 MB | 8.2s | `### Code Development Assistance` |
| `template-panel.gif` | 3.58 MB | 57.4s | `### Template Management` |
| `temp-shots.gif` | 0.47 MB | 17.1s | `### Temp Screenshots` |
| `task-launcher.gif` | 1.27 MB | 28.3s | `### Task Launcher` |
| `character-manager.gif` | 2.18 MB | 31.4s | `### Character Skill Management` |

All are **900×476 / 12fps**, totaling **9.0 MB**.

The bottom **86px** of recording black bars has been uniformly cropped (original 2560×1440 → cropped to 1354 → scaled to 900×476).
Without cropping: 900×506 / 9.2 MB.

> [!NOTE]
> `template-panel.gif` is composed of `template-panel-14s.mkv` (first 14s) + `template-panel.mkv`,
> covering the full chain: "template panel → template assets → annotation editor". It is the only one exceeding 30s.
> If too long, re-crop with `-s` / `-e`.

Source recording files are in `C:\Users\26309\Videos` (2560×1440 @ 60fps); GIFs in this directory were converted from them.
Regenerate using `scripts/make-gif.sh` from the repo root; toolchain documentation is at
[`../scripts/README-gif.md`](../scripts/README-gif.en.md).

## Requirements

- **Width**: Uniformly **900px** (hero can use 1000px). GitHub README content column is ~1012px wide;
  exceeding it causes compression, and under 800px looks empty. Mobile auto-scales, no extra handling needed.
- **Size**: Each GIF should be **under 5MB**. GitHub warns for single files over 10MB and rejects pushes over 50MB.
  GIF size = frame count × visual complexity, so—
- **Compression tips**:
  - **Only capture the area to demonstrate** during recording, not the full screen — this is the most effective size reduction.
  - Reducing frame rate to **10–12 fps** is sufficient; demo operations don't need 30/60 fps.
  - Reduce color count to **128 colors** (`gifsicle --colors 128`).
  - Prefer `gifsicle -O3 --lossy=80` optimization; if still over budget, consider recording MP4 + converting to WebP,
    or splitting into two static PNGs.
  - Single GIFs over 10 seconds should be split into two segments — viewer attention can't sustain longer.
- **Crop black bars**: Window capture often records a **pure black region** at the bottom (when the capture area is taller than the window).
  This adds no value to the demo and creates a black stripe below the image. Use `--crop-bottom` to fix it in one go.
  All 6 images in this directory have had the bottom **86px** cropped (1440 → 1354, scaled to 900×476).
  Measurement method at [`../scripts/README-gif.md`](../scripts/README-gif.en.md).
- **Readability**: VS Code's default dark theme records well with good contrast; if recording a light theme,
  ensure it also looks good in GitHub's dark mode — avoid low-contrast light gray on light gray.
- **Cursor**: Slow down mouse movement during recording and pause ~0.5s at key positions to help viewers follow.

## Recommended Workflow: Record MP4 → Convert to GIF

Exporting GIFs directly from recording software usually yields poor quality (default palette is only 216 colors, prone to color banding).
A better approach is **record as MP4, then convert to GIF with ffmpeg** — this repo provides a script:

```bash
# Basic usage (default 900px width / 12fps, outputs to screenshots/<same-name>.gif)
./scripts/make-gif.sh demo.mp4

# Specify output path
./scripts/make-gif.sh demo.mp4 -o screenshots/hero.gif

# Keep only seconds 3-9 (trim preparation work before the demo)
./scripts/make-gif.sh demo.mp4 -s 3 -e 9

# Auto-retry with lower frame rate if over 4MB
./scripts/make-gif.sh demo.mp4 --max-mb 4

# Crop bottom 86px black bars (pure black region recorded below the window)
./scripts/make-gif.sh demo.mp4 --crop-bottom 86

# The three-pronged approach for size reduction
./scripts/make-gif.sh demo.mp4 -w 800 -f 10 -c 128
```

Run `./scripts/make-gif.sh -h` for full parameters. The script uses a **two-pass palette method**
(`palettegen` + `paletteuse`) — first computing an optimal palette of up to 256 colors from the video,
then using it for dithering, yielding quality one tier above "one-step GIF conversion"; if `gifsicle` is installed,
it applies an additional compression pass. When exceeding the size limit, the script auto-retries with progressively
lower frame rates (minimum 6fps), and provides specific adjustment suggestions if still over budget.

> [!TIP]
> `gifsicle` can reduce size by an additional **35~46%** — strongly recommended.
> Note it is **not in the winget source**; `winget install gifsicle` will fail.
> See [`../scripts/README-gif.md`](../scripts/README-gif.en.md) for working installation methods.

## Why This Directory Isn't Packed into VSIX

The root `.vscodeignore` already includes `screenshots/**`, so images here **only serve GitHub README display
and are not included in the extension install package**. High-resolution assets can be stored here safely.

## Note

The sub-repo README currently ships **no** demo GIFs: the JetBrains edition is a native
Swing UI that looks nothing like the parent repo's webviews, so the GIFs here cannot be
reused and must be re-recorded from the sandbox IDE. The sub-repo README already has
**commented-out placeholder blocks** reserved under English filenames (`hero.gif`,
`code-hints.gif`, `tool-windows.gif`, `character-manager.gif`) — once recorded, drop them
into `jetbrains/screenshots/` (that directory does not exist yet) and uncomment the blocks.

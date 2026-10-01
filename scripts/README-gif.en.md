# GIF Toolchain

[简体中文](README-gif.md) | [English](README-gif.en.md)

Recording and conversion instructions for README demo images. See the [demo asset directory](../screenshots/README.en.md).

## Recording

**ScreenToGif** is recommended on Windows (free and open-source, `winget install NickeManarin.ScreenToGif`).
Record as **MP4/MKV** instead of exporting GIF directly — much better quality, then convert with the scripts below.

## Conversion

```bash
# Basic usage: default 900px width / 12fps, outputs to screenshots/<same-name>.gif
./scripts/make-gif.sh demo.mp4

# Specify output
./scripts/make-gif.sh demo.mp4 -o screenshots/hero.gif

# Keep only seconds 3-9
./scripts/make-gif.sh demo.mp4 -s 3 -e 9

# Auto-retry with lower frame rate if over 4MB
./scripts/make-gif.sh demo.mp4 --max-mb 4

# Crop bottom 86px (black bars recorded below the window)
./scripts/make-gif.sh demo.mp4 --crop-bottom 86
```

Full parameters: `./scripts/make-gif.sh -h`

The script uses a **two-pass palette method** (`palettegen` + `paletteuse`), yielding quality one tier above one-step GIF conversion.
If `gifsicle` is installed, it applies an additional `-O3 --lossy` compression pass.

## Cropping Recording Black Bars (`--crop-bottom`)

Window capture often records the extra black region below the window — this appears when the capture area is taller than the window.
These pure black pixels add no value, waste space, and create a black stripe below the image.

First measure how tall the black bar is:

```bash
# cropdetect outputs the "effective frame" dimensions; the difference between height and source height is the black bar
ffmpeg -ss 2 -t 3 -i demo.mp4 -vf cropdetect=limit=24:round=2 -f null - 2>&1 | grep -o 'crop=[0-9:]*' | tail -1
# Example: crop=2560:1354:0:0 → source height 1440, black bar = 1440 - 1354 = 86
```

Then pass the difference to `--crop-bottom` to regenerate:

```bash
./scripts/make-gif.sh demo.mp4 --crop-bottom 86
```

> [!TIP]
> `cropdetect`'s `limit=24` means "brightness ≤24 is treated as black". If your UI is already dark-themed
> and the bottom happens to be a dark area, this value may be too conservative (crops less);
> conversely, to also crop a dark gray bottom border, add a few pixels to the calculated difference.
>
> Cropping happens **at the front of the filter chain**, i.e., at the original resolution,
> so boundaries never fall on fractional pixels due to scaling.

## Installing gifsicle (Important)

**gifsicle is not in the winget source** — `winget install gifsicle` will fail. Verified working methods:

### Method 1: Chocolatey

```bash
choco install gifsicle -y
```

> [!WARNING]
> On some Windows environments, choco installation reports
> `The dictionary key: "http_proxy" added key: "HTTP_PROXY"`.
> This is a known issue with choco's case-insensitive environment variable handling.
> Clear the `http_proxy` / `HTTP_PROXY` environment variables and retry, or use Method 2.

### Method 2: Portable (Recommended, No Admin Required)

Download from the official Windows build page:

<https://eternallybored.org/misc/gifsicle/>

Select `gifsicle-1.95-win64.zip`, extract `gifsicle.exe`, and place it in the repo root's `.tools/` directory:

```bash
mkdir -p .tools && cd .tools
curl -LO https://eternallybored.org/misc/gifsicle/releases/gifsicle-1.95-win64.zip
unzip -o gifsicle-1.95-win64.zip
```

`make-gif.sh` automatically finds it in order: **PATH → `.tools/`** — no environment variable configuration needed.

> [!NOTE]
> `.tools/` is already excluded in `.vscodeignore` and will not enter the VSIX.

## Compression Results Reference

For 900px / 12fps IDE demo GIFs, `gifsicle -O3 --lossy=80` achieves a **35~46%** size reduction
(this step is built into the script and activates automatically when gifsicle is installed).

Measured benefits of `--crop-bottom 86` on this repo's assets (sizes already include gifsicle compression):

| File | Before Crop | After Crop |
|---|---|---|
| `template-panel.gif` | 3.58 MB | 3.58 MB |
| `character-manager.gif` | 2.20 MB | 2.18 MB |
| `task-launcher.gif` | 1.34 MB | 1.27 MB |
| `hero.gif` | 1.26 MB | 1.24 MB |
| `temp-shots.gif` | 0.49 MB | 0.47 MB |
| `code-hints.gif` | 0.29 MB | 0.29 MB |
| **Total** | **9.16 MB** | **9.03 MB** |

> [!NOTE]
> Pure black regions compress extremely well, so cropping only saves ~1.5% in size — the real value of cropping is
> **visual appearance** (removing the black stripe below images), not size reduction.
> Actual size reduction comes from gifsicle and "only capturing the necessary area during recording".

## Size & Duration Guidelines

- **Width 900px** (hero can use 1000px): GitHub content column is ~1012px; exceeding it causes compression.
- **Single file < 5MB**: GitHub warns for files >10MB, rejects pushes >50MB.
- **Single GIF ≤ 10s**: Longer demos should be split into two segments.
- Frame rate 10~12fps is sufficient; demo operations don't need 30/60fps.
- **Only capture the area to demonstrate** during recording — this is the most effective size reduction technique.

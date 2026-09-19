# 演示素材 / Demo Assets

## 中文

README 里引用的演示图放在这个目录。当前 6 张已全部就位并在 README 中启用：

| 文件名 | 大小 | 时长 | 用在 README 的位置 |
|---|---|---|---|
| `hero.gif` | 1.24 MB | 23.6s | 顶部（`## 功能` 之前） |
| `code-hints.gif` | 0.29 MB | 8.2s | `### 代码开发辅助` |
| `template-panel.gif` | 3.58 MB | 57.4s | `### 模板管理` |
| `temp-shots.gif` | 0.47 MB | 17.1s | `### 临时截图` |
| `task-launcher.gif` | 1.27 MB | 28.3s | `### 任务启动` |
| `character-manager.gif` | 2.18 MB | 31.4s | `### 角色技能管理` |

全部为 **900×476 / 12fps**，合计 **9.0 MB**。

底部已统一裁掉 **86px** 录屏黑边（原始 2560×1440 → 裁到 1354 → 缩放后 900×476）。
未裁边时是 900×506 / 9.2 MB。

> [!NOTE]
> `template-panel.gif` 是 `template-panel-14s.mkv`（前 14s）+ `template-panel.mkv` 拼接而成，
> 覆盖「模板面板 → 模板素材 → 标注编辑器」的完整链路。它是唯一超过 30s 的一张，
> 若嫌太长，可用 `-s` / `-e` 重新裁剪。

源录制文件在 `C:\Users\26309\Videos`（2560×1440 @ 60fps），本目录的 GIF 由它们转换而来。
重新生成用仓库根目录的 `scripts/make-gif.sh`，工具链说明见
[`../scripts/README-gif.md`](../scripts/README-gif.md)。

### 制作要求

- **宽度**：统一 **900px**（hero 可用 1000px）。GitHub README 正文栏约 1012px 宽，
  超过会被压缩，小于 800px 会显得空。手机端会自动缩放，无需额外处理。
- **体积**：单个 GIF **控制在 5MB 以内**。GitHub 对单文件超过 10MB 的仓库会告警，
  超过 50MB 直接拒绝 push。GIF 体积 = 帧数 × 画面复杂度，所以——
- **压缩技巧**：
  - 录制时**只框选需要展示的区域**，不要整屏录，这是最有效的减重手段。
  - 帧率降到 **10–12 fps** 就够，演示操作不需要 30/60 fps。
  - 颜色数降到 **128 色**（`gifsicle --colors 128`）。
  - 优先用 `gifsicle -O3 --lossy=80` 优化；体积仍超标就考虑改录 MP4 + 转 WebP，
    或截成两张静态 PNG。
  - 单 GIF 超过 10 秒建议拆成两段，观众注意力撑不住。
- **裁掉黑边**：窗口捕获常在画面下方多录进一条**纯黑区域**（捕获区域比窗口高时就会出现），
  它对演示毫无价值，还会让图片下面拖一条黑带。用 `--crop-bottom` 一次解决，
  本目录 6 张图都已裁掉底部 **86px**（1440 → 1354，缩放后 900×476）。
  测量方法见 [`../scripts/README-gif.md`](../scripts/README-gif.md)。
- **可读性**：VS Code 默认深色主题录出来对比度好；如果录浅色主题，注意
  README 在 GitHub 深色模式下也能看，不要用低对比度的浅灰配浅灰。
- **光标**：录屏时鼠标移动放慢、在关键位置停顿约 0.5s，方便观众跟上。

### 推荐工作流：录 MP4 → 转 GIF

直接用录制软件导出 GIF 画质通常偏差（默认调色板只有 216 色，容易出色带）。
更好的做法是**录成 MP4，再用 ffmpeg 转 GIF**，本仓库已提供脚本：

```bash
# 基础用法（默认 900px 宽 / 12fps，输出到 screenshots/<同名>.gif）
./scripts/make-gif.sh demo.mp4

# 指定输出路径
./scripts/make-gif.sh demo.mp4 -o screenshots/hero.gif

# 只保留第 3~9 秒（演示前的准备工作剪掉）
./scripts/make-gif.sh demo.mp4 -s 3 -e 9

# 超过 4MB 就自动降帧率重试
./scripts/make-gif.sh demo.mp4 --max-mb 4

# 裁掉底部 86px 黑边（录屏时窗口下方多录进来的纯黑区域）
./scripts/make-gif.sh demo.mp4 --crop-bottom 86

# 减小体积的三板斧
./scripts/make-gif.sh demo.mp4 -w 800 -f 10 -c 128
```

完整参数用 `./scripts/make-gif.sh -h` 查看。脚本内部用**两遍调色板法**
（`palettegen` + `paletteuse`）——先从视频统计出最多 256 色的最优调色板，
再用它做抖动映射，画质比"一步转 GIF"高一档；装了 `gifsicle` 还会再压一道。
超出体积上限时脚本会自动逐档降帧率（最低 6fps），仍超标则给出具体调整建议。

> [!TIP]
> `gifsicle` 能再减 **35~46%** 体积，强烈建议装。注意 **它不在 winget 源里**，
> `winget install gifsicle` 会失败 —— 可行的安装方式见
> [`../scripts/README-gif.md`](../scripts/README-gif.md)。


### 为什么这个目录不会被塞进 VSIX

根目录 `.vscodeignore` 里已经有 `screenshots/**`，所以这里的图片**只服务于 GitHub 上的
README 展示，不会被打进扩展安装包**。可以放心放高分辨率素材。

### 注意

`jetbrains/screenshots/` 是给子仓库 README 用的独立目录（子仓库是独立 git 仓库，
无法引用父仓库的 `.vscodeignore` 规则，但因为子仓库整体在 `.vscodeignore` 里被
`jetbrains/**` 排除，同样不会进 VSIX）。子仓库那个目录里用的是英文文件名：
`hero.gif`、`code-hints.gif`、`tool-windows.gif`、`character-manager.gif`。

---

## English

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
[`../scripts/README-gif.md`](../scripts/README-gif.md).

### Requirements

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
  Measurement method at [`../scripts/README-gif.md`](../scripts/README-gif.md).
- **Readability**: VS Code's default dark theme records well with good contrast; if recording a light theme,
  ensure it also looks good in GitHub's dark mode — avoid low-contrast light gray on light gray.
- **Cursor**: Slow down mouse movement during recording and pause ~0.5s at key positions to help viewers follow.

### Recommended Workflow: Record MP4 → Convert to GIF

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
> See [`../scripts/README-gif.md`](../scripts/README-gif.md) for working installation methods.


### Why This Directory Isn't Packed into VSIX

The root `.vscodeignore` already includes `screenshots/**`, so images here **only serve GitHub README display
and are not included in the extension install package**. High-resolution assets can be stored here safely.

### Note

`jetbrains/screenshots/` is a separate directory for the sub-repo README (the sub-repo is an independent git repo
and cannot reference the parent's `.vscodeignore` rules, but since the entire sub-repo is excluded in `.vscodeignore`
via `jetbrains/**`, it also won't enter VSIX). The sub-repo directory uses English filenames:
`hero.gif`, `code-hints.gif`, `tool-windows.gif`, `character-manager.gif`.
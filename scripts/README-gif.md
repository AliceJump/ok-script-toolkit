# GIF 制作工具链 / GIF Toolchain

README 演示图的录制与转换说明。素材目录见 [`../screenshots/README.md`](../screenshots/README.md)。

Recording and conversion instructions for README demo images. Asset directory at [`../screenshots/README.md`](../screenshots/README.md).

---

## 中文

### 录制

Windows 上推荐 **ScreenToGif**（免费开源，`winget install NickeManarin.ScreenToGif`）。
录成 **MP4/MKV** 而不是直接导出 GIF，画质会好很多，再用下面的脚本转换。

### 转换

```bash
# 基础用法：默认 900px 宽 / 12fps，输出到 screenshots/<同名>.gif
./scripts/make-gif.sh demo.mp4

# 指定输出
./scripts/make-gif.sh demo.mp4 -o screenshots/hero.gif

# 只取第 3~9 秒
./scripts/make-gif.sh demo.mp4 -s 3 -e 9

# 超 4MB 自动降帧率重试
./scripts/make-gif.sh demo.mp4 --max-mb 4

# 裁掉底部 86px（录屏时窗口下方多录进来的黑边）
./scripts/make-gif.sh demo.mp4 --crop-bottom 86
```

完整参数：`./scripts/make-gif.sh -h`

脚本用**两遍调色板法**（`palettegen` + `paletteuse`），比一步转 GIF 的画质高一档。
装了 gifsicle 会自动再压一道 `-O3 --lossy`。

### 裁掉录屏黑边（`--crop-bottom`）

窗口捕获常常把窗口下方多余的黑色区域一起录进来 —— 捕获区域比窗口高时就会出现。
这些纯黑像素对演示毫无价值，白占体积，还会让图片下面拖一条黑带。

先量出黑边有多高：

```bash
# cropdetect 会给出「有效画面」的尺寸，height 与源高度之差就是黑边
ffmpeg -ss 2 -t 3 -i demo.mp4 -vf cropdetect=limit=24:round=2 -f null - 2>&1 | grep -o 'crop=[0-9:]*' | tail -1
# 例：crop=2560:1354:0:0 → 源高 1440，黑边 = 1440 - 1354 = 86
```

然后把差值传给 `--crop-bottom` 重新生成：

```bash
./scripts/make-gif.sh demo.mp4 --crop-bottom 86
```

> [!TIP]
> `cropdetect` 的 `limit=24` 表示「亮度 ≤24 视为黑」。如果你的界面本身就是深色主题、
> 底部又刚好是深色区域，这个值可能偏保守（少裁一点）；反之想连深灰底边一起裁掉，
> 就在算出的差值上再加几像素。
>
> 裁边在**滤镜链最前面**执行，也就是在原始分辨率下裁，不会因为缩放让边界落在小数像素上。

### gifsicle 的安装（重要）

**gifsicle 不在 winget 源里**，`winget install gifsicle` 会失败。实测可行的方式：

#### 方式一：Chocolatey

```bash
choco install gifsicle -y
```

> [!WARNING]
> 在部分 Windows 环境下 choco 安装会报
> `字典中的关键字:"http_proxy"所添加的关键字:"HTTP_PROXY"`。
> 这是 choco 处理大小写不敏感环境变量的已知问题。遇到时清掉 `http_proxy` /
> `HTTP_PROXY` 环境变量后重试，或改用方式二。

#### 方式二：便携版（推荐，无需管理员）

从官方 Windows 构建页下载：

<https://eternallybored.org/misc/gifsicle/>

选 `gifsicle-1.95-win64.zip`，解压出 `gifsicle.exe`，放到仓库根的 `.tools/` 目录：

```bash
mkdir -p .tools && cd .tools
curl -LO https://eternallybored.org/misc/gifsicle/releases/gifsicle-1.95-win64.zip
unzip -o gifsicle-1.95-win64.zip
```

`make-gif.sh` 会按 **PATH → `.tools/`** 的顺序自动找到它，无需配置环境变量。

> [!NOTE]
> `.tools/` 已在 `.vscodeignore` 中排除，不会进入 VSIX。

### 压缩效果参考

对 900px / 12fps 的 IDE 演示图，`gifsicle -O3 --lossy=80` 实测减幅 **35~46%**
（脚本已内置这一步，装了 gifsicle 就自动生效）。

`--crop-bottom 86` 在本仓库素材上的实测收益（体积已含 gifsicle 压缩）：

| 文件 | 裁边前 | 裁边后 |
|---|---|---|
| `template-panel.gif` | 3.58 MB | 3.58 MB |
| `character-manager.gif` | 2.20 MB | 2.18 MB |
| `task-launcher.gif` | 1.34 MB | 1.27 MB |
| `hero.gif` | 1.26 MB | 1.24 MB |
| `temp-shots.gif` | 0.49 MB | 0.47 MB |
| `code-hints.gif` | 0.29 MB | 0.29 MB |
| **合计** | **9.16 MB** | **9.03 MB** |

> [!NOTE]
> 纯黑区域的压缩率本来就极高，所以裁掉它省下的体积只有 ~1.5% —— 裁边的价值主要在
> **观感**（去掉图片下方拖着的黑带），而不是体积。真正的减重还是靠 gifsicle 和
> 「录制时只框选必要区域」。

### 体积与时长建议

- **宽度 900px**（hero 可 1000px）：GitHub 正文栏约 1012px，超了会被压缩。
- **单文件 < 5MB**：GitHub 对 >10MB 的文件告警，>50MB 直接拒绝 push。
- **单张 ≤ 10s**：更长的演示建议拆成两段。
- 帧率 10~12fps 足够，演示操作不需要 30/60fps。
- 录制时**只框选需要展示的区域**，这是最有效的减重手段。

---

## English

### Recording

**ScreenToGif** is recommended on Windows (free and open-source, `winget install NickeManarin.ScreenToGif`).
Record as **MP4/MKV** instead of exporting GIF directly — much better quality, then convert with the scripts below.

### Conversion

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

### Cropping Recording Black Bars (`--crop-bottom`)

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

### Installing gifsicle (Important)

**gifsicle is not in the winget source** — `winget install gifsicle` will fail. Verified working methods:

#### Method 1: Chocolatey

```bash
choco install gifsicle -y
```

> [!WARNING]
> On some Windows environments, choco installation reports
> `The dictionary key: "http_proxy" added key: "HTTP_PROXY"`.
> This is a known issue with choco's case-insensitive environment variable handling.
> Clear the `http_proxy` / `HTTP_PROXY` environment variables and retry, or use Method 2.

#### Method 2: Portable (Recommended, No Admin Required)

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

### Compression Results Reference

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

### Size & Duration Guidelines

- **Width 900px** (hero can use 1000px): GitHub content column is ~1012px; exceeding it causes compression.
- **Single file < 5MB**: GitHub warns for files >10MB, rejects pushes >50MB.
- **Single GIF ≤ 10s**: Longer demos should be split into two segments.
- Frame rate 10~12fps is sufficient; demo operations don't need 30/60fps.
- **Only capture the area to demonstrate** during recording — this is the most effective size reduction technique.

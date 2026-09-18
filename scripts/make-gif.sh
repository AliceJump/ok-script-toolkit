#!/usr/bin/env bash
# 把录屏视频转成 README 用的高质量 GIF。
#
# 用两遍调色板法（palettegen + paletteuse），比"直接转 GIF"的画质高一档：
# 第一遍从视频里统计出最多 256 色的最优调色板，第二遍用这块调色板做抖动映射，
# 避免默认 216 色网板导致的色带和噪点。
#
# 用法:
#   ./scripts/make-gif.sh input.mp4                     # 默认 900px 宽，12fps
#   ./scripts/make-gif.sh input.mp4 -w 1000 -f 15       # 自定义宽度与帧率
#   ./scripts/make-gif.sh input.mp4 -o screenshots/hero.gif
#   ./scripts/make-gif.sh input.mp4 -s 3 -e 9           # 只取第 3~9 秒
#   ./scripts/make-gif.sh input.mp4 --max-mb 4          # 超限自动降帧率重试
#   ./scripts/make-gif.sh input.mp4 --crop-bottom 86    # 裁掉底部 86px（录屏黑边）
#
# 依赖: ffmpeg（必需）、gifsicle（可选，装了会再压一道）
set -euo pipefail

WIDTH=900
FPS=12
COLORS=256
OUT=""
START=""
END=""
MAX_MB=5
LOSSY=80
CROP_BOTTOM=0

# 打印文件头部的注释块作为帮助（跳过 shebang，遇到第一行非注释即停），
# 这样以后往头部加/删注释都不用同步改行号。
usage() {
	awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
	exit "${1:-0}"
}

die() { printf '\033[31m错误: %s\033[0m\n' "$1" >&2; exit 1; }
info() { printf '\033[36m%s\033[0m\n' "$1"; }
ok() { printf '\033[32m%s\033[0m\n' "$1"; }

# ---- 参数解析 ----
INPUT=""
while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help) usage 0 ;;
		-o|--output) OUT="${2:-}"; shift 2 ;;
		-w|--width) WIDTH="${2:-}"; shift 2 ;;
		-f|--fps) FPS="${2:-}"; shift 2 ;;
		-c|--colors) COLORS="${2:-}"; shift 2 ;;
		-s|--start) START="${2:-}"; shift 2 ;;
		-e|--end) END="${2:-}"; shift 2 ;;
		--max-mb) MAX_MB="${2:-}"; shift 2 ;;
		--lossy) LOSSY="${2:-}"; shift 2 ;;
		--crop-bottom) CROP_BOTTOM="${2:-}"; shift 2 ;;
		-*) die "未知参数: $1（用 -h 看用法）" ;;
		*) INPUT="$1"; shift ;;
	esac
done

[ -n "$INPUT" ] || usage 1
[ -f "$INPUT" ] || die "找不到输入文件: $INPUT"

case "$CROP_BOTTOM" in
	''|*[!0-9]*) die "--crop-bottom 需要一个非负整数（像素数），当前: $CROP_BOTTOM" ;;
esac

command -v ffmpeg >/dev/null 2>&1 || die "未找到 ffmpeg。Windows 可用: winget install Gyan.FFmpeg"

# ---- 输出路径 ----
if [ -z "$OUT" ]; then
	base="$(basename "$INPUT")"
	OUT="screenshots/${base%.*}.gif"
fi
mkdir -p "$(dirname "$OUT")"

# gifsicle 查找顺序：PATH → 仓库内便携版 .tools/ → 脚本同级 ../.tools/
# 找不到也能跑，只是少一道压缩。
GIFSICLE=""
if command -v gifsicle >/dev/null 2>&1; then
	GIFSICLE="gifsicle"
else
	for cand in "$(dirname "$0")/../.tools/gifsicle.exe" "$(dirname "$0")/../.tools/gifsicle"; do
		[ -x "$cand" ] && { GIFSICLE="$cand"; break; }
	done
fi
have_gifsicle=0
[ -n "$GIFSICLE" ] && have_gifsicle=1

# ---- 裁剪参数 ----
trim_args=()
[ -n "$START" ] && trim_args+=(-ss "$START")
[ -n "$END" ] && trim_args+=(-to "$END")

# 底部裁边：录屏工具经常把窗口下方多余的黑色区域一起录进去（窗口高度小于
# 捕获区域时就会出现），这类纯黑像素对 GIF 毫无价值却要占不少体积。
# crop 放在滤镜链最前面，在原始分辨率下裁，避免缩放后边界落在小数像素上。
crop_filter=""
if [ "$CROP_BOTTOM" -gt 0 ]; then
	crop_filter="crop=iw:ih-${CROP_BOTTOM}:0:0,"
	info "底部裁边: 去掉最后 ${CROP_BOTTOM}px"
fi

tmp_pal=""
tmp_gif=""
cleanup() { rm -f "$tmp_pal" "$tmp_gif"; }
trap cleanup EXIT

# 注意：不要用 mktemp -u。Git Bash 会返回 /tmp/xxx 这种 MSYS 虚拟路径，
# 而 ffmpeg 是原生 Windows 程序，会把 /tmp 解析成「当前盘符根目录下的 tmp」，
# 两边指向不同位置，导致写完找不到文件。临时文件放在输出目录旁最稳妥。
outdir="$(dirname "$OUT")"
tmp_pal="${outdir}/.tmp-palette-$$.png"
tmp_gif="${outdir}/.tmp-$$.gif"

# scale 用 -2 保证高度是偶数（lanczos 是高质量缩放算法）
build_gif() {
	local fps="$1" out="$2"
	info "→ 第 1 遍：统计最优调色板（${COLORS} 色，${WIDTH}px，${fps}fps）..."
	ffmpeg -hide_banner -loglevel error -y "${trim_args[@]}" -i "$INPUT" \
		-vf "${crop_filter}fps=${fps},scale=${WIDTH}:-2:flags=lanczos,palettegen=max_colors=${COLORS}:stats_mode=diff" \
		"$tmp_pal"

	info "→ 第 2 遍：用调色板生成 GIF..."
	ffmpeg -hide_banner -loglevel error -y "${trim_args[@]}" -i "$INPUT" -i "$tmp_pal" \
		-filter_complex "${crop_filter}fps=${fps},scale=${WIDTH}:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
		"$tmp_gif"

	if [ "$have_gifsicle" -eq 1 ]; then
		info "→ gifsicle 优化（--lossy=${LOSSY}）..."
		"$GIFSICLE" -O3 --lossy="$LOSSY" --colors "$COLORS" "$tmp_gif" -o "$out"
	else
		mv "$tmp_gif" "$out"
	fi
}

size_mb() { awk -v b="$(wc -c < "$1")" 'BEGIN{printf "%.2f", b/1048576}'; }

# ---- 主流程 ----
cur_fps="$FPS"
build_gif "$cur_fps" "$OUT"
sz="$(size_mb "$OUT")"

# 超限就逐档降帧率重试，最多降到 6fps
while awk -v s="$sz" -v m="$MAX_MB" 'BEGIN{exit !(s>m)}' && [ "$cur_fps" -gt 6 ]; do
	next=$(( cur_fps > 10 ? cur_fps - 2 : cur_fps - 1 ))
	info "⚠ ${sz}MB 超过 ${MAX_MB}MB 上限，降到 ${next}fps 重试..."
	cur_fps="$next"
	build_gif "$cur_fps" "$OUT"
	sz="$(size_mb "$OUT")"
done

printf '\n'
if awk -v s="$sz" -v m="$MAX_MB" 'BEGIN{exit !(s>m)}'; then
	printf '\033[33m⚠ 已降到 %sfps 仍为 %sMB（上限 %sMB）。建议：\033[0m\n' "$cur_fps" "$sz" "$MAX_MB"
	printf '   · 缩短录制时长（单张 GIF 建议 ≤ 10s）：-s 起始 -e 结束\n'
	printf '   · 缩小宽度：-w 800\n'
	printf '   · 减少颜色数：-c 128\n'
	printf '   · 录制时只框选必要区域（最有效）\n'
else
	ok "✓ 完成: $OUT  (${sz}MB, ${cur_fps}fps, ${WIDTH}px)"
fi
if [ "$CROP_BOTTOM" -gt 0 ]; then
	printf '\033[90m  底部已裁掉 %spx（原始高度减 %s）\033[0m\n' "$CROP_BOTTOM" "$CROP_BOTTOM"
fi
if [ "$have_gifsicle" -eq 0 ]; then
	printf '\033[90m提示: 安装 gifsicle 可再减 35~45%% 体积。安装方式见 scripts/README-gif.md\033[0m\n'
fi

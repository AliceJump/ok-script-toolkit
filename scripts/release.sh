#!/bin/sh
# ──────────────────────────────────────────────────────────
# 一键发版脚本 (POSIX sh)
#
# 自动完成：
#   1. 读取当前版本号并自动递增
#   2. 同步新版本号到五处：package.json / package-lock.json /
#      jetbrains/gradle.properties / README.md / jetbrains/README.md 的徽章
#   3. 验证版本一致性
#   4. 提交 jetbrains 子模块版本变更并推送
#   5. 提交父仓库版本变更（含 README 徽章与子模块指针）并推送
#   6. 创建 v{新版本} 标签并推送（这一步才会真正触发发布流水线）
#
# 用法:
#   ./scripts/release.sh [--major|--minor|--patch] [--dry-run] [version]
#   npm run release -- [同上参数]
#
# 默认递增 minor 版本（与 scripts/release.ps1 保持一致）。
# 也可显式指定版本号覆盖自动计算。
#
# 示例:
#   ./scripts/release.sh              # 0.5.3 -> 0.6.0
#   ./scripts/release.sh --patch      # 0.5.3 -> 0.5.4
#   ./scripts/release.sh --major      # 0.5.3 -> 1.0.0
#   ./scripts/release.sh 0.8.0        # 显式指定
#   ./scripts/release.sh --dry-run    # 预览模式
#
# Windows 用户可直接用 PowerShell 版：scripts/release.ps1（参数等价）。
# ──────────────────────────────────────────────────────────

set -e

# ── 参数解析 ──────────────────────────────────────────────
DRY_RUN=0
BUMP_LEVEL="minor"
VERSION=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --major)   BUMP_LEVEL="major" ;;
        --minor)   BUMP_LEVEL="minor" ;;
        --patch)   BUMP_LEVEL="patch" ;;
        *)         VERSION="$arg" ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Git Bash / MSYS 下 `pwd` 给的是 `/d/items/...` 形式的 MSYS 路径，原生 git.exe
# 不认，会报 "cannot change to '/d/...': No such file or directory"。
# 用 `pwd -W` 拿 Windows 形式（D:/items/...）传给 git；非 MSYS 平台没有 -W，
# 失败时保留原值。node/python 两种形式都能吃，所以只影响 git 调用。
if ROOT_WIN="$(cd "$ROOT" && pwd -W 2>/dev/null)" && [ -n "$ROOT_WIN" ]; then
    ROOT_GIT="$ROOT_WIN"
else
    ROOT_GIT="$ROOT"
fi
JETBRAINS_DIR="$ROOT/jetbrains"
JETBRAINS_DIR_GIT="$ROOT_GIT/jetbrains"

# ── 版本计算 ──────────────────────────────────────────────
read_current_version() {
    _ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)".*/\1 \2 \3/p' "$ROOT/package.json" | head -1)
    if [ -z "$_ver" ]; then
        echo "错误: package.json 中未找到有效版本号" >&2
        exit 1
    fi
    echo "$_ver"
}

bump_version() {
    _major=$1; _minor=$2; _patch=$3; _level=$4
    case "$_level" in
        major) echo "$((_major + 1)).0.0" ;;
        minor) echo "$_major.$((_minor + 1)).0" ;;
        patch) echo "$_major.$_minor.$((_patch + 1))" ;;
        *)     echo "错误: 未知递增级别: $_level" >&2; exit 1 ;;
    esac
}

# 读取当前版本
read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<EOF
$(read_current_version)
EOF
OLD_VERSION="$CUR_MAJOR.$CUR_MINOR.$CUR_PATCH"

# 计算新版本
if [ -n "$VERSION" ]; then
    if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "版本号格式无效: $VERSION" >&2
        exit 1
    fi
    NEW_VERSION="$VERSION"
else
    NEW_VERSION=$(bump_version "$CUR_MAJOR" "$CUR_MINOR" "$CUR_PATCH" "$BUMP_LEVEL")
fi

# ── 工具函数 ──────────────────────────────────────────────
run() {
    _label="$1"
    shift
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '  \033[90m[dry-run] %s\033[0m\n' "$_label"
        return 0
    fi
    printf '  \033[36m▸ %s\033[0m\n' "$_label"
    "$@"
}

# ── 主流程 ──────────────────────────────────────────────
printf '\n\033[32m🚀 发版: %s → v%s\033[0m\n\n' "$OLD_VERSION" "$NEW_VERSION"

# ① 检查工作区是否干净
echo '▸ 检查工作区状态...'
PARENT_STATUS=$(run 'git status (parent)' git -C "$ROOT_GIT" status --porcelain)
if [ -n "$PARENT_STATUS" ]; then
    echo "" >&2
    echo "错误: 父仓库工作区有未提交的更改，请先处理：" >&2
    echo "$PARENT_STATUS" >&2
    exit 1
fi

JETBRAINS_STATUS=$(run 'git status (jetbrains)' git -C "$JETBRAINS_DIR_GIT" status --porcelain)
if [ -n "$JETBRAINS_STATUS" ]; then
    echo "" >&2
    echo "错误: jetbrains 子模块工作区有未提交的更改，请先处理：" >&2
    echo "$JETBRAINS_STATUS" >&2
    exit 1
fi

# ② 同步版本号
echo "▸ 同步版本号 → $NEW_VERSION"
run 'version:sync' node "$ROOT/scripts/release/sync-version.js" "$NEW_VERSION"

# ③ 验证版本一致性
echo '▸ 验证版本一致性...'
run 'verify:version' node "$ROOT/scripts/release/verify-version.js"

# ④ 提交 jetbrains 子模块
echo '▸ 提交 jetbrains 子模块...'
run 'git add (jetbrains)' git -C "$JETBRAINS_DIR_GIT" add -A
run 'git commit (jetbrains)' git -C "$JETBRAINS_DIR_GIT" commit -m "chore(release): prepare v$NEW_VERSION"
run 'git push (jetbrains)' git -C "$JETBRAINS_DIR_GIT" push origin main

# ⑤ 提交父仓库（含子模块指针更新）
echo '▸ 提交父仓库...'
# README.md 也必须显式纳入：sync-version.js 会改写它的版本徽章，但它是未跟踪文件，
# `git commit`（非 -a）不会带上它，于是徽章更新会滞留在工作区——
# 下次 release.sh 的「工作区必须干净」检查又会直接报错卡住。
run 'git add (parent)' git -C "$ROOT_GIT" add package.json package-lock.json README.md jetbrains
run 'git commit (parent)' git -C "$ROOT_GIT" commit -m "chore(release): prepare v$NEW_VERSION"
run 'git push (parent)' git -C "$ROOT_GIT" push origin main

# ⑥ 打标签并推送
echo "▸ 创建标签 v$NEW_VERSION..."
run 'git tag' git -C "$ROOT_GIT" tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
run 'git push tag' git -C "$ROOT_GIT" push origin "v$NEW_VERSION"

# 完成
printf '\n\033[32m✅ 发版完成！\033[0m\n'
printf '   %s → v%s\n\n' "$OLD_VERSION" "$NEW_VERSION"

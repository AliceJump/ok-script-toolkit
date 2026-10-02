#!/usr/bin/env bash
set -euo pipefail

PARENT_REPO="${PARENT_REPO:-AliceJump/ok-script-toolkit}"
CHILD_REPO="${CHILD_REPO:-AliceJump/ok-script-toolkit-jetbrains}"
BUMP_LEVEL="${BUMP_LEVEL:-minor}"
EXPLICIT_VERSION="${EXPLICIT_VERSION:-}"
RUN_ID="${GITHUB_RUN_ID:-manual-$(date +%s)}"
WORK_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ok-script-release-${RUN_ID}"
PARENT_DIR="$WORK_ROOT/parent"
CHILD_DIR="$PARENT_DIR/jetbrains"

die() {
  echo "::error::$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

for cmd in git gh node; do
  need "$cmd"
done

[ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is required."
case "$BUMP_LEVEL" in
  major|minor|patch) ;;
  *) die "Unsupported bump level: $BUMP_LEVEL" ;;
esac
if [ -n "$EXPLICIT_VERSION" ] && ! [[ "$EXPLICIT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "Explicit version must be MAJOR.MINOR.PATCH, got: $EXPLICIT_VERSION"
fi

compare_versions() {
  node - "$1" "$2" <<'NODE'
const parse = (value) => value.split('.').map((part) => Number(part));
const [left, right] = process.argv.slice(2).map(parse);
for (let i = 0; i < 3; i += 1) {
  if (left[i] < right[i]) { console.log(-1); process.exit(0); }
  if (left[i] > right[i]) { console.log(1); process.exit(0); }
}
console.log(0);
NODE
}

wait_mergeable() {
  local repo="$1"
  local pr="$2"
  local state=""
  for _ in $(seq 1 30); do
    state=$(gh pr view "$pr" --repo "$repo" --json mergeable --jq '.mergeable')
    case "$state" in
      MERGEABLE) return 0 ;;
      CONFLICTING) die "$repo PR #$pr has merge conflicts." ;;
    esac
    sleep 2
  done
  die "$repo PR #$pr did not become mergeable (last state: ${state:-unknown})."
}

merge_release_pr() {
  local repo="$1"
  local pr="$2"
  local version="$3"
  wait_mergeable "$repo" "$pr"
  gh pr merge "$pr" \
    --repo "$repo" \
    --squash \
    --delete-branch \
    --subject "chore(release): prepare v$version (#$pr)" \
    --body "Automated version synchronization for v$version."
}

git config --global user.name "alicejump-release-bot[bot]"
git config --global user.email "alicejump-release-bot[bot]@users.noreply.github.com"
gh auth setup-git

rm -rf "$WORK_ROOT"
mkdir -p "$WORK_ROOT"
git clone --branch main --single-branch "https://github.com/$PARENT_REPO.git" "$PARENT_DIR"
git -C "$PARENT_DIR" submodule update --init jetbrains

pinned_child=$(git -C "$PARENT_DIR" rev-parse HEAD:jetbrains)
git -C "$CHILD_DIR" fetch origin main
git -C "$CHILD_DIR" checkout -B main origin/main
child_main=$(git -C "$CHILD_DIR" rev-parse HEAD)

current_version=$(node -p "require('$PARENT_DIR/package.json').version")
child_version=$(sed -n 's/^pluginVersion=//p' "$CHILD_DIR/gradle.properties" | head -n 1)
[[ "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Invalid parent version: $current_version"
[[ "$child_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Invalid JetBrains version: $child_version"

if [ -n "$EXPLICIT_VERSION" ]; then
  target_version="$EXPLICIT_VERSION"
else
  if [ "$child_version" != "$current_version" ]; then
    die "Parent is $current_version but JetBrains main is $child_version. Resume with an explicit version instead of an automatic bump."
  fi
  IFS=. read -r major minor patch <<< "$current_version"
  case "$BUMP_LEVEL" in
    major) target_version="$((major + 1)).0.0" ;;
    minor) target_version="$major.$((minor + 1)).0" ;;
    patch) target_version="$major.$minor.$((patch + 1))" ;;
  esac
fi

cmp=$(compare_versions "$target_version" "$current_version")
if [ "$cmp" -lt 0 ]; then
  die "Target version $target_version is older than parent version $current_version."
fi
if [ "$child_version" != "$current_version" ] && [ "$child_version" != "$target_version" ]; then
  die "JetBrains main is $child_version; expected either current parent version $current_version or target $target_version."
fi

tag="v$target_version"
if git -C "$PARENT_DIR" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  die "Tag $tag already exists."
fi

parent_pr=""
child_pr=""

if [ "$target_version" = "$current_version" ]; then
  [ "$child_version" = "$target_version" ] || die "JetBrains main is not prepared for $tag."
  if [ "$pinned_child" != "$child_main" ]; then
    die "Parent gitlink ($pinned_child) does not match JetBrains main ($child_main). Use a new version bump so the workflow can synchronize the two repositories."
  fi
  (cd "$PARENT_DIR" && npm run --silent verify:version)
else
  (cd "$PARENT_DIR" && node scripts/rele[X\ÙKÜŞ[˜Ë]™\œÚ[Û‹šœÈ‰\™Ù]İ™\œÚ[ÛˆŠBˆ
Ù‰T‘S•ÑTˆˆ	‰ˆœH[ˆK\Ú[[™\šYN™\œÚ[ÛŠB‚ˆÚ[Øœ˜[˜ÚHœ™[X\ÙKİ‰İ\™Ù]İ™\œÚ[ÛŸKIÔ•S—ÒQH‚ˆYˆHÚ]PÈ‰ÒSÑTˆˆY™ˆK\]ZY]KHÜ˜YKœ›Ü\Y\È‘PQQK›Y‘PQQK™[‹›YÈ[‚ˆÚ]PÈ‰ÒSÑTˆˆÚXÚÛİ]Xˆ‰Ú[Øœ˜[˜Ú‚ˆÚ]PÈ‰ÒSÑTˆˆYÜ˜YKœ›Ü\Y\È‘PQQK›Y‘PQQK™[‹›YˆÚ]PÈ‰ÒSÑTˆˆÛÛ[Z][H˜ÚÜ™J™[X\ÙJNˆ™\\™H‰\™Ù]İ™\œÚ[Ûˆ‚ˆÚ]PÈ‰ÒSÑTˆˆ\Ú]HÜšYÚ[ˆ‰Ú[Øœ˜[˜Ú‚‚ˆÚ[Ü—İ\›I
ÚˆÜ™X]HˆK\™\È‰ÒSÔ‘TÈˆˆKX˜\ÙHXZ[ˆˆKZXY‰Ú[Øœ˜[˜ÚˆˆK]]H˜ÚÜ™J™[X\ÙJNˆ™\\™H‰\™Ù]İ™\œÚ[ÛˆˆˆKX›ÙH]]ÛX]Y™]œ˜Z[œÈ™\œÚ[Ûˆ[™‘PQQH˜YÙHŞ[˜Ú›Ûš^˜][Ûˆ›Üˆ‰\™Ù]İ™\œÚ[Û‹ˆŠBˆÚ[ÜH‰ØÚ[Ü—İ\›ÈÊ‹ßH‚ˆY\™ÙWÜ™[X\ÙWÜˆ‰ÒSÔ‘TÈˆ‰Ú[Üˆˆ‰\™Ù]İ™\œÚ[Ûˆ‚ˆ[YˆÈ‰Ú[İ™\œÚ[ÛˆˆOH‰\™Ù]İ™\œÚ[ÛˆˆNÈ[‚ˆYH’™]œ˜Z[œÈ™\œÚ[Ûˆ™YYÈÈÚ[™ÙHÈ	\™Ù]İ™\œÚ[Û‹]›È™[X\ÙHY™ˆØ\È›ÙXÙYˆ‚ˆšB‚ˆÚ]PÈ‰ÒSÑTˆˆ™]ÚÜšYÚ[ˆXZ[‚ˆÚ]PÈ‰ÒSÑTˆˆÚXÚÛİ]PˆXZ[ˆÜšYÚ[‹ÛXZ[‚ˆÈ‰
ÙY[ˆ	ÜË×œYÚ[•™\œÚ[ÛKËÜ	È‰ÒSÑT‹ÙÜ˜YKœ›Ü\Y\ÈˆXY[ˆJHˆH‰\™Ù]İ™\œÚ[ÛˆˆHˆYH’™]œ˜Z[œÈXZ[ˆY›İ™XXÚ™\œÚ[Ûˆ	\™Ù]İ™\œÚ[Û‹ˆ‚‚ˆ
Ù‰T‘S•ÑTˆˆ	‰ˆœH[ˆK\Ú[[™\šYN™\œÚ[ÛŠB‚ˆ\™[Øœ˜[˜ÚHœ™[X\ÙKİ‰İ\™Ù]İ™\œÚ[ÛŸKIÔ•S—ÒQH‚ˆÚ]PÈ‰T‘S•ÑTˆˆÚXÚÛİ]Xˆ‰\™[Øœ˜[˜Ú‚ˆÚ]PÈ‰T‘S•ÑTˆˆYXÚØYÙKšœÛÛˆXÚØYÙK[ØÚËšœÛÛˆ‘PQQK›Y‘PQQK™[‹›Y™]œ˜Z[œÂˆÚ]PÈ‰T‘S•ÑTˆˆÛÛ[Z][H˜ÚÜ™J™[X\ÙJNˆ™\\™H‰\™Ù]İ™\œÚ[Ûˆ‚ˆÚ]PÈ‰T‘S•ÑTˆˆ\Ú]HÜšYÚ[ˆ‰\™[Øœ˜[˜Ú‚‚ˆ\™[Ü—İ\›I
ÚˆÜ™X]HˆK\™\È‰T‘S•Ô‘TÈˆˆKX˜\ÙHXZ[ˆˆKZXY‰\™[Øœ˜[˜ÚˆˆK]]H˜ÚÜ™J™[X\ÙJNˆ™\\™H‰\™Ù]İ™\œÚ[ÛˆˆˆKX›ÙH]]ÛX]Y\™[™\œÚ[ÛˆŞ[˜Ú›Ûš^˜][Ûˆ[™™]œ˜Z[œÈÚ][šÈ\]H›Üˆ‰\™Ù]İ™\œÚ[Û‹ˆŠBˆ\™[ÜH‰Ü\™[Ü—İ\›ÈÊ‹ßH‚ˆY\™ÙWÜ™[X\ÙWÜˆ‰T‘S•Ô‘TÈˆ‰\™[Üˆˆ‰\™Ù]İ™\œÚ[Ûˆ‚‚ˆÚ]PÈ‰T‘S•ÑTˆˆ™]ÚÜšYÚ[ˆXZ[‚ˆÚ]PÈ‰T‘S•ÑTˆˆÚXÚÛİ]PˆXZ[ˆÜšYÚ[‹ÛXZ[‚ˆÚ]PÈ‰T‘S•ÑTˆˆİX›[Ù[H\]HKZ[š]™]œ˜Z[œÂˆ
Ù‰T‘S•ÑTˆˆ	‰ˆœH[ˆK\Ú[[™\šYN™\œÚ[ÛŠB™šB‚œ™[X\ÙWÜÚOI
Ú]PÈ‰T‘S•ÑTˆˆ™]‹\\œÙHPQ
B™Ú]PÈ‰T‘S•ÑTˆˆYÈXH‰YÈˆ‰™[X\ÙWÜÚHˆ[H”™[X\ÙH	YÈ‚™Ú]PÈ‰T‘S•ÑTˆˆ\ÚÜšYÚ[ˆ‰YÈ‚‚šYˆÈ[ˆ‰ÑÒUP—ÓÕUU‹_HˆNÈ[‚ˆÂˆXÚÈ™\œÚ[ÛI\™Ù]İ™\œÚ[Ûˆ‚ˆXÚÈYÏIYÈ‚ˆXÚÈœ™[X\ÙWÜÚOI™[X\ÙWÜÚH‚ˆXÚÈœ\™[ÜI\™[Üˆ‚ˆXÚÈ˜Ú[ÜIÚ[Üˆ‚ˆHˆ‰ÒUP—ÓÕUU‚™šB‚™XÚÈ”™[X\ÙY	YÈOˆ	™[X\ÙWÜÚH‚–È[ˆ‰Ú[ÜˆˆH	‰ˆXÚÈ’™]œ˜Z[œÈˆÎ‹ËÙÚ]X‹˜ÛÛKÉÒSÔ‘TËÜ[ÉÚ[Üˆ‚–È[ˆ‰\™[ÜˆˆH	‰ˆXÚÈ”\™[ˆÎ‹ËÙÚ]X‹˜ÛÛKÉT‘S•Ô‘TËÜ[É\™[Üˆ‚
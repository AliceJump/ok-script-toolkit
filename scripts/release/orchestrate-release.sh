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

wait_pr_checks() {
  local repo="$1"
  local pr="$2"
  local count="0"
  for _ in $(seq 1 30); do
    count=$(gh pr view "$pr" --repo "$repo" --json statusCheckRollup --jq '.statusCheckRollup | length')
    if [ "$count" -gt 0 ]; then
      gh pr checks "$pr" --repo "$repo" --watch --interval 5
      return 0
    fi
    sleep 2
  done
  die "$repo PR #$pr did not report any CI checks."
}

merge_release_pr() {
  local repo="$1"
  local pr="$2"
  local version="$3"
  wait_mergeable "$repo" "$pr"
  wait_pr_checks "$repo" "$pr"
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
  (cd "$PARENT_DIR" && node scripts/release/sync-version.js "$target_version")
  (cd "$PARENT_DIR" && npm run --silent verify:version)

  child_branch="release/v${target_version}-${RUN_ID}"
  if ! git -C "$CHILD_DIR" diff --quiet -- gradle.properties README.md README.en.md; then
    git -C "$CHILD_DIR" checkout -b "$child_branch"
    git -C "$CHILD_DIR" add gradle.properties README.md README.en.md
    git -C "$CHILD_DIR" commit -m "chore(release): prepare v$target_version"
    git -C "$CHILD_DIR" push -u origin "$child_branch"

    child_pr_url=$(gh pr create \
      --repo "$CHILD_REPO" \
      --base main \
      --head "$child_branch" \
      --title "chore(release): prepare v$target_version" \
      --body "Automated JetBrains version and README badge synchronization for v$target_version.")
    child_pr="${child_pr_url##*/}"
    merge_release_pr "$CHILD_REPO" "$child_pr" "$target_version"
  elif [ "$child_version" != "$target_version" ]; then
    die "JetBrains version needs to change to $target_version, but no release diff was produced."
  fi

  git -C "$CHILD_DIR" fetch origin main
  git -C "$CHILD_DIR" checkout -B main origin/main
  [ "$(sed -n 's/^pluginVersion=//p' "$CHILD_DIR/gradle.properties" | head -n 1)" = "$target_version" ] \
    || die "JetBrains main did not reach version $target_version."

  (cd "$PARENT_DIR" && npm run --silent verify:version)

  parent_branch="release/v${target_version}-${RUN_ID}"
  git -C "$PARENT_DIR" checkout -b "$parent_branch"
  git -C "$PARENT_DIR" add package.json package-lock.json README.md README.en.md jetbrains
  git -C "$PARENT_DIR" commit -m "chore(release): prepare v$target_version"
  git -C "$PARENT_DIR" push -u origin "$parent_branch"

  parent_pr_url=$(gh pr create \
    --repo "$PARENT_REPO" \
    --base main \
    --head "$parent_branch" \
    --title "chore(release): prepare v$target_version" \
    --body "Automated parent version synchronization and JetBrains gitlink update for v$target_version.")
  parent_pr="${parent_pr_url##*/}"
  merge_release_pr "$PARENT_REPO" "$parent_pr" "$target_version"

  git -C "$PARENT_DIR" fetch origin main
  git -C "$PARENT_DIR" checkout -B main origin/main
  git -C "$PARENT_DIR" submodule update --init jetbrains
  (cd "$PARENT_DIR" && npm run --silent verify:version)
fi

release_sha=$(git -C "$PARENT_DIR" rev-parse HEAD)
git -C "$PARENT_DIR" tag -a "$tag" "$release_sha" -m "Release $tag"
git -C "$PARENT_DIR" push origin "$tag"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$target_version"
    echo "tag=$tag"
    echo "release_sha=$release_sha"
    echo "parent_pr=$parent_pr"
    echo "child_pr=$child_pr"
  } >> "$GITHUB_OUTPUT"
fi

echo "Released $tag -> $release_sha"
[ -n "$child_pr" ] && echo "JetBrains PR: https://github.com/$CHILD_REPO/pull/$child_pr"
[ -n "$parent_pr" ] && echo "Parent PR: https://github.com/$PARENT_REPO/pull/$parent_pr"

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

wait_commit_ci() {
  local repo="$1"
  local sha="$2"
  local run_id=""
  local run_url=""

  for _ in $(seq 1 60); do
    local row
    row=$(gh run list \
      --repo "$repo" \
      --workflow ci.yml \
      --event push \
      --commit "$sha" \
      --limit 20 \
      --json databaseId,headSha,url \
      --jq ".[] | select(.headSha == \"$sha\") | [.databaseId, .url] | @tsv" \
      | head -n 1 || true)
    if [ -n "$row" ]; then
      IFS=$'\t' read -r run_id run_url <<< "$row"
      break
    fi
    sleep 3
  done

  if [ -z "$run_id" ]; then
    die "$repo CI did not start for $sha."
  fi

  echo "Waiting for $repo CI: $run_url"
  gh run watch "$run_id" --repo "$repo" --exit-status
}

release_git_name="${RELEASE_GIT_NAME:-${GITHUB_ACTOR:-release}}"
release_git_email="${RELEASE_GIT_EMAIL:-${release_git_name}@users.noreply.github.com}"
git config --global user.name "$release_git_name"
git config --global user.email "$release_git_email"
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

current_tag="v$current_version"
current_tag_exists=false
if git -C "$PARENT_DIR" ls-remote --exit-code --tags origin "refs/tags/$current_tag" >/dev/null 2>&1; then
  current_tag_exists=true
fi

if [ -n "$EXPLICIT_VERSION" ]; then
  target_version="$EXPLICIT_VERSION"
else
  if [ "$child_version" != "$current_version" ]; then
    die "Parent is $current_version but JetBrains main is $child_version. Resume with an explicit version instead of an automatic bump."
  fi

  # If both repositories are already synchronized at the current version but its
  # tag is missing, finish that prepared release instead of skipping a version.
  if [ "$current_tag_exists" = false ] && [ "$pinned_child" = "$child_main" ]; then
    target_version="$current_version"
  else
    IFS=. read -r major minor patch <<< "$current_version"
    case "$BUMP_LEVEL" in
      major) target_version="$((major + 1)).0.0" ;;
      minor) target_version="$major.$((minor + 1)).0" ;;
      patch) target_version="$major.$minor.$((patch + 1))" ;;
    esac
  fi
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

parent_sha=$(git -C "$PARENT_DIR" rev-parse HEAD)
child_sha="$child_main"

if [ "$target_version" = "$current_version" ]; then
  [ "$child_version" = "$target_version" ] || die "JetBrains main is not prepared for $tag."
  if [ "$pinned_child" != "$child_main" ]; then
    die "Parent gitlink ($pinned_child) does not match JetBrains main ($child_main). Use a new version bump so the workflow can synchronize the two repositories."
  fi
  (cd "$PARENT_DIR" && npm run --silent verify:version)
else
  (cd "$PARENT_DIR" && node scripts/release/sync-version.js "$target_version")
  (cd "$PARENT_DIR" && npm run --silent verify:version)

  if ! git -C "$CHILD_DIR" diff --quiet -- gradle.properties README.md README.en.md; then
    git -C "$CHILD_DIR" add gradle.properties README.md README.en.md
    git -C "$CHILD_DIR" commit -m "chore(release): prepare v$target_version"
    child_sha=$(git -C "$CHILD_DIR" rev-parse HEAD)
    git -C "$CHILD_DIR" push origin HEAD:main
    wait_commit_ci "$CHILD_REPO" "$child_sha"
  elif [ "$child_version" != "$target_version" ]; then
    die "JetBrains version needs to change to $target_version, but no release diff was produced."
  else
    child_sha=$(git -C "$CHILD_DIR" rev-parse HEAD)
    wait_commit_ci "$CHILD_REPO" "$child_sha"
  fi

  git -C "$CHILD_DIR" fetch origin main
  git -C "$CHILD_DIR" checkout -B main origin/main
  [ "$(git -C "$CHILD_DIR" rev-parse HEAD)" = "$child_sha" ] \
    || die "JetBrains main moved after preparing v$target_version. Rerun the release from the new main state."
  [ "$(sed -n 's/^pluginVersion=//p' "$CHILD_DIR/gradle.properties" | head -n 1)" = "$target_version" ] \
    || die "JetBrains main did not reach version $target_version."

  (cd "$PARENT_DIR" && npm run --silent verify:version)

  git -C "$PARENT_DIR" add package.json package-lock.json README.md README.en.md jetbrains
  git -C "$PARENT_DIR" commit -m "chore(release): prepare v$target_version"
  parent_sha=$(git -C "$PARENT_DIR" rev-parse HEAD)
  git -C "$PARENT_DIR" push origin HEAD:main
  wait_commit_ci "$PARENT_REPO" "$parent_sha"

  git -C "$PARENT_DIR" fetch origin main
  [ "$(git -C "$PARENT_DIR" rev-parse origin/main)" = "$parent_sha" ] \
    || die "Parent main moved after preparing v$target_version. Rerun the release from the new main state."
  (cd "$PARENT_DIR" && npm run --silent verify:version)
fi

release_sha=$(git -C "$PARENT_DIR" rev-parse HEAD)
[ "$release_sha" = "$parent_sha" ] || die "Release SHA changed unexpectedly before tagging."
git -C "$PARENT_DIR" tag -a "$tag" "$release_sha" -m "Release $tag"
git -C "$PARENT_DIR" push origin "$tag"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$target_version"
    echo "tag=$tag"
    echo "release_sha=$release_sha"
    echo "parent_sha=$parent_sha"
    echo "child_sha=$child_sha"
  } >> "$GITHUB_OUTPUT"
fi

echo "Released $tag -> $release_sha"
echo "JetBrains main: $child_sha"
echo "Parent main: $parent_sha"

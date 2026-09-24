<#
.SYNOPSIS
    One-click release script (PowerShell)

.DESCRIPTION
    Automates:
      1. Read current version and auto-increment
      2. Sync new version to nine places: package.json / package-lock.json /
         jetbrains/gradle.properties / the four README badges
         (README.md / README.en.md + jetbrains/README.md / jetbrains/README.en.md)
      3. Verify version consistency
      4. Commit and push jetbrains submodule
      5. Commit and push parent repo (with README badge and submodule pointer update)
      6. Create and push the v{newVersion} tag (this is what triggers the release pipeline)

    Precondition: both the parent repo and the jetbrains submodule must be on the
    'main' branch; the script refuses to run otherwise (releasing from another
    branch strands the release commit there — hit on v1.12.0).

.PARAMETER Version
    Explicit version number (MAJOR.MINOR.PATCH). If omitted, auto-increments minor.

.PARAMETER Major
    Auto-increment major version (e.g. 0.5.3 -> 1.0.0)

.PARAMETER Minor
    Auto-increment minor version (default, e.g. 0.5.3 -> 0.6.0)

.PARAMETER Patch
    Auto-increment patch version (e.g. 0.5.3 -> 0.5.4)

.PARAMETER DryRun
    Preview mode, no write operations

.EXAMPLE
    .\scripts\release.ps1              # 0.5.3 -> 0.6.0 (minor is the default)
    .\scripts\release.ps1 -Minor       # 0.5.3 -> 0.6.0
    .\scripts\release.ps1 -Patch       # 0.5.3 -> 0.5.4
    .\scripts\release.ps1 -Major       # 0.5.3 -> 1.0.0
    .\scripts\release.ps1 0.8.0        # explicit version
    .\scripts\release.ps1 -DryRun      # preview mode
#>

param(
    [string]$Version,

    [switch]$Major,
    [switch]$Minor,
    [switch]$Patch,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# -- Helpers --
function Invoke-Cmd {
    param(
        [string]$Command,
        [string]$Label,
        [string]$WorkingDir = $Root
    )
    if ($DryRun) {
        Write-Host "  [dry-run] $Label" -ForegroundColor DarkGray
        return ''
    }
    Write-Host "  > $Label" -ForegroundColor Cyan
    $prevLocation = Get-Location
    try {
        Set-Location $WorkingDir
        $output = Invoke-Expression "$Command 2>&1" | Out-String
        return $output.Trim()
    } finally {
        Set-Location $prevLocation
    }
}

function Read-CurrentVersion {
    $pkgPath = Join-Path $Root 'package.json'
    $pkgContent = Get-Content $pkgPath -Raw
    if ($pkgContent -match '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"') {
        return @{ Raw = $Matches[0]; Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Patch = [int]$Matches[3] }
    }
    throw 'package.json: no valid version found'
}

function Bump-Version {
    param([hashtable]$Current, [string]$Level)
    switch ($Level) {
        'major' { return "$($Current.Major + 1).0.0" }
        'minor' { return "$($Current.Major).$($Current.Minor + 1).0" }
        'patch' { return "$($Current.Major).$($Current.Minor).$($Current.Patch + 1)" }
        default { throw "Unknown bump level: $Level" }
    }
}

# -- Calculate version --
$Root = Split-Path $PSScriptRoot -Parent
$JetbrainsDir = Join-Path $Root 'jetbrains'

$current = Read-CurrentVersion
if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Write-Error "Invalid version: $Version`nUsage: .\scripts\release.ps1 [-Major|-Minor|-Patch] [version] [-DryRun]"
        exit 1
    }
    $newVersion = $Version
} else {
    $level = if ($Major) { 'major' } elseif ($Patch) { 'patch' } else { 'minor' }
    $newVersion = Bump-Version -Current $current -Level $level
}

$oldVersion = "$($current.Major).$($current.Minor).$($current.Patch)"

Write-Host ""
Write-Host "Release: $oldVersion -> v$newVersion" -ForegroundColor Green
Write-Host ""

# 1. Check current branch: releases are only allowed on main. These git calls are
#    made directly (not via Invoke-Cmd) on purpose: Invoke-Cmd no-ops in dry-run
#    and would return an empty value, defeating read-only checks.
Write-Host "> Checking current branch..."
$parentBranch = (git -C $Root rev-parse --abbrev-ref HEAD).Trim()
if ($parentBranch -ne 'main') {
    Write-Error "`nParent repo is on branch [$parentBranch]. Releases must run on 'main' (git checkout main). Releasing from another branch lands the release commit there (hit on v1.12.0)."
    exit 1
}
$jetbrainsBranch = (git -C $JetbrainsDir rev-parse --abbrev-ref HEAD).Trim()
if ($jetbrainsBranch -ne 'main') {
    Write-Error "`nJetbrains submodule is on branch [$jetbrainsBranch]. Releases require the submodule to be on 'main'."
    exit 1
}

# 2. Check clean workspaces (direct git calls, same dry-run rationale as step 1)
Write-Host "> Checking workspace status..."
$parentStatus = (git -C $Root status --porcelain | Out-String).Trim()
if ($parentStatus) {
    Write-Error "`nParent repo has uncommitted changes:`n$parentStatus"
    exit 1
}

$jetbrainsStatus = (git -C $JetbrainsDir status --porcelain | Out-String).Trim()
if ($jetbrainsStatus) {
    Write-Error "`nJetbrains submodule has uncommitted changes:`n$jetbrainsStatus"
    exit 1
}

# 3. Sync version
Write-Host "> Syncing version -> $newVersion"
$syncScript = Join-Path $Root 'scripts\release\sync-version.js'
Invoke-Cmd "node `"$syncScript`" $newVersion" 'version:sync'

# 4. Verify version consistency
Write-Host "> Verifying version consistency..."
$verifyScript = Join-Path $Root 'scripts\release\verify-version.js'
Invoke-Cmd "node `"$verifyScript`"" 'verify:version'

# 5. Commit jetbrains submodule
Write-Host "> Committing jetbrains submodule..."
Invoke-Cmd 'git add -A' 'git add (jetbrains)' $JetbrainsDir
$commitMsg = "chore(release): prepare v$newVersion"
Invoke-Cmd "git commit -m `"$commitMsg`"" 'git commit (jetbrains)' $JetbrainsDir
Invoke-Cmd 'git push origin main' 'git push (jetbrains)' $JetbrainsDir

# 6. Commit parent repo (with submodule pointer update)
# README badge files must be added EXPLICITLY one by one: sync-version.js rewrites
# all four README badges, but `git commit` (without -a) only picks up staged files.
# This list used to omit README.en.md, leaving the English badge update stuck in the
# working tree and failing CI's version check (hit on v1.11.0, 2026-09-22).
# When adding a new README, remember to extend this list.
Write-Host "> Committing parent repo..."
Invoke-Cmd 'git add package.json package-lock.json README.md README.en.md jetbrains' 'git add (parent)'
Invoke-Cmd "git commit -m `"$commitMsg`"" 'git commit (parent)'
Invoke-Cmd 'git push origin main' 'git push (parent)'

# 7. Create tag and push
Write-Host "> Creating tag v$newVersion..."
Invoke-Cmd "git tag -a v$newVersion -m `"Release v$newVersion`"" 'git tag'
Invoke-Cmd "git push origin v$newVersion" 'git push tag'

Write-Host ""
Write-Host "Done! $oldVersion -> v$newVersion" -ForegroundColor Green
Write-Host ""

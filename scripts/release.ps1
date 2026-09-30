<#
.SYNOPSIS
    One-click release script (PowerShell)

.DESCRIPTION
    Automates:
      1. Read current version and auto-increment
      2. Stash local tracked/untracked changes in both repositories
      3. Sync new version to seven places: package.json / package-lock.json /
         jetbrains/gradle.properties / the four README badges
         (README.md / README.en.md + jetbrains/README.md / jetbrains/README.en.md)
      4. Verify version consistency
      5. Commit and push jetbrains submodule
      6. Commit and push parent repo (with README badge and submodule pointer update)
      7. Create and push the v{newVersion} tag (this is what triggers the release pipeline)
      8. Restore this run's stashes, including the original staging state

    Local changes are not included in the release. Existing stashes and ignored
    files are left alone. Restoration is attempted even if a release step fails;
    a conflicting stash is kept and its commit ID is reported for recovery.
    Uncommitted work left by a failed release is saved in a separate stash before
    restoring local edits; commits or pushes that already succeeded are not undone.

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
# Exit codes are checked below, including expected nonzero read-only results.
$PSNativeCommandUseErrorActionPreference = $false

# -- Helpers --
function Invoke-Cmd {
    param(
        [string]$Command,
        [string[]]$Arguments,
        [string]$Label,
        [string]$WorkingDir = $Root,
        [switch]$ReadOnly,
        [int[]]$SuccessCodes = @(0)
    )
    if ($DryRun -and -not $ReadOnly) {
        Write-Host "  [dry-run] $Label" -ForegroundColor DarkGray
        return ''
    }
    if ($Label) { Write-Host "  > $Label" -ForegroundColor Cyan }
    $prevLocation = Get-Location
    try {
        Set-Location $WorkingDir
        $output = & $Command @Arguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
        if ($exitCode -notin $SuccessCodes) {
            throw "$Command failed (exit $exitCode): $($output.Trim())"
        }
        return $output.Trim()
    } finally {
        Set-Location $prevLocation
    }
}

function Read-CurrentVersion {
    # Local package.json edits will be stashed; dry-run must use that same baseline.
    $pkgContent = Invoke-Cmd -Command git -Arguments @('show', 'HEAD:package.json') -ReadOnly
    if ($pkgContent -match '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"') {
        return @{ Raw = $Matches[0]; Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Patch = [int]$Matches[3] }
    }
    throw 'package.json: no valid version found'
}

function Get-WorkspaceStatus {
    param([string]$Directory, [switch]$IgnoreSubmodules)
    $ignore = if ($IgnoreSubmodules) { 'all' } else { 'dirty' }
    Invoke-Cmd -Command git -Arguments @('status', '--porcelain', '--untracked-files=all', "--ignore-submodules=$ignore") -WorkingDir $Directory -ReadOnly
}

function Get-StashHead {
    param([string]$Directory)
    Invoke-Cmd -Command git -Arguments @('rev-parse', '--verify', '--quiet', 'refs/stash') -WorkingDir $Directory -ReadOnly -SuccessCodes @(0, 1)
}

function Save-ReleaseChanges {
    param([string]$Directory, [string]$Name, [switch]$Retain)
    if (-not (Get-WorkspaceStatus $Directory)) { return }
    if ($DryRun) {
        Write-Host "  [dry-run] Stash tracked/untracked changes ($Name); restore after release" -ForegroundColor DarkGray
        return
    }
    $previous = Get-StashHead $Directory
    Invoke-Cmd -Command git -Arguments @('stash', 'push', '--include-untracked', '--message', "ok-script release v$newVersion $stashRunId ($Name)") -Label "Stash local changes ($Name)" -WorkingDir $Directory | Out-Null
    $stashId = Get-StashHead $Directory
    if ($stashId -and $stashId -ne $previous) {
        if (-not $Retain) {
            $savedStashes.Add(@{ Directory = $Directory; Name = $Name; Id = $stashId })
        }
        Write-Host "  Saved $Name changes: $stashId" -ForegroundColor DarkGray
    }
}

function Restore-ReleaseChanges {
    param([hashtable]$Saved)
    # Apply by immutable ID; never pop the user's latest stash by position.
    Invoke-Cmd -Command git -Arguments @('stash', 'apply', '--index', $Saved.Id) -Label "Restore local changes ($($Saved.Name))" -WorkingDir $Saved.Directory | Out-Null
    $entries = Invoke-Cmd -Command git -Arguments @('stash', 'list', '--format=%H%x09%gd') -WorkingDir $Saved.Directory -ReadOnly
    $entry = $entries -split '\r?\n' | Where-Object { $_.StartsWith($Saved.Id + "`t") } | Select-Object -First 1
    if ($entry) {
        $selector = ($entry -split "`t", 2)[1]
        Invoke-Cmd -Command git -Arguments @('stash', 'drop', $selector) -Label "Remove restored release stash ($($Saved.Name))" -WorkingDir $Saved.Directory | Out-Null
    }
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

# 1. Check current branch even during dry-run: releases are only allowed on main.
Write-Host "> Checking current branch..."
$parentBranch = Invoke-Cmd -Command git -Arguments @('rev-parse', '--abbrev-ref', 'HEAD') -ReadOnly
if ($parentBranch -ne 'main') {
    Write-Error "`nParent repo is on branch [$parentBranch]. Releases must run on 'main' (git checkout main). Releasing from another branch lands the release commit there (hit on v1.12.0)."
    exit 1
}
$jetbrainsBranch = Invoke-Cmd -Command git -Arguments @('rev-parse', '--abbrev-ref', 'HEAD') -WorkingDir $JetbrainsDir -ReadOnly
if ($jetbrainsBranch -ne 'main') {
    Write-Error "`nJetbrains submodule is on branch [$jetbrainsBranch]. Releases require the submodule to be on 'main'."
    exit 1
}

$savedStashes = [System.Collections.Generic.List[hashtable]]::new()
$stashRunId = [guid]::NewGuid().ToString('N')
$releaseFailure = $null
$releaseStarted = $false
$restoreFailures = [System.Collections.Generic.List[string]]::new()
try {
    Write-Host "> Stashing local changes..."
    # Git does not stash submodule contents; save the child before the parent.
    Save-ReleaseChanges $JetbrainsDir 'jetbrains'
    Save-ReleaseChanges $Root 'parent'
    if (-not $DryRun) {
        # A checked-out child commit can differ from the parent's gitlink; the
        # release will update that pointer after committing the child version.
        if ((Get-WorkspaceStatus $Root -IgnoreSubmodules) -or (Get-WorkspaceStatus $JetbrainsDir)) {
            throw 'Workspace is still dirty after stashing; release stopped.'
        }
    }

    $releaseStarted = $true
    Write-Host "> Syncing version -> $newVersion"
    $syncScript = Join-Path $Root 'scripts\release\sync-version.js'
    Invoke-Cmd -Command node -Arguments @($syncScript, $newVersion) -Label 'version:sync'

    Write-Host "> Verifying version consistency..."
    $verifyScript = Join-Path $Root 'scripts\release\verify-version.js'
    Invoke-Cmd -Command node -Arguments @($verifyScript) -Label 'verify:version'

    Write-Host "> Committing jetbrains submodule..."
    Invoke-Cmd -Command git -Arguments @('add', '-A') -Label 'git add (jetbrains)' -WorkingDir $JetbrainsDir
    $commitMsg = "chore(release): prepare v$newVersion"
    Invoke-Cmd -Command git -Arguments @('commit', '-m', $commitMsg) -Label 'git commit (jetbrains)' -WorkingDir $JetbrainsDir
    Invoke-Cmd -Command git -Arguments @('push', 'origin', 'main') -Label 'git push (jetbrains)' -WorkingDir $JetbrainsDir

    # All four README badges must be committed; the parent also pins the new child.
    Write-Host "> Committing parent repo..."
    Invoke-Cmd -Command git -Arguments @('add', 'package.json', 'package-lock.json', 'README.md', 'README.en.md', 'jetbrains') -Label 'git add (parent)'
    Invoke-Cmd -Command git -Arguments @('commit', '-m', $commitMsg) -Label 'git commit (parent)'
    Invoke-Cmd -Command git -Arguments @('push', 'origin', 'main') -Label 'git push (parent)'

    Write-Host "> Creating tag v$newVersion..."
    Invoke-Cmd -Command git -Arguments @('tag', '-a', "v$newVersion", '-m', "Release v$newVersion") -Label 'git tag'
    Invoke-Cmd -Command git -Arguments @('push', 'origin', "v$newVersion") -Label 'git push tag'
} catch {
    $releaseFailure = $_.Exception.Message
    # In particular, a failed commit leaves version files staged. Save that work
    # separately so it cannot prevent restoration of the user's original index.
    if ($releaseStarted) {
        foreach ($pending in @(
            @{ Directory = $JetbrainsDir; Name = 'unfinished release - jetbrains' },
            @{ Directory = $Root; Name = 'unfinished release - parent' }
        )) {
            try {
                Save-ReleaseChanges $pending.Directory $pending.Name -Retain
            } catch {
                Write-Warning "Could not stash unfinished release work ($($pending.Name)): $($_.Exception.Message)"
            }
        }
    }
} finally {
    # Attempt every restoration even if another repository has a conflict.
    for ($i = $savedStashes.Count - 1; $i -ge 0; $i--) {
        $saved = $savedStashes[$i]
        try {
            Restore-ReleaseChanges $saved
        } catch {
            $message = "Could not finish restoring $($saved.Name) changes: $($_.Exception.Message). Saved changes remain at stash $($saved.Id) in $($saved.Directory). Inspect git status and git stash show before recovering."
            $restoreFailures.Add($message)
            Write-Warning $message
        }
    }
}

if ($releaseFailure -or $restoreFailures.Count) {
    if ($releaseFailure) { Write-Error "Release failed: $releaseFailure" -ErrorAction Continue }
    if ($restoreFailures.Count) {
        if (-not $releaseFailure) { Write-Host "Release v$newVersion was pushed; only local-change restoration needs attention." -ForegroundColor Yellow }
        Write-Error 'Local changes need manual recovery from the retained stash(es).' -ErrorAction Continue
    }
    exit 1
}

Write-Host ""
Write-Host "Done! $oldVersion -> v$newVersion" -ForegroundColor Green
Write-Host ""

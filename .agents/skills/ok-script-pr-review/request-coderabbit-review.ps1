param(
    [Parameter(Mandatory = $true)][ValidateSet('AliceJump/ok-script-toolkit', 'AliceJump/ok-script-toolkit-jetbrains')][string]$Repo,
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$PrNumber,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedHead,
    [ValidateRange(0, 3600)][int]$AutoWaitSeconds = 120,
    [ValidateRange(5, 120)][int]$PollSeconds = 15,
    [ValidateRange(30, 1800)][int]$QuotaReplyTimeoutSeconds = 180,
    [ValidateRange(0, 86400)][int]$MaxQuotaWaitSeconds = 3600,
    [switch]$NoTrigger
)

# Send one review command only after a fresh, positive quota response for this head.
# -NoTrigger still posts a quota query, but does not post the review command.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:CR_LOGIN = 'coderabbitai[bot]'
$env:CR_BOT = 'Bot'
. (Join-Path $PSScriptRoot 'coderabbit-review-helpers.ps1')

function Invoke-GhChecked {
    param([string[]]$GhArgs)
    $output = gh @GhArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($GhArgs -join ' ') failed: $output" }
    return ($output | Out-String).Trim()
}

function Get-PrState {
    $line = Invoke-GhChecked -GhArgs @('api', "repos/$Repo/pulls/$PrNumber", '--jq', '[.head.sha, .state, .draft] | @tsv')
    $parts = ([string]$line).Trim() -split "`t"
    if ($parts.Count -ne 3) { throw "Cannot parse PR state: $line" }
    return [pscustomobject]@{ head = $parts[0]; state = $parts[1]; draft = $parts[2] }
}

function Assert-TargetHead {
    $pr = Get-PrState
    if ($pr.head -ne $ExpectedHead) { throw "PR head changed: expected $ExpectedHead, actual $($pr.head)" }
    if ($pr.state -ne 'open' -or $pr.draft -ne 'false') { throw 'PR is closed or draft; review trigger stopped' }
}

function Get-BotReviews {
    $out = Invoke-GhChecked -GhArgs @('api', '--paginate', "repos/$Repo/pulls/$PrNumber/reviews", '--jq',
        '.[] | select(.user.login == $ENV.CR_LOGIN and .user.type == $ENV.CR_BOT) | [.commit_id, .state] | @tsv')
    $items = @()
    foreach ($line in ($out -split "`n")) {
        if (-not $line) { continue }
        $fields = $line.Trim() -split "`t"
        if ($fields.Count -ge 2) { $items += [pscustomobject]@{ commit_id = $fields[0]; state = $fields[1] } }
    }
    return $items
}

function Get-BotStatus {
    $out = Invoke-GhChecked -GhArgs @('api', "repos/$Repo/commits/$ExpectedHead/status", '--jq',
        '[.statuses[] | select(.context == $ENV.CR_CONTEXT)] | sort_by(.created_at) | reverse | .[0] | if . then [.state, .description] | @tsv else empty end')
    if (-not $out) { return $null }
    $fields = ([string]$out).Trim() -split "`t", 2
    return [pscustomobject]@{ sha = $ExpectedHead; state = $fields[0]; description = $(if ($fields.Count -gt 1) { $fields[1] } else { '' }) }
}

function Get-PrComments {
    param([ValidateSet('issues', 'pulls')][string]$Kind = 'issues')
    $out = Invoke-GhChecked -GhArgs @('api', '--paginate', "repos/$Repo/$Kind/$PrNumber/comments", '--jq',
        '.[] | [.id, .user.login, .user.type, .created_at, (.body | @base64)] | @tsv')
    $items = @()
    foreach ($line in ($out -split "`n")) {
        if (-not $line) { continue }
        $fields = $line.Trim() -split "`t", 5
        if ($fields.Count -ne 5) { throw 'Cannot parse PR comment' }
        $items += [pscustomobject]@{
            id = [long]$fields[0]; kind = $Kind; login = $fields[1]; type = $fields[2]
            created = [datetimeoffset]::Parse($fields[3]); body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($fields[4]))
        }
    }
    return $items
}

function Get-HeadCommitTime {
    $value = Invoke-GhChecked -GhArgs @('api', "repos/$Repo/commits/$ExpectedHead", '--jq', '.commit.committer.date')
    return [datetimeoffset]::Parse(([string]$value).Trim())
}

function Test-AlreadyRequested {
    param([object[]]$Comments, [datetimeoffset]$HeadTime)
    return @($Comments | Where-Object {
        $_.type -ne 'Bot' -and $_.created -ge $HeadTime -and
        $_.body.Trim() -in @('@coderabbitai review', '@coderabbitai full review')
    }).Count -gt 0
}

function Get-FreshQuotaReply {
    param([long]$ProbeId, [datetimeoffset]$ProbeTime)
    $comments = @(Get-PrComments -Kind issues) + @(Get-PrComments -Kind pulls)
    $replies = @($comments | Where-Object {
        $_.created -ge $ProbeTime -and
        (($_.kind -eq 'issues' -and $_.id -gt $ProbeId) -or $_.kind -eq 'pulls') -and
        $_.login -eq 'coderabbitai[bot]' -and $_.type -eq 'Bot'
    } | Sort-Object created -Descending)
    foreach ($reply in $replies) {
        $quota = Get-CodeRabbitQuotaState -Body $reply.body
        if ($quota -ne 'unknown') { return [pscustomobject]@{ quota = $quota; body = $reply.body; id = $reply.id } }
    }
    return $null
}

function Send-QuotaProbe {
    $line = Invoke-GhChecked -GhArgs @('api', "repos/$Repo/issues/$PrNumber/comments", '-f', 'body=@coderabbitai rate limit',
        '--jq', '[.id, .created_at] | @tsv')
    $fields = ([string]$line).Trim() -split "`t"
    if ($fields.Count -ne 2) { throw 'Cannot parse quota probe response' }
    return [pscustomobject]@{ id = [long]$fields[0]; created = [datetimeoffset]::Parse($fields[1]) }
}

function Wait-QuotaReply {
    param([object]$Probe)
    $deadline = [datetimeoffset]::UtcNow.AddSeconds($QuotaReplyTimeoutSeconds)
    while ([datetimeoffset]::UtcNow -lt $deadline) {
        Assert-TargetHead
        $reply = Get-FreshQuotaReply -ProbeId $Probe.id -ProbeTime $Probe.created
        if ($reply) { return $reply }
        Start-Sleep -Seconds $PollSeconds
    }
    return $null
}

try {
    $env:CR_CONTEXT = 'CodeRabbit'
    Assert-TargetHead
    $headTime = Get-HeadCommitTime
    $autoDeadline = [datetimeoffset]::UtcNow.AddSeconds($AutoWaitSeconds)
    $manualRequired = $false
    do {
        Assert-TargetHead
        $reviews = @(Get-BotReviews)
        $status = Get-BotStatus
        if (Test-CodeRabbitReviewDone -Head $ExpectedHead -Reviews $reviews -Status $status) {
            Write-Host 'CodeRabbit has reviewed this head; no trigger sent.'
            exit 0
        }
        if ($status -and $status.description -match '(?i)review skipped:.*manual review required|review rate limited') {
            $manualRequired = $true
            break
        }
        if ($status -and $status.description -match '(?i)review skipped:.*draft pull request') {
            throw 'CodeRabbit skipped draft PR; review trigger stopped'
        }
        if ([datetimeoffset]::UtcNow -ge $autoDeadline) { break }
        Start-Sleep -Seconds $PollSeconds
    } while ($true)
    if (-not $manualRequired) { throw 'No explicit manual-review-required or rate-limited status; automatic review may still be running' }

    $comments = @(Get-PrComments -Kind issues)
    if (Test-AlreadyRequested -Comments $comments -HeadTime $headTime) {
        throw 'A review command already exists after the head commit; stopping to avoid a duplicate'
    }

    $quotaDeadline = [datetimeoffset]::UtcNow.AddSeconds($MaxQuotaWaitSeconds)
    do {
        Assert-TargetHead
        Write-Host 'Querying CodeRabbit review quota...'
        $probe = Send-QuotaProbe
        $reply = Wait-QuotaReply -Probe $probe
        if (-not $reply) { throw 'No fresh, unambiguous CodeRabbit quota reply; review not triggered' }
        if ($reply.quota -eq 'available') { break }
        if ([datetimeoffset]::UtcNow -ge $quotaDeadline) { throw 'CodeRabbit review quota remains unavailable' }
        Write-Host 'Quota unavailable; waiting before a new query.'
        $remaining = [Math]::Max(0, ($quotaDeadline - [datetimeoffset]::UtcNow).TotalSeconds)
        $retrySeconds = Get-CodeRabbitQuotaRetrySeconds -Body $reply.body
        Start-Sleep -Seconds ([int][Math]::Min($retrySeconds, $remaining))
    } while ($true)

    Assert-TargetHead
    $reviews = @(Get-BotReviews)
    $status = Get-BotStatus
    if (Test-CodeRabbitReviewDone -Head $ExpectedHead -Reviews $reviews -Status $status) {
        Write-Host 'CodeRabbit reviewed the head during the quota query; no trigger sent.'
        exit 0
    }
    if (-not $status -or $status.description -notmatch '(?i)review skipped:.*manual review required|review rate limited') {
        throw 'Review state changed during quota query; review not triggered'
    }
    $comments = @(Get-PrComments -Kind issues)
    if (Test-AlreadyRequested -Comments $comments -HeadTime $headTime) {
        throw 'A review command already exists; review not triggered'
    }
    if ($NoTrigger) {
        Write-Host 'Fresh quota response confirms availability; -NoTrigger prevented review command.'
        exit 0
    }
    Invoke-GhChecked -GhArgs @('api', "repos/$Repo/issues/$PrNumber/comments", '-f', 'body=@coderabbitai review', '--jq', '.html_url') | Write-Host
    Write-Host "Sent one review command for $Repo PR #$PrNumber at $ExpectedHead."
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}

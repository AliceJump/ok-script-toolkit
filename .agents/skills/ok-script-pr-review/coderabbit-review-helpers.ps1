# Pure CodeRabbit state helpers shared by wait-coderabbit.ps1 and wait-coderabbit-rate-limit.ps1.
# Nothing here calls gh. Every body, login and status text is untrusted GitHub data.

$script:CodeRabbitExitCodes = @{
    REVIEWED = 0; AVAILABLE = 0
    ERROR = 2; DRAFT = 3; CLOSED = 4; SKIPPED = 5; REVIEW_FAILED = 5
    TIMEOUT = 6; UNCONFIRMED = 6; NO_SIGNAL = 6
    RATE_LIMITED = 7; UNAVAILABLE = 7; TRIGGER_RATE_LIMITED = 7
    TRIGGER_EXHAUSTED = 8; TRIGGER_REQUIRED = 9; HEAD_CHANGED = 11
    NO_REPLY = 12; UNKNOWN_REPLY = 12
}

function Get-CrNow {
    if ($global:CodeRabbitFakeClock) { return $global:CodeRabbitFakeClock.Now }
    return [datetimeoffset]::UtcNow
}

function Wait-CrSeconds {
    param([double]$Seconds)
    if ($Seconds -le 0) { return }
    if ($global:CodeRabbitFakeClock) {
        $global:CodeRabbitFakeClock.Now = $global:CodeRabbitFakeClock.Now.AddSeconds($Seconds)
        return
    }
    Start-Sleep -Milliseconds ([int][Math]::Ceiling($Seconds * 1000))
}

function ConvertTo-CrTime {
    param([object]$Value)
    if ($null -eq $Value -or "$Value" -eq '') { return $null }
    if ($Value -is [datetimeoffset]) { return $Value }
    if ($Value -is [datetime]) {
        # PowerShell 7 ConvertFrom-Json already turned the ISO string into a DateTime.
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) { $Value = [datetime]::SpecifyKind($Value, [DateTimeKind]::Utc) }
        return [datetimeoffset]$Value
    }
    return [datetimeoffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture)
}

# REST reports the bot as "coderabbitai[bot]"/"Bot"; GraphQL reports "coderabbitai" with __typename "Bot".
function Test-CodeRabbitAuthor {
    param([string]$Login, [string]$Type)
    return ($Login -eq 'coderabbitai[bot]' -or $Login -eq 'coderabbitai') -and $Type -eq 'Bot'
}

function Test-CodeRabbitReviewCommand {
    param([AllowEmptyString()][string]$Body)
    return ([string]$Body).Trim() -match '^(?i)@coderabbitai\s+(?:full\s+)?review$'
}

function Get-CrPlainText {
    param([AllowEmptyString()][string]$Body)
    return (([string]$Body) -replace '(?s)<!--.*?-->', ' ' -replace '[*_`]', '' -replace '\s+', ' ').Trim()
}

# Seconds until CodeRabbit says to look again. This is only a recheck time, never proof of quota.
function Get-CodeRabbitRetrySeconds {
    param([AllowEmptyString()][string]$Body)
    $text = Get-CrPlainText $Body
    $unit = '(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)'
    $match = [regex]::Match($text, "(?i)(?:available in|wait|try again in|retry in)\s+((?:\d+(?:\.\d+)?\s*$unit(?:\s*(?:,|and)\s*)?)+)")
    if (-not $match.Success) { return $null }
    $total = 0.0
    foreach ($part in [regex]::Matches($match.Groups[1].Value, "(?i)(\d+(?:\.\d+)?)\s*($unit)")) {
        $value = [double]::Parse($part.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
        switch -Regex ($part.Groups[2].Value) {
            '^(?i)h' { $total += $value * 3600 }
            '^(?i)m' { $total += $value * 60 }
            default { $total += $value }
        }
    }
    return [int][Math]::Ceiling($total)
}

# available | unavailable | unknown. Negative forms are checked before any positive phrase.
function Get-CodeRabbitQuotaState {
    param([AllowEmptyString()][string]$Body)
    $text = Get-CrPlainText $Body
    if ($text -match '(?i)\b(?:no|zero|0)\s+(?:more\s+)?(?:included\s+|pr\s+)?reviews?\s+(?:are\s+|is\s+)?(?:currently\s+)?(?:available|remaining|left)\b' -or
        $text -match '(?i)\breviews?\s+(?:are|is)\s+(?:not|n''t)\s+(?:currently\s+)?available\b' -or
        $text -match '(?i)\breviews?\s+aren''t\s+available\b') {
        return 'unavailable'
    }
    if ($text -match '(?i)\breviews?\s+(?:are|is)\s+available now\b') {
        return 'available'
    }
    if ($null -ne (Get-CodeRabbitRetrySeconds $text)) { return 'unavailable' }
    if ($text -match '(?i)\brate limit(?:ed| exceeded| reached)\b|\breview rate limited\b') { return 'unavailable' }
    $count = [regex]::Match($text, '(?i)\b(\d+)\s+(?:included\s+|pr\s+)?reviews?\s+(?:are\s+)?(?:remaining|left)\b')
    if (-not $count.Success) { $count = [regex]::Match($text, '(?i)\b(?:remaining|available)\s+(?:included\s+|pr\s+)?reviews?\s*[:=]\s*(\d+)\b') }
    if ($count.Success) {
        if ([int]$count.Groups[1].Value -gt 0) { return 'available' }
        return 'unavailable'
    }
    return 'unknown'
}

# A review record proves coverage only when it is CodeRabbit's review summary for exactly this head.
# Thread replies also create review records on the current head, but with an empty body.
function Test-CodeRabbitReviewCoversHead {
    param([object]$Review, [string]$Head)
    if (-not (Test-CodeRabbitAuthor $Review.login $Review.type)) { return $false }
    if ([string]$Review.commit_id -ne $Head) { return $false }
    if ($Review.state -notin @('COMMENTED', 'APPROVED', 'CHANGES_REQUESTED')) { return $false }
    $body = [string]$Review.body
    if ($body -notmatch 'auto-generated comment by CodeRabbit for review status|Actionable comments posted:\s*\d+') { return $false }
    $ranges = [regex]::Matches($body, '(?i)between\s+([0-9a-f]{40})\s+and\s+([0-9a-f]{40})')
    if ($ranges.Count -gt 0 -and $ranges[$ranges.Count - 1].Groups[2].Value -ne $Head) { return $false }
    return $true
}

# CodeRabbit's walkthrough summary records which commit its latest review covered.
function Get-CodeRabbitSummaryCoverage {
    param([object[]]$Comments, [string]$Head)
    foreach ($comment in @($Comments)) {
        if (-not (Test-CodeRabbitAuthor $comment.login $comment.type)) { continue }
        foreach ($match in [regex]::Matches([string]$comment.body, '<!--\s*final_review_risk_coverage:(\{[^>]*?\})\s*-->')) {
            try { $coverage = $match.Groups[1].Value | ConvertFrom-Json } catch { continue }
            if ($coverage.coveredCommitId -eq $Head -and $coverage.kind -eq 'reviewed') { return $comment }
        }
    }
    return $null
}

function Get-CodeRabbitLatestStatus {
    param([object[]]$Statuses)
    $own = @($Statuses | Where-Object { $_.context -eq 'CodeRabbit' -and (Test-CodeRabbitAuthor $_.login $_.type) })
    if ($own.Count -eq 0) { return $null }
    return @($own | Sort-Object @{ Expression = { $_.created } }, @{ Expression = { [long]$_.id } })[-1]
}

# Earliest moment the head is known to exist on GitHub; triggers before it belong to an older head.
function Get-CodeRabbitHeadArrival {
    param([object[]]$ObservedTimes, [object]$CommitTime)
    $times = @($ObservedTimes | Where-Object { $null -ne $_ } | Sort-Object)
    if ($times.Count -gt 0) { return $times[0] }
    return $CommitTime
}

function New-CrState {
    param([string]$State, [string]$Evidence = '', [string]$Detail = '', [object]$Since = $null)
    return [pscustomobject]@{ state = $State; evidence = $Evidence; detail = $Detail; since = $Since }
}

<#
Snapshot fields: head, prState, draft, statuses, reviews, comments, headArrivedAt, ledger.
Comments/reviews/statuses carry login, type, created (datetimeoffset) and body/description.
The result is one state of the per-head machine; callers decide how long each waiting state may last.
#>
function Get-CodeRabbitHeadState {
    param([object]$Snapshot)
    $head = [string]$Snapshot.head
    if ($Snapshot.prState -ne 'open') { return New-CrState 'CLOSED' -Detail "PR state is $($Snapshot.prState)" }
    if ($Snapshot.draft) { return New-CrState 'DRAFT' -Detail 'PR is a draft; do not un-draft it to get a review' }

    $latest = Get-CodeRabbitLatestStatus $Snapshot.statuses
    $description = if ($latest) { [string]$latest.description } else { '' }
    if ($latest -and $latest.state -eq 'pending') {
        return New-CrState 'IN_PROGRESS' -Evidence "status:$($latest.id)" -Detail $description -Since $latest.created
    }

    $covering = @($Snapshot.reviews | Where-Object { Test-CodeRabbitReviewCoversHead $_ $head } | Sort-Object { $_.created })
    if ($covering.Count -gt 0) {
        return New-CrState 'REVIEWED' -Evidence "review:$($covering[-1].id)" -Since $covering[-1].created
    }
    $completed = $latest -and $latest.state -eq 'success' -and $description -match '(?i)review (?:completed|finished)'
    if ($completed) {
        $summary = Get-CodeRabbitSummaryCoverage $Snapshot.comments $head
        if ($summary) { return New-CrState 'REVIEWED' -Evidence "summary:$($summary.id)" -Since $latest.created }
    }

    $arrival = $Snapshot.headArrivedAt
    $triggers = @($Snapshot.comments | Where-Object {
        -not (Test-CodeRabbitAuthor $_.login $_.type) -and (Test-CodeRabbitReviewCommand $_.body) -and
        ($null -eq $arrival -or $_.created -ge $arrival)
    } | Sort-Object { $_.created })
    $triggerTime = $null
    $triggerEvidence = ''
    if ($triggers.Count -gt 0) { $triggerTime = $triggers[0].created; $triggerEvidence = "comment:$($triggers[0].id)" }
    if ($Snapshot.ledger -and $Snapshot.ledger.head -eq $head) {
        $ledgerTime = ConvertTo-CrTime $Snapshot.ledger.recordedAt
        if ($null -eq $triggerTime -or ($ledgerTime -and $ledgerTime -lt $triggerTime)) {
            $triggerTime = $ledgerTime
            $triggerEvidence = "ledger:$($Snapshot.ledger.path)"
        }
    }
    if ($null -ne $triggerTime) {
        # Same-second timestamps are ambiguous; treating them as "limited after the trigger" never re-triggers.
        if ($latest -and $latest.created -ge $triggerTime -and $description -match '(?i)rate limit') {
            return New-CrState 'TRIGGER_RATE_LIMITED' -Evidence "status:$($latest.id)" -Detail $description -Since $triggerTime
        }
        $acks = @($Snapshot.comments | Where-Object {
            (Test-CodeRabbitAuthor $_.login $_.type) -and $_.created -ge $triggerTime -and
            [string]$_.body -match 'CodeRabbit review command invocation|Action performed'
        })
        foreach ($ack in $acks) {
            if ((Get-CodeRabbitQuotaState $ack.body) -eq 'unavailable') {
                return New-CrState 'TRIGGER_RATE_LIMITED' -Evidence "comment:$($ack.id)" -Detail (Get-CrPlainText $ack.body) -Since $triggerTime
            }
        }
        if ($completed -and $latest.created -gt $triggerTime) {
            return New-CrState 'COMPLETED_UNCONFIRMED' -Evidence "status:$($latest.id)" -Detail 'triggered review finished but no review record or summary covers this head' -Since $latest.created
        }
        $detail = if ($acks.Count -gt 0) { Get-CrPlainText $acks[-1].body } else { 'waiting for CodeRabbit to acknowledge' }
        return New-CrState 'TRIGGERED' -Evidence $triggerEvidence -Detail $detail -Since $triggerTime
    }

    if (-not $latest) { return New-CrState 'AWAITING_AUTO' -Detail 'no CodeRabbit status on this head yet' }
    if ($description -match '(?i)rate limit') { return New-CrState 'RATE_LIMITED' -Evidence "status:$($latest.id)" -Detail $description -Since $latest.created }
    if ($description -match '(?i)review skipped') {
        if ($description -match '(?i)manual review required') {
            return New-CrState 'MANUAL_REQUIRED' -Evidence "status:$($latest.id)" -Detail $description -Since $latest.created
        }
        if ($description -match '(?i)draft') { return New-CrState 'DRAFT' -Evidence "status:$($latest.id)" -Detail $description }
        return New-CrState 'SKIPPED' -Evidence "status:$($latest.id)" -Detail $description -Since $latest.created
    }
    if ($completed) {
        return New-CrState 'COMPLETED_UNCONFIRMED' -Evidence "status:$($latest.id)" -Detail 'status says completed but no review record or summary covers this head' -Since $latest.created
    }
    if ($latest.state -in @('error', 'failure')) {
        return New-CrState 'REVIEW_FAILED' -Evidence "status:$($latest.id)" -Detail $description -Since $latest.created
    }
    return New-CrState 'AWAITING_AUTO' -Evidence "status:$($latest.id)" -Detail "unrecognized status: $($latest.state) $description" -Since $latest.created
}

function Get-CrLedgerPath {
    param([string]$StateDir, [string]$Repo, [int]$PrNumber, [string]$Head)
    $name = ('{0}_pr{1}_{2}.json' -f ($Repo -replace '[^A-Za-z0-9_.-]', '_'), $PrNumber, $Head.ToLowerInvariant())
    return Join-Path $StateDir $name
}

function ConvertTo-CrResultJson {
    param([hashtable]$Result)
    return ($Result | ConvertTo-Json -Compress -Depth 5)
}

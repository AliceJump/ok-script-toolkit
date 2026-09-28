$ErrorActionPreference = 'Stop'
$folder = $PSScriptRoot
foreach ($name in @('coderabbit-review-helpers.ps1', 'coderabbit-github.ps1', 'wait-coderabbit.ps1',
        'wait-coderabbit-rate-limit.ps1', 'get-coderabbit-review-data.ps1', 'test-coderabbit-wait-mock.ps1')) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $folder $name), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw "$name did not parse: $($errors[0])" }
}
. (Join-Path $folder 'coderabbit-review-helpers.ps1')

$script:assertions = 0
function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    $script:assertions++
    if ($Actual -ne $Expected) { throw "$Message -> got '$Actual', expected '$Expected'" }
}

# ---- quota replies: a countdown is unavailable; only an explicit positive reply is available ----
$plan = '<!-- This is an auto-generated reply by CodeRabbit -->' + "`n" +
    'Your [plan](https://docs.coderabbit.ai/management/plans#fair-usage-limits-policy) includes PR reviews subject to [rate limits](https://docs.coderabbit.ai/management/plans#rate-limits).'
$quotaCases = @(
    @{ Body = "$plan More reviews will be available in 1 minute."; Want = 'unavailable'; Retry = 60 },
    @{ Body = "$plan More reviews will be available in 3 minutes."; Want = 'unavailable'; Retry = 180 },
    @{ Body = "$plan Reviews are available now."; Want = 'available'; Retry = $null },
    @{ Body = 'No reviews are available now.'; Want = 'unavailable'; Retry = $null },
    @{ Body = 'Reviews are not available now.'; Want = 'unavailable'; Retry = $null },
    @{ Body = 'You have 2 PR reviews remaining.'; Want = 'available'; Retry = $null },
    @{ Body = 'Remaining PR reviews: 1'; Want = 'available'; Retry = $null },
    @{ Body = '0 reviews remaining. Next included review available in 1.2 minutes.'; Want = 'unavailable'; Retry = 72 },
    @{ Body = 'Please wait **12 minutes and 34 seconds** before requesting another review.'; Want = 'unavailable'; Retry = 754 },
    @{ Body = 'More reviews will be available in 1 hour.'; Want = 'unavailable'; Retry = 3600 },
    @{ Body = 'Review rate limited'; Want = 'unavailable'; Retry = $null },
    @{ Body = $plan; Want = 'unknown'; Retry = $null },
    @{ Body = 'The current review has 2 comments.'; Want = 'unknown'; Retry = $null },
    @{ Body = 'Reviews remaining: maybe later.'; Want = 'unknown'; Retry = $null }
)
foreach ($case in $quotaCases) {
    Assert-Equal (Get-CodeRabbitQuotaState $case.Body) $case.Want "quota state of '$($case.Body)'"
    Assert-Equal (Get-CodeRabbitRetrySeconds $case.Body) $case.Retry "retry seconds of '$($case.Body)'"
}

# ---- review commands must be the whole comment ----
foreach ($pair in @(
        @('@coderabbitai review', $true), @('  @CodeRabbitAI  full review ', $true), @('@coderabbitai review please', $false),
        @('@coderabbitai rate limit', $false), @('please @coderabbitai review', $false), @("@coderabbitai full review`n", $true))) {
    Assert-Equal (Test-CodeRabbitReviewCommand $pair[0]) $pair[1] "review command '$($pair[0])'"
}

# ---- fixtures ----
$head = 'a' * 40
$older = 'b' * 40
$t0 = [datetimeoffset]'2026-01-01T00:00:00Z'
function At([int]$Seconds) { return $t0.AddSeconds($Seconds) }
function Status([long]$Id, [string]$State, [string]$Description, [int]$At, [string]$Login = 'coderabbitai[bot]', [string]$Type = 'Bot') {
    [pscustomobject]@{ id = $Id; context = 'CodeRabbit'; state = $State; description = $Description; login = $Login; type = $Type; created = (At $At) }
}
function Review([long]$Id, [string]$Commit, [string]$Body, [int]$At, [string]$State = 'COMMENTED', [string]$Type = 'Bot') {
    [pscustomobject]@{ id = $Id; login = 'coderabbitai[bot]'; type = $Type; commit_id = $Commit; state = $State; body = $Body; created = (At $At) }
}
function Comment([long]$Id, [string]$Body, [int]$At, [string]$Login = 'alice', [string]$Type = 'User') {
    [pscustomobject]@{ id = $Id; login = $Login; type = $Type; body = $Body; created = (At $At); updated = (At $At) }
}
$marker = '<!-- This is an auto-generated comment by CodeRabbit for review status -->'
$summaryBody = "**Actionable comments posted: 2**`nReviewing files that changed from the base of the PR and between $older and $head.`n$marker"
$outsideOnlyBody = "> Outside diff range comments (1)`nReviewing files that changed from the base of the PR and between $older and $head.`n$marker"
function Snap([object[]]$Statuses = @(), [object[]]$Reviews = @(), [object[]]$Comments = @(), [object]$Ledger = $null,
    [string]$State = 'open', [bool]$Draft = $false, [int]$Arrival = 0) {
    [pscustomobject]@{ head = $head; prState = $State; draft = $Draft; statuses = $Statuses; reviews = $Reviews; comments = $Comments
        headArrivedAt = (At $Arrival); ledger = $Ledger }
}
function Assert-State([object]$Snapshot, [string]$Want, [string]$Message, [string]$Evidence = '') {
    $actual = Get-CodeRabbitHeadState $Snapshot
    Assert-Equal $actual.state $Want $Message
    if ($Evidence) { Assert-Equal $actual.evidence $Evidence "$Message (evidence)" }
}

# ---- coverage proof ----
Assert-Equal (Test-CodeRabbitReviewCoversHead (Review 1 $head $summaryBody 10) $head) $true 'summary review covers head'
Assert-Equal (Test-CodeRabbitReviewCoversHead (Review 1 $head $outsideOnlyBody 10) $head) $true 'outside-diff-only summary covers head'
Assert-Equal (Test-CodeRabbitReviewCoversHead (Review 1 $head '' 10) $head) $false 'thread-reply review with empty body is not a review of the head'
Assert-Equal (Test-CodeRabbitReviewCoversHead (Review 1 $older $summaryBody 10) $head) $false 'review of an older commit'
Assert-Equal (Test-CodeRabbitReviewCoversHead (Review 1 $head ($summaryBody -replace "and $head", "and $older") 10) $head) $false 'reviewed range ending elsewhere'
Assert-Equal (Test-CodeRabbitReviewCoversHead (Review 1 $head $summaryBody 10 'PENDING') $head) $false 'pending review'
Assert-Equal (Test-CodeRabbitReviewCoversHead (Review 1 $head $summaryBody 10 'COMMENTED' 'User') $head) $false 'non-bot author with the bot login'

# ---- per-head state machine ----
$skipped = Status 1 'success' 'Review skipped: manual review required for this OSS repository' 5
$pending = Status 2 'pending' 'Review in progress' 40
$completed = Status 3 'success' 'Review completed' 100
$limited = Status 4 'success' 'Review rate limited' 5
Assert-State (Snap) 'AWAITING_AUTO' 'no status yet'
Assert-State (Snap -Statuses @($skipped)) 'MANUAL_REQUIRED' 'manual review required'
Assert-State (Snap -Statuses @($limited)) 'RATE_LIMITED' 'rate limited'
Assert-State (Snap -Statuses @((Status 1 'success' 'Review skipped: ignored title keyword' 5))) 'SKIPPED' 'skipped for another reason'
Assert-State (Snap -Statuses @((Status 1 'success' 'Review skipped: draft pull request' 5))) 'DRAFT' 'skipped draft'
Assert-State (Snap -Statuses @((Status 1 'error' 'Review failed' 5))) 'REVIEW_FAILED' 'failed status'
Assert-State (Snap -Draft $true -Statuses @($skipped)) 'DRAFT' 'draft PR'
Assert-State (Snap -State 'closed') 'CLOSED' 'closed PR'
Assert-State (Snap -Statuses @($skipped, $pending)) 'IN_PROGRESS' 'pending after skip'
Assert-State (Snap -Statuses @((Status 6 'success' 'Review skipped: manual review required' 60), $pending)) 'MANUAL_REQUIRED' 'status order follows creation time, not list order'
Assert-State (Snap -Statuses @($skipped, $pending, $completed) -Reviews @((Review 9 $head $summaryBody 95))) 'REVIEWED' 'completed with covering review' 'review:9'
Assert-State (Snap -Statuses @($skipped) -Reviews @((Review 9 $head '' 30))) 'MANUAL_REQUIRED' 'thread replies on the head leave it unreviewed'
Assert-State (Snap -Statuses @($completed) -Reviews @((Review 9 $head '' 30))) 'COMPLETED_UNCONFIRMED' 'completed status alone is only a signal'
Assert-State (Snap -Statuses @($completed) -Reviews @((Review 9 $older $summaryBody 30))) 'COMPLETED_UNCONFIRMED' 'older review does not cover head'
$coverage = "<!-- final_review_risk_coverage:{`"sourceCommitId`":`"$head`",`"coveredCommitId`":`"$head`",`"kind`":`"reviewed`"} -->"
$walkthrough = Comment 7 "walkthrough $coverage" 1 'coderabbitai[bot]' 'Bot'
Assert-State (Snap -Statuses @($completed) -Comments @($walkthrough)) 'REVIEWED' 'summary coverage plus completed status' 'summary:7'
Assert-State (Snap -Statuses @($skipped) -Comments @($walkthrough)) 'MANUAL_REQUIRED' 'summary coverage needs a completed status'
Assert-State (Snap -Statuses @($completed) -Comments @((Comment 7 ($walkthrough.body -replace "coveredCommitId`":`"$head", "coveredCommitId`":`"$older") 1 'coderabbitai[bot]' 'Bot'))) 'COMPLETED_UNCONFIRMED' 'summary coverage of another head'
Assert-State (Snap -Statuses @($completed) -Comments @((Comment 7 $walkthrough.body 1 'mallory' 'User'))) 'COMPLETED_UNCONFIRMED' 'summary marker from a human'
Assert-State (Snap -Statuses @((Status 3 'success' 'Review completed' 100), (Status 5 'success' 'Review rate limited' 200)) -Reviews @((Review 9 $head $summaryBody 95))) 'REVIEWED' 'a covered head stays covered after a later limit'
Assert-State (Snap -Statuses @($completed, (Status 5 'pending' 'Review in progress' 200)) -Reviews @((Review 9 $head $summaryBody 95))) 'IN_PROGRESS' 'a new review round is awaited'
Assert-State (Snap -Statuses @((Status 1 'success' 'Review completed' 5 'mallory' 'User'))) 'AWAITING_AUTO' 'status from a non-bot creator is ignored'

$trigger = Comment 20 '@coderabbitai review' 30
Assert-State (Snap -Statuses @($skipped) -Comments @($trigger)) 'TRIGGERED' 'trigger newer than the stale skip status' 'comment:20'
Assert-State (Snap -Statuses @($skipped) -Comments @((Comment 20 '@coderabbitai review' 30 'coderabbitai[bot]' 'Bot'))) 'MANUAL_REQUIRED' 'bot text is not a trigger'
Assert-State (Snap -Statuses @($skipped) -Comments @((Comment 20 '@coderabbitai review' 30)) -Arrival 60) 'MANUAL_REQUIRED' 'a trigger before the head arrived belongs to an older head'
$ack = Comment 21 "<!-- CodeRabbit review command invocation: v2:x -->`n<details><summary>Action performed</summary>Review triggered.</details>" 35 'coderabbitai[bot]' 'Bot'
Assert-State (Snap -Statuses @($skipped) -Comments @($trigger, $ack)) 'TRIGGERED' 'acknowledged trigger'
$finishedAck = Comment 21 ($ack.body -replace 'Review triggered', 'Review finished') 35 'coderabbitai[bot]' 'Bot'
Assert-State (Snap -Statuses @($skipped, $completed) -Comments @($trigger, $finishedAck)) 'COMPLETED_UNCONFIRMED' 'an edited "finished" ack is not a review'
Assert-State (Snap -Statuses @($skipped, $completed) -Comments @($trigger, $finishedAck) -Reviews @((Review 9 $head $summaryBody 95))) 'REVIEWED' 'triggered review landed'
Assert-State (Snap -Statuses @($skipped, (Status 5 'success' 'Review rate limited' 50)) -Comments @($trigger)) 'TRIGGER_RATE_LIMITED' 'trigger answered by a limit'
Assert-State (Snap -Statuses @($skipped) -Comments @($trigger, (Comment 22 'More reviews will be available in 5 minutes.' 40 'coderabbitai[bot]' 'Bot'))) 'TRIGGERED' 'an unrelated reply is not an ack'
$ledger = [pscustomobject]@{ head = $head; recordedAt = (At 30).ToString('o'); path = 'ledger.json' }
Assert-State (Snap -Statuses @($skipped) -Ledger $ledger) 'TRIGGERED' 'local ledger records an earlier trigger' 'ledger:ledger.json'
Assert-State (Snap -Statuses @($skipped) -Ledger ([pscustomobject]@{ head = $older; recordedAt = (At 30).ToString('o'); path = 'x' })) 'MANUAL_REQUIRED' 'another head ledger is ignored'

Assert-Equal (Get-CodeRabbitHeadArrival @((At 50), (At 20), $null) (At 0)) (At 20) 'arrival uses the earliest observed time'
Assert-Equal (Get-CodeRabbitHeadArrival @() (At 3)) (At 3) 'arrival falls back to the commit time'
Assert-Equal ((ConvertTo-CrTime ([datetime]::SpecifyKind([datetime]'2026-01-01T00:00:00', 'Utc'))) -eq $t0) $true 'DateTime from PowerShell 7 JSON'

Write-Output "PowerShell parser and $script:assertions helper assertions passed."

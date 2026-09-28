$ErrorActionPreference = 'Stop'
$folder = $PSScriptRoot
foreach ($name in @('coderabbit-review-helpers.ps1', 'request-coderabbit-review.ps1')) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $folder $name), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw "$name did not parse: $($errors[0])" }
}
. (Join-Path $folder 'coderabbit-review-helpers.ps1')

$cases = @(
    @{ Body = 'Reviews are available now.'; Want = 'available' },
    @{ Body = 'You have 2 PR reviews remaining.'; Want = 'available' },
    @{ Body = 'Remaining PR reviews: 1'; Want = 'available' },
    @{ Body = '0 reviews remaining. Next included review available in 5 minutes.'; Want = 'unavailable' },
    @{ Body = 'Review rate limited.'; Want = 'unavailable' },
    @{ Body = 'More reviews will be available in 30 seconds.'; Want = 'unavailable' },
    @{ Body = '<!-- This is an auto-generated reply by CodeRabbit --> Your plan includes PR reviews subject to rate limits. More reviews will be available in 3 minutes.'; Want = 'unavailable' },
    @{ Body = '<!-- This is an auto-generated reply by CodeRabbit --> Your plan includes PR reviews subject to rate limits. Reviews are available now.'; Want = 'available' },
    @{ Body = 'The current review has 2 comments.'; Want = 'unknown' },
    @{ Body = 'Reviews remaining: maybe later.'; Want = 'unknown' }
)
foreach ($case in $cases) {
    $actual = Get-CodeRabbitQuotaState -Body $case.Body
    if ($actual -ne $case.Want) { throw "Quota case failed: $($case.Body) -> $actual, expected $($case.Want)" }
}
if ((Get-CodeRabbitQuotaRetrySeconds -Body 'Next included review available in 1.2 minutes.') -ne 180) { throw 'Minute retry buffer failed' }
if ((Get-CodeRabbitQuotaRetrySeconds -Body 'More reviews available in 30 seconds.') -ne 90) { throw 'Second retry buffer failed' }
if ((Get-CodeRabbitQuotaRetrySeconds -Body 'Review rate limited.') -ne 300) { throw 'Unknown retry backoff failed' }
$head = 'a' * 40
$skipped = [pscustomobject]@{ sha = $head; state = 'success'; description = 'Review skipped: manual review required for this OSS repository' }
$limited = [pscustomobject]@{ sha = $head; state = 'success'; description = 'Review rate limited' }
$empty = [pscustomobject]@{ sha = $head; state = 'success'; description = '' }
$pending = [pscustomobject]@{ sha = $head; state = 'pending'; description = 'Review in progress' }
$complete = [pscustomobject]@{ sha = $head; state = 'success'; description = 'Review completed' }
if (Test-CodeRabbitReviewDone -Head $head -Reviews @() -Status $skipped) { throw 'Skipped review was treated as complete' }
if (Test-CodeRabbitReviewDone -Head $head -Reviews @() -Status $limited) { throw 'Rate-limited review was treated as complete' }
if (Test-CodeRabbitReviewDone -Head $head -Reviews @() -Status $empty) { throw 'Empty status was treated as complete' }
if (Test-CodeRabbitReviewDone -Head $head -Reviews @([pscustomobject]@{ commit_id = $head; state = 'COMMENTED' }) -Status $skipped) { throw 'Older review masked manual skip' }
if (Test-CodeRabbitReviewDone -Head $head -Reviews @([pscustomobject]@{ commit_id = $head; state = 'COMMENTED' }) -Status $limited) { throw 'Older review masked rate limit' }
if (Test-CodeRabbitReviewDone -Head $head -Reviews @([pscustomobject]@{ commit_id = $head; state = 'COMMENTED' }) -Status $pending) { throw 'Older review masked pending state' }
if (-not (Test-CodeRabbitReviewDone -Head $head -Reviews @() -Status $complete)) { throw 'Completed status was missed' }
if (-not (Test-CodeRabbitReviewDone -Head $head -Reviews @([pscustomobject]@{ commit_id = $head; state = 'COMMENTED' }) -Status $null)) { throw 'Head review was missed' }
if (Test-CodeRabbitReviewDone -Head $head -Reviews @([pscustomobject]@{ commit_id = $head; state = 'PENDING' }) -Status $null) { throw 'Pending review was treated as complete' }
Write-Output "PowerShell parser and $($cases.Count + 12) helper assertions passed."

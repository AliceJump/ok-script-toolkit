param(
    [ValidateSet('AliceJump/ok-script-toolkit', 'AliceJump/ok-script-toolkit-jetbrains')][string]$Repo = 'AliceJump/ok-script-toolkit',
    [switch]$NoTrigger, [switch]$ChangedHead, [switch]$ExistingTrigger, [switch]$RateLimited,
    [switch]$InlineQuotaReply
)

# All gh calls are intercepted in this process. Use a caller-provided log path.
$ErrorActionPreference = 'Stop'
$env:CR_MOCK_LOG = Join-Path $env:TEMP 'codex-coderabbit-request-mock.log'
Set-Content -LiteralPath $env:CR_MOCK_LOG -Value ''
$global:mockHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$global:probeCreated = [datetimeoffset]::MinValue
$global:probeSent = $false
$global:changedHead = [bool]$ChangedHead
$global:existingTrigger = [bool]$ExistingTrigger
$global:rateLimited = [bool]$RateLimited
$global:mockRepo = $Repo
$global:inlineQuotaReply = [bool]$InlineQuotaReply

function global:gh {
    $global:LASTEXITCODE = 0
    $arguments = @($args)
    $command = $arguments -join ' '
    Add-Content -LiteralPath $env:CR_MOCK_LOG -Value "call: $command"
    if ($command -match '^api user ') { return 'alice' }
    if ($command -match "^api repos/$([regex]::Escape($global:mockRepo))/pulls/17 --jq ") {
        if ($global:changedHead) { return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`topen`tfalse" }
        return "$global:mockHead`topen`tfalse"
    }
    if ($command -match "^api repos/$([regex]::Escape($global:mockRepo))/commits/[^/]+ --jq ") {
        return '2026-09-01T00:00:00Z'
    }
    if ($command -match "^api --paginate repos/$([regex]::Escape($global:mockRepo))/pulls/17/reviews ") { return '' }
    if ($command -match "^api repos/$([regex]::Escape($global:mockRepo))/commits/[^/]+/status ") {
        if ($global:rateLimited) { return "success`tReview rate limited" }
        return "success`tReview skipped: manual review required for this OSS repository"
    }
    if ($command -match "^api --paginate repos/$([regex]::Escape($global:mockRepo))/issues/17/comments ") {
        if ($global:existingTrigger) {
            $existing = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('@coderabbitai review'))
            return "99`talice`tUser`t2026-09-02T00:00:00Z`t$existing"
        }
        if (-not $global:probeSent -or $global:inlineQuotaReply) { return '' }
        $reply = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('You have 2 PR reviews remaining.'))
        $created = $global:probeCreated.AddSeconds(1).ToString('yyyy-MM-ddTHH:mm:ssZ')
        return "101`tcoderabbitai[bot]`tBot`t$created`t$reply"
    }
    if ($command -match "^api --paginate repos/$([regex]::Escape($global:mockRepo))/pulls/17/comments ") {
        if (-not $global:probeSent -or -not $global:inlineQuotaReply) { return '' }
        $reply = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('Reviews are available now.'))
        $created = $global:probeCreated.AddSeconds(1).ToString('yyyy-MM-ddTHH:mm:ssZ')
        return "77`tcoderabbitai[bot]`tBot`t$created`t$reply"
    }
    if ($command -match 'body=@coderabbitai rate limit') {
        $global:probeSent = $true
        $global:probeCreated = [datetimeoffset]::UtcNow.AddSeconds(-2)
        Add-Content -LiteralPath $env:CR_MOCK_LOG -Value 'probe'
        return "100`t$($global:probeCreated.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
    }
    if ($command -match 'body=@coderabbitai review') {
        if (-not $global:probeSent) { throw 'review was posted before quota probe' }
        Add-Content -LiteralPath $env:CR_MOCK_LOG -Value 'review'
        return 'https://example.invalid/review-command'
    }
    throw "Unexpected gh call: $command"
}

$request = Join-Path $PSScriptRoot 'request-coderabbit-review.ps1'
& $request -Repo $Repo -PrNumber 17 -ExpectedHead $global:mockHead -AutoWaitSeconds 0 -NoTrigger:$NoTrigger
exit $LASTEXITCODE

function Get-CodeRabbitQuotaState {
    param([AllowEmptyString()][string]$Body)

    if ($Body -match '(?i)reviews? are available now') {
        return 'available'
    }
    if ($Body -match '(?i)(?:next|more)\s+(?:included\s+)?reviews?\s+(?:will be |is )?available in\s+\d' -or
        $Body -match '(?i)review (?:rate )?limit reached|review rate limited|no (?:pr )?reviews? remaining|(?:reviews? remaining|remaining (?:pr )?reviews?)\s*[:=]?\s*0\b|\b0\s+(?:pr )?reviews? remaining') {
        return 'unavailable'
    }
    $matches = @(
        [regex]::Match($Body, '(?i)\b(\d+)\s+(?:included\s+|pr\s+)?reviews?\s+(?:are\s+)?remaining\b'),
        [regex]::Match($Body, '(?i)\b(?:remaining|available)\s+(?:included\s+|pr\s+)?reviews?\s*[:=]?\s*(\d+)\b'),
        [regex]::Match($Body, '(?i)\b(?:reviews?\s+remaining|reviews?\s+available)\s*[:=]\s*(\d+)\b')
    )
    foreach ($match in $matches) {
        if ($match.Success) {
            if ([int]$match.Groups[1].Value -gt 0) { return 'available' }
            return 'unavailable'
        }
    }
    return 'unknown'
}

function Get-CodeRabbitQuotaRetrySeconds {
    param([AllowEmptyString()][string]$Body)

    $match = [regex]::Match($Body, '(?i)available in\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?)')
    if (-not $match.Success) { return 300 }
    $value = [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
    $unit = $match.Groups[2].Value
    if ($unit -match '(?i)^min') { return [int]([Math]::Ceiling($value) * 60 + 60) }
    return [int]([Math]::Ceiling($value) + 60)
}

function Test-CodeRabbitReviewDone {
    param([string]$Head, [object[]]$Reviews, [object]$Status)

    if ($null -ne $Status -and $Status.sha -eq $Head) {
        # The newest status can supersede earlier review entries on the same commit.
        if ($Status.state -eq 'pending' -or
            $Status.description -match '(?i)review skipped|manual review required|draft pull request|review rate limited') {
            return $false
        }
        if ($Status.state -eq 'success' -and $Status.description -match '(?i)review completed|review finished') {
            return $true
        }
    }
    return @($Reviews | Where-Object {
        $_.commit_id -eq $Head -and $_.state -in @('APPROVED', 'COMMENTED', 'CHANGES_REQUESTED')
    }).Count -gt 0
}

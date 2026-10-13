$ErrorActionPreference = "Stop"

$secretsPath = Join-Path $PSScriptRoot ".dev.vars"
if (-not (Test-Path -LiteralPath $secretsPath -PathType Leaf)) {
    throw "Local Worker secrets were not found. Run setup-local-secrets.ps1 only for a brand-new local setup."
}

$randomBytes = New-Object byte[] 24
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
$randomGenerator.GetBytes($randomBytes)
$randomGenerator.Dispose()
$adminAccessCode = "MRDS-ADMIN-" + [BitConverter]::ToString($randomBytes).Replace("-", "").ToLowerInvariant()
$adminCodeLine = 'ADMIN_ACCESS_CODE="' + $adminAccessCode + '"'
$secrets = Get-Content -LiteralPath $secretsPath -Raw

if ($secrets -match '(?m)^ADMIN_ACCESS_CODE=') {
    $secrets = [regex]::Replace(
        $secrets,
        '(?m)^ADMIN_ACCESS_CODE=.*$',
        [System.Text.RegularExpressions.MatchEvaluator]{ param($match) return $adminCodeLine },
        1
    )
} else {
    $secrets = $secrets.TrimEnd("`r", "`n") + "`n" + $adminCodeLine + "`n"
}

[IO.File]::WriteAllText($secretsPath, $secrets, [Text.UTF8Encoding]::new($false))
Write-Host "New local admin code: $adminAccessCode"
Write-Host "Only ADMIN_ACCESS_CODE was changed. Existing client codes remain valid."
Write-Host "Restart Wrangler, then sign in at http://localhost:8010/admin."

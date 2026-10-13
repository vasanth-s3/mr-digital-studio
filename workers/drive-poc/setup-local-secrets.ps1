$ErrorActionPreference = "Stop"

$keyPath = Read-Host "Path to the downloaded Google service-account JSON key"
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    throw "The key file path does not exist."
}

$account = Get-Content -LiteralPath $keyPath -Raw | ConvertFrom-Json
if ($account.type -ne "service_account" -or -not $account.client_email -or -not $account.private_key) {
    throw "That file does not look like a Google service-account JSON key."
}

$randomBytes = New-Object byte[] 24
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
$randomGenerator.GetBytes($randomBytes)
$adminAccessCode = "MRDS-ADMIN-" + [BitConverter]::ToString($randomBytes).Replace("-", "").ToLowerInvariant()
$sessionBytes = New-Object byte[] 48
$randomGenerator.GetBytes($sessionBytes)
$randomGenerator.Dispose()
$sessionSecret = [Convert]::ToBase64String($sessionBytes)
$serviceAccountJson = ConvertTo-Json -InputObject $account -Compress -Depth 100

$dotenv = @(
    "ADMIN_ACCESS_CODE=`"$adminAccessCode`""
    "SESSION_SECRET=`"$sessionSecret`""
    "GOOGLE_SERVICE_ACCOUNT_JSON='$serviceAccountJson'"
) -join "`n"
$secretsPath = Join-Path $PSScriptRoot ".dev.vars"
[IO.File]::WriteAllText($secretsPath, $dotenv, [Text.UTF8Encoding]::new($false))

Write-Host "Local Worker secrets created at $secretsPath"
Write-Host "Local photographer admin code: $adminAccessCode"
Write-Host "The service-account key was read locally and was not displayed."

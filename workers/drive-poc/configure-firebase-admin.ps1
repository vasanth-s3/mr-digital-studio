$ErrorActionPreference = "Stop"

$firebaseApiKey = Read-Host "Firebase Web API key (public Firebase app configuration)"
$adminUid = Read-Host "Firebase UID for the verified studio admin account"

if ($firebaseApiKey -notmatch '^AIza[0-9A-Za-z_-]+$') {
    throw "Enter the Firebase Web API key from Project settings → General → Web app configuration."
}
if ($adminUid -notmatch '^[A-Za-z0-9_-]{5,128}$') {
    throw "Enter the Firebase UID shown for the studio admin in Authentication → Users."
}

$secretsPath = Join-Path $PSScriptRoot ".dev.vars"
$configPath = Join-Path $PSScriptRoot "..\..\select\gallery-config.js"
if (-not (Test-Path -LiteralPath $secretsPath -PathType Leaf)) {
    throw "Local Worker secrets were not found. Run setup-local-secrets.ps1 first."
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Gallery configuration was not found at $configPath."
}

$config = Get-Content -LiteralPath $configPath -Raw
if ($config -notmatch 'firebaseApiKey:\s*"[^"]*"') {
    throw "The firebaseApiKey setting was not found in gallery-config.js."
}
$updatedConfig = [regex]::Replace(
    $config,
    'firebaseApiKey:\s*"[^"]*"',
    [System.Text.RegularExpressions.MatchEvaluator]{ param($match) return ('firebaseApiKey: "' + $firebaseApiKey + '"') },
    1
)

$existingLines = Get-Content -LiteralPath $secretsPath
$keptLines = @($existingLines | Where-Object { $_ -notmatch '^(FIREBASE_WEB_API_KEY|FIREBASE_ADMIN_UID)=' })
$updatedLines = @($keptLines + "FIREBASE_WEB_API_KEY=$firebaseApiKey" + "FIREBASE_ADMIN_UID=$adminUid")
[IO.File]::WriteAllText($secretsPath, ($updatedLines -join "`n"), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($configPath, $updatedConfig, [Text.UTF8Encoding]::new($false))

Write-Host "Firebase admin sign-in is configured for local development."
Write-Host "The Firebase key and admin UID were written locally and were not displayed."
Write-Host "Restart Wrangler, then sign in at http://localhost:8010/admin."

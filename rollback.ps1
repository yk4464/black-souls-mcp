param(
  [string]$RuntimeRoot = (Join-Path $PSScriptRoot 'runtime'),
  [string]$CodexConfig = "$env:USERPROFILE\.codex\config.toml",
  [string]$ConfigBackup
)

$ErrorActionPreference = 'Stop'
$backupDir = Join-Path $RuntimeRoot 'backup'
if (-not $ConfigBackup) {
  $ConfigBackup = Get-ChildItem -LiteralPath $backupDir -Filter 'config.toml.before-black-souls-*.bak' -File |
    Where-Object { $_.Name -notlike '*uninstall*' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ConfigBackup -or -not (Test-Path -LiteralPath $ConfigBackup)) { throw 'No Codex config backup was found.' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $CodexConfig) | Out-Null
if (Test-Path -LiteralPath $CodexConfig) {
  $safetyName = "config.toml.before-rollback-{0}-{1}.bak" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
  $safety = Join-Path $backupDir $safetyName
  Copy-Item -LiteralPath $CodexConfig -Destination $safety
}
Copy-Item -LiteralPath $ConfigBackup -Destination $CodexConfig -Force
Write-Host "Codex config restored from: $ConfigBackup"
Write-Host 'Game and save files were not changed.'

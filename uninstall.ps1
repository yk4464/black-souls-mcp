param(
  [string]$RuntimeRoot = (Join-Path $PSScriptRoot 'runtime'),
  [string]$CodexConfig = "$env:USERPROFILE\.codex\config.toml"
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $CodexConfig)) { Write-Host 'Codex config does not exist.'; exit 0 }
$backupDir = Join-Path $RuntimeRoot 'backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$backupName = "config.toml.before-black-souls-uninstall-{0}-{1}.bak" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$backup = Join-Path $backupDir $backupName
Copy-Item -LiteralPath $CodexConfig -Destination $backup
$content = [IO.File]::ReadAllText($CodexConfig)
$pattern = '(?ms)^# BLACK_SOULS_MCP_BEGIN.*?^# BLACK_SOULS_MCP_END\r?\n?'
$updated = [regex]::Replace($content, $pattern, '').TrimEnd() + "`r`n"
[IO.File]::WriteAllText($CodexConfig, $updated, (New-Object Text.UTF8Encoding($false)))
Write-Host 'BLACK SOULS MCP was removed from the Codex config.'
Write-Host "Runtime files were left unchanged at $RuntimeRoot"

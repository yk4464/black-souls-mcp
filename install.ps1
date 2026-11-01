param(
  [ValidateSet('bs1', 'bs2')][string]$Game = 'bs1',
  [string]$RuntimeRoot = (Join-Path $PSScriptRoot 'runtime'),
  [string]$GameDir,
  [string]$Game2Dir,
  [string]$CodexConfig = "$env:USERPROFILE\.codex\config.toml",
  [string]$ExpectedGameExeHash = $(if ($null -ne [Environment]::GetEnvironmentVariable('BLACK_SOULS_GAME_EXE_SHA256')) { [Environment]::GetEnvironmentVariable('BLACK_SOULS_GAME_EXE_SHA256') } else { 'E4447454C551B96C833E7ED4C7114F807C86FE32F0757C206BEDDA94AC85BC2B' }),
  [string]$ExpectedGame2ExeHash = $(if ($null -ne [Environment]::GetEnvironmentVariable('BLACK_SOULS2_GAME_EXE_SHA256')) { [Environment]::GetEnvironmentVariable('BLACK_SOULS2_GAME_EXE_SHA256') } else { '45DD547893F7CCC3D58A045612C1C265313644D390EFF28C8B13684A06EA2BAC' })
)

$ErrorActionPreference = 'Stop'
$mcpDir = $PSScriptRoot
$server = Join-Path $mcpDir 'dist\index.js'
if (-not $GameDir) { $GameDir = Join-Path $RuntimeRoot 'game' }
if (-not $Game2Dir) { $Game2Dir = Join-Path $RuntimeRoot 'game2' }
$selectedDir = if ($Game -eq 'bs2') { $Game2Dir } else { $GameDir }
$selectedHash = if ($Game -eq 'bs2') { $ExpectedGame2ExeHash } else { $ExpectedGameExeHash }
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$node = $nodeCommand.Source

if (-not (Test-Path -LiteralPath $server)) { throw "MCP server missing: $server. Run npm.cmd run build first." }
$gameExe = Join-Path $selectedDir 'Game.exe'
if (-not (Test-Path -LiteralPath $gameExe)) { throw "Prepared game copy missing: $selectedDir" }
if (-not (Test-Path -LiteralPath (Join-Path $selectedDir 'Data\Scripts.rvdata2'))) { throw 'Patched Data\Scripts.rvdata2 is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $selectedDir 'Game.rgss3a~'))) { throw 'Game.rgss3a~ backup is missing.' }

$actualGameExeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $gameExe).Hash
$ExpectedGameExeHash = $ExpectedGameExeHash.Trim().ToUpperInvariant()
$ExpectedGame2ExeHash = $ExpectedGame2ExeHash.Trim().ToUpperInvariant()
$selectedHash = $selectedHash.Trim().ToUpperInvariant()
if ($selectedHash -and $actualGameExeHash -ne $selectedHash) {
  throw "Game.exe integrity check failed. Expected $selectedHash, found $actualGameExeHash"
}
$nodeMajor = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) { throw 'Node.js 18 or newer is required.' }

$backupDir = Join-Path $RuntimeRoot 'backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
if (Test-Path -LiteralPath $CodexConfig) {
  $backupName = "config.toml.before-black-souls-{0}-{1}.bak" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
  $backup = Join-Path $backupDir $backupName
  Copy-Item -LiteralPath $CodexConfig -Destination $backup
  $content = [IO.File]::ReadAllText($CodexConfig)
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $CodexConfig) | Out-Null
  $content = ''
}

$begin = '# BLACK_SOULS_MCP_BEGIN'
$end = '# BLACK_SOULS_MCP_END'

# Refuse to touch a config whose markers are unbalanced. Rewriting it blindly would
# let a later uninstall delete everything between an orphaned BEGIN and the new END.
$beginCount = [regex]::Matches($content, '(?m)^' + [regex]::Escape($begin) + '\r?$').Count
$endCount = [regex]::Matches($content, '(?m)^' + [regex]::Escape($end) + '\r?$').Count
if ($beginCount -ne $endCount) {
  throw "Unbalanced BLACK SOULS markers in ${CodexConfig} (BEGIN=$beginCount, END=$endCount). Repair the file manually, then re-run install."
}
if ($beginCount -gt 1) {
  throw "Found $beginCount BLACK SOULS blocks in ${CodexConfig}. Remove the duplicates manually, then re-run install."
}

$pattern = '(?ms)^' + [regex]::Escape($begin) + '\r?$.*?^' + [regex]::Escape($end) + '\r?$\r?\n?'
$content = [regex]::Replace($content, $pattern, '').TrimEnd()
$nodeToml = $node.Replace('\', '/')
$serverToml = $server.Replace('\', '/')
$rootToml = $RuntimeRoot.Replace('\', '/')
$gameToml = $GameDir.Replace('\', '/')
$game2Toml = $Game2Dir.Replace('\', '/')
foreach ($value in @($nodeToml, $serverToml, $rootToml, $gameToml, $game2Toml, $ExpectedGameExeHash, $ExpectedGame2ExeHash)) {
  if ($value -match '[\"\r\n]') { throw "Value cannot be embedded in a TOML string (contains a quote or newline): $value" }
}
$block = @"
$begin
[mcp_servers.black_souls]
type = "stdio"
command = "$nodeToml"
args = ["$serverToml"]
startup_timeout_sec = 20

[mcp_servers.black_souls.env]
BLACK_SOULS_ROOT = "$rootToml"
BLACK_SOULS_GAME = "$Game"
BLACK_SOULS_DIR = "$gameToml"
BLACK_SOULS2_DIR = "$game2Toml"
BLACK_SOULS_GAME_EXE_SHA256 = "$ExpectedGameExeHash"
BLACK_SOULS2_GAME_EXE_SHA256 = "$ExpectedGame2ExeHash"
$end
"@
$updated = if ($content) { $content + "`r`n`r`n" + $block + "`r`n" } else { $block + "`r`n" }
[IO.File]::WriteAllText($CodexConfig, $updated, (New-Object Text.UTF8Encoding($false)))

Write-Host 'BLACK SOULS MCP registration installed.'
Write-Host "Server: $server"
Write-Host "Selected game: $Game ($selectedDir)"
Write-Host 'Restart Codex to load the server.'

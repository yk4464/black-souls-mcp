param(
  [string]$RuntimeRoot = (Join-Path $PSScriptRoot 'runtime'),
  [string]$GameDir,
  [string]$CodexConfig = "$env:USERPROFILE\.codex\config.toml",
  [string]$ExpectedGameExeHash = $(if ($null -ne [Environment]::GetEnvironmentVariable('BLACK_SOULS_GAME_EXE_SHA256')) { [Environment]::GetEnvironmentVariable('BLACK_SOULS_GAME_EXE_SHA256') } else { 'E4447454C551B96C833E7ED4C7114F807C86FE32F0757C206BEDDA94AC85BC2B' })
)

$ErrorActionPreference = 'Stop'
$mcpDir = $PSScriptRoot
$server = Join-Path $mcpDir 'dist\index.js'
if (-not $GameDir) { $GameDir = Join-Path $RuntimeRoot 'game' }
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$node = $nodeCommand.Source

if (-not (Test-Path -LiteralPath $server)) { throw "MCP server missing: $server. Run npm.cmd run build first." }
$gameExe = Join-Path $GameDir 'Game.exe'
if (-not (Test-Path -LiteralPath $gameExe)) { throw "Prepared game copy missing: $GameDir" }
if (-not (Test-Path -LiteralPath (Join-Path $GameDir 'Data\Scripts.rvdata2'))) { throw 'Patched Data\Scripts.rvdata2 is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $GameDir 'Game.rgss3a~'))) { throw 'Game.rgss3a~ backup is missing.' }

$actualGameExeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $gameExe).Hash
$ExpectedGameExeHash = $ExpectedGameExeHash.Trim().ToUpperInvariant()
if ($ExpectedGameExeHash -and $actualGameExeHash -ne $ExpectedGameExeHash) {
  throw "Game.exe integrity check failed. Expected $ExpectedGameExeHash, found $actualGameExeHash"
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
$pattern = '(?ms)^' + [regex]::Escape($begin) + '.*?^' + [regex]::Escape($end) + '\r?\n?'
$content = [regex]::Replace($content, $pattern, '').TrimEnd()
$nodeToml = $node.Replace('\', '/')
$serverToml = $server.Replace('\', '/')
$rootToml = $RuntimeRoot.Replace('\', '/')
$gameToml = $GameDir.Replace('\', '/')
$hashLine = "`r`nBLACK_SOULS_GAME_EXE_SHA256 = `"$ExpectedGameExeHash`""
$block = @"
$begin
[mcp_servers.black_souls]
type = "stdio"
command = "$nodeToml"
args = ["$serverToml"]
startup_timeout_sec = 20

[mcp_servers.black_souls.env]
BLACK_SOULS_ROOT = "$rootToml"
BLACK_SOULS_DIR = "$gameToml"$hashLine
$end
"@
$updated = if ($content) { $content + "`r`n`r`n" + $block + "`r`n" } else { $block + "`r`n" }
[IO.File]::WriteAllText($CodexConfig, $updated, (New-Object Text.UTF8Encoding($false)))

Write-Host 'BLACK SOULS MCP registration installed.'
Write-Host "Server: $server"
Write-Host "Game:   $GameDir"
Write-Host 'Restart Codex to load the server.'

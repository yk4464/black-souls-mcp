param(
  [ValidateSet('bs1', 'bs2')][string]$Game,
  [string]$RuntimeRoot = (Join-Path $PSScriptRoot 'runtime'),
  [string]$GameDir,
  [string]$Game2Dir,
  [string]$CodexConfig = "$env:USERPROFILE\.codex\config.toml",
  [string]$ExpectedGameExeHash = $(if ($null -ne [Environment]::GetEnvironmentVariable('BLACK_SOULS_GAME_EXE_SHA256')) { [Environment]::GetEnvironmentVariable('BLACK_SOULS_GAME_EXE_SHA256') } else { 'E4447454C551B96C833E7ED4C7114F807C86FE32F0757C206BEDDA94AC85BC2B' }),
  [string]$ExpectedGame2ExeHash = $(if ($null -ne [Environment]::GetEnvironmentVariable('BLACK_SOULS2_GAME_EXE_SHA256')) { [Environment]::GetEnvironmentVariable('BLACK_SOULS2_GAME_EXE_SHA256') } else { '45DD547893F7CCC3D58A045612C1C265313644D390EFF28C8B13684A06EA2BAC' }),
  [switch]$IncludeRuntime
)

$ErrorActionPreference = 'Stop'
$mcp = $PSScriptRoot
if (-not $GameDir) { $GameDir = Join-Path $RuntimeRoot 'game' }
if (-not $Game2Dir) { $Game2Dir = Join-Path $RuntimeRoot 'game2' }
if (-not $PSBoundParameters.ContainsKey('Game')) {
  $selectionFile = Join-Path $RuntimeRoot 'active_game.txt'
  $stored = if (Test-Path -LiteralPath $selectionFile) { (Get-Content -LiteralPath $selectionFile -Raw).Trim() } else { '' }
  $Game = if ($stored -in @('bs1', 'bs2')) { $stored } elseif ($env:BLACK_SOULS_GAME -in @('bs1', 'bs2')) { $env:BLACK_SOULS_GAME } else { 'bs1' }
}
$selectedDir = if ($Game -eq 'bs2') { $Game2Dir } else { $GameDir }
$selectedHash = if ($Game -eq 'bs2') { $ExpectedGame2ExeHash } else { $ExpectedGameExeHash }
$failures = [System.Collections.Generic.List[string]]::new()

Push-Location $mcp
try {
  npm.cmd run check
  if ($LASTEXITCODE -ne 0) { throw "MCP checks failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

$summary = [ordered]@{
  mcp_version = (Get-Content -LiteralPath (Join-Path $mcp 'package.json') -Raw | ConvertFrom-Json).version
  source_checks = $true
  runtime_checked = [bool]$IncludeRuntime
  selected_game = $Game
}

if ($IncludeRuntime) {
  $gameExe = Join-Path $selectedDir 'Game.exe'
  $actualGameExeHash = if (Test-Path -LiteralPath $gameExe) { (Get-FileHash -Algorithm SHA256 -LiteralPath $gameExe).Hash } else { $null }
  $selectedHash = $selectedHash.Trim().ToUpperInvariant()
  $saves = if (Test-Path -LiteralPath $selectedDir) { @(Get-ChildItem -LiteralPath $selectedDir -Filter 'Save*.rvdata2' -File).Count } else { 0 }
  $configRegistered = $false
  if (Test-Path -LiteralPath $CodexConfig) {
    $configText = [IO.File]::ReadAllText($CodexConfig)
    # Same anchored matching as install/uninstall; substring matching would report a
    # block as registered when uninstall could never actually remove it.
    $beginCount = [regex]::Matches($configText, '(?m)^# BLACK_SOULS_MCP_BEGIN\r?$').Count
    $endCount = [regex]::Matches($configText, '(?m)^# BLACK_SOULS_MCP_END\r?$').Count
    $configRegistered = $beginCount -ge 1 -and $beginCount -eq $endCount
  }

  if (-not $actualGameExeHash) { $failures.Add('Game.exe is missing') }
  elseif ($selectedHash -and $actualGameExeHash -ne $selectedHash) { $failures.Add('Game.exe SHA256 does not match the configured value') }
  if (-not (Test-Path -LiteralPath (Join-Path $selectedDir 'Data\Scripts.rvdata2'))) { $failures.Add('Data\Scripts.rvdata2 is missing') }
  if (-not (Test-Path -LiteralPath (Join-Path $selectedDir 'Game.rgss3a~'))) { $failures.Add('Game.rgss3a~ is missing') }
  if (-not $configRegistered) { $failures.Add('Codex registration block is missing') }

  $latestState = $null
  $stateDir = Join-Path $selectedDir 'BridgeRuntime\state'
  if (Test-Path -LiteralPath $stateDir) {
    foreach ($candidate in @(Get-ChildItem -LiteralPath $stateDir -Filter 'state-*.json' -File | Sort-Object LastWriteTime -Descending)) {
      try { $latestState = Get-Content -LiteralPath $candidate.FullName -Raw -Encoding UTF8 | ConvertFrom-Json; break } catch { }
    }
  }
  $bridgeLive = $false
  if ($latestState) {
    $ageMs = [math]::Max(0, ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]([double]$latestState.updated_at * 1000)))
    $processAlive = $null -ne (Get-Process -Id ([int]$latestState.pid) -ErrorAction SilentlyContinue)
    $bridgeLive = $processAlive -and $ageMs -lt 60000
  }

  $summary.game_directory = $selectedDir
  $summary.game_exe_sha256 = $actualGameExeHash
  $summary.game_exe_integrity = if ($selectedHash) { $actualGameExeHash -eq $selectedHash } else { $null }
  $summary.saves = $saves
  $summary.codex_registered = $configRegistered
  $summary.bridge_live = $bridgeLive
  $summary.bridge_version = if ($latestState) { $latestState.bridge_version } else { $null }
  $summary.scene = if ($latestState) { $latestState.scene.name } else { $null }
}

$summary.failures = @($failures)
$summary | ConvertTo-Json -Depth 5
if ($failures.Count -gt 0) { throw ('Checks failed: ' + ($failures -join '; ')) }

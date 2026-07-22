param(
  [string]$RuntimeRoot = (Join-Path $PSScriptRoot 'runtime'),
  [string]$GameDir,
  [string]$CodexConfig = "$env:USERPROFILE\.codex\config.toml",
  [string]$ExpectedGameExeHash = $(if ($null -ne [Environment]::GetEnvironmentVariable('BLACK_SOULS_GAME_EXE_SHA256')) { [Environment]::GetEnvironmentVariable('BLACK_SOULS_GAME_EXE_SHA256') } else { 'E4447454C551B96C833E7ED4C7114F807C86FE32F0757C206BEDDA94AC85BC2B' }),
  [switch]$IncludeRuntime
)

$ErrorActionPreference = 'Stop'
$mcp = $PSScriptRoot
if (-not $GameDir) { $GameDir = Join-Path $RuntimeRoot 'game' }
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
}

if ($IncludeRuntime) {
  $gameExe = Join-Path $GameDir 'Game.exe'
  $actualGameExeHash = if (Test-Path -LiteralPath $gameExe) { (Get-FileHash -Algorithm SHA256 -LiteralPath $gameExe).Hash } else { $null }
  $ExpectedGameExeHash = $ExpectedGameExeHash.Trim().ToUpperInvariant()
  $saves = if (Test-Path -LiteralPath $GameDir) { @(Get-ChildItem -LiteralPath $GameDir -Filter 'Save*.rvdata2' -File).Count } else { 0 }
  $configRegistered = $false
  if (Test-Path -LiteralPath $CodexConfig) {
    $configText = [IO.File]::ReadAllText($CodexConfig)
    $configRegistered = $configText.Contains('# BLACK_SOULS_MCP_BEGIN') -and $configText.Contains('# BLACK_SOULS_MCP_END')
  }

  if (-not $actualGameExeHash) { $failures.Add('Game.exe is missing') }
  elseif ($ExpectedGameExeHash -and $actualGameExeHash -ne $ExpectedGameExeHash) { $failures.Add('Game.exe SHA256 does not match the configured value') }
  if (-not (Test-Path -LiteralPath (Join-Path $GameDir 'Data\Scripts.rvdata2'))) { $failures.Add('Data\Scripts.rvdata2 is missing') }
  if (-not (Test-Path -LiteralPath (Join-Path $GameDir 'Game.rgss3a~'))) { $failures.Add('Game.rgss3a~ is missing') }
  if (-not $configRegistered) { $failures.Add('Codex registration block is missing') }

  $latestState = $null
  $stateDir = Join-Path $GameDir 'BridgeRuntime\state'
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

  $summary.game_directory = $GameDir
  $summary.game_exe_sha256 = $actualGameExeHash
  $summary.game_exe_integrity = if ($ExpectedGameExeHash) { $actualGameExeHash -eq $ExpectedGameExeHash } else { $null }
  $summary.saves = $saves
  $summary.codex_registered = $configRegistered
  $summary.bridge_live = $bridgeLive
  $summary.bridge_version = if ($latestState) { $latestState.bridge_version } else { $null }
  $summary.scene = if ($latestState) { $latestState.scene.name } else { $null }
}

$summary.failures = @($failures)
$summary | ConvertTo-Json -Depth 5
if ($failures.Count -gt 0) { throw ('Checks failed: ' + ($failures -join '; ')) }

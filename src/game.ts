import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { bridgeRuntimeDirectory, bridgeStatus, prepareBridgeRuntime } from "./bridge.js";
import { GAME_IDS, GAME_PROFILES, activeGame, expectedExeSha256, gameDir, gameExe, gameProfile, setActiveGame, type GameId } from "./config.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);

async function stopLaunchedProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch { /* process already exited */ }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(1000),
    ]);
  }
  child.unref();
}

async function sha256(file: string): Promise<string> {
  const data = await fs.readFile(file);
  return createHash("sha256").update(data).digest("hex").toUpperCase();
}

export async function getGameInfo(): Promise<Record<string, unknown>> {
  const expected = expectedExeSha256();
  const required = ["Game.exe", "Game.ini", "Data/Scripts.rvdata2", "Game.rgss3a~"];
  const files = await Promise.all(required.map(async (name) => {
    const fullPath = path.join(gameDir(), ...name.split("/"));
    try {
      const stat = await fs.stat(fullPath);
      const hash = name === "Game.exe" ? await sha256(fullPath) : undefined;
      return {
        name,
        exists: true,
        bytes: stat.size,
        ...(hash ? {
          sha256: hash,
          integrity_ok: expected ? hash === expected : null,
        } : {}),
      };
    } catch { return { name, exists: false }; }
  }));
  let version: string | null = null;
  try { version = (await fs.readFile(path.join(gameDir(), "ver.txt"), "utf8")).trim(); } catch { /* optional */ }
  const executable = files.find((entry) => entry.name === "Game.exe") as { integrity_ok?: boolean } | undefined;
  return {
    game: gameProfile().title,
    game_id: activeGame(),
    edition: "MCP",
    engine: "RPG Maker VX Ace / RGSS3",
    directory: gameDir(),
    version,
    executable_integrity_ok: expected ? executable?.integrity_ok === true : null,
    expected_game_exe_sha256: expected || null,
    files,
  };
}

export async function listSaves(): Promise<Array<Record<string, unknown>>> {
  const entries = await fs.readdir(gameDir(), { withFileTypes: true });
  const saves = entries.filter((entry) => entry.isFile() && /^Save\d+\.rvdata2$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  return Promise.all(saves.map(async (entry) => {
    const stat = await fs.stat(path.join(gameDir(), entry.name));
    const displaySlot = Number(entry.name.match(/\d+/)?.[0]);
    // save/load tool inputs are zero-indexed, so the machine-facing slot returned
    // here must be directly reusable. Keep the filename's one-based number explicit
    // for humans instead of silently mixing two incompatible numbering systems.
    return { name: entry.name, slot: displaySlot - 1, display_slot: displaySlot, bytes: stat.size, modified: stat.mtime.toISOString() };
  }));
}

// Minimizing right after launch keeps the operator's real keyboard away from the game
// window (a focused RPG Maker window eats every keystroke typed on the machine). The
// bridge's background wake keeps inputs working while minimized.
const MINIMIZE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id ([int]$env:BLACK_SOULS_MINIMIZE_PID) -ErrorAction Stop
for ($i = 0; $i -lt 40 -and $process.MainWindowHandle -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $process.Refresh() }
if ($process.MainWindowHandle -eq [IntPtr]::Zero) { exit 4 }
Add-Type '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);' -Name Win -Namespace BlackSouls
if (-not [BlackSouls.Win]::ShowWindowAsync($process.MainWindowHandle, 6)) { exit 5 }
`;
const MINIMIZE_SCRIPT_BASE64 = Buffer.from(MINIMIZE_SCRIPT, "utf16le").toString("base64");

type ProcessIdentity = "match" | "mismatch" | "missing" | "unknown";
const PROCESS_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id ([int]$env:BLACK_SOULS_PROCESS_PID) -ErrorAction SilentlyContinue
if ($null -eq $process) { [Console]::Out.Write('missing'); exit 0 }
try {
  $expected = [IO.Path]::GetFullPath($env:BLACK_SOULS_EXPECTED_EXE)
  $actual = [IO.Path]::GetFullPath($process.Path)
  if ([StringComparer]::OrdinalIgnoreCase.Equals($expected, $actual)) {
    [Console]::Out.Write('match')
  } else {
    [Console]::Out.Write('mismatch')
  }
} catch {
  [Console]::Out.Write('unknown')
}
`;
const PROCESS_IDENTITY_SCRIPT_BASE64 = Buffer.from(PROCESS_IDENTITY_SCRIPT, "utf16le").toString("base64");

const TERMINATE_GAME_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id ([int]$env:BLACK_SOULS_PROCESS_PID) -ErrorAction SilentlyContinue
if ($null -eq $process) { [Console]::Out.Write('missing'); exit 0 }
try {
  $expected = [IO.Path]::GetFullPath($env:BLACK_SOULS_EXPECTED_EXE)
  $actual = [IO.Path]::GetFullPath($process.Path)
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($expected, $actual)) {
    [Console]::Out.Write('mismatch')
    exit 0
  }
  $process.Kill()
  if ($process.WaitForExit(5000)) { [Console]::Out.Write('killed') }
  else { [Console]::Out.Write('still_alive') }
} catch {
  [Console]::Out.Write('unknown')
}
`;
const TERMINATE_GAME_SCRIPT_BASE64 = Buffer.from(TERMINATE_GAME_SCRIPT, "utf16le").toString("base64");

async function runWindowsProcessGuard(script: string, pid: number): Promise<string> {
  const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", script,
  ], {
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 128 * 1024,
    env: {
      ...process.env,
      BLACK_SOULS_PROCESS_PID: String(pid),
      BLACK_SOULS_EXPECTED_EXE: gameExe(),
    },
  });
  return stdout.trim();
}

async function inspectProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!isAlive(pid)) return "missing";
  if (process.platform !== "win32") return "unknown";
  try {
    const result = await runWindowsProcessGuard(PROCESS_IDENTITY_SCRIPT_BASE64, pid);
    return (["match", "mismatch", "missing", "unknown"] as const).includes(result as ProcessIdentity)
      ? result as ProcessIdentity : "unknown";
  } catch {
    return isAlive(pid) ? "unknown" : "missing";
  }
}

async function minimizeGameWindow(pid: number): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    await execFileAsync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", MINIMIZE_SCRIPT_BASE64,
    ], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 128 * 1024,
      env: { ...process.env, BLACK_SOULS_MINIMIZE_PID: String(pid) },
    });
    return true;
  } catch { return false; }
}

const FIND_GAME_BY_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::GetFullPath($env:BLACK_SOULS_EXPECTED_EXE)
$hits = @()
foreach ($process in Get-Process) {
  try {
    if ($process.Path -and [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($process.Path), $expected)) { $hits += $process.Id }
  } catch { }
}
[Console]::Out.Write(($hits -join ','))
`;
const FIND_GAME_BY_PATH_SCRIPT_BASE64 = Buffer.from(FIND_GAME_BY_PATH_SCRIPT, "utf16le").toString("base64");

// The duplicate-launch guard normally keys off the info snapshots; when those are
// missing or corrupt, only a real process scan can still see a live game.
async function findGameProcessesByPath(): Promise<number[]> {
  const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", FIND_GAME_BY_PATH_SCRIPT_BASE64,
  ], {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 128 * 1024,
    env: { ...process.env, BLACK_SOULS_EXPECTED_EXE: gameExe() },
  });
  return stdout.trim().split(",").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function launchGame(waitMs = 12000, minimizeWindow = true): Promise<Record<string, unknown>> {
  await fs.access(gameExe());
  const executableHash = await sha256(gameExe());
  const expected = expectedExeSha256();
  if (expected && executableHash !== expected) {
    throw new Error(`${gameProfile().title} Game.exe integrity check failed. Expected ${expected}, found ${executableHash}. Restore the independent copy from the Steam original before launch.`);
  }

  const existing = await bridgeStatus();
  if (existing.connected === true) {
    return { launched: false, already_running: true, pid: existing.pid, bridge: existing };
  }
  const existingPid = Number(existing.pid || 0);
  if (existing.process_alive === true && Number.isInteger(existingPid) && existingPid > 0) {
    const identity = await inspectProcessIdentity(existingPid);
    if (identity !== "mismatch" && identity !== "missing") {
      throw new Error(`Refusing to launch a second BLACK SOULS process while PID ${existingPid} is still alive (executable identity: ${identity}). Wait for the existing bridge to recover or terminate that exact game process first.`);
    }
  }
  if (process.platform === "win32") {
    const runningGamePids = await findGameProcessesByPath().catch(() => [] as number[]);
    if (runningGamePids.length) {
      throw new Error(`A BLACK SOULS process (pid ${runningGamePids.join(", ")}) is already running from ${gameExe()} but its bridge snapshots are missing or unreadable. Close that process first, or point ${gameProfile().dirEnv} at its game directory; launching a second copy would give two games one runtime directory.`);
    }
  }

  const launchToken = randomUUID().replaceAll("-", "");
  const runtime = await prepareBridgeRuntime(launchToken);
  const child = spawn(gameExe(), [], { cwd: gameDir(), detached: true, stdio: "ignore", windowsHide: false });
  let spawnError: Error | null = null;
  child.once("error", (error) => { spawnError = error; });
  try {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const observedSpawnError = spawnError as Error | null;
      if (observedSpawnError) throw new Error(`Could not start Game.exe: ${observedSpawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        const currentHash = await sha256(gameExe()).catch(() => "missing");
        throw new Error(`Game process exited before the bridge was ready (code=${child.exitCode}, signal=${child.signalCode || "none"}, Game.exe sha256=${currentHash}).`);
      }
      const status = await bridgeStatus();
      if (
        status.connected === true
        && Number(status.pid) === child.pid
        && String(status.launch_token || "") === launchToken
      ) {
        child.unref();
        const windowMinimized = minimizeWindow && child.pid ? await minimizeGameWindow(child.pid) : false;
        return { launched: true, pid: child.pid, launch_token: launchToken, window_minimized: windowMinimized, runtime, bridge: status };
      }
      await sleep(100);
    }
    const currentHash = await sha256(gameExe()).catch(() => "missing");
    throw new Error(`Game process ${child.pid} did not publish a matching bridge within ${waitMs}ms (Game.exe sha256=${currentHash}).`);
  } catch (error) {
    await stopLaunchedProcess(child);
    throw error;
  }
}

export interface KillResult {
  ok: boolean;
  pid: number | null;
  signal: string;
  message: string;
}

async function latestInfoPid(): Promise<number | null> {
  const directory = path.join(bridgeRuntimeDirectory(), "info");
  try {
    const names = (await fs.readdir(directory)).filter((name) => /^info-.*\.json$/i.test(name));
    const candidates = await Promise.all(names.map(async (name) => {
      const file = path.join(directory, name);
      try { return { file, mtime: (await fs.stat(file)).mtimeMs }; } catch { return null; }
    }));
    for (const entry of candidates.filter((value): value is { file: string; mtime: number } => value !== null)
      .sort((a, b) => b.mtime - a.mtime)) {
      try {
        const pid = Number(JSON.parse(await fs.readFile(entry.file, "utf8")).pid);
        if (Number.isInteger(pid) && pid > 0) return pid;
      } catch { /* try the next snapshot */ }
    }
    try {
      const pid = Number(JSON.parse(await fs.readFile(path.join(bridgeRuntimeDirectory(), "info.json"), "utf8")).pid);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch { return null; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function killGame(): Promise<KillResult> {
  const pid = await latestInfoPid();
  if (pid === null || !isAlive(pid)) return { ok: true, pid: pid && isAlive(pid) ? pid : null, signal: "none", message: "not running" };
  if (process.platform === "win32") {
    const result = await runWindowsProcessGuard(TERMINATE_GAME_SCRIPT_BASE64, pid).catch(() => isAlive(pid) ? "unknown" : "missing");
    if (result === "mismatch") throw new Error(`Refusing to terminate PID ${pid}: its executable does not match ${gameExe()}`);
    if (result === "unknown") throw new Error(`Refusing to terminate PID ${pid}: its executable identity could not be verified as ${gameExe()}`);
    const alive = isAlive(pid);
    return { ok: !alive, pid, signal: result === "killed" ? "verified process kill" : "none", message: alive ? "process still running" : "terminated" };
  }
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (isAlive(pid)) throw error; }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isAlive(pid)) await sleep(50);
  let signal = "SIGTERM";
  if (isAlive(pid)) { process.kill(pid, "SIGKILL"); signal = "SIGKILL"; }
  return { ok: !isAlive(pid), pid, signal, message: isAlive(pid) ? "process still running" : "terminated" };
}

async function gameIsRunning(): Promise<{ running: boolean; pid: number | null }> {
  const status = await bridgeStatus();
  const pid = Number(status.pid || 0);
  if (status.connected === true || (status.process_alive === true && pid > 0)) return { running: true, pid: pid > 0 ? pid : null };
  if (process.platform === "win32") {
    // A crashed bridge leaves no readable snapshot but the process may still hold the copy.
    const pids = await findGameProcessesByPath().catch(() => [] as number[]);
    if (pids.length) return { running: true, pid: pids[0] };
  }
  return { running: false, pid: null };
}

export async function listGames(): Promise<Record<string, unknown>> {
  const games = await Promise.all(GAME_IDS.map(async (id) => {
    const profile = GAME_PROFILES[id];
    const prepared = await fs.access(gameExe(id)).then(() => true, () => false);
    return { id, title: profile.title, directory: gameDir(id), prepared, directory_env: profile.dirEnv, sha256_env: profile.hashEnv };
  }));
  return { active: activeGame(), games };
}

// Switching while a game runs would orphan it: every later tool call would look in the
// other copy's BridgeRuntime, report "not running", and could launch a second process.
export async function selectGame(id: GameId): Promise<Record<string, unknown>> {
  const previous = activeGame();
  if (id === previous) return { switched: false, ...(await listGames()) };
  const current = await gameIsRunning();
  if (current.running) {
    throw new Error(`${gameProfile(previous).title} is still running${current.pid ? ` (pid ${current.pid})` : ""}. Save if needed, close it with black_souls_kill, then select ${GAME_PROFILES[id].title}.`);
  }
  setActiveGame(id);
  return { switched: true, previous, ...(await listGames()) };
}

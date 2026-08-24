import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { bridgeRuntimeDirectory, bridgeStatus, prepareBridgeRuntime } from "./bridge.js";
import { gameDir, gameExe } from "./config.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
export const KNOWN_GAME_EXE_SHA256 = "E4447454C551B96C833E7ED4C7114F807C86FE32F0757C206BEDDA94AC85BC2B";
export const EXPECTED_GAME_EXE_SHA256 = (
  process.env.BLACK_SOULS_GAME_EXE_SHA256 ?? KNOWN_GAME_EXE_SHA256
).trim().toUpperCase();

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
          integrity_ok: EXPECTED_GAME_EXE_SHA256 ? hash === EXPECTED_GAME_EXE_SHA256 : null,
        } : {}),
      };
    } catch { return { name, exists: false }; }
  }));
  let version: string | null = null;
  try { version = (await fs.readFile(path.join(gameDir(), "ver.txt"), "utf8")).trim(); } catch { /* optional */ }
  const executable = files.find((entry) => entry.name === "Game.exe") as { integrity_ok?: boolean } | undefined;
  return {
    game: "BLACK SOULS",
    edition: "MCP",
    engine: "RPG Maker VX Ace / RGSS3",
    directory: gameDir(),
    version,
    executable_integrity_ok: EXPECTED_GAME_EXE_SHA256 ? executable?.integrity_ok === true : null,
    expected_game_exe_sha256: EXPECTED_GAME_EXE_SHA256 || null,
    files,
  };
}

export async function listSaves(): Promise<Array<Record<string, unknown>>> {
  const entries = await fs.readdir(gameDir(), { withFileTypes: true });
  const saves = entries.filter((entry) => entry.isFile() && /^Save\d+\.rvdata2$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  return Promise.all(saves.map(async (entry) => {
    const stat = await fs.stat(path.join(gameDir(), entry.name));
    return { name: entry.name, slot: Number(entry.name.match(/\d+/)?.[0]), bytes: stat.size, modified: stat.mtime.toISOString() };
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

export async function launchGame(waitMs = 12000, minimizeWindow = true): Promise<Record<string, unknown>> {
  await fs.access(gameExe());
  const executableHash = await sha256(gameExe());
  if (EXPECTED_GAME_EXE_SHA256 && executableHash !== EXPECTED_GAME_EXE_SHA256) {
    throw new Error(`Game.exe integrity check failed. Expected ${EXPECTED_GAME_EXE_SHA256}, found ${executableHash}. Restore the independent copy from the Steam original before launch.`);
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

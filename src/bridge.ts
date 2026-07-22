import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gameDir, installRoot } from "./config.js";

export const BRIDGE_PROTOCOL = "black-souls-bridge/1";
export const ACTIONS = [
  "move_up", "move_down", "move_left", "move_right",
  "confirm", "cancel", "open_menu", "page_up", "page_down", "dash",
] as const;
export type Action = typeof ACTIONS[number];
export type SequenceStep = { action: Action; repeat?: number } | { wait_frames: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runtimeDir = () => path.join(gameDir(), "BridgeRuntime");
const inboxDir = () => path.join(runtimeDir(), "inbox");
const outboxDir = () => path.join(runtimeDir(), "outbox");
const infoDir = () => path.join(runtimeDir(), "info");
const stateDir = () => path.join(runtimeDir(), "state");
const mapDir = () => path.join(runtimeDir(), "map");
const launchTokenFile = () => path.join(runtimeDir(), "launch.token");
const TRANSIENT_FILE_CODES = new Set(["EACCES", "EPERM", "EBUSY", "ENFILE", "EMFILE"]);
const HEARTBEAT_MAX_AGE_MS = 60000;
const MAX_PENDING_COMMANDS = 128;
const MAX_SEQUENCE_FRAMES = 3600;
const execFileAsync = promisify(execFile);
const WINDOWS_WAKE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$pidValue = [int]$env:BLACK_SOULS_WAKE_PID
$expected = [IO.Path]::GetFullPath($env:BLACK_SOULS_WAKE_EXE)
$process = Get-Process -Id $pidValue -ErrorAction Stop
$actual = [IO.Path]::GetFullPath($process.Path)
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($expected, $actual)) { exit 3 }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BlackSoulsWindowWake {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool PostMessage(IntPtr hWnd, UInt32 message, IntPtr wParam, IntPtr lParam);
}
'@
$window = $process.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { exit 4 }
$activateApp = [BlackSoulsWindowWake]::PostMessage($window, 0x001C, [IntPtr]1, [IntPtr]0)
$activate = [BlackSoulsWindowWake]::PostMessage($window, 0x0006, [IntPtr]1, [IntPtr]0)
$focus = [BlackSoulsWindowWake]::PostMessage($window, 0x0007, [IntPtr]0, [IntPtr]0)
if (-not ($activateApp -and $activate -and $focus)) { exit 5 }
`;
const WINDOWS_WAKE_SCRIPT_BASE64 = Buffer.from(WINDOWS_WAKE_SCRIPT, "utf16le").toString("base64");

export function bridgeRuntimeDirectory(): string { return runtimeDir(); }

class BridgeJsonUnavailableError extends Error {
  constructor(file: string, cause: unknown) {
    super(`Could not read valid bridge JSON at ${file}: ${String(cause)}`);
    this.name = "BridgeJsonUnavailableError";
  }
}

async function retryFileOperation<T>(operation: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!TRANSIENT_FILE_CODES.has(String(code)) || attempt === attempts - 1) throw error;
      await sleep(15 * (attempt + 1));
    }
  }
  throw lastError;
}

async function readJsonWithRetry<T>(file: string, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return JSON.parse(await retryFileOperation(() => fs.readFile(file, "utf8"), 3)) as T; }
    catch (error) { lastError = error; await sleep(12 * (attempt + 1)); }
  }
  throw new BridgeJsonUnavailableError(file, lastError);
}

async function existingDirectoryFiles(directory: string, prefix: string): Promise<string[]> {
  try {
    const names = await retryFileOperation(() => fs.readdir(directory));
    const candidates = names.filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".json"));
    const details = await Promise.all(candidates.map(async (name) => {
      const file = path.join(directory, name);
      try { return { file, mtime: (await fs.stat(file)).mtimeMs }; }
      catch { return null; }
    }));
    return details.filter((entry): entry is { file: string; mtime: number } => entry !== null)
      .sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readNewestJson(
  directory: string,
  prefix: string,
  legacyFile: string,
  expectedToken?: string,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  let inspected = 0;
  for (let scan = 0; scan < 4; scan += 1) {
    const files = await existingDirectoryFiles(directory, prefix);
    files.push(path.join(runtimeDir(), legacyFile));
    for (const file of files) {
      if (inspected >= 256) break;
      inspected += 1;
      try {
        const value = await readJsonWithRetry<Record<string, unknown>>(file, 2);
        if (expectedToken && String(value.launch_token || "") !== expectedToken) continue;
        return value;
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
    }
    if (scan < 3) await sleep(15 * (scan + 1));
  }
  throw new Error(`No valid ${prefix} snapshot is available in ${runtimeDir()}: ${String(lastError || "not found")}`);
}

async function readInfo(): Promise<Record<string, unknown>> {
  return readNewestJson(infoDir(), "info", "info.json");
}

async function readStateSnapshot(expectedToken?: string): Promise<Record<string, unknown>> {
  return readNewestJson(stateDir(), "state", "state.json", expectedToken);
}

async function readMapSnapshot(expectedToken?: string): Promise<Record<string, unknown>> {
  return readNewestJson(mapDir(), "map", "map.json", expectedToken);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function statusFailure(status: Record<string, unknown>): Error {
  const reasons = Array.isArray(status.reasons) ? status.reasons.join(", ") : String(status.reason || "bridge unavailable");
  return new Error(`BLACK SOULS bridge is not ready (${reasons}). Start the MCP edition with black_souls_launch.`);
}

export async function bridgeStatus(): Promise<Record<string, unknown>> {
  try {
    const info = await readInfo();
    const token = String(info.launch_token || "");
    const state = await readStateSnapshot(token || undefined);
    const infoPid = Number(info.pid || 0);
    const statePid = Number(state.pid || 0);
    const updatedAt = Number(state.updated_at || 0) * 1000;
    const ageMs = Date.now() - updatedAt;
    const heartbeatLimitMs = HEARTBEAT_MAX_AGE_MS;
    const processAlive = processIsAlive(infoPid);
    const reasons: string[] = [];
    if (String(info.protocol || "") !== BRIDGE_PROTOCOL || String(state.protocol || "") !== BRIDGE_PROTOCOL) reasons.push("protocol_mismatch");
    if (!token || String(state.launch_token || "") !== token) reasons.push("launch_token_mismatch");
    if (infoPid <= 0 || statePid !== infoPid) reasons.push("pid_mismatch");
    if (!processAlive) reasons.push("process_not_running");
    if (!Number.isFinite(ageMs) || ageMs < -2000 || ageMs >= heartbeatLimitMs) reasons.push("stale_heartbeat");
    return {
      connected: reasons.length === 0,
      process_alive: processAlive,
      heartbeat_age_ms: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs)) : null,
      heartbeat_limit_ms: heartbeatLimitMs,
      runtime_directory: runtimeDir(),
      protocol: info.protocol,
      bridge_version: info.bridge_version,
      pid: infoPid,
      launch_token: token || null,
      capabilities: info.capabilities,
      frame: state.frame,
      scene: state.scene,
      reasons,
    };
  } catch (error) {
    return {
      connected: false,
      process_alive: false,
      runtime_directory: runtimeDir(),
      reasons: ["bridge_files_unavailable"],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function requireConnectedStatus(): Promise<Record<string, unknown>> {
  const status = await bridgeStatus();
  if (status.connected !== true) throw statusFailure(status);
  return status;
}

async function wakeWindowsGameLoop(pid: number): Promise<void> {
  if (process.platform !== "win32") return;
  const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await execFileAsync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", WINDOWS_WAKE_SCRIPT_BASE64,
  ], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 128 * 1024,
    env: {
      ...process.env,
      BLACK_SOULS_WAKE_PID: String(pid),
      BLACK_SOULS_WAKE_EXE: path.join(gameDir(), "Game.exe"),
    },
  });
}

async function requireInputReadyStatus(): Promise<Record<string, unknown>> {
  let status = await bridgeStatus();
  const reasons = Array.isArray(status.reasons) ? status.reasons.map(String) : [];
  const pid = Number(status.pid || 0);
  const wakeable = status.connected !== true
    && status.process_alive === true
    && Number.isInteger(pid) && pid > 0
    && reasons.every((reason) => reason === "stale_heartbeat");
  if (process.platform === "win32" && wakeable) {
    const previousFrame = Number(status.frame || 0);
    try {
      await wakeWindowsGameLoop(pid);
    } catch (error) {
      throw new Error(`Could not wake the BLACK SOULS keyboard loop for PID ${pid}: ${String(error)}`);
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(50);
      status = await bridgeStatus();
      if (status.connected === true && Number(status.frame || 0) > previousFrame) return status;
    }
    throw new Error(`BLACK SOULS PID ${pid} did not resume its keyboard loop after a background wake command`);
  }
  if (status.connected !== true) throw statusFailure(status);
  return status;
}

function ensureSnapshotMatches(snapshot: Record<string, unknown>, status: Record<string, unknown>, kind: string): void {
  if (String(snapshot.protocol || "") !== BRIDGE_PROTOCOL) throw new Error(`${kind} snapshot protocol mismatch`);
  if (Number(snapshot.pid || 0) !== Number(status.pid || 0)) throw new Error(`${kind} snapshot PID mismatch`);
  if (String(snapshot.launch_token || "") !== String(status.launch_token || "")) throw new Error(`${kind} snapshot launch token mismatch`);
}

export async function readState(): Promise<Record<string, unknown>> {
  const status = await requireConnectedStatus();
  const state = await readStateSnapshot(String(status.launch_token));
  ensureSnapshotMatches(state, status, "State");
  return state;
}

export async function readMap(): Promise<Record<string, unknown>> {
  const status = await requireConnectedStatus();
  const map = await readMapSnapshot(String(status.launch_token));
  ensureSnapshotMatches(map, status, "Map");
  return map;
}

function encodeSteps(steps: SequenceStep[]): string {
  if (!steps.length || steps.length > 200) throw new Error("Sequence must contain 1 to 200 steps");
  let frameBudget = 0;
  const encoded = steps.map((step) => {
    if ("wait_frames" in step) {
      const frames = Math.trunc(step.wait_frames);
      if (frames < 1 || frames > 600) throw new Error("wait_frames must be from 1 to 600");
      frameBudget += frames;
      return `wait:${frames}`;
    }
    if (!ACTIONS.includes(step.action)) throw new Error(`Unsupported action: ${step.action}`);
    const repeat = Math.trunc(step.repeat ?? 1);
    if (repeat < 1 || repeat > 100) throw new Error("repeat must be from 1 to 100");
    frameBudget += repeat * 2 - 1;
    return `${step.action}:${repeat}`;
  });
  if (frameBudget > MAX_SEQUENCE_FRAMES) {
    throw new Error(`Sequence requires ${frameBudget} frames; the maximum is ${MAX_SEQUENCE_FRAMES}`);
  }
  return encoded.join(";");
}

async function writeCommand(finalPath: string, payload: string): Promise<void> {
  const tempPath = `${finalPath}.tmp.${process.pid}.${randomUUID().replaceAll("-", "")}`;
  try {
    await retryFileOperation(() => fs.writeFile(tempPath, payload, { encoding: "ascii", flag: "wx" }));
    await retryFileOperation(() => fs.rename(tempPath, finalPath));
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function stateAtOrAfter(token: string, frame: number, timeoutMs = 1200): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await readStateSnapshot(token);
      if (Number(state.frame || 0) >= frame) return state;
    } catch { /* the command response remains useful */ }
    await sleep(20);
  }
  return null;
}

export async function sendSequence(steps: SequenceStep[], timeoutMs = 60000): Promise<Record<string, unknown>> {
  const status = await requireInputReadyStatus();
  const launchToken = String(status.launch_token || "");
  const frameBefore = Number(status.frame || 0);
  await fs.mkdir(inboxDir(), { recursive: true });
  await fs.mkdir(outboxDir(), { recursive: true });
  const pendingCommands = (await fs.readdir(inboxDir())).filter((name) => name.endsWith(".cmd")).length;
  if (pendingCommands >= MAX_PENDING_COMMANDS) {
    throw new Error(`Bridge command queue is full (${pendingCommands}/${MAX_PENDING_COMMANDS}); wait for pending commands to finish`);
  }
  const id = randomUUID().replaceAll("-", "");
  const finalPath = path.join(inboxDir(), `${id}.cmd`);
  const responsePath = path.join(outboxDir(), `${id}.json`);
  const payload = `id=${id}\ntoken=${launchToken}\nsteps=${encodeSteps(steps)}\n`;
  await writeCommand(finalPath, payload);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await readJsonWithRetry<Record<string, unknown>>(responsePath, 2);
      if (String(response.id || "") !== id) throw new Error(`Bridge response command ID mismatch for ${id}`);
      if (String(response.launch_token || "") !== launchToken) throw new Error(`Bridge response launch token mismatch for ${id}`);
      await fs.unlink(responsePath).catch(() => undefined);
      if (response.ok === false) throw new Error(String(response.error || "Bridge rejected command"));
      const responseFrame = Number(response.frame || frameBefore);
      const state = await stateAtOrAfter(launchToken, responseFrame);
      return {
        ok: true,
        protocol: BRIDGE_PROTOCOL,
        bridge_version: status.bridge_version,
        pid: status.pid,
        launch_token: launchToken,
        command_id: id,
        frame_before: frameBefore,
        frame: responseFrame,
        response,
        state,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof BridgeJsonUnavailableError)) throw error;
    }
    await sleep(16);
  }
  let removedBeforePickup = false;
  try {
    await fs.unlink(finalPath);
    removedBeforePickup = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const current = await bridgeStatus();
  const detail = current.connected === true ? "bridge remained connected" : `bridge disconnected: ${JSON.stringify(current.reasons || current.reason)}`;
  const execution = removedBeforePickup
    ? "the pending file was removed before bridge pickup"
    : "the bridge may already have consumed the command; inspect state before retrying";
  throw new Error(`Bridge command ${id} timed out after ${timeoutMs}ms (${detail}; ${execution})`);
}

export async function sendAction(action: Action, repeat = 1, timeoutMs = 60000) {
  return sendSequence([{ action, repeat }], timeoutMs);
}

export async function prepareBridgeRuntime(launchToken: string): Promise<{ archived_runtime: string | null; runtime_directory: string }> {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(launchToken)) throw new Error("Invalid launch token");
  const runtime = runtimeDir();
  let archivedRuntime: string | null = null;
  try {
    await fs.access(runtime);
    const archiveRoot = path.join(installRoot(), "extract");
    await fs.mkdir(archiveRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const destination = path.join(archiveRoot, `BridgeRuntime-stale-${stamp}-${randomUUID().slice(0, 8)}`);
    await retryFileOperation(() => fs.rename(runtime, destination), 8);
    archivedRuntime = destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await Promise.all([inboxDir(), outboxDir(), infoDir(), stateDir(), mapDir()].map((directory) => fs.mkdir(directory, { recursive: true })));
  const temp = `${launchTokenFile()}.tmp.${process.pid}`;
  await fs.writeFile(temp, `${launchToken}\n`, { encoding: "ascii", flag: "wx" });
  await retryFileOperation(() => fs.rename(temp, launchTokenFile()));
  return { archived_runtime: archivedRuntime, runtime_directory: runtime };
}

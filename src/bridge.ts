import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gameDir, installRoot } from "./config.js";

export const BRIDGE_PROTOCOL = "black-souls-bridge/1";
export const ACTIONS = [
  "move_up", "move_down", "move_left", "move_right",
  "dash_up", "dash_down", "dash_left", "dash_right",
  "confirm", "cancel", "open_menu", "page_up", "page_down", "dash", "text_skip",
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
// Remembered across calls so a failed snapshot read can still tell "the game died" apart
// from "the game is alive but I could not read a file this instant".
let lastKnownPid = 0;
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
    // The writer rotates snapshots every few frames, so a scan can list a set of files that
    // are all deleted before any of them is read. Back off past a whole rotation cycle
    // instead of declaring the bridge gone after ~90ms of bad luck.
    if (scan < 3) await sleep(60 * (scan + 1));
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
  const advice = status.process_alive === false
    ? "Start the MCP edition with black_souls_launch."
    : "The game process is still running, so do not relaunch it; wait a moment and read state again.";
  return new Error(`BLACK SOULS bridge is not ready (${reasons}). ${advice}`);
}

export async function bridgeStatus(): Promise<Record<string, unknown>> {
  try {
    const info = await readInfo();
    const token = String(info.launch_token || "");
    const infoPid = Number(info.pid || 0);
    // Recorded before the state read so a snapshot failure still knows which process to ask about.
    if (infoPid > 0) lastKnownPid = infoPid;
    const state = await readStateSnapshot(token || undefined);
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
    // Failing to read a snapshot says nothing about the game being alive. Claiming the
    // process died here sent an earlier playtester chasing a phantom crash while the game
    // was sitting on screen waiting for a keypress, so answer "unknown" unless the last
    // known PID proves otherwise.
    const alive = lastKnownPid > 0 ? processIsAlive(lastKnownPid) : null;
    return {
      connected: false,
      process_alive: alive,
      pid: lastKnownPid > 0 ? lastKnownPid : null,
      runtime_directory: runtimeDir(),
      reasons: [alive === true ? "bridge_files_unreadable_process_alive" : "bridge_files_unavailable"],
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

// RPG Maker suspends its whole frame loop whenever the window is not active, which a
// minimized window always is. Waiting for the 60s heartbeat limit before reacting made
// every call after an idle moment stall for a minute, so nudge as soon as the snapshot
// stops being fresh — the game is asleep, not broken.
const HEARTBEAT_NUDGE_MS = 1200;

async function requireInputReadyStatus(): Promise<Record<string, unknown>> {
  let status = await bridgeStatus();
  const reasons = Array.isArray(status.reasons) ? status.reasons.map(String) : [];
  const pid = Number(status.pid || 0);
  const heartbeatAge = Number(status.heartbeat_age_ms ?? Number.POSITIVE_INFINITY);
  const wakeable = status.process_alive === true
    && Number.isInteger(pid) && pid > 0
    && reasons.every((reason) => reason === "stale_heartbeat")
    && (status.connected !== true || !Number.isFinite(heartbeatAge) || heartbeatAge > HEARTBEAT_NUDGE_MS);
  if (process.platform === "win32" && wakeable) {
    const previousFrame = Number(status.frame || 0);
    // Long in-engine cutscenes (battle settlement, transitions) can hold the loop for a
    // while, so retry the wake instead of giving up after one nudge.
    const connectedBefore = status.connected === true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await wakeWindowsGameLoop(pid);
      } catch (error) {
        // A merely-drowsy bridge is still usable, so never let a failed nudge break a
        // call that would otherwise succeed; only a disconnected bridge is fatal.
        if (connectedBefore) return status;
        if (!processIsAlive(pid)) throw new Error(`BLACK SOULS PID ${pid} is no longer running; call black_souls_launch to restart it`);
        throw new Error(`Could not wake the BLACK SOULS keyboard loop for PID ${pid}: ${String(error)}`);
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(50);
        status = await bridgeStatus();
        if (status.connected === true && Number(status.frame || 0) > previousFrame) return status;
      }
      if (!processIsAlive(pid)) break;
    }
    if (!processIsAlive(pid)) {
      throw new Error(`BLACK SOULS PID ${pid} exited while the bridge was waiting for it; the game is gone, call black_souls_launch to restart`);
    }
    if (status.connected === true) return status;
    throw new Error(`BLACK SOULS PID ${pid} is still running but published no new frame within 15s. The game is alive — it is most likely inside a long in-engine cutscene or waiting on a modal prompt. Read state again in a few seconds before assuming anything failed.`);
  }
  if (status.connected !== true) throw statusFailure(status);
  return status;
}

function ensureSnapshotMatches(snapshot: Record<string, unknown>, status: Record<string, unknown>, kind: string): void {
  if (String(snapshot.protocol || "") !== BRIDGE_PROTOCOL) throw new Error(`${kind} snapshot protocol mismatch`);
  if (Number(snapshot.pid || 0) !== Number(status.pid || 0)) throw new Error(`${kind} snapshot PID mismatch`);
  if (String(snapshot.launch_token || "") !== String(status.launch_token || "")) throw new Error(`${kind} snapshot launch token mismatch`);
}

// State/map reads go through the wake-capable check: RPG Maker pauses its loop in the
// background, and without a wake every read tool fails with stale_heartbeat after ~60s
// of idling even though the game is healthy.
export async function readState(): Promise<Record<string, unknown>> {
  const status = await requireInputReadyStatus();
  const state = await readStateSnapshot(String(status.launch_token));
  ensureSnapshotMatches(state, status, "State");
  return state;
}

export async function readMap(): Promise<Record<string, unknown>> {
  const status = await requireInputReadyStatus();
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

// A suspended game will not pick a command out of the inbox at all, so keep nudging it
// awake for as long as we are waiting on a response instead of letting it sleep.
function commandLoopNudger(pid: number): () => Promise<void> {
  let nextNudge = Date.now() + 1500;
  let running = false;
  return async () => {
    if (process.platform !== "win32" || running || Date.now() < nextNudge) return;
    if (!Number.isInteger(pid) || pid <= 0 || !processIsAlive(pid)) return;
    running = true;
    try { await wakeWindowsGameLoop(pid); } catch { /* best effort; the poll loop reports real failures */ }
    finally { running = false; nextNudge = Date.now() + 1500; }
  };
}

async function stateAtOrAfter(token: string, frame: number, previousFrame: number, responseWrittenAtMs: number, timeoutMs = 1200): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  const frameReset = frame < previousFrame;
  while (Date.now() < deadline) {
    try {
      const state = await readStateSnapshot(token);
      const stateFrame = Number(state.frame || 0);
      const stateUpdatedAtMs = Number(state.updated_at || 0) * 1000;
      // DataManager.setup_new_game and load_game reset Graphics.frame_count. In that
      // case an old snapshot from before the transition has a much larger frame number
      // and would otherwise be accepted immediately as the post-command state. A valid
      // post-reset snapshot may already climb past previousFrame on a slow filesystem,
      // so its bridge timestamp can also prove it was written after the response.
      const postResponse = Number.isFinite(stateUpdatedAtMs) && stateUpdatedAtMs >= responseWrittenAtMs;
      if (stateFrame >= frame && (!frameReset || stateFrame < previousFrame || postResponse)) return state;
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

  const nudge = commandLoopNudger(Number(status.pid || 0));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await readJsonWithRetry<Record<string, unknown>>(responsePath, 2);
      const responseWrittenAtMs = (await fs.stat(responsePath)).mtimeMs;
      if (String(response.id || "") !== id) throw new Error(`Bridge response command ID mismatch for ${id}`);
      if (String(response.launch_token || "") !== launchToken) throw new Error(`Bridge response launch token mismatch for ${id}`);
      await fs.unlink(responsePath).catch(() => undefined);
      if (response.ok === false) throw new Error(String(response.error || "Bridge rejected command"));
      const responseFrame = Number(response.frame || frameBefore);
      const state = await stateAtOrAfter(launchToken, responseFrame, frameBefore, responseWrittenAtMs);
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
    await nudge();
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

export async function sendQuery(queryName: string, params = "", timeoutMs = 10000): Promise<unknown> {
  if (!/^[a-z_]{1,64}$/.test(queryName)) throw new Error("Invalid query name");
  if (params.length > 1024 || /[\r\n]/.test(params)) throw new Error("Invalid query params");
  const status = await requireInputReadyStatus();
  const launchToken = String(status.launch_token || "");
  await fs.mkdir(inboxDir(), { recursive: true });
  await fs.mkdir(outboxDir(), { recursive: true });
  const pendingCommands = (await fs.readdir(inboxDir())).filter((name) => name.endsWith(".cmd")).length;
  if (pendingCommands >= MAX_PENDING_COMMANDS) throw new Error(`Bridge command queue is full (${pendingCommands}/${MAX_PENDING_COMMANDS})`);
  const id = randomUUID().replaceAll("-", "");
  const finalPath = path.join(inboxDir(), `${id}.cmd`);
  const responsePath = path.join(outboxDir(), `${id}.json`);
  await writeCommand(finalPath, `id=${id}\ntoken=${launchToken}\ntype=query\nquery=${queryName}\nparams=${params}\n`);
  const nudge = commandLoopNudger(Number(status.pid || 0));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await readJsonWithRetry<Record<string, unknown>>(responsePath, 2);
      if (String(response.id || "") !== id) throw new Error(`Bridge response command ID mismatch for ${id}`);
      if (String(response.launch_token || "") !== launchToken) throw new Error(`Bridge response launch token mismatch for ${id}`);
      await fs.unlink(responsePath).catch(() => undefined);
      if (response.ok === false) throw new Error(String(response.error || "Bridge rejected query"));
      return response.data;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof BridgeJsonUnavailableError)) throw error;
    }
    await nudge();
    await sleep(16);
  }
  let removedBeforePickup = false;
  try { await fs.unlink(finalPath); removedBeforePickup = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  throw new Error(`Bridge query ${id} timed out after ${timeoutMs}ms (${removedBeforePickup ? "removed before bridge pickup" : "bridge may have consumed query"})`);
}

export async function queryVariables(ids: number[]): Promise<Record<string, unknown>> {
  const data = objectValue(await sendQuery("variables", [...new Set(ids)].slice(0, 64).join(",")));
  return objectValue(data.variables);
}
export async function querySwitches(ids: number[]): Promise<Record<string, unknown>> {
  const data = objectValue(await sendQuery("switches", [...new Set(ids)].slice(0, 64).join(",")));
  return objectValue(data.switches);
}
export async function queryItems(): Promise<{ items: unknown[] }> {
  const data = objectValue(await sendQuery("items")); return { items: Array.isArray(data.items) ? data.items : [] };
}
export async function queryWeapons(): Promise<{ weapons: unknown[] }> {
  const data = objectValue(await sendQuery("weapons")); return { weapons: Array.isArray(data.weapons) ? data.weapons : [] };
}
export async function queryArmors(): Promise<{ armors: unknown[] }> {
  const data = objectValue(await sendQuery("armors")); return { armors: Array.isArray(data.armors) ? data.armors : [] };
}
export async function queryFullParty(): Promise<Record<string, unknown>> {
  return objectValue(await sendQuery("full_party"));
}

export async function sendAction(action: Action, repeat = 1, timeoutMs = 60000) {
  return sendSequence([{ action, repeat }], timeoutMs);
}

export interface SaveResult {
  ok: boolean; slot: number; saved: boolean; frame_before: number; frame_after: number;
  scene_after: string | null; message: string;
}
export interface LoadResult {
  ok: boolean; slot: number; scene_before: string | null; scene_after: string | null;
  player_after: { x: number; y: number; map_id: number } | null; message: string;
}
export interface SituationSnapshot {
  ok: boolean;
  scene: string | null;
  location: string | null;
  player: { x: number; y: number; direction: number } | null;
  party: Array<{ name: string; hp: number; mhp: number; mp: number; mmp: number; tp: number; level: number; alive: boolean }>;
  gold: number;
  message_text: string | null;
  choices: string[];
  battle_enemies: Array<{ name: string; hp: number; mhp: number; dead: boolean }>;
  nearby_events: Array<{ id: number; name: string; x: number; y: number; dx: number; dy: number }>;
  passable: { up: boolean; down: boolean; left: boolean; right: boolean } | null;
  suggested_actions: string[];
  warnings: string[];
  frame: number;
  updated_at: number;
}

export interface HealthIssue { code: string; severity: "critical" | "warning" | "info"; detail: string }
export interface HealthReport {
  ok: boolean; game_running: boolean; bridge_connected: boolean; state_age_ms: number | null; map_age_ms: number | null;
  last_error_log: string | null; inbox_pending: number; outbox_orphaned: number; memory_ok: boolean;
  issues: HealthIssue[]; recommended_action: string;
}
export type WaitCondition =
  | { type: "scene"; value: string } | { type: "not_scene"; value: string }
  | { type: "message_clear" } | { type: "battle_end" } | { type: "player_stopped" }
  | { type: "frame_advance"; frames: number };
export interface WaitResult { ok: boolean; condition: WaitCondition; elapsed_ms: number; final_scene: string | null; timed_out: boolean }

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const sceneName = (state: Record<string, unknown>): string | null => {
  const value = objectValue(state.scene).name;
  return typeof value === "string" ? value : null;
};

export interface CommandWindowInfo { class: string; active: boolean; index: number; item_max: number; col_max: number; current_symbol: string | null }
export const windowsOf = (state: Record<string, unknown>): CommandWindowInfo[] => {
  const raw = objectValue(state.scene).windows;
  return (Array.isArray(raw) ? raw : []).map(objectValue).map((window) => ({
    class: String(window.class || ""),
    active: window.active === true,
    index: Number(window.index ?? -1),
    item_max: Number(window.item_max || 0),
    col_max: Math.max(1, Number(window.col_max || 1)),
    current_symbol: typeof window.current_symbol === "string" ? window.current_symbol : null,
  }));
};
export const activeWindowOf = (state: Record<string, unknown>): CommandWindowInfo | null =>
  windowsOf(state).find((window) => window.active) || null;

async function cursorStep(action: Action, timeoutMs: number, waitFrames = 6): Promise<Record<string, unknown>> {
  await sendSequence([{ action }, { wait_frames: waitFrames }], timeoutMs);
  return readState();
}

// Closed-loop command selection: rewind the active window's cursor to index 0, then walk
// down until the requested occurrence of a symbol is under the cursor. Every step re-reads
// the real cursor from the game, so sticky indices and dropped inputs self-correct.
export async function selectCommandSymbol(symbol: string, occurrence = 0, timeoutMs = 15000): Promise<Record<string, unknown>> {
  let state = await readState();
  let window = activeWindowOf(state);
  if (!window) throw new Error("No active command window to navigate");
  const itemMax = Math.max(1, window.item_max);
  for (let guard = 0; guard < itemMax * 2 && window.index > 0; guard += 1) {
    const previous = window.index;
    state = await cursorStep("move_up", timeoutMs);
    window = activeWindowOf(state) ?? window;
    if (window.index >= previous) break;
  }
  let matched = 0;
  const startClass = window.class;
  const seen: string[] = [];
  for (let step = 0; step < itemMax; step += 1) {
    state = await readState();
    // A window can read as inactive for a frame or two during a fade-in, so give it a
    // moment. If it never comes back the menu really did close under us, and reusing the
    // previous reading would keep pressing keys into whatever opened next.
    let current = activeWindowOf(state);
    for (let retry = 0; !current && retry < 10; retry += 1) {
      await sleep(250);
      state = await readState();
      current = activeWindowOf(state);
    }
    if (!current) throw new Error(`The ${startClass} menu closed while looking for "${symbol}" (cursor path so far: ${seen.join(", ") || "none"}); read state and retry`);
    window = current;
    if (window.class !== startClass) {
      throw new Error(`The active window changed from ${startClass} to ${window.class} while looking for "${symbol}"`);
    }
    seen.push(`${window.index}=${window.current_symbol ?? "null"}`);
    if (window.current_symbol === symbol) {
      if (matched === occurrence) return state;
      matched += 1;
    }
    state = await cursorStep("move_down", timeoutMs);
  }
  throw new Error(`Command "${symbol}" (occurrence ${occurrence + 1}) was not found in ${startClass}; the cursor walked over ${seen.join(", ")}`);
}

// Closed-loop cursor movement inside any Window_Selectable, grid aware: RPG Maker lays
// item and skill windows out in 2 columns, so the neighbour to the right is index+1 while
// down is index+col_max. Every step re-reads the real cursor, so sticky positions,
// wrap-around and dropped inputs self-correct.
export async function selectWindowIndex(target: number, timeoutMs = 15000): Promise<Record<string, unknown>> {
  let stuck = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await readState();
    const window = activeWindowOf(state);
    if (!window) throw new Error("The selection window disappeared while navigating");
    if (window.index === target) return state;
    if (target >= window.item_max) throw new Error(`Selection index ${target} is out of range (${window.item_max} entries)`);
    const delta = target - window.index;
    const columns = window.col_max;
    const action: Action = delta >= columns ? "move_down"
      : delta > 0 ? "move_right"
      : delta <= -columns ? "move_up"
      : "move_left";
    const after = activeWindowOf(await cursorStep(action, timeoutMs));
    if (after && after.index === window.index) {
      stuck += 1;
      if (stuck >= 4) throw new Error(`Selection cursor is stuck at ${window.index} while targeting ${target}`);
    } else stuck = 0;
  }
  throw new Error(`Could not reach selection index ${target}`);
}

// Closed-loop save-file slot selection driven by the scene's real file_index.
export async function selectSavefileSlot(slot: number, timeoutMs = 20000): Promise<Record<string, unknown>> {
  let stuck = 0;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const state = await readState();
    const fileIndex = objectValue(state.scene).file_index;
    if (fileIndex === null || fileIndex === undefined) throw new Error("The current scene has no save-file cursor");
    const current = Number(fileIndex);
    if (current === slot) return state;
    const next = await cursorStep(current < slot ? "move_down" : "move_up", timeoutMs);
    const after = Number(objectValue(next.scene).file_index ?? current);
    if (after === current) {
      stuck += 1;
      if (stuck >= 3) throw new Error(`Save-file cursor is stuck at ${current} while targeting slot ${slot}`);
    } else stuck = 0;
  }
  throw new Error(`Could not reach save slot ${slot}`);
}

const savefilePath = (slot: number) => path.join(gameDir(), `Save${String(slot + 1).padStart(2, "0")}.rvdata2`);
const playerPosition = (state: Record<string, unknown>) => {
  const player = objectValue(state.player);
  const map = objectValue(state.map);
  return Number.isFinite(Number(player.x)) && Number.isFinite(Number(player.y))
    ? { x: Number(player.x), y: Number(player.y), map_id: Number(map.id || 0) } : null;
};

export async function triggerSave(slot: number, timeoutMs = 30000): Promise<SaveResult> {
  const before = await readState();
  const beforeScene = sceneName(before);
  if (beforeScene !== "Scene_Map") throw new Error(`Save is only available from Scene_Map (current: ${beforeScene || "unknown"})`);
  if (objectValue(before.message).busy) throw new Error("Save is unavailable while a message or choice is active");
  const statBefore = await fs.stat(savefilePath(slot)).catch(() => null);
  await sendSequence([{ action: "open_menu" }, { wait_frames: 12 }], timeoutMs);
  try {
    await selectCommandSymbol("save", 0, timeoutMs);
    await sendSequence([{ action: "confirm" }, { wait_frames: 16 }], timeoutMs);
    const saveScene = await readState();
    if (sceneName(saveScene) !== "Scene_Save") throw new Error(`The save command did not open Scene_Save (got ${sceneName(saveScene) || "unknown"})`);
    await selectSavefileSlot(slot, timeoutMs);
    await sendSequence([{ action: "confirm" }, { wait_frames: 40 }], timeoutMs);
  } finally {
    for (let backOut = 0; backOut < 4; backOut += 1) {
      const current = await readState().catch(() => null);
      if (!current || sceneName(current) === "Scene_Map") break;
      await sendSequence([{ action: "cancel" }, { wait_frames: 12 }], timeoutMs).catch(() => undefined);
    }
  }
  const statAfter = await fs.stat(savefilePath(slot)).catch(() => null);
  const saved = Boolean(statAfter && (!statBefore || statAfter.mtimeMs > statBefore.mtimeMs));
  const after = await readState();
  return {
    ok: saved, slot, saved,
    frame_before: Number(before.frame || 0), frame_after: Number(after.frame || 0),
    scene_after: sceneName(after),
    message: saved ? `save slot ${slot} was written and verified on disk` : "save inputs completed but the save file on disk did not change",
  };
}

export async function triggerLoad(slot: number, timeoutMs = 30000): Promise<LoadResult> {
  const before = await readState();
  const beforeScene = sceneName(before);
  // A previous attempt may have already opened the file list (a timed-out command often
  // still lands), so treat Scene_Load as a resumable mid-point rather than an error.
  if (beforeScene === "Scene_Load") {
    await selectSavefileSlot(slot, timeoutMs);
    await sendSequence([{ action: "confirm" }, { wait_frames: 40 }], timeoutMs);
    const settled = await waitForCondition({ type: "scene", value: "Scene_Map" }, Math.min(timeoutMs, 15000));
    const after = await readState();
    return {
      ok: settled.ok, slot, scene_before: beforeScene, scene_after: sceneName(after), player_after: playerPosition(after),
      message: settled.ok ? "load completed from the already-open file list" : "load inputs were sent but Scene_Map did not appear in time",
    };
  }
  if (beforeScene === "Scene_Title") {
    await selectCommandSymbol("continue", 0, timeoutMs);
    await sendSequence([{ action: "confirm" }, { wait_frames: 10 }], timeoutMs);
    // Some builds open Scene_Load for slot selection; this game's title quick-continues
    // straight into the newest save. Handle both.
    let note = "";
    const deadline = Date.now() + Math.min(timeoutMs, 10000);
    while (Date.now() < deadline) {
      const current = await readState();
      const scene = sceneName(current);
      if (scene === "Scene_Load") {
        await selectSavefileSlot(slot, timeoutMs);
        await sendSequence([{ action: "confirm" }, { wait_frames: 40 }], timeoutMs);
        break;
      }
      if (scene === "Scene_Map") {
        note = "; this game quick-continues into the most recent save, so the slot parameter was not used";
        break;
      }
      await sleep(150);
    }
    const settled = await waitForCondition({ type: "scene", value: "Scene_Map" }, Math.min(timeoutMs, 15000));
    const after = await readState();
    return {
      ok: settled.ok, slot, scene_before: beforeScene, scene_after: sceneName(after), player_after: playerPosition(after),
      message: settled.ok ? `load completed${note}` : "load inputs were sent but Scene_Map did not appear in time",
    };
  }
  if (beforeScene === "Scene_Map") {
    await sendSequence([{ action: "open_menu" }, { wait_frames: 12 }], timeoutMs);
    try {
      await selectCommandSymbol("load", 0, timeoutMs);
    } catch {
      await sendSequence([{ action: "cancel" }, { wait_frames: 12 }], timeoutMs).catch(() => undefined);
      const state = await readState();
      return {
        ok: false, slot, scene_before: beforeScene, scene_after: sceneName(state), player_after: playerPosition(state),
        message: "this game's in-game menu has no load command; use black_souls_kill + black_souls_launch, then load from the title screen",
      };
    }
    await sendSequence([{ action: "confirm" }, { wait_frames: 16 }], timeoutMs);
    await selectSavefileSlot(slot, timeoutMs);
    await sendSequence([{ action: "confirm" }, { wait_frames: 40 }], timeoutMs);
    const after = await readState();
    return { ok: true, slot, scene_before: beforeScene, scene_after: sceneName(after), player_after: playerPosition(after), message: "load completed from the in-game menu" };
  }
  throw new Error(`Load is only available from Scene_Title, Scene_Load or Scene_Map (current: ${beforeScene || "unknown"})`);
}

export interface DialogueResult { ok: boolean; lines_advanced: number; final_choices: string[]; dialogue_ended: boolean; scene_after: string | null; message: string }
export async function advanceDialogue(choiceIndex?: number, maxAdvances = 30, timeoutMs = 30000): Promise<DialogueResult> {
  let state = await readState(); let message = objectValue(state.message);
  if (!message.busy) return { ok: false, lines_advanced: 0, final_choices: [], dialogue_ended: true, scene_after: sceneName(state), message: "no active dialogue" };
  const started = Date.now(); let lines = 0; let selectedChoice = false;
  for (; lines < maxAdvances; lines += 1) {
    const choices = Array.isArray(message.choices) ? message.choices.map(String) : [];
    if (choices.length) {
      if (choiceIndex === undefined) return { ok: true, lines_advanced: lines, final_choices: choices, dialogue_ended: false, scene_after: sceneName(state), message: "choice required" };
      if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= choices.length) return { ok: false, lines_advanced: lines, final_choices: choices, dialogue_ended: false, scene_after: sceneName(state), message: "choice index out of range" };
      const remaining = () => Math.max(500, timeoutMs - (Date.now() - started));
      // $game_message exposes choices as soon as the interpreter queues them, but a
      // preceding \! pause can keep Window_ChoiceList inactive until the text itself is
      // confirmed. Advance only while no selectable window owns focus, then wait for the
      // real choice cursor instead of treating declared choices as an open menu.
      for (let reveal = 0; reveal < 8; reveal += 1) {
        state = await readState(); message = objectValue(state.message);
        const active = activeWindowOf(state);
        if (active?.class === "Window_ChoiceList") break;
        if (active) throw new Error(`Expected Window_ChoiceList but ${active.class} owns the input focus`);
        const pendingChoices = Array.isArray(message.choices) ? message.choices : [];
        if (!message.busy || pendingChoices.length === 0) throw new Error("The pending choice disappeared before its window opened");
        await sendSequence([{ action: "confirm" }, { wait_frames: 8 }], remaining());
      }
      if (activeWindowOf(await readState())?.class !== "Window_ChoiceList") {
        throw new Error("The choice window did not become active after advancing its preceding text");
      }
      // BLACK SOULS installs an anti-misclick script that intentionally opens every
      // choice window at index -1. Blindly pressing confirm cannot select choice 0,
      // and N down presses select N-1. Navigate against the observed cursor instead.
      await selectWindowIndex(choiceIndex, remaining());
      await sendSequence([{ action: "confirm" }, { wait_frames: 8 }], remaining());
      state = await readState(); message = objectValue(state.message); selectedChoice = true; lines += 1; break;
    }
    await sendSequence([{ action: "confirm" }, { wait_frames: 8 }], Math.max(500, timeoutMs - (Date.now() - started)));
    state = await readState(); message = objectValue(state.message); if (!message.busy) { lines += 1; break; }
    if (Date.now() - started >= timeoutMs) break;
  }
  const finalChoices = Array.isArray(message.choices) ? message.choices.map(String) : [];
  return { ok: true, lines_advanced: lines, final_choices: finalChoices, dialogue_ended: !message.busy, scene_after: sceneName(state), message: !message.busy ? "dialogue ended" : finalChoices.length ? "choice required" : selectedChoice ? "choice selected; dialogue continues" : "maximum advances reached" };
}

export async function buildSituation(): Promise<SituationSnapshot> {
  const [state, mapResult] = await Promise.all([readState(), readMap().catch(() => ({}))]);
  const map = objectValue(mapResult);
  const scene = sceneName(state);
  const playerRaw = objectValue(state.player);
  const partyRaw = objectValue(state.party);
  const messageRaw = objectValue(state.message);
  const battleRaw = objectValue(state.battle);
  const mapRaw = objectValue(state.map);
  const members = Array.isArray(partyRaw.members) ? partyRaw.members.map(objectValue) : [];
  const party = members.map((member) => ({
    name: String(member.name || ""), hp: Number(member.hp || 0), mhp: Number(member.mhp || 0),
    mp: Number(member.mp || 0), mmp: Number(member.mmp || 0), tp: Number(member.tp || 0),
    level: Number(member.level || 0), alive: Number(member.hp || 0) > 0,
  }));
  // $game_troop keeps the previous battle's members after it ends; only report enemies mid-battle.
  const enemies = battleRaw.active !== true ? [] : (Array.isArray(battleRaw.enemies) ? battleRaw.enemies : []).map(objectValue).map((enemy) => ({
    name: String(enemy.name || ""), hp: Number(enemy.hp || 0), mhp: Number(enemy.mhp || 0), dead: Boolean(enemy.dead),
  }));
  const px = Number(playerRaw.x || 0); const py = Number(playerRaw.y || 0);
  const events = (Array.isArray(map.events) ? map.events : []).map(objectValue).map((event) => ({
    id: Number(event.id || 0), name: String(event.name || ""), x: Number(event.x || 0), y: Number(event.y || 0),
    dx: Number(event.x || 0) - px, dy: Number(event.y || 0) - py,
  }));
  const centerTile = (Array.isArray(map.tiles) ? map.tiles : []).map(objectValue).find((tile) => Number(tile.x) === px && Number(tile.y) === py);
  const passableRaw = objectValue(centerTile?.passable);
  const passable = centerTile ? { up: Boolean(passableRaw.up), down: Boolean(passableRaw.down), left: Boolean(passableRaw.left), right: Boolean(passableRaw.right) } : null;
  const choices = Array.isArray(messageRaw.choices) ? messageRaw.choices.map(String) : [];
  const busy = Boolean(messageRaw.busy); const battleActive = Boolean(battleRaw.active);
  const suggested: string[] = [];
  if (scene === "Scene_Title") suggested.push("confirm (start game)", "move_down + confirm (load game)");
  else if (busy && choices.length) suggested.push("confirm (select choice)", "cancel (back)");
  else if (busy) suggested.push("confirm (advance text)");
  else if (battleActive) suggested.push("confirm (fight)", "cancel (flee/menu)");
  else if (scene === "Scene_Map") {
    if (passable?.up) suggested.push("move_up"); if (passable?.down) suggested.push("move_down");
    if (passable?.left) suggested.push("move_left"); if (passable?.right) suggested.push("move_right");
    suggested.push("open_menu");
  }
  if (!suggested.length) suggested.push("read state and wait");
  const warnings: string[] = [];
  for (const member of party) { if (member.hp === 0) warnings.push(`DEAD: ${member.name}`); else if (member.mhp > 0 && member.hp < member.mhp * 0.25) warnings.push(`HP critical: ${member.name}`); }
  if (battleActive) warnings.push("in battle"); if (busy) warnings.push("dialogue active");
  return {
    ok: true, scene, location: battleActive ? "Battle" : scene === "Scene_Map" ? String(mapRaw.display_name || "") || null : scene?.replace(/^Scene_/, "") || null,
    player: Object.keys(playerRaw).length ? { x: px, y: py, direction: Number(playerRaw.direction || 0) } : null,
    party, gold: Number(partyRaw.gold || 0), message_text: typeof messageRaw.text === "string" && messageRaw.text ? messageRaw.text : null,
    choices, battle_enemies: enemies, nearby_events: events, passable, suggested_actions: suggested, warnings,
    frame: Number(state.frame || 0), updated_at: Number(state.updated_at || 0),
  };
}

async function snapshotAge(directory: string, prefix: string): Promise<number | null> {
  const files = await existingDirectoryFiles(directory, prefix); const candidate = files[0];
  if (!candidate) return null;
  try {
    const json = await readJsonWithRetry<Record<string, unknown>>(candidate, 1);
    const timestamp = Number(json.updated_at || 0) * 1000;
    if (Number.isFinite(timestamp) && timestamp > 0) return Math.max(0, Math.round(Date.now() - timestamp));
    return Math.max(0, Math.round(Date.now() - (await fs.stat(candidate)).mtimeMs));
  } catch { return null; }
}

async function directoryFileAges(directory: string, suffix: string): Promise<Array<{ name: string; age: number }>> {
  try {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith(suffix));
    return (await Promise.all(names.map(async (name) => { try { return { name, age: Date.now() - (await fs.stat(path.join(directory, name))).mtimeMs }; } catch { return null; } })))
      .filter((entry): entry is { name: string; age: number } => entry !== null);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function bridgeHealth(): Promise<HealthReport> {
  const status = await bridgeStatus(); const stateAge = await snapshotAge(stateDir(), "state"); const mapAge = await snapshotAge(mapDir(), "map");
  const inbox = await directoryFileAges(inboxDir(), ".cmd"); const outbox = await directoryFileAges(outboxDir(), ".json");
  let lastError: string | null = null; let errorRecent = false;
  try { const errorFile = path.join(runtimeDir(), "error.log"); const stat = await fs.stat(errorFile); errorRecent = Date.now() - stat.mtimeMs < 60000; const lines = (await fs.readFile(errorFile, "utf8")).trim().split(/\r?\n/); lastError = lines.at(-1) || null; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let memoryOk = true; const memoryDir = path.join(installRoot(), "memory"); const probe = path.join(memoryDir, `.health-${process.pid}-${randomUUID()}.tmp`);
  try { await fs.mkdir(memoryDir, { recursive: true }); await fs.writeFile(probe, "ok", "ascii"); await fs.unlink(probe); } catch { memoryOk = false; await fs.unlink(probe).catch(() => undefined); }
  const issues: HealthIssue[] = []; const gameRunning = status.process_alive === true; const connected = status.connected === true;
  // Failing to read a snapshot is not evidence the game died. Saying so anyway makes
  // callers kill a healthy game, so only claim death when the PID itself is gone.
  const unreadable = Array.isArray(status.reasons) && status.reasons.some((reason) => String(reason).startsWith("bridge_files_"));
  if (!connected && unreadable && status.process_alive !== false) issues.push({ code: "bridge_unreadable", severity: "warning", detail: "Bridge snapshots could not be read; the game may still be running and simply not writing right now" });
  else if (!connected && !gameRunning) issues.push({ code: "game_not_running", severity: "critical", detail: "No live game process was found" });
  if (gameRunning && stateAge !== null && stateAge > 5000) issues.push({ code: "stale_state", severity: "warning", detail: `State snapshot is ${stateAge}ms old` });
  let state: Record<string, unknown> | null = null; try { state = await readStateSnapshot(String(status.launch_token || "") || undefined); } catch { /* unavailable */ }
  if (gameRunning && stateAge !== null && stateAge > 3000 && objectValue(state?.scene).name == null) issues.push({ code: "scene_transition", severity: "info", detail: "Scene name remains unavailable during transition" });
  const stuck = inbox.filter((entry) => entry.age > 10000); if (stuck.length) issues.push({ code: "stuck_command", severity: "critical", detail: `${stuck.length} command file(s) have waited more than 10 seconds` });
  const orphaned = outbox.filter((entry) => entry.age > 60000); if (orphaned.length) issues.push({ code: "orphaned_response", severity: "warning", detail: `${orphaned.length} response file(s) are older than 60 seconds` });
  if (errorRecent) issues.push({ code: "error_log_recent", severity: "warning", detail: lastError || "Bridge error log changed recently" });
  if (!memoryOk) issues.push({ code: "memory_unwritable", severity: "critical", detail: "Persistent memory directory did not pass a write probe" });
  let recommended = "All systems nominal; proceed with gameplay";
  if (issues.some((issue) => issue.code === "stuck_command")) recommended = "Call black_souls_kill then black_souls_launch to reset the bridge";
  else if (issues.some((issue) => issue.code === "game_not_running")) recommended = "Call black_souls_launch to start the game";
  else if (issues.some((issue) => issue.code === "bridge_unreadable")) recommended = "Wait a few seconds and read state again; do not kill the game, it is probably alive";
  else if (issues.some((issue) => issue.code === "stale_state")) recommended = "Wait 2 seconds and retry; bridge may be recovering from scene transition";
  else if (issues.some((issue) => issue.severity === "critical")) recommended = "Resolve the critical health issue before continuing";
  return { ok: !issues.some((issue) => issue.severity === "critical"), game_running: gameRunning, bridge_connected: connected, state_age_ms: stateAge, map_age_ms: mapAge, last_error_log: lastError, inbox_pending: inbox.length, outbox_orphaned: orphaned.length, memory_ok: memoryOk, issues, recommended_action: recommended };
}

function conditionMet(condition: WaitCondition, initialFrame: number, state: Record<string, unknown>): boolean {
  const scene = sceneName(state); const message = objectValue(state.message); const battle = objectValue(state.battle); const player = objectValue(state.player);
  if (condition.type === "scene") return scene === condition.value;
  if (condition.type === "not_scene") return scene !== condition.value;
  if (condition.type === "message_clear") return message.busy === false;
  if (condition.type === "battle_end") return battle.active === false;
  if (condition.type === "player_stopped") return player.moving === false;
  return Number(state.frame || 0) >= initialFrame + condition.frames;
}
export async function waitForCondition(condition: WaitCondition, timeoutMs = 15000, pollIntervalMs = 200): Promise<WaitResult> {
  const started = Date.now(); let state = await readState(); const initialFrame = Number(state.frame || 0);
  while (true) {
    if (conditionMet(condition, initialFrame, state)) return { ok: true, condition, elapsed_ms: Date.now() - started, final_scene: sceneName(state), timed_out: false };
    if (Date.now() - started >= timeoutMs) return { ok: false, condition, elapsed_ms: Date.now() - started, final_scene: sceneName(state), timed_out: true };
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - started)))); state = await readState();
  }
}

export interface EvalCondition {
  type: "scene" | "map_id" | "variable" | "switch" | "player_x" | "player_y" | "all_party_dead";
  value?: string | number | boolean;
  variable_id?: number;
  switch_id?: number;
}
export interface EvalConditionResult { condition: EvalCondition; actual: unknown; passed: boolean }
export interface EvalStatus { ok: boolean; all_passed: boolean; results: EvalConditionResult[]; frame: number; scene: string | null }

export async function evalStatus(conditions: EvalCondition[]): Promise<EvalStatus> {
  const state = await readState();
  const scene = sceneName(state);
  const player = objectValue(state.player);
  const map = objectValue(state.map);
  const members = (Array.isArray(objectValue(state.party).members) ? objectValue(state.party).members as unknown[] : []).map(objectValue);
  const variableIds = [...new Set(conditions.filter((item) => item.type === "variable").map((item) => Number(item.variable_id || 0)).filter((id) => id > 0))];
  const switchIds = [...new Set(conditions.filter((item) => item.type === "switch").map((item) => Number(item.switch_id || 0)).filter((id) => id > 0))];
  const variables = variableIds.length ? await queryVariables(variableIds) : {};
  const switches = switchIds.length ? await querySwitches(switchIds) : {};
  const results = conditions.map((condition) => {
    let actual: unknown = null;
    if (condition.type === "scene") actual = scene;
    else if (condition.type === "map_id") actual = Number(map.id || 0);
    else if (condition.type === "variable") actual = variables[String(condition.variable_id || 0)] ?? null;
    else if (condition.type === "switch") actual = Boolean(switches[String(condition.switch_id || 0)]);
    else if (condition.type === "player_x") actual = Number(player.x || 0);
    else if (condition.type === "player_y") actual = Number(player.y || 0);
    else actual = members.length > 0 && members.every((member) => Number(member.hp || 0) <= 0);
    const expected = condition.value ?? (condition.type === "all_party_dead" || condition.type === "switch" ? true : condition.value);
    const passed = actual === expected || String(actual) === String(expected);
    return { condition, actual, passed };
  });
  return { ok: true, all_passed: results.every((entry) => entry.passed), results, frame: Number(state.frame || 0), scene };
}

export async function prepareBridgeRuntime(launchToken: string): Promise<{ archived_runtime: string | null; runtime_directory: string }> {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(launchToken)) throw new Error("Invalid launch token");
  const runtime = runtimeDir();
  let archivedRuntime: string | null = null;
  let frameRateOverride: string | null = null;
  try {
    await fs.access(runtime);
    try {
      const configured = (await fs.readFile(path.join(runtime, "frame_rate.txt"), "ascii")).trim();
      const parsed = Number(configured);
      if (/^\d{2,3}$/.test(configured) && Number.isInteger(parsed) && parsed >= 30 && parsed <= 120) {
        frameRateOverride = `${parsed}\n`;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
  if (frameRateOverride !== null) {
    await fs.writeFile(path.join(runtime, "frame_rate.txt"), frameRateOverride, { encoding: "ascii", flag: "wx" });
  }
  const temp = `${launchTokenFile()}.tmp.${process.pid}`;
  await fs.writeFile(temp, `${launchToken}\n`, { encoding: "ascii", flag: "wx" });
  await retryFileOperation(() => fs.rename(temp, launchTokenFile()));
  return { archived_runtime: archivedRuntime, runtime_directory: runtime };
}

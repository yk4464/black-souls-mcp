import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { memoryDir } from "./config.js";

export interface Scratchpad {
  session_id: string; updated_at: number; notes: string;
  recent_actions: Array<{ frame: number; action: string; result: string }>;
  flags: Record<string, boolean>;
}
export type MemoryConfidence = "certain" | "likely" | "uncertain";
export interface LongtermEntry { value: string; updated_at: number; confidence: MemoryConfidence; source: string }
export interface LongtermMemory { updated_at: number; entries: Record<string, Record<string, LongtermEntry>> }
export type GoalStatus = "active" | "completed" | "failed" | "blocked";
export interface Goal {
  id: string; title: string; description: string; status: GoalStatus; priority: number;
  parent_id: string | null; created_at: number; updated_at: number;
  completion_condition: string; notes: string;
}
export interface GoalStack { updated_at: number; active_goal_id: string | null; goals: Record<string, Goal> }
export interface SessionLogEntry {
  timestamp: number; session_id: string; frame: number | null; scene: string | null;
  event_type: "action" | "observation" | "error" | "milestone" | "decision"; summary: string;
}

const directory = () => memoryDir();
const file = (name: string) => path.join(directory(), name);
const now = () => Date.now();
let writeQueue: Promise<void> = Promise.resolve();
let sessionLogLineCount: number | null = null;
let sessionLogCountDir: string | null = null;
let fallbackSessionId: string | null = null;

async function readJson<T>(name: string, fallback: () => T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file(name), "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    // A corrupt file must not brick every memory tool and the session log
    // (appendSessionLog reads the scratchpad). Park it next to the original so the
    // bytes stay inspectable, then rebuild from an empty state.
    const corrupt = `${file(name)}.corrupt`;
    await fs.rename(file(name), corrupt).catch(() => undefined);
    console.error(`memory: ${name} was unreadable (${String(error)}); moved it to ${path.basename(corrupt)} and starting fresh`);
    return fallback();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const defineOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  // Plain assignment on "__proto__" swaps the object's prototype instead of storing
  // the value; defineProperty makes any key a real own property.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

// Memory files live in a shared directory, so two MCP server processes can run against
// the same installRoot. The in-process writeQueue alone lets their read-modify-write
// cycles interleave and silently drop each other's updates; a lock file serializes the
// whole memory directory across processes. A lock older than 15s is treated as
// abandoned by a crashed process and stolen.
const LOCK_STALE_MS = 15000;
async function withFileLock<T>(operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(directory(), { recursive: true });
  const deadline = Date.now() + 5000;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      await fs.writeFile(file(".lock"), String(process.pid), { encoding: "ascii", flag: "wx" });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(file(".lock"));
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) { await fs.unlink(file(".lock")).catch(() => undefined); continue; }
      } catch { /* the holder released it; retry immediately */ }
      await sleep(25);
    }
  }
  if (!acquired) throw new Error("the memory directory is locked by another process; retry shortly");
  try { return await operation(); } finally { await fs.unlink(file(".lock")).catch(() => undefined); }
}

async function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const previous = writeQueue;
  let release!: () => void;
  writeQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await withFileLock(operation); } finally { release(); }
}

const TRANSIENT_FILE_CODES = new Set(["EACCES", "EPERM", "EBUSY", "ENFILE", "EMFILE"]);
async function atomicJson(name: string, value: unknown): Promise<void> {
  await fs.mkdir(directory(), { recursive: true });
  const target = file(name); const temp = `${target}.tmp.${process.pid}.${randomUUID().replaceAll("-", "")}`;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        await fs.rename(temp, target);
        break;
      } catch (error) {
        // Windows AV/indexing can hold the target for a moment; bridge.ts retries the
        // identical write+rename pattern, so memory writes must too.
        if (attempt >= 4 || !TRANSIENT_FILE_CODES.has(String((error as NodeJS.ErrnoException).code))) throw error;
        await sleep(15 * (attempt + 1));
      }
    }
  } catch (error) { await fs.unlink(temp).catch(() => undefined); throw error; }
}

const emptyScratchpad = (): Scratchpad => ({ session_id: randomUUID(), updated_at: now(), notes: "", recent_actions: [], flags: {} });
const emptyMemory = (): LongtermMemory => ({ updated_at: now(), entries: {} });
const emptyGoals = (): GoalStack => ({ updated_at: now(), active_goal_id: null, goals: {} });

export async function readScratchpad(): Promise<Scratchpad> { return readJson("scratchpad.json", emptyScratchpad); }
export async function writeScratchpad(patch: {
  notes?: string; flags?: Record<string, boolean>;
  append_action?: { frame: number; action: string; result: string };
}): Promise<Scratchpad> {
  return serialize(async () => {
    const value = await readScratchpad();
    if (patch.notes !== undefined) value.notes = patch.notes.slice(0, 8000);
    if (patch.flags) for (const [key, enabled] of Object.entries(patch.flags)) { if (enabled) defineOwn(value.flags, key, true); else delete value.flags[key]; }
    if (Object.keys(value.flags).length > 200) throw new Error("scratchpad flag limit reached (200); delete some flags first");
    if (patch.append_action) value.recent_actions.push(patch.append_action);
    value.recent_actions = value.recent_actions.slice(-50); value.updated_at = now();
    await atomicJson("scratchpad.json", value); return value;
  });
}

export async function readMemory(category?: string): Promise<LongtermMemory | Record<string, LongtermEntry>> {
  const value = await readJson("longterm.json", emptyMemory);
  return category ? (value.entries[category] || {}) : value;
}
export async function writeMemory(category: string, key: string, value: string, confidence: MemoryConfidence, source: string): Promise<LongtermEntry> {
  return serialize(async () => {
    const memory = await readJson("longterm.json", emptyMemory);
    const entry = { value: value.slice(0, 1000), updated_at: now(), confidence, source: source.slice(0, 200) };
    memory.entries[category] ||= {}; defineOwn(memory.entries[category], key, entry);
    // Eviction candidates exclude the entry this call just wrote: ranking puts a new
    // uncertain entry first, so including it would delete it again and still report
    // success. The other slots plus the new one hold the 200-entry cap.
    const all = Object.entries(memory.entries).flatMap(([entryCategory, values]) => Object.entries(values).map(([entryKey, item]) => ({ entryCategory, entryKey, item })))
      .filter((item) => !(item.entryCategory === category && item.entryKey === key));
    const rank: Record<MemoryConfidence, number> = { uncertain: 0, likely: 1, certain: 2 };
    all.sort((a, b) => rank[a.item.confidence] - rank[b.item.confidence] || a.item.updated_at - b.item.updated_at);
    for (const expired of all.slice(0, Math.max(0, all.length - 199))) {
      delete memory.entries[expired.entryCategory][expired.entryKey];
      if (!Object.keys(memory.entries[expired.entryCategory]).length) delete memory.entries[expired.entryCategory];
    }
    memory.updated_at = now(); await atomicJson("longterm.json", memory); return entry;
  });
}
export async function deleteMemory(category: string, key: string): Promise<{ deleted: boolean }> {
  return serialize(async () => {
    const memory = await readJson("longterm.json", emptyMemory);
    const bucket = memory.entries[category];
    const deleted = Boolean(bucket) && Object.prototype.hasOwnProperty.call(bucket, key);
    if (deleted) { delete memory.entries[category][key]; if (!Object.keys(memory.entries[category]).length) delete memory.entries[category]; }
    memory.updated_at = now(); await atomicJson("longterm.json", memory); return { deleted };
  });
}

export async function readGoals(): Promise<GoalStack> { return readJson("goals.json", emptyGoals); }
export async function writeGoal(input: Omit<Goal, "created_at" | "updated_at"> & { id: string }): Promise<Goal> {
  return serialize(async () => {
    const stack = await readGoals(); const timestamp = now(); const existing = stack.goals[input.id];
    const goal: Goal = { ...input, created_at: existing?.created_at || timestamp, updated_at: timestamp };
    defineOwn(stack.goals, input.id, goal);
    const goals = Object.values(stack.goals);
    if (goals.length > 100) {
      const removable = goals.filter((item) => item.status === "completed" || item.status === "failed").sort((a, b) => a.updated_at - b.updated_at);
      for (const item of removable.slice(0, goals.length - 100)) { delete stack.goals[item.id]; if (stack.active_goal_id === item.id) stack.active_goal_id = null; }
      if (Object.keys(stack.goals).length > 100) throw new Error("goal limit reached; complete or delete old goals first");
    }
    stack.updated_at = timestamp; await atomicJson("goals.json", stack); return goal;
  });
}
export async function setActiveGoal(id: string | null): Promise<GoalStack> {
  return serialize(async () => {
    const stack = await readGoals(); if (id !== null && !stack.goals[id]) throw new Error(`goal not found: ${id}`);
    stack.active_goal_id = id; stack.updated_at = now(); await atomicJson("goals.json", stack); return stack;
  });
}

export async function appendSessionLog(entry: Omit<SessionLogEntry, "timestamp" | "session_id"> & { session_id?: string }): Promise<{ appended: true }> {
  return serialize(async () => {
    const currentDir = directory();
    if (sessionLogCountDir !== currentDir) { sessionLogLineCount = null; fallbackSessionId = null; sessionLogCountDir = currentDir; }
    await fs.mkdir(currentDir, { recursive: true });
    let sessionId = entry.session_id;
    if (!sessionId) {
      const scratchpadExists = await fs.access(file("scratchpad.json")).then(() => true, () => false);
      // emptyScratchpad() mints a fresh id in memory without persisting it; cache one
      // per process so consecutive appends on a missing scratchpad share a session id.
      sessionId = scratchpadExists ? (await readScratchpad()).session_id : (fallbackSessionId ||= randomUUID());
    }
    const value: SessionLogEntry = { timestamp: now(), session_id: sessionId, frame: entry.frame ?? null, scene: entry.scene ?? null, event_type: entry.event_type, summary: entry.summary.slice(0, 500) };
    const target = file("session.log");
    if (sessionLogLineCount === null) sessionLogLineCount = (await fs.readFile(target, "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean).length;
    await fs.appendFile(target, `${JSON.stringify(value)}\n`, "utf8"); sessionLogLineCount += 1;
    if (sessionLogLineCount > 2000) {
      const lines = (await fs.readFile(target, "utf8")).trim().split(/\r?\n/).filter(Boolean);
      const temp = `${target}.tmp.${process.pid}.${randomUUID().replaceAll("-", "")}`;
      try { await fs.writeFile(temp, `${lines.slice(-2000).join("\n")}\n`, "utf8"); await fs.rename(temp, target); }
      catch (error) { await fs.unlink(temp).catch(() => undefined); throw error; }
      sessionLogLineCount = 2000;
    }
    return { appended: true };
  });
}
export async function readSessionLog(lastN = 50): Promise<SessionLogEntry[]> {
  try {
    const lines = (await fs.readFile(file("session.log"), "utf8")).trim().split(/\r?\n/).filter(Boolean);
    const entries: SessionLogEntry[] = [];
    for (const line of lines.slice(-Math.min(200, Math.max(1, lastN)))) {
      try { entries.push(JSON.parse(line) as SessionLogEntry); }
      catch { console.error("memory: skipped an unreadable session.log line"); }
    }
    return entries;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

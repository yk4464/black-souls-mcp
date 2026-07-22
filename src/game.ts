import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { bridgeStatus, prepareBridgeRuntime } from "./bridge.js";
import { gameDir, gameExe } from "./config.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

export async function launchGame(waitMs = 12000): Promise<Record<string, unknown>> {
  await fs.access(gameExe());
  const executableHash = await sha256(gameExe());
  if (EXPECTED_GAME_EXE_SHA256 && executableHash !== EXPECTED_GAME_EXE_SHA256) {
    throw new Error(`Game.exe integrity check failed. Expected ${EXPECTED_GAME_EXE_SHA256}, found ${executableHash}. Restore the independent copy from the Steam original before launch.`);
  }

  const existing = await bridgeStatus();
  if (existing.connected === true) {
    return { launched: false, already_running: true, pid: existing.pid, bridge: existing };
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
        return { launched: true, pid: child.pid, launch_token: launchToken, runtime, bridge: status };
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

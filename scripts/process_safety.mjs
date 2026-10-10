import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("Windows process identity safety: skipped on non-Windows host");
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "black-souls-mcp-process-safety-"));
const game = path.join(root, "game");
const runtime = path.join(game, "BridgeRuntime");
const gameExe = path.join(game, "Game.exe");
let exactGame = null;
let decoy = null;

try {
  await fs.mkdir(path.join(runtime, "info"), { recursive: true });
  await fs.mkdir(path.join(runtime, "state"), { recursive: true });
  await fs.copyFile(process.execPath, gameExe);
  const hash = createHash("sha256").update(await fs.readFile(gameExe)).digest("hex").toUpperCase();
  process.env.BLACK_SOULS_ROOT = root;
  process.env.BLACK_SOULS_DIR = game;
  process.env.BLACK_SOULS_GAME_EXE_SHA256 = hash;

  const { BRIDGE_PROTOCOL } = await import("../dist/bridge.js");
  const { killGame, launchGame } = await import("../dist/game.js");
  const token = "0123456789abcdef0123456789abcdef";
  exactGame = spawn(gameExe, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(exactGame.pid && await waitFor(() => alive(exactGame.pid)), "exact-path test process did not start");
  const base = { protocol: BRIDGE_PROTOCOL, bridge_version: "test", pid: exactGame.pid, launch_token: token };
  await fs.writeFile(path.join(runtime, "info", "info-live.json"), JSON.stringify({ ...base, capabilities: [] }));
  await fs.writeFile(path.join(runtime, "state", "state-live.json"), JSON.stringify({ ...base, frame: 1, updated_at: Date.now() / 1000 - 120, scene: { name: "Scene_Title" } }));

  await assert.rejects(
    () => launchGame(1000, false),
    /Refusing to launch a second BLACK SOULS process/,
    "a stale bridge must not cause a second writer to launch",
  );
  assert.equal(alive(exactGame.pid), true, "launch refusal must leave the existing game process alive");
  const killed = await killGame();
  assert.equal(killed.ok, true);
  assert.equal(await waitFor(() => !alive(exactGame.pid)), true, "verified game process was not terminated");
  exactGame = null;

  decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(decoy.pid && await waitFor(() => alive(decoy.pid)), "decoy process did not start");
  await sleep(20);
  await fs.writeFile(path.join(runtime, "info", "info-decoy.json"), JSON.stringify({ ...base, pid: decoy.pid }));
  await assert.rejects(
    () => killGame(),
    /Refusing to terminate PID .* executable does not match/,
    "a reused PID belonging to another executable must never be killed",
  );
  assert.equal(alive(decoy.pid), true, "identity refusal must leave the decoy process alive");

  console.log("Windows process identity, duplicate-launch refusal, and PID-reuse kill safety: OK");
} finally {
  if (exactGame && alive(exactGame.pid)) exactGame.kill();
  if (decoy && alive(decoy.pid)) decoy.kill();
  await fs.rm(root, { recursive: true, force: true });
}

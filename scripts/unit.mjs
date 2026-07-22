import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const testTemp = process.env.BLACK_SOULS_TEST_TEMP
  || path.join(os.tmpdir(), "black-souls-mcp-tests");
await fs.mkdir(testTemp, { recursive: true });
const root = await fs.mkdtemp(path.join(testTemp, "black-souls-mcp-unit-"));
const game = path.join(root, "game");
const runtime = path.join(game, "BridgeRuntime");
process.env.BLACK_SOULS_ROOT = root;
process.env.BLACK_SOULS_DIR = game;

const { BRIDGE_PROTOCOL, bridgeStatus, prepareBridgeRuntime, readMap, readState, sendSequence } = await import("../dist/bridge.js");
const { launchGame } = await import("../dist/game.js");
const token = "0123456789abcdef0123456789abcdef";
const now = () => Date.now() / 1000;

const writeJson = async (directory, name, value, mtimeOffsetMs = 0) => {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await fs.writeFile(file, JSON.stringify(value), "utf8");
  if (mtimeOffsetMs) {
    const time = new Date(Date.now() + mtimeOffsetMs);
    await fs.utimes(file, time, time);
  }
  return file;
};

try {
  const base = {
    protocol: BRIDGE_PROTOCOL,
    bridge_version: "1.1.1",
    pid: process.pid,
    launch_token: token,
  };
  await writeJson(path.join(runtime, "info"), "info-1.json", {
    ...base,
    capabilities: ["state", "map", "input", "input_sequence"],
  });
  await writeJson(path.join(runtime, "state"), "state-1.json", {
    ...base,
    frame: 120,
    updated_at: now(),
    scene: { name: "Scene_Map" },
    player: { x: 14, y: 12 },
  });
  await writeJson(path.join(runtime, "map"), "map-1.json", {
    ...base,
    frame: 120,
    updated_at: now(),
    available: true,
    map_id: 104,
  });

  const status = await bridgeStatus();
  assert.equal(status.connected, true);
  assert.equal(status.pid, process.pid);
  assert.equal((await readState()).frame, 120);
  assert.equal((await readMap()).map_id, 104);
  await assert.rejects(
    () => sendSequence(Array.from({ length: 7 }, () => ({ wait_frames: 600 })), 500),
    /maximum is 3600/,
    "oversized sequences must be rejected before a command file is written",
  );

  await fs.writeFile(path.join(runtime, "state", "state-corrupt.json"), "{broken", "utf8");
  const future = new Date(Date.now() + 1000);
  await fs.utimes(path.join(runtime, "state", "state-corrupt.json"), future, future);
  assert.equal((await readState()).frame, 120, "corrupt newest state should fall back to a valid snapshot");

  await writeJson(path.join(runtime, "state"), "state-other.json", {
    ...base,
    launch_token: "ffffffffffffffffffffffffffffffff",
    frame: 999,
    updated_at: now(),
  }, 2000);
  assert.equal((await readState()).frame, 120, "a different launch generation must be ignored");

  const stateDirectory = path.join(runtime, "state");
  await Promise.all([
    "state-1.json", "state-corrupt.json", "state-other.json",
  ].map((name) => fs.unlink(path.join(stateDirectory, name)).catch(() => undefined)));
  let rotatingFile = await writeJson(stateDirectory, "state-rotation-0.json", {
    ...base, frame: 200, updated_at: now(), scene: { name: "Scene_Map" },
  });
  const rotateSnapshots = async () => {
    for (let index = 1; index <= 60; index += 1) {
      const next = await writeJson(stateDirectory, `state-rotation-${index}.json`, {
        ...base, frame: 200 + index, updated_at: now(), scene: { name: "Scene_Map" },
      });
      await fs.unlink(rotatingFile).catch(() => undefined);
      rotatingFile = next;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const readDuringRotation = async () => {
    for (let index = 0; index < 60; index += 1) {
      const rotatingState = await readState();
      assert.equal(rotatingState.launch_token, token);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await Promise.all([rotateSnapshots(), readDuringRotation()]);

  const transitionState = await writeJson(stateDirectory, "state-transition.json", {
    ...base,
    frame: 300,
    updated_at: now() - 20,
    scene: { name: null },
  }, 3000);
  const transitioning = await bridgeStatus();
  assert.equal(transitioning.connected, true, "a live process should tolerate a long scene transition");
  assert.equal(transitioning.heartbeat_limit_ms, 60000);
  await fs.unlink(transitionState);

  const staleToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeJson(path.join(runtime, "info"), "info-2.json", {
    ...base,
    launch_token: staleToken,
  }, 3000);
  await writeJson(path.join(runtime, "state"), "state-2.json", {
    ...base,
    launch_token: staleToken,
    frame: 1,
    updated_at: now() - 120,
    scene: { name: "Scene_Title" },
  }, 3000);
  const stale = await bridgeStatus();
  assert.equal(stale.connected, false);
  assert.ok(stale.reasons.includes("stale_heartbeat"));

  const nextToken = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const prepared = await prepareBridgeRuntime(nextToken);
  assert.ok(prepared.archived_runtime?.startsWith(path.join(root, "extract")));
  assert.equal((await fs.readFile(path.join(runtime, "launch.token"), "ascii")).trim(), nextToken);
  assert.equal((await bridgeStatus()).connected, false);

  await fs.writeFile(path.join(game, "Game.exe"), "not-the-original-engine", "ascii");
  await assert.rejects(() => launchGame(1000), /integrity check failed/);

  console.log("Bridge generation, corruption recovery, stale-state rejection, runtime archival, and launch integrity: OK");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

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

const { BRIDGE_PROTOCOL, advanceDialogue, bridgeHealth, bridgeStatus, buildSituation, evalStatus, prepareBridgeRuntime, queryVariables, readMap, readState, sendQuery, sendSequence, triggerSave, waitForCondition } = await import("../dist/bridge.js");
const { killGame, launchGame } = await import("../dist/game.js");
const { appendSessionLog, readGoals, readMemory, readScratchpad, readSessionLog, setActiveGoal, writeGoal, writeMemory, writeScratchpad } = await import("../dist/memory.js");
const { findPath, navigate } = await import("../dist/navigation.js");
const { battleAction } = await import("../dist/battle.js");
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
const answerNextQuery = async (response) => {
  const inbox = path.join(runtime, "inbox");
  const outbox = path.join(runtime, "outbox");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const names = await fs.readdir(inbox).catch(() => []);
    const name = names.find((entry) => entry.endsWith(".cmd"));
    if (name) {
      const command = await fs.readFile(path.join(inbox, name), "ascii");
      const id = command.match(/^id=(.+)$/m)?.[1]?.trim();
      assert.ok(id);
      await fs.unlink(path.join(inbox, name));
      await writeJson(outbox, `${id}.json`, { id, launch_token: token, ...response });
      return command;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("query command was not written");
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
  const situationState = await writeJson(path.join(runtime, "state"), "state-situation.json", {
    ...base, frame: 121, updated_at: now(), scene: { name: "Scene_Title" },
    player: { x: 2, y: 3, direction: 2 }, party: { gold: 9, members: [{ name: "Hero", hp: 1, mhp: 100, mp: 4, mmp: 5, tp: 0, level: 1 }] },
    message: { busy: true, text: "Choose", choices: ["Yes", "No"] }, battle: { active: false, enemies: [] },
  }, 5000);
  const situationMap = await writeJson(path.join(runtime, "map"), "map-situation.json", {
    ...base, frame: 121, updated_at: now(), available: true, map_id: 1, events: [], tiles: [],
  }, 5000);
  const situation = await buildSituation();
  assert.ok(situation.suggested_actions.some((entry) => entry.includes("confirm")));
  assert.deepEqual(situation.choices, ["Yes", "No"]);
  assert.ok(situation.warnings.some((entry) => /HP critical/.test(entry)));
  await fs.unlink(situationState); await fs.unlink(situationMap);
  assert.equal((await advanceDialogue()).ok, false);
  assert.equal((await battleAction("attack")).ok, false);
  const evalState = await writeJson(path.join(runtime, "state"), "state-eval.json", {
    ...base, frame: 122, updated_at: now(), scene: { name: "Scene_Map" },
    player: { x: 5, y: 9 }, map: { id: 104 },
    party: { gold: 0, members: [{ name: "Hero", hp: 0, mhp: 100 }] },
  }, 5000);
  const [evalResult] = await Promise.all([
    evalStatus([
      { type: "scene", value: "Scene_Map" },
      { type: "map_id", value: 104 },
      { type: "player_x", value: 5 },
      { type: "player_y", value: 8 },
      { type: "all_party_dead" },
      { type: "variable", variable_id: 7, value: 3 },
    ]),
    answerNextQuery({ ok: true, data: { variables: { "7": 3 } } }),
  ]);
  const evalByType = Object.fromEntries(evalResult.results.map((entry) => [entry.condition.type, entry]));
  assert.equal(evalResult.all_passed, false);
  assert.equal(evalByType.scene.passed, true);
  assert.equal(evalByType.map_id.passed, true);
  assert.equal(evalByType.player_x.passed, true);
  assert.equal(evalByType.player_y.passed, false);
  assert.equal(evalByType.all_party_dead.passed, true);
  assert.equal(evalByType.variable.passed, true);
  await fs.unlink(evalState);
  const grid = [];
  for (let y = 0; y < 2; y += 1) for (let x = 0; x < 3; x += 1) grid.push({ x, y, passable: { up: y > 0, down: y < 1, left: x > 0, right: x < 2 } });
  assert.deepEqual(findPath(grid, { x: 0, y: 0 }, { x: 2, y: 0 }), ["move_right", "move_right"]);
  grid.find((tile) => tile.x === 0 && tile.y === 0).passable.right = false;
  assert.ok(findPath(grid, { x: 0, y: 0 }, { x: 2, y: 0 }).length > 2);
  const blocked = grid.map((tile) => ({ ...tile, passable: { up: false, down: false, left: false, right: false } }));
  assert.deepEqual(findPath(blocked, { x: 0, y: 0 }, { x: 2, y: 0 }), []);
  assert.equal(findPath(grid, { x: 0, y: 0 }, { x: 7, y: 0 }), null);
  const [variables, variablesCommand] = await Promise.all([
    queryVariables([1, 2]),
    answerNextQuery({ ok: true, data: { variables: { "1": 42, "2": "ready" } } }),
  ]);
  assert.deepEqual(variables, { "1": 42, "2": "ready" });
  assert.match(variablesCommand, /type=query/); assert.match(variablesCommand, /query=variables/);
  await assert.rejects(
    () => Promise.all([sendQuery("variables", "1", 1000), answerNextQuery({ ok: false, error: "synthetic query error" })]).then(([value]) => value),
    /synthetic query error/,
  );
  const [, fullMapCommand] = await Promise.all([sendQuery("full_map", "radius=8"), answerNextQuery({ ok: true, data: { available: true } })]);
  assert.match(fullMapCommand, /query=full_map/); assert.match(fullMapCommand, /params=radius=8/);
  const [, eventCommand] = await Promise.all([sendQuery("event_detail", "5"), answerNextQuery({ ok: true, data: { found: true } })]);
  assert.match(eventCommand, /query=event_detail/); assert.match(eventCommand, /params=5/);
  await assert.rejects(
    () => Promise.all([sendQuery("unknown_query_xyz", "", 1000), answerNextQuery({ ok: false, error: "unknown query: unknown_query_xyz" })]).then(([value]) => value),
    /unknown query: unknown_query_xyz/,
  );
  await assert.rejects(() => sendQuery("variables", "1", 50), /timed out/);
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
  await assert.rejects(() => sendQuery("variables"), /bridge is not ready/i);
  assert.deepEqual(await killGame(), { ok: true, pid: null, signal: "none", message: "not running" });
  await assert.rejects(() => triggerSave(2), /bridge is not ready/i);
  await assert.rejects(() => navigate(1, 1), /bridge is not ready/i);
  const stoppedHealth = await bridgeHealth();
  assert.equal(stoppedHealth.game_running, false); assert.ok(stoppedHealth.issues.some((issue) => issue.code === "game_not_running" && issue.severity === "critical"));
  assert.match(stoppedHealth.recommended_action, /black_souls_launch/);
  await writeJson(path.join(runtime, "info"), "info-health.json", { ...base, bridge_version: "1.7.0", launch_token: nextToken, capabilities: [] });
  await writeJson(path.join(runtime, "state"), "state-health.json", { ...base, bridge_version: "1.7.0", launch_token: nextToken, frame: 10, updated_at: now(), scene: { name: "Scene_Map" }, message: { busy: false }, battle: { active: false }, player: { x: 1, y: 1, moving: false } });
  const stuckFile = path.join(runtime, "inbox", "stuck.cmd"); await fs.writeFile(stuckFile, "synthetic", "ascii");
  const old = new Date(Date.now() - 20000); await fs.utimes(stuckFile, old, old);
  const stuckHealth = await bridgeHealth(); assert.ok(stuckHealth.issues.some((issue) => issue.code === "stuck_command" && issue.severity === "critical"));
  assert.equal((await waitForCondition({ type: "message_clear" }, 100)).timed_out, false);
  assert.equal((await waitForCondition({ type: "scene", value: "Scene_Battle" }, 50, 10)).timed_out, true);

  const truncated = await writeScratchpad({ notes: "x".repeat(9000) });
  assert.equal(truncated.notes.length, 8000);
  await writeScratchpad({ flags: { a: true } }); await writeScratchpad({ flags: { b: true } });
  for (let index = 0; index < 60; index += 1) await writeScratchpad({ append_action: { frame: index, action: `action-${index}`, result: "ok" } });
  const scratchpad = await readScratchpad();
  assert.equal(scratchpad.flags.a, true); assert.equal(scratchpad.flags.b, true); assert.equal(scratchpad.recent_actions.length, 50);
  for (let index = 0; index < 201; index += 1) await writeMemory("map", `key-${index}`, `value-${index}`, "uncertain", "unit test");
  const longterm = await readMemory();
  assert.ok(Object.values(longterm.entries).reduce((total, entries) => total + Object.keys(entries).length, 0) <= 200);
  await writeGoal({ id: "g1", title: "Goal", description: "Test", status: "active", priority: 1, parent_id: null, completion_condition: "done", notes: "" });
  assert.ok((await readGoals()).goals.g1); await assert.rejects(() => setActiveGoal("nonexistent"), /goal not found/i);
  const memoryFiles = await fs.readdir(path.join(root, "memory"));
  assert.equal(memoryFiles.some((name) => name.includes(".tmp")), false);
  for (let index = 0; index < 2100; index += 1) await appendSessionLog({ frame: index, scene: "Scene_Map", event_type: "observation", summary: `entry-${index}` });
  assert.ok((await readSessionLog(200)).length <= 2000);
  const recentLog = await readSessionLog(10); assert.equal(recentLog.length, 10); assert.equal(recentLog.at(-1).summary, "entry-2099");

  await fs.writeFile(path.join(game, "Game.exe"), "not-the-original-engine", "ascii");
  await assert.rejects(() => launchGame(1000), /integrity check failed/);

  console.log("Bridge generation, corruption recovery, stale-state rejection, runtime archival, and launch integrity: OK");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

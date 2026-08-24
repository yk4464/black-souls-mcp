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

const { ACTIONS, BRIDGE_PROTOCOL, advanceDialogue, bridgeHealth, bridgeStatus, buildSituation, evalStatus, prepareBridgeRuntime, queryVariables, readMap, readState, sendQuery, sendSequence, triggerSave, waitForCondition } = await import("../dist/bridge.js");
const { killGame, launchGame, listSaves } = await import("../dist/game.js");
const { appendSessionLog, readGoals, readMemory, readScratchpad, readSessionLog, setActiveGoal, writeGoal, writeMemory, writeScratchpad } = await import("../dist/memory.js");
const { findPath, navigate, interact } = await import("../dist/navigation.js");
const { allEnemiesDefeated, battleAction } = await import("../dist/battle.js");
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
  await fs.mkdir(game, { recursive: true });
  await fs.writeFile(path.join(game, "Save01.rvdata2"), "slot-one", "ascii");
  await fs.writeFile(path.join(game, "Save02.rvdata2"), "slot-two", "ascii");
  const indexedSaves = await listSaves();
  assert.deepEqual(indexedSaves.map(({ name, slot, display_slot }) => ({ name, slot, display_slot })), [
    { name: "Save01.rvdata2", slot: 0, display_slot: 1 },
    { name: "Save02.rvdata2", slot: 1, display_slot: 2 },
  ]);
  await Promise.all(["Save01.rvdata2", "Save02.rvdata2"].map((name) => fs.unlink(path.join(game, name))));

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
  assert.ok(ACTIONS.includes("dash_up"));
  assert.ok(ACTIONS.includes("text_skip"));
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
  assert.equal(allEnemiesDefeated({ battle: { enemies: [{ hp: 0, dead: true, hidden: false }] } }), true);
  assert.equal(allEnemiesDefeated({ battle: { enemies: [{ hp: 1, dead: false, hidden: false }] } }), false);
  assert.equal(allEnemiesDefeated({ battle: { enemies: [{ hp: 99, dead: false, hidden: true }] } }), false);

  // A skill the actor cannot pay for must be refused before any key is sent. Letting it
  // through makes the game buzz, commit nothing, and the call report a phantom success.
  const battleState = await writeJson(path.join(runtime, "state"), "state-battle.json", {
    ...base, frame: 130, updated_at: now(), scene: {
      name: "Scene_Battle",
      windows: [{ class: "Window_ActorCommand", active: true, index: 0, item_max: 4, col_max: 1, current_symbol: "attack" }],
    },
    player: { x: 1, y: 1 }, message: { busy: false, choices: [] },
    party: { gold: 0, members: [{ name: "Hero", hp: 100, mhp: 100, mp: 3, mmp: 60, tp: 0 }] },
    battle: { active: true, turn: 4, enemies: [{ name: "Slime", hp: 50, mhp: 50, dead: false }] },
  });
  const optionsPayload = {
    ok: true, data: {
      available: true, actor: { name: "Hero", hp: 100, mhp: 100, mp: 3, mmp: 60, tp: 0 },
      commands: [], items: [], enemy_targets: [{ target_index: 0, battler_index: 0, name: "Slime" }],
      skill_groups: [{ action: "skill", label: "Skills", skills: [{ index: 0, name: "Fireball", mp_cost: 20, tp_cost: 0, usable_now: false }] }],
    },
  };
  const refusal = battleAction("skill", 0, 0, 0, 8000);
  await answerNextQuery(optionsPayload);
  await assert.rejects(refusal, /Fireball.*cannot be used right now/s, "an unaffordable skill must be refused, not silently swallowed");
  const missing = battleAction("skill", 7, 0, 0, 8000);
  await answerNextQuery(optionsPayload);
  await assert.rejects(missing, /skill_index 7 does not exist/, "an out-of-range skill index must name the real list");
  await fs.unlink(battleState);
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
  const corridor = [0, 1, 2].map((x) => ({ x, y: 0, passable: { up: false, down: false, left: x > 0, right: x < 2 } }));
  assert.deepEqual(findPath(corridor, { x: 0, y: 0 }, { x: 2, y: 0 }, 6, new Set(["1,0"])), [], "an occupied event tile must block the route");
  corridor[1].passable.left = false;
  assert.deepEqual(findPath(corridor, { x: 0, y: 0 }, { x: 1, y: 0 }), [], "movement also requires reverse passability from the destination tile");
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
  const [, acceleratedInputCommand] = await Promise.all([
    sendSequence([{ action: "dash_up" }, { action: "text_skip", repeat: 3 }], 3000),
    answerNextQuery({ ok: true, frame: 131 }),
  ]);
  assert.match(acceleratedInputCommand, /steps=dash_up:1;text_skip:3/);
  await assert.rejects(
    () => sendSequence(Array.from({ length: 7 }, () => ({ wait_frames: 600 })), 500),
    /maximum is 3600/,
    "oversized sequences must be rejected before a command file is written",
  );

  const preResetState = await writeJson(path.join(runtime, "state"), "state-pre-reset.json", {
    ...base, frame: 500, updated_at: now(), scene: { name: "Scene_Title" },
  });
  const resetAction = sendSequence([{ action: "confirm" }], 3000);
  let postResetState;
  const resetResponder = (async () => {
    await answerNextQuery({ ok: true, frame: 3 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    postResetState = await writeJson(path.join(runtime, "state"), "state-post-reset.json", {
      ...base, frame: 600, updated_at: now(), scene: { name: "Scene_Map" },
    });
  })();
  const [resetResult] = await Promise.all([resetAction, resetResponder]);
  assert.equal(resetResult.frame_before, 500);
  assert.equal(resetResult.frame, 3);
  assert.equal(resetResult.state?.frame, 600, "a post-reset snapshot remains valid even if its counter already passed the old frame");
  assert.equal(resetResult.state?.scene?.name, "Scene_Map");
  await Promise.all([fs.unlink(preResetState), fs.unlink(postResetState)]);

  // Choices can already be declared while a preceding text pause still owns input, and
  // BLACK SOULS then opens the menu with no selected row (index -1). Advance the pause,
  // move the real cursor to row zero, and only then confirm.
  const choiceState = await writeJson(path.join(runtime, "state"), "state-choice.json", {
    ...base, frame: 510, updated_at: now(), scene: {
      name: "Scene_Map",
      windows: [{ class: "Window_ChoiceList", active: false, index: 0, item_max: 2, col_max: 1, current_symbol: null }],
    },
    message: { busy: true, text: "Confirm?", choices: ["Yes", "No"] },
  });
  let openedChoiceState; let selectedChoiceState; let completedChoiceState;
  const chooseFirst = advanceDialogue(0, 30, 3000);
  const choiceResponder = (async () => {
    const revealCommand = await answerNextQuery({ ok: true, frame: 511 });
    assert.match(revealCommand, /confirm:1/, "declared choices must not be treated as an active window before the text pause clears");
    openedChoiceState = await writeJson(path.join(runtime, "state"), "state-choice-opened.json", {
      ...base, frame: 512, updated_at: now(), scene: {
        name: "Scene_Map",
        windows: [{ class: "Window_ChoiceList", active: true, index: -1, item_max: 2, col_max: 1, current_symbol: null }],
      },
      message: { busy: true, text: "Confirm?", choices: ["Yes", "No"] },
    });
    const cursorCommand = await answerNextQuery({ ok: true, frame: 513 });
    assert.match(cursorCommand, /move_down:1/, "an unselected choice window must move to row zero before confirmation");
    selectedChoiceState = await writeJson(path.join(runtime, "state"), "state-choice-selected.json", {
      ...base, frame: 514, updated_at: now(), scene: {
        name: "Scene_Map",
        windows: [{ class: "Window_ChoiceList", active: true, index: 0, item_max: 2, col_max: 1, current_symbol: null }],
      },
      message: { busy: true, text: "Confirm?", choices: ["Yes", "No"] },
    });
    const confirmCommand = await answerNextQuery({ ok: true, frame: 515 });
    assert.match(confirmCommand, /confirm:1/, "the requested choice must be confirmed after the cursor reaches it");
    completedChoiceState = await writeJson(path.join(runtime, "state"), "state-choice-completed.json", {
      ...base, frame: 516, updated_at: now(), scene: { name: "Scene_Map", windows: [] },
      message: { busy: false, text: "", choices: [] },
    });
  })();
  const [choiceResult] = await Promise.all([chooseFirst, choiceResponder]);
  assert.equal(choiceResult.ok, true);
  assert.equal(choiceResult.dialogue_ended, true);
  assert.equal(choiceResult.lines_advanced, 1);
  await Promise.all([choiceState, openedChoiceState, selectedChoiceState, completedChoiceState].map((file) => fs.unlink(file)));

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
  await fs.writeFile(path.join(runtime, "frame_rate.txt"), "120\n", "ascii");
  const prepared = await prepareBridgeRuntime(nextToken);
  assert.ok(prepared.archived_runtime?.startsWith(path.join(root, "extract")));
  assert.equal((await fs.readFile(path.join(runtime, "launch.token"), "ascii")).trim(), nextToken);
  assert.equal((await fs.readFile(path.join(runtime, "frame_rate.txt"), "ascii")).trim(), "120");
  assert.equal((await bridgeStatus()).connected, false);
  await assert.rejects(() => sendQuery("variables"), /bridge is not ready/i);
  assert.deepEqual(await killGame(), { ok: true, pid: null, signal: "none", message: "not running" });
  await assert.rejects(() => triggerSave(2), /bridge is not ready/i);
  await assert.rejects(() => navigate(1, 1), /bridge is not ready/i);
  const menuState = await writeJson(path.join(runtime, "state"), "state-menu.json", {
    ...base, launch_token: nextToken, frame: 400, updated_at: now(), scene: { name: "Scene_Menu" }, player: { x: 5, y: 5 },
  });
  const menuMap = await writeJson(path.join(runtime, "map"), "map-menu.json", {
    ...base, launch_token: nextToken, frame: 400, updated_at: now(), available: true, map_id: 21, radius: 6, tiles: [], events: [{ id: 5, x: 5, y: 4 }],
  });
  await writeJson(path.join(runtime, "info"), "info-menu.json", { ...base, launch_token: nextToken, capabilities: [] });
  await assert.rejects(() => navigate(5, 6), /needs the player on the map/i, "movement keys must never be sent from a menu");
  await assert.rejects(() => interact(5), /needs the player on the map/i, "interact must never be sent from a menu");
  await Promise.all([fs.unlink(menuState), fs.unlink(menuMap)]);
  // Unreadable snapshots are not evidence the game died: while the recorded PID is alive the
  // report must stay a warning and must never tell the caller to relaunch or kill.
  const unreadableHealth = await bridgeHealth();
  assert.equal(unreadableHealth.game_running, true, "a live PID must not be reported as a dead game");
  assert.ok(unreadableHealth.issues.some((issue) => issue.code === "bridge_unreadable" && issue.severity === "warning"));
  assert.doesNotMatch(unreadableHealth.recommended_action, /black_souls_launch|black_souls_kill/);
  const deadPid = 0x7ffffffe;
  await writeJson(path.join(runtime, "info"), "info-dead.json", { ...base, pid: deadPid, launch_token: nextToken, capabilities: [] });
  const stoppedHealth = await bridgeHealth();
  assert.equal(stoppedHealth.game_running, false); assert.ok(stoppedHealth.issues.some((issue) => issue.code === "game_not_running" && issue.severity === "critical"));
  assert.match(stoppedHealth.recommended_action, /black_souls_launch/);
  await fs.unlink(path.join(runtime, "info", "info-dead.json"));
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

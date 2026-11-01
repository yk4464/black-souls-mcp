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

const { ACTIONS, BRIDGE_PROTOCOL, advanceDialogue, bridgeHealth, bridgeStatus, buildSituation, evalStatus, prepareBridgeRuntime, queryVariables, readMap, readState, selectCommandSymbol, sendQuery, sendSequence, triggerLoad, triggerSave, waitForCondition } = await import("../dist/bridge.js");
const { killGame, launchGame, listSaves } = await import("../dist/game.js");
const { appendSessionLog, deleteMemory, readGoals, readMemory, readScratchpad, readSessionLog, setActiveGoal, writeGoal, writeMemory, writeScratchpad } = await import("../dist/memory.js");
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
      commands: [{ index: 0, action: "skill", symbol: "skill", occurrence: 0, enabled: true }], items: [], enemy_targets: [{ target_index: 0, battler_index: 0, name: "Slime" }],
      skill_groups: [{ action: "skill", label: "Skills", skills: [{ index: 0, name: "Fireball", mp_cost: 20, tp_cost: 0, usable_now: false }] }],
    },
  };
  const refusal = battleAction("skill", 0, 0, 0, 8000);
  await answerNextQuery(optionsPayload);
  await assert.rejects(refusal, /Fireball.*cannot be used right now.*insufficient MP/s, "an unaffordable skill must be refused, not silently swallowed");
  const unusableSkill = battleAction("skill", 0, 0, 0, 8000);
  await answerNextQuery({ ok: true, data: {
    ...optionsPayload.data, actor: { name: "Hero", mp: 80, mmp: 100, tp: 20 },
    skill_groups: [{ action: "skill", label: "Skills", skills: [{ name: "Decapitation", mp_cost: 10, tp_cost: 0, usable_now: false }] }],
  } });
  await assert.rejects(unusableSkill, (error) => {
    assert.match(error.message, /Decapitation.*cannot be used right now.*costs 10 MP \/ 0 TP.*80\/100 MP and 20 TP/s);
    return true;
  });
  assert.deepEqual(await fs.readdir(path.join(runtime, "inbox")), [], "an unusable skill must not send any battle input");
  const missing = battleAction("skill", 7, 0, 0, 8000);
  await answerNextQuery(optionsPayload);
  await assert.rejects(missing, /skill_index 7 does not exist/, "an out-of-range skill index must name the real list");
  const absentMagic = battleAction("magic", 0, 0, 0, 8000);
  await answerNextQuery(optionsPayload);
  await assert.rejects(absentMagic, /no "magic" command/, "one skill type must not invent a second magic command");
  const disabledItem = battleAction("item", 0, 0, 0, 8000);
  await answerNextQuery({ ok: true, data: { ...optionsPayload.data, commands: [{ index: 0, action: "item", symbol: "item", occurrence: 0, enabled: false }] } });
  await assert.rejects(disabledItem, /"item" command is disabled/, "disabled actor commands must be rejected before confirmation");
  const charging = battleAction("skill", 0, 0, 0, 8000);
  await answerNextQuery({ ok: true, data: { available: false, reason: "no acting battler ready" } });
  await assert.rejects(charging, /no acting battler ready/, "ATB charge must not fall back to a different actor");
  const disabledCursorState = await writeJson(path.join(runtime, "state"), "state-disabled-command.json", {
    ...base, frame: 131, updated_at: now(), scene: { name: "Scene_Battle", windows: [{ class: "Window_ActorCommand", active: true, index: 0, item_max: 1, col_max: 1, current_symbol: "item", current_enabled: false }] },
    battle: { active: true },
  });
  await assert.rejects(selectCommandSymbol("item"), /disabled/, "current command enablement must be enforced even if a stale options query said yes");
  await fs.unlink(disabledCursorState);
  await fs.unlink(battleState);
  const corpseState = await writeJson(path.join(runtime, "state"), "state-corpse.json", {
    ...base, frame: 135, updated_at: now(), scene: {
      name: "Scene_Battle",
      windows: [{ class: "Window_ActorCommand", active: true, index: 0, item_max: 4, col_max: 1, current_symbol: "attack" }],
    },
    player: { x: 1, y: 1 }, message: { busy: false, choices: [] },
    party: { gold: 0, members: [{ name: "Hero", hp: 100, mhp: 100, mp: 30, mmp: 60, tp: 0 }] },
    battle: { active: true, turn: 5, enemies: [{ name: "Slime", hp: 0, mhp: 50, dead: true }, { name: "Bat", hp: 30, mhp: 30, dead: false }] },
  });
  const targetOptions = { ok: true, data: { ...optionsPayload.data, commands: [{ index: 0, action: "attack", symbol: "attack", occurrence: 0, enabled: true }], enemy_targets: [{ battler_index: 1, target_index: 0, name: "Bat" }] } };
  const corpse = battleAction("attack", 0, 0, 0, 8000);
  await answerNextQuery(targetOptions);
  await assert.rejects(corpse, /already dead/, "a dead enemy_index must be refused instead of silently retargeting");
  const nonexistentTarget = battleAction("attack", 0, 0, 9, 8000);
  await answerNextQuery(targetOptions);
  await assert.rejects(nonexistentTarget, /enemy_index 9 does not exist/);
  const unselectableTarget = battleAction("attack", 0, 0, 1, 8000);
  await answerNextQuery({ ok: true, data: { ...targetOptions.data, enemy_targets: [] } });
  await assert.rejects(unselectableTarget, /not targetable/, "the target index must follow the game's alive_members list");
  await fs.unlink(corpseState);
  const guardState = await writeJson(path.join(runtime, "state"), "state-guard.json", {
    ...base, frame: 140, updated_at: now(), scene: { name: "Scene_Battle", windows: [{ class: "Window_ActorCommand", active: true, index: 0, item_max: 1, col_max: 1, current_symbol: "guard", current_enabled: true }] },
    message: { busy: false, choices: [] }, party: { members: [{ name: "Hero", hp: 100, mhp: 100 }] },
    battle: { active: true, turn: 5, enemies: [{ name: "Bat", hp: 30, dead: false }] },
  });
  const guard = battleAction("guard", 0, 0, 0, 8000);
  await answerNextQuery({ ok: true, data: { available: true, commands: [{ action: "guard", symbol: "guard", occurrence: 0, enabled: true }], enemy_targets: [] } });
  const guardConfirm = await answerNextQuery({ ok: true, frame: 141 });
  assert.match(guardConfirm, /confirm:1/);
  const guardResult = await guard;
  assert.equal(guardResult.ok, true);
  assert.equal(guardResult.turn_before, guardResult.turn_after, "a reopened command window can mean another action slot; turn need not change");
  assert.match(guardResult.message, /one battle input accepted/);
  await fs.unlink(guardState);
  const resolvingState = await writeJson(path.join(runtime, "state"), "state-resolving.json", {
    ...base, frame: 145, updated_at: now(), scene: { name: "Scene_Battle", windows: [{ class: "Window_ActorCommand", active: true, index: 0, item_max: 1, col_max: 1, current_symbol: "guard", current_enabled: true }] },
    message: { busy: false }, party: { members: [{ name: "Hero", hp: 100 }] },
    battle: { active: true, turn: 5, enemies: [{ name: "Bat", hp: 30, dead: false }] },
  });
  const resolving = battleAction("guard", 0, 0, 0, 8000);
  await answerNextQuery({ ok: true, data: { available: true, commands: [{ action: "guard", symbol: "guard", occurrence: 0, enabled: true }] } });
  await answerNextQuery({ ok: true, frame: 146 });
  const resolvingAnimation = await writeJson(path.join(runtime, "state"), "state-resolving-animation.json", {
    ...base, frame: 147, updated_at: now(), scene: { name: "Scene_Battle", windows: [] },
    message: { busy: false }, party: { members: [{ name: "Hero", hp: 100 }] },
    battle: { active: true, turn: 5, enemies: [{ name: "Bat", hp: 30, dead: false }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 2300));
  const victoryState = await writeJson(path.join(runtime, "state"), "state-resolving-victory.json", {
    ...base, frame: 148, updated_at: now(), scene: { name: "Scene_Battle", windows: [] },
    message: { busy: true, text: "Victory" }, party: { members: [{ name: "Hero", hp: 100 }] },
    battle: { active: true, turn: 6, enemies: [{ name: "Bat", hp: 0, dead: true }] },
  });
  const settlementConfirm = await answerNextQuery({ ok: true, frame: 149 });
  assert.match(settlementConfirm, /confirm:1;wait:20/, "victory settlement must still receive confirmation");
  const settledState = await writeJson(path.join(runtime, "state"), "state-resolving-settled.json", {
    ...base, frame: 150, updated_at: now(), scene: { name: "Scene_Map", windows: [], interpreter_running: false },
    message: { busy: false }, party: { members: [{ name: "Hero", hp: 100 }] }, battle: { active: false, turn: 6, enemies: [] },
  });
  const resolvingResult = await resolving;
  assert.equal(resolvingResult.battle_ended, true, "battle settlement after two seconds must not be skipped");
  assert.equal(resolvingResult.battle_outcome, "victory", "the observed victory must survive the troop being cleared on the map");
  assert.equal(resolvingResult.message_pending, false);
  await Promise.all([resolvingState, resolvingAnimation, victoryState, settledState].map((file) => fs.unlink(file)));
  // 输入前已胜利时跳过指令选择，仍须推进胜利结算。
  const alreadyVictoryState = await writeJson(path.join(runtime, "state"), "state-already-victory.json", {
    ...base, frame: 150, updated_at: now(), scene: { name: "Scene_Battle", windows: [] },
    message: { busy: true, text: "Victory" }, party: { members: [{ name: "Hero", hp: 100 }] },
    battle: { active: true, turn: 6, enemies: [{ name: "Bat", hp: 0, dead: true }] },
  });
  const alreadyVictorious = battleAction("guard", 0, 0, 0, 8000);
  const alreadyVictoryConfirm = await answerNextQuery({ ok: true, frame: 151 });
  assert.match(alreadyVictoryConfirm, /confirm:1;wait:20/, "a victory observed before input must still advance settlement");
  const alreadySettledState = await writeJson(path.join(runtime, "state"), "state-already-settled.json", {
    ...base, frame: 152, updated_at: now(), scene: { name: "Scene_Map", windows: [], interpreter_running: false },
    message: { busy: false }, party: { members: [{ name: "Hero", hp: 100 }] }, battle: { active: false, turn: 6, enemies: [] },
  });
  const alreadyVictoryResult = await alreadyVictorious;
  assert.equal(alreadyVictoryResult.ok, false);
  assert.equal(alreadyVictoryResult.battle_outcome, "victory");
  assert.equal(alreadyVictoryResult.battle_ended, true);
  assert.equal(alreadyVictoryResult.message_pending, false);
  assert.match(alreadyVictoryResult.message, /^no input was submitted;/);
  assert.doesNotMatch(alreadyVictoryResult.message, /input accepted/);
  assert.deepEqual(await fs.readdir(path.join(runtime, "inbox")), []);
  await Promise.all([alreadyVictoryState, alreadySettledState].map((file) => fs.unlink(file)));
  // 结局与待处理事件独立报告，阵亡和逃跑消息不接受额外确认。
  for (const ending of [
    { action: "guard", outcome: "defeat", scene: "Scene_Battle", active: true, hp: 0, text: "Defeat", running: false },
    { action: "guard", outcome: "defeat", scene: "Scene_Map", active: false, hp: 100, text: "YOU DIED", running: true },
    { action: "flee", outcome: "escape", scene: "Scene_Map", active: false, hp: 100, text: "Hero escaped!", running: true },
    { action: "flee", outcome: "escape", scene: "Scene_Battle", active: false, hp: 100, text: "Hero escaped!", running: false },
    { action: "guard", outcome: "unknown", scene: "Scene_Map", active: false, hp: 100, text: "Event", running: true },
  ]) {
    const command = { action: ending.action, symbol: ending.action === "flee" ? "escape" : "guard", occurrence: 0, enabled: true };
    const startingState = await writeJson(path.join(runtime, "state"), "state-ending-start.json", {
      ...base, frame: 150, updated_at: now(), scene: { name: "Scene_Battle", windows: [{ class: "Window_ActorCommand", active: true, current_symbol: command.symbol }] },
      message: { busy: false }, party: { members: [{ name: "Hero", hp: 100 }] },
      battle: { active: true, turn: 5, enemies: [{ name: "Bat", hp: 44, mhp: 50, dead: false }] },
    });
    const endingAction = battleAction(ending.action, 0, 0, 0, 8000);
    await answerNextQuery({ ok: true, data: { available: true, commands: [command] } });
    await answerNextQuery({ ok: true, frame: 151 });
    const endingState = await writeJson(path.join(runtime, "state"), "state-ending-result.json", {
      ...base, frame: 152, updated_at: now(), scene: { name: ending.scene, windows: [], interpreter_running: ending.running },
      message: { busy: true, text: ending.text }, party: { members: [{ name: "Hero", hp: ending.hp }] },
      battle: { active: ending.active, turn: 6, enemies: [{ name: "Bat", hp: 44, mhp: 50, dead: false }] },
    });
    const endingResult = await endingAction;
    assert.equal(endingResult.ok, true);
    assert.equal(endingResult.battle_outcome, ending.outcome);
    assert.equal(endingResult.battle_ended, !ending.active);
    assert.equal(endingResult.message_pending, true);
    assert.equal(endingResult.interpreter_running, ending.running);
    assert.doesNotMatch(endingResult.message, /settlement was advanced/);
    if (ending.outcome === "defeat") assert.match(endingResult.message, /party was defeated/);
    if (ending.active) {
      const alreadyDefeated = await battleAction("guard", 0, 0, 0, 8000);
      assert.equal(alreadyDefeated.ok, false);
      assert.equal(alreadyDefeated.battle_outcome, "defeat");
      assert.match(alreadyDefeated.message, /^no input was submitted;/);
      assert.doesNotMatch(alreadyDefeated.message, /input accepted/);
    }
    assert.deepEqual(await fs.readdir(path.join(runtime, "inbox")), [], "death and map messages must not receive automatic input");
    await Promise.all([startingState, endingState].map((file) => fs.unlink(file)));
  }
  const equipmentState = await writeJson(path.join(runtime, "state"), "state-equipment.json", {
    ...base, frame: 150, updated_at: now(), scene: { name: "Scene_Battle", windows: [{ class: "Window_ActorCommand", active: true, index: 0, item_max: 1, col_max: 1, current_symbol: "equip_change", current_enabled: true }] },
    message: { busy: false }, party: { members: [{ name: "Hero", hp: 100 }] }, battle: { active: true, turn: 5, enemies: [] },
  });
  const equip = battleAction("equip_change", 0, 0, 0, 8000);
  await answerNextQuery({ ok: true, data: { available: true, commands: [{ action: "equip_change", symbol: "equip_change", occurrence: 0, enabled: true }] } });
  await answerNextQuery({ ok: true, frame: 151 });
  const equipmentScene = await writeJson(path.join(runtime, "state"), "state-equipment-scene.json", {
    ...base, frame: 152, updated_at: now(), scene: { name: "Scene_Equip", windows: [] },
    party: { members: [{ name: "Hero", hp: 100 }] }, battle: { active: true, turn: 5, enemies: [] },
  });
  const equipResult = await equip;
  assert.equal(equipResult.ok, true);
  assert.equal(equipResult.battle_ended, false, "opening equipment must not be described as winning the battle");
  await Promise.all([equipmentState, equipmentScene].map((file) => fs.unlink(file)));
  const noTurnState = await writeJson(path.join(runtime, "state"), "state-noturn.json", {
    ...base, frame: 136, updated_at: now(), scene: { name: "Scene_Map" }, battle: { active: false, turn: null },
  }, 3000);
  const notInBattle = await battleAction("attack", 0, 0, 0, 8000);
  assert.equal(notInBattle.ok, false);
  assert.equal(notInBattle.turn_before, null, "a missing turn must not be reported as turn 0");
  await fs.unlink(noTurnState);
  const menuDisabledState = await writeJson(path.join(runtime, "state"), "state-menu-disabled.json", {
    ...base, frame: 137, updated_at: now(), scene: { name: "Scene_Map", windows: [], interpreter_running: true },
    message: { busy: false }, system: { menu_disabled: true }, battle: { active: false },
  }, 3000);
  await assert.rejects(triggerSave(0), /菜单被剧情禁用/, "story-locked menus must not be misreported as a missing command window");
  await assert.rejects(triggerLoad(0), /菜单被剧情禁用/, "story-locked menus must not be misreported as a missing load command");
  assert.ok(!(await buildSituation()).suggested_actions.includes("open_menu"));
  await fs.unlink(menuDisabledState);
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
      ...base, frame: 516, updated_at: now(), scene: { name: "Scene_Map", windows: [], interpreter_running: true },
      message: { busy: false, text: "", choices: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const nextLine = await writeJson(path.join(runtime, "state"), "state-choice-next.json", {
      ...base, frame: 517, updated_at: now(), scene: { name: "Scene_Map", windows: [], interpreter_running: true },
      message: { busy: true, text: "Next line", choices: [] },
    });
    const nextConfirm = await answerNextQuery({ ok: true, frame: 518 });
    assert.match(nextConfirm, /confirm:1/, "a new line after a choice gap must also be advanced");
    await fs.unlink(nextLine);
    await writeJson(path.join(runtime, "state"), "state-choice-end.json", {
      ...base, frame: 519, updated_at: now(), scene: { name: "Scene_Map", windows: [], interpreter_running: false }, message: { busy: false, text: "", choices: [] },
    });
  })();
  const [choiceResult] = await Promise.all([chooseFirst, choiceResponder]);
  assert.equal(choiceResult.ok, true);
  assert.equal(choiceResult.dialogue_ended, true);
  assert.equal(choiceResult.lines_advanced, 2);
  await Promise.all([choiceState, openedChoiceState, selectedChoiceState, completedChoiceState].map((file) => fs.unlink(file)));
  await fs.unlink(path.join(runtime, "state", "state-choice-end.json"));
  const disabledChoiceState = await writeJson(path.join(runtime, "state"), "state-disabled-choice.json", {
    ...base, frame: 520, updated_at: now(), scene: { name: "Scene_Map", windows: [{ class: "Window_ChoiceList", active: true, index: 0, item_max: 2, col_max: 1, current_enabled: false }] },
    message: { busy: true, choices: ["No", "Yes"] },
  });
  await assert.rejects(advanceDialogue(0), /choice_index 0 is disabled/, "a disabled choice must not be reported as selected");
  await fs.unlink(disabledChoiceState);
  const stalledDialogueState = await writeJson(path.join(runtime, "state"), "state-stalled-dialogue.json", {
    ...base, frame: 521, updated_at: now(), scene: { name: "Scene_Map", windows: [], interpreter_running: true },
    message: { busy: true, text: "Before event wait", choices: [] },
  });
  const stalledStart = Date.now();
  const stalledDialogue = advanceDialogue(undefined, 1, 30000);
  await answerNextQuery({ ok: true, frame: 522 });
  const stalledEventState = await writeJson(path.join(runtime, "state"), "state-stalled-event.json", {
    ...base, frame: 523, updated_at: now(), scene: { name: "Scene_Map", windows: [], interpreter_running: true },
    message: { busy: false, text: "", choices: [] },
  });
  const stalledResult = await stalledDialogue;
  assert.equal(stalledResult.dialogue_ended, false, "a running event can have a long gap between messages");
  assert.ok(Date.now() - stalledStart < 5000, "a running event must not occupy the full 30-second call timeout");
  await Promise.all([stalledDialogueState, stalledEventState].map((file) => fs.unlink(file)));

  // 模拟移动事件离开快照范围，区分目标丢失与真实对话响应。
  for (const scenario of ["approach-disappeared", "confirm-disappeared", "dialogue"]) {
    const eventX = scenario === "approach-disappeared" ? 2 : 1;
    const event = { id: 7, name: "移动 NPC", x: eventX, y: 0, priority_type: 1, through: false, active_page: 1 };
    const fieldState = {
      ...base, frame: 700, updated_at: now(), scene: { name: "Scene_Map", windows: [] },
      player: { x: 0, y: 0 }, map: { id: 104 }, message: { busy: false, choices: [] }, battle: { active: false },
    };
    const fieldMap = {
      ...base, available: true, map_id: 104, radius: 6, center: { x: 0, y: 0 }, events: [event],
      tiles: [0, 1, 2].map((x) => ({ x, y: 0, passable: { left: x > 0, right: x < 2, up: false, down: false } })),
    };
    const stateFile = await writeJson(path.join(runtime, "state"), "state-interaction.json", fieldState);
    const mapFile = await writeJson(path.join(runtime, "map"), "map-interaction.json", fieldMap);
    const response = (async () => {
      const inbox = path.join(runtime, "inbox");
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const file = (await fs.readdir(inbox).catch(() => [])).find((name) => name.endsWith(".cmd"));
        if (!file) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
        const command = await fs.readFile(path.join(inbox, file), "ascii");
        const id = command.match(/^id=(.+)$/m)?.[1]?.trim();
        assert.ok(id);
        if (scenario === "approach-disappeared") {
          assert.doesNotMatch(command, /confirm:/, "接近目标时尚未发送确认");
        } else {
          assert.match(command, /confirm:/, "相邻目标应收到确认输入");
        }
        await fs.unlink(path.join(inbox, file));
        await writeJson(path.join(runtime, "state"), "state-interaction.json", {
          ...fieldState, frame: 701, updated_at: now(),
          player: { x: scenario === "approach-disappeared" ? 1 : 0, y: 0 },
          message: scenario === "dialogue" ? { busy: true, text: "你好", choices: [] } : fieldState.message,
        });
        await writeJson(path.join(runtime, "map"), "map-interaction.json", {
          ...fieldMap, events: scenario === "dialogue" ? [event] : [],
        });
        await writeJson(path.join(runtime, "outbox"), `${id}.json`, { id, launch_token: token, ok: true, frame: 701 });
        return;
      }
      throw new Error("交互测试没有收到输入指令");
    })();
    const [interaction] = await Promise.all([interact(7, 3000), response]);
    assert.equal(interaction.ok, scenario === "dialogue", `${scenario} 不应把目标丢失当成交互成功`);
    if (scenario === "dialogue") assert.equal(interaction.message_after, "你好");
    await Promise.all([fs.unlink(stateFile), fs.unlink(mapFile)]);
  }

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
  const unavailState = await writeJson(path.join(runtime, "state"), "state-unavail.json", {
    ...base, launch_token: nextToken, frame: 402, updated_at: now(), scene: { name: "Scene_Map" }, player: { x: 5, y: 5 },
  }, 3000);
  await writeJson(path.join(runtime, "map"), "map-unavail.json", {
    ...base, launch_token: nextToken, frame: 402, updated_at: now(), available: false,
  }, 4000);
  const unavailable = await navigate(5, 6);
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.message, /map data is unavailable/, "a missing map snapshot must not be reported as an unpassable route");
  await Promise.all([fs.unlink(unavailState), fs.unlink(path.join(runtime, "map", "map-unavail.json")).catch(() => undefined)]);
  await Promise.all([fs.unlink(menuState), fs.unlink(menuMap)]);

  // triggerLoad from the in-game menu must verify the transition actually landed: an
  // empty slot only buzzes, and the old code reported that as a completed load.
  const loadStateFor = (scene) => async () => {
    await writeJson(path.join(runtime, "state"), "state-loadflow.json", {
      ...base, launch_token: nextToken, frame: 900, updated_at: now(), scene, player: { x: 5, y: 5 },
    });
  };
  const respondToSequence = async (steps) => {
    const inbox = path.join(runtime, "inbox");
    const outbox = path.join(runtime, "outbox");
    for (const step of steps) {
      const deadline = Date.now() + 2000;
      let name = null;
      while (Date.now() < deadline) {
        name = (await fs.readdir(inbox).catch(() => [])).find((entry) => entry.endsWith(".cmd"));
        if (name) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(name, "expected a command file");
      const command = await fs.readFile(path.join(inbox, name), "ascii");
      const id = command.match(/^id=(.+)$/m)?.[1]?.trim();
      assert.ok(id);
      await fs.unlink(path.join(inbox, name));
      await step.writeState();
      await writeJson(outbox, `${id}.json`, { id, launch_token: nextToken, ok: true, frame: 900 });
    }
  };
  const menuAt = (index, symbol) => ({ name: "Scene_Menu", windows: [{ class: "Window_MenuCommand", active: true, index, item_max: 2, col_max: 1, current_symbol: symbol }] });
  const loadScene = { name: "Scene_Load", file_index: 0, windows: [] };
  await writeJson(path.join(runtime, "state"), "state-loadflow.json", {
    ...base, launch_token: nextToken, frame: 899, updated_at: now(), scene: { name: "Scene_Map" }, player: { x: 5, y: 5 },
  });
  const loadFlow = triggerLoad(0, 3000);
  const loadResponder = respondToSequence([
    { writeState: loadStateFor(menuAt(0, "save")) },
    { writeState: loadStateFor(menuAt(1, "load")) },
    { writeState: loadStateFor(loadScene) },
    { writeState: loadStateFor(loadScene) },
  ]);
  const loadResult = await Promise.all([loadFlow, loadResponder]).then(([value]) => value);
  assert.equal(loadResult.ok, false, "an in-game-menu load that never reaches Scene_Map must not report success");
  assert.match(loadResult.message, /did not appear/);
  await fs.unlink(path.join(runtime, "state", "state-loadflow.json")).catch(() => undefined);
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
  const stuckHealth = await bridgeHealth(); assert.ok(stuckHealth.issues.some((issue) => issue.code === "stuck_command" && issue.severity === "warning"), "a connected bridge with queued commands is a wait, not a wedge");
  assert.doesNotMatch(stuckHealth.recommended_action, /black_souls_kill/);
  assert.equal((await waitForCondition({ type: "message_clear" }, 100)).timed_out, false);
  assert.equal((await waitForCondition({ type: "scene", value: "Scene_Battle" }, 50, 10)).timed_out, true);

  // Corrupt memory files must recover instead of bricking every memory tool and the
  // session log, which reads the scratchpad on every append.
  await fs.writeFile(path.join(root, "memory", "scratchpad.json"), "{corrupt", "utf8");
  const recoveredPad = await readScratchpad();
  assert.equal(typeof recoveredPad.session_id, "string");
  await appendSessionLog({ event_type: "observation", summary: "after-corruption" });
  assert.equal((await readSessionLog(1)).at(-1).summary, "after-corruption", "a corrupt scratchpad must not block the session log");
  // Consecutive appends without a persisted scratchpad must share one session id.
  await appendSessionLog({ event_type: "observation", summary: "sid-a" });
  await appendSessionLog({ event_type: "observation", summary: "sid-b" });
  const sidLogs = await readSessionLog(2);
  assert.equal(sidLogs[0].session_id, sidLogs[1].session_id, "appends without a scratchpad must share a session id");

  // "__proto__" must become a real own property: readable, deletable, non-polluting.
  await writeMemory("map", "__proto__", "polluted", "certain", "unit test");
  const protoBucket = await readMemory("map");
  assert.equal(Object.prototype.hasOwnProperty.call(protoBucket, "__proto__"), true);
  assert.equal(protoBucket.__proto__.value, "polluted");
  assert.equal((await deleteMemory("map", "__proto__")).deleted, true);
  assert.equal(Object.prototype.hasOwnProperty.call(await readMemory("map"), "__proto__"), false);
  await writeMemory("map", "clean-key", "v", "certain", "unit test");
  assert.equal((await deleteMemory("map", "__proto__")).deleted, false, "a clean bucket must not report a phantom deletion via the prototype chain");

  // Eviction must not delete the entry the current write just added.
  for (let index = 0; index < 200; index += 1) await writeMemory("boss", `c-${index}`, `v-${index}`, "certain", "unit test");
  await writeMemory("boss", "fresh", "kept", "uncertain", "unit test");
  assert.ok((await readMemory("boss")).fresh, "a just-written uncertain entry must survive its own write's eviction");

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

  // Game selection: bs1 stays the default so existing installs keep working; bs2 gets
  // its own copy, fingerprint and memory, and the choice survives a server restart.
  const { activeGame, gameDir, memoryDir, expectedExeSha256, GAME_PROFILES } = await import("../dist/config.js");
  const { listGames, selectGame } = await import("../dist/game.js");
  assert.equal(activeGame(), "bs1");
  assert.equal(gameDir(), game);
  assert.equal((await listGames()).games.find((entry) => entry.id === "bs2").prepared, false);
  // A live bs1 bridge (this test process stands in for Game.exe) must block switching.
  await prepareBridgeRuntime(token);
  await writeJson(path.join(runtime, "info"), "info-running.json", { ...base, capabilities: [] });
  await writeJson(path.join(runtime, "state"), "state-running.json", { ...base, updated_at: now(), scene: { name: "Scene_Map", windows: [] } });
  await assert.rejects(selectGame("bs2"), /still running/, "selectGame must refuse while the bridge reports a live game");
  // Once the process is gone (a dead PID in fresh snapshots) the switch goes through.
  await prepareBridgeRuntime(token);
  await writeJson(path.join(runtime, "info"), "info-exited.json", { ...base, pid: 0x7ffffffe, capabilities: [] });
  await writeJson(path.join(runtime, "state"), "state-exited.json", { ...base, pid: 0x7ffffffe, updated_at: now(), scene: { name: "Scene_Map", windows: [] } });
  const switched = await selectGame("bs2");
  assert.equal(switched.switched, true); assert.equal(switched.previous, "bs1"); assert.equal(switched.active, "bs2");
  assert.equal(activeGame(), "bs2");
  assert.equal(gameDir(), path.join(root, "game2"));
  assert.equal(memoryDir(), path.join(root, "memory-bs2"));
  assert.equal(expectedExeSha256(), GAME_PROFILES.bs2.knownExeSha256);
  assert.equal((await fs.readFile(path.join(root, "active_game.txt"), "ascii")).trim(), "bs2");
  assert.equal((await readScratchpad()).notes, "", "bs2 must not see bs1's scratchpad");
  await appendSessionLog({ event_type: "observation", summary: "bs2-only" });
  assert.equal((await readSessionLog(1))[0].summary, "bs2-only");
  assert.notEqual((await readSessionLog(1))[0].session_id, recentLog.at(-1).session_id, "missing scratchpads must not reuse a session id across games");
  await assert.rejects(() => launchGame(1000), /ENOENT|no such file/i);
  assert.equal((await selectGame("bs2")).switched, false);
  assert.equal((await selectGame("bs1")).active, "bs1");
  assert.equal(gameDir(), game);

  console.log("Bridge generation, corruption recovery, stale-state rejection, runtime archival, and launch integrity: OK");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

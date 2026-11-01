import { activeWindowOf, readState, selectCommandSymbol, selectWindowIndex, sendQuery, sendSequence } from "./bridge.js";

export type BattleActionType = "attack" | "skill" | "magic" | "guard" | "item" | "flee" | "equip_change";
export interface BattleActionResult {
  ok: boolean; action: BattleActionType; turn_before: number | null; turn_after: number | null;
  battle_still_active: boolean; battle_ended: boolean;
  battle_outcome: "victory" | "escape" | "defeat" | "unknown";
  message_pending: boolean; interpreter_running: boolean;
  enemies_after: Array<{ name: string; hp: number; mhp: number; dead: boolean }>;
  party_after: Array<{ name: string; hp: number; mhp: number; mp: number; mmp: number; tp: number }>; message: string;
}

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const turnOf = (battle: Record<string, unknown>): number | null => {
  const value = battle.turn;
  // JSON null (no troop yet) must not become turn 0 through Number(null) === 0.
  return (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value)) ? Number(value) : null;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const enemiesOf = (state: Record<string, unknown>) => (Array.isArray(objectValue(state.battle).enemies) ? objectValue(state.battle).enemies as unknown[] : []).map(objectValue);

export const allEnemiesDefeated = (state: Record<string, unknown>): boolean => {
  const visibleEnemies = enemiesOf(state).filter((enemy) => enemy.hidden !== true);
  return visibleEnemies.length > 0
    && visibleEnemies.every((enemy) => enemy.dead === true || Number(enemy.hp || 0) <= 0);
};

function battleOutcomeOf(state: Record<string, unknown>, action?: BattleActionType): BattleActionResult["battle_outcome"] {
  const party = objectValue(state.party);
  const members = (Array.isArray(party.members) ? party.members : []).map(objectValue);
  const scene = String(objectValue(state.scene).name || "");
  if ((members.length > 0 && members.every((member) => Number(member.hp) <= 0))
    || scene === "Scene_Gameover" || /\bYOU DIED\b/i.test(String(objectValue(state.message).text || ""))) return "defeat";
  if (allEnemiesDefeated(state)) return "victory";
  if (action === "flee" && objectValue(state.battle).active === false && scene === "Scene_Map"
    && members.some((member) => Number(member.hp) > 0)
    && enemiesOf(state).some((enemy) => enemy.hidden !== true && enemy.dead !== true && Number(enemy.hp) > 0)) return "escape";
  return "unknown";
}

async function cursor(action: "confirm" | "cancel", waitFrames: number, timeoutMs: number) {
  await sendSequence([{ action }, { wait_frames: waitFrames }], timeoutMs);
  return readState();
}

const readStateSafe = async (): Promise<Record<string, unknown> | null> => { try { return await readState(); } catch { return null; } };

// 回到角色指令窗；转场或演出期间等待，胜负已定时停止寻找输入窗口。
async function ensureActorCommandWindow(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let state = await readStateSafe();
  while (Date.now() < deadline) {
    const battleActive = objectValue(state?.battle ?? {}).active === true;
    const scene = String(objectValue(state?.scene ?? {}).name || "");
    if (state && (!battleActive || (scene && scene !== "Scene_Battle"))) return false;
    if (state && battleOutcomeOf(state) !== "unknown") return false;
    // Boss fights open with dialogue, and the engine holds the input windows closed until
    // it is dismissed. Waiting it out would burn the whole budget for nothing.
    const message = objectValue(state?.message ?? {});
    if (message.busy === true) {
      const choices = Array.isArray(message.choices) ? message.choices : [];
      if (choices.length > 0) throw new Error(`a choice is open during battle (${choices.join(" / ")}); answer it with black_souls_advance_dialogue before issuing a battle action`);
      state = await cursor("confirm", 12, Math.min(timeoutMs, 10000)).catch(() => null);
      continue;
    }
    const window = state ? activeWindowOf(state) : null;
    if (window?.class === "Window_ActorCommand") return true;
    if (window?.class === "Window_PartyCommand") {
      await selectCommandSymbol("fight", 0, Math.min(timeoutMs, 10000)).catch(() => undefined);
      state = await cursor("confirm", 8, Math.min(timeoutMs, 10000)).catch(() => null);
      continue;
    }
    if (window) { state = await cursor("cancel", 8, Math.min(timeoutMs, 10000)).catch(() => null); continue; }
    await sleep(400);
    state = await readStateSafe();
  }
  const last = await readStateSafe();
  if (last && objectValue(last.battle).active !== true) return false;
  throw new Error(`No battle input window appeared within ${Math.round(timeoutMs / 1000)}s; the fight is probably still playing a long animation, so read state and retry rather than assuming a failure`);
}

// Any failure mid-selection leaves the game inside a half-opened submenu, one confirm away
// from spending the wrong skill or item. Always unwind back to the actor command window.
// Returns whether the menu actually reached a safe window and whether the state could be
// read at all: a failed read must not be reported as "rolled back".
async function rollbackToCommandWindow(timeoutMs: number): Promise<{ unwound: boolean; known: boolean }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await readStateSafe();
    if (!state) return { unwound: false, known: false };
    if (!objectValue(state.battle).active) return { unwound: true, known: true };
    const window = activeWindowOf(state);
    if (!window || window.class === "Window_ActorCommand" || window.class === "Window_PartyCommand") return { unwound: true, known: true };
    if (window.class === "Window_ChoiceList") {
      // Cancel on a choice window selects the choice's cancel branch — the rollback
      // must not advance the story while cleaning up after an error.
      return { unwound: false, known: true };
    }
    await sendSequence([{ action: "cancel" }, { wait_frames: 10 }], Math.min(timeoutMs, 8000)).catch(() => undefined);
    await sleep(250);
  }
  return { unwound: false, known: true };
}

// The engine stops servicing bridge commands inside its own wait loops, so a commit can
// legitimately time out while succeeding. Poll state instead of trusting the send result.
async function commitConfirm(timeoutMs: number): Promise<Record<string, unknown> | null> {
  await sendSequence([{ action: "confirm" }, { wait_frames: 10 }], Math.min(timeoutMs, 12000)).catch(() => undefined);
  await sleep(300);
  return readStateSafe();
}

// 不可用的技能只会触发蜂鸣；资源充足也可能被冷却、封印等条件禁用。
function preflight(options: Record<string, unknown>, action: BattleActionType, skillIndex: number, itemIndex: number): Record<string, unknown> {
  if (options.available !== true) throw new Error(`battle options unavailable: ${String(options.reason || options.error || "no actor is ready")}`);
  const commands = (Array.isArray(options.commands) ? options.commands : []).map(objectValue);
  const command = commands.find((entry) => entry.action === action);
  if (!command) throw new Error(`this battler has no "${action}" command; available commands are ${commands.map((entry) => entry.action).join(", ") || "none"}`);
  if (typeof command.symbol !== "string" || !Number.isInteger(command.occurrence)) throw new Error("the game is running an older bridge; re-inject rgss/BlackSoulsBridge.rb version 1.11.0 before battle input");
  if (command.enabled === false) throw new Error(`the "${action}" command is disabled right now`);
  if (action !== "skill" && action !== "magic" && action !== "item") return command;
  const actor = objectValue(options.actor);
  const purse = `${actor.name || "the actor"} has ${actor.mp}/${actor.mmp} MP and ${actor.tp} TP`;
  if (action === "item") {
    const items = (Array.isArray(options.items) ? options.items : []).map(objectValue);
    const entry = items[itemIndex];
    if (!entry) throw new Error(`item_index ${itemIndex} does not exist; the battle item list holds ${items.length} entries (${items.map((item, index) => `${index}=${item.name}`).join(", ") || "none"})`);
    if (entry.usable_now !== true) throw new Error(`"${entry.name}" cannot be used right now; call black_souls_battle_options to see what is usable`);
    return command;
  }
  const groups = (Array.isArray(options.skill_groups) ? options.skill_groups : []).map(objectValue);
  const group = groups.find((candidate) => candidate.action === action);
  if (!group) throw new Error(`this battler has no "${action}" command; available command groups are ${groups.map((candidate) => candidate.action).join(", ") || "none"}`);
  const skills = (Array.isArray(group.skills) ? group.skills : []).map(objectValue);
  const entry = skills[skillIndex];
  if (!entry) throw new Error(`skill_index ${skillIndex} does not exist in "${group.label}"; it holds ${skills.length} entries (${skills.map((skill, index) => `${index}=${skill.name}`).join(", ") || "none"})`);
  if (entry.usable_now !== true) {
    const shortfalls = [];
    if (Number(entry.mp_cost) > Number(actor.mp)) shortfalls.push("insufficient MP");
    if (Number(entry.tp_cost) > Number(actor.tp)) shortfalls.push("insufficient TP");
    const reason = shortfalls.length > 0 ? ` (${shortfalls.join(" and ")})` : "";
    throw new Error(`"${entry.name}" cannot be used right now${reason}: it costs ${entry.mp_cost} MP / ${entry.tp_cost} TP and ${purse}. Call black_souls_battle_options to see what is usable`);
  }
  return command;
}

function targetSlotFor(state: Record<string, unknown>, options: Record<string, unknown>, enemyIndex: number): number {
  const roster = enemiesOf(state);
  const requested = roster[enemyIndex];
  if (!requested) throw new Error(`enemy_index ${enemyIndex} does not exist; the troop holds ${roster.length} entries (call black_souls_battle_options for living targets)`);
  const targets = (Array.isArray(options.enemy_targets) ? options.enemy_targets : []).map(objectValue);
  const target = targets.find((entry) => Number(entry.battler_index) === enemyIndex);
  if (!target) throw new Error(`enemy_index ${enemyIndex} ("${String(requested.name || "")}") is ${requested.dead ? "already dead" : requested.hidden ? "hidden" : "not targetable"} and has no entry in the enemy window`);
  return Number(target.target_index);
}

// Safety net for the same buzzer, in case the engine disagrees with the usability check
// above: if the cursor is still sitting in the submenu we just confirmed, nothing was
// committed, and waiting out the caller's budget would report a success that never happened.
async function confirmAndLeave(fromClass: string, label: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let state = await commitConfirm(timeoutMs);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const window = state ? activeWindowOf(state) : null;
    if (!window || window.class !== fromClass) return state;
    await sleep(300);
    state = await readStateSafe();
  }
  throw new Error(`the game refused ${label}: the cursor never left ${fromClass}, so nothing was committed. This normally means the choice is unusable right now (not enough MP/TP, or sealed by a state)`);
}

// After the last enemy dies the engine plays victory settlement (EXP, level up, drops),
// each screen waiting for a confirm. Push through it so the caller lands back on the map.
async function advanceBattleEnd(timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  let state = await readStateSafe();
  while (Date.now() < deadline) {
    const scene = String(objectValue(state?.scene ?? {}).name || "");
    if (state && scene && scene !== "Scene_Battle") return state;
    if (!state || battleOutcomeOf(state) !== "victory") return state;
    await sendSequence([{ action: "confirm" }, { wait_frames: 20 }], 8000).catch(() => undefined);
    await sleep(400);
    state = await readStateSafe();
  }
  return state;
}

export async function battleAction(action: BattleActionType, skillIndex = 0, itemIndex = 0, enemyIndex = 0, timeoutMs = 40000): Promise<BattleActionResult> {
  const before = await readState();
  const battleBefore = objectValue(before.battle);
  if (!battleBefore.active) return { ok: false, action, turn_before: turnOf(battleBefore), turn_after: turnOf(battleBefore), battle_still_active: false, battle_ended: false, battle_outcome: "unknown", message_pending: objectValue(before.message).busy === true, interpreter_running: objectValue(before.scene).interpreter_running === true, enemies_after: [], party_after: [], message: "not in battle" };
  if (String(objectValue(before.scene).name || "") !== "Scene_Battle") return { ok: false, action, turn_before: turnOf(battleBefore), turn_after: turnOf(battleBefore), battle_still_active: true, battle_ended: false, battle_outcome: "unknown", message_pending: objectValue(before.message).busy === true, interpreter_running: objectValue(before.scene).interpreter_running === true, enemies_after: [], party_after: [], message: "battle is active but another scene owns input" };
  const started = Date.now();
  const remaining = () => Math.max(2000, timeoutMs - (Date.now() - started));
  let inputMayHaveCommitted = false;

  try {
    if (await ensureActorCommandWindow(remaining())) {
      const options = objectValue(await sendQuery("battle_options", "", 8000));
      const command = preflight(options, action, skillIndex, itemIndex);
      let targetSlot = action === "attack" ? targetSlotFor(before, options, enemyIndex) : null;
      await selectCommandSymbol(String(command.symbol), Number(command.occurrence), remaining());

      inputMayHaveCommitted = true;
      let state = await commitConfirm(remaining());
      let window = state ? activeWindowOf(state) : null;
      let selectionOpened = false;
      if (window && (window.class === "Window_BattleSkill" || window.class === "Window_BattleItem")) {
        selectionOpened = true;
        const submenu = window.class;
        const wanted = submenu === "Window_BattleSkill" ? skillIndex : itemIndex;
        await selectWindowIndex(wanted, remaining());
        state = await confirmAndLeave(submenu, `entry ${wanted} of ${submenu}`, remaining());
        window = state ? activeWindowOf(state) : null;
      }
      if (window && window.class === "Window_BattleEnemy") {
        selectionOpened = true;
        targetSlot ??= targetSlotFor(state ?? before, options, enemyIndex);
        await selectWindowIndex(targetSlot, remaining());
        state = await confirmAndLeave("Window_BattleEnemy", `target ${targetSlot}`, remaining());
        window = state ? activeWindowOf(state) : null;
      }
      if (window && window.class === "Window_BattleActor") {
        selectionOpened = true;
        state = await confirmAndLeave("Window_BattleActor", "ally target", remaining());
        window = state ? activeWindowOf(state) : null;
      }
      if (window?.class === "Window_ActorCommand" && !selectionOpened && ["attack", "skill", "magic", "item"].includes(action)) {
        throw new Error(`${action} did not open a selection window or advance input; read state before retrying`);
      }
    }
  } catch (error) {
    const rollback = await rollbackToCommandWindow(8000);
    const recovered = await readStateSafe();
    const stranded = String(activeWindowOf(recovered ?? {})?.class ?? "none");
    const tail = rollback.unwound
      ? inputMayHaveCommitted
        ? "the battle menu returned to the command window, but the input may already have executed; read state before retrying"
        : "the battle menu was rolled back to the command window; no action was committed by this call"
      : rollback.known
        ? `the battle menu could NOT be unwound and is still sitting on ${stranded} - do not send blind confirms, read state first`
        : "the battle state could not be read during rollback, so the menu position is unknown - read state before sending any input";
    throw new Error(`${error instanceof Error ? error.message : String(error)} (${tail})`, { cause: error });
  }

  // A second action slot or a turn-free skill can reopen the actor window before
  // the turn resolves; wait for that window or the battle ending, not a fixed delay.
  const deadline = Date.now() + remaining();
  let after = await readStateSafe();
  let outcome: BattleActionResult["battle_outcome"] = "unknown";
  while (Date.now() < deadline) {
    if (after) {
      const battle = objectValue(after.battle);
      const scene = String(objectValue(after.scene).name || "");
      outcome = battleOutcomeOf(after, action);
      if (!battle.active || scene !== "Scene_Battle" || outcome !== "unknown") break;
      const active = activeWindowOf(after);
      if (active && (active.class === "Window_ActorCommand" || active.class === "Window_PartyCommand")) break;
    }
    await sleep(400);
    after = await readStateSafe();
  }
  if (outcome === "victory") after = await advanceBattleEnd(Math.max(15000, remaining()));
  if (!after) after = await readState();
  const finalOutcome = battleOutcomeOf(after, action);
  if (finalOutcome !== "unknown") outcome = finalOutcome;

  const battleAfter = objectValue(after.battle);
  const party = objectValue(after.party);
  const stillActive = Boolean(battleAfter.active);
  const messagePending = objectValue(after.message).busy === true;
  const interpreterRunning = objectValue(after.scene).interpreter_running === true;
  const enemies = (stillActive ? enemiesOf(after) : []).map((enemy) => ({ name: String(enemy.name || ""), hp: Number(enemy.hp || 0), mhp: Number(enemy.mhp || 0), dead: Boolean(enemy.dead) }));
  const members = (Array.isArray(party.members) ? party.members : []).map(objectValue).map((member) => ({ name: String(member.name || ""), hp: Number(member.hp || 0), mhp: Number(member.mhp || 0), mp: Number(member.mp || 0), mmp: Number(member.mmp || 0), tp: Number(member.tp || 0) }));
  let message = action === "flee"
    ? "escape input accepted; the battle continues (escape may have failed)"
    : action === "equip_change"
      ? "equipment command accepted; configure equipment before returning to battle"
      : "one battle input accepted; execution or further action selection may still be pending";
  if (outcome === "defeat") message = "the party was defeated";
  else if (outcome === "victory") message = stillActive ? "victory detected; settlement is still pending" : "victory; the battle ended";
  else if (!stillActive) message = outcome === "escape" ? "escape succeeded; the battle ended" : "the battle ended; its outcome is unknown";
  if (!inputMayHaveCommitted) message += "; no input was submitted";
  if (!stillActive || outcome !== "unknown") message += `; current scene is ${String(objectValue(after.scene).name || "unknown")}; message_pending=${messagePending}; interpreter_running=${interpreterRunning}`;
  return { ok: inputMayHaveCommitted, action, turn_before: turnOf(battleBefore), turn_after: turnOf(battleAfter), battle_still_active: stillActive, battle_ended: !stillActive, battle_outcome: outcome, message_pending: messagePending, interpreter_running: interpreterRunning, enemies_after: enemies, party_after: members, message };
}

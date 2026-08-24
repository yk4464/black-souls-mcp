import { activeWindowOf, readState, selectCommandSymbol, selectWindowIndex, sendQuery, sendSequence } from "./bridge.js";

// Live-calibrated actor command layout (BLACK SOULS): attack / skill(特技) / skill(魔法)
// / guard / item / escape. "magic" targets the second command whose symbol is "skill".
export type BattleActionType = "attack" | "skill" | "magic" | "guard" | "item" | "flee";
export interface BattleActionResult {
  ok: boolean; action: BattleActionType; turn_before: number | null; turn_after: number | null;
  battle_still_active: boolean; battle_ended: boolean;
  enemies_after: Array<{ name: string; hp: number; mhp: number; dead: boolean }>;
  party_after: Array<{ name: string; hp: number; mhp: number; mp: number; mmp: number; tp: number }>; message: string;
}

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const turnOf = (battle: Record<string, unknown>): number | null => Number.isFinite(Number(battle.turn)) ? Number(battle.turn) : null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const enemiesOf = (state: Record<string, unknown>) => (Array.isArray(objectValue(state.battle).enemies) ? objectValue(state.battle).enemies as unknown[] : []).map(objectValue);

export const allEnemiesDefeated = (state: Record<string, unknown>): boolean => {
  const visibleEnemies = enemiesOf(state).filter((enemy) => enemy.hidden !== true);
  return visibleEnemies.length > 0
    && visibleEnemies.every((enemy) => enemy.dead === true || Number(enemy.hp || 0) <= 0);
};

const COMMAND_TARGET: Record<BattleActionType, { symbol: string; occurrence: number }> = {
  attack: { symbol: "attack", occurrence: 0 },
  skill: { symbol: "skill", occurrence: 0 },
  magic: { symbol: "skill", occurrence: 1 },
  guard: { symbol: "guard", occurrence: 0 },
  item: { symbol: "item", occurrence: 0 },
  flee: { symbol: "escape", occurrence: 0 },
};

async function cursor(action: "confirm" | "cancel", waitFrames: number, timeoutMs: number) {
  await sendSequence([{ action }, { wait_frames: waitFrames }], timeoutMs);
  return readState();
}

const readStateSafe = async (): Promise<Record<string, unknown> | null> => { try { return await readState(); } catch { return null; } };

// Back out of any sub-window until the actor command window is active; when the party
// command window (fight/escape) shows up first, pick "fight" to reach the actor commands.
// Death animations, phase transitions and victory settlement can hold the engine for a
// long time with no input window on screen. That is not a failure — wait it out for the
// caller's whole budget and report "battle over" rather than erroring mid-fight.
async function ensureActorCommandWindow(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let state = await readStateSafe();
  while (Date.now() < deadline) {
    const battleActive = objectValue(state?.battle ?? {}).active === true;
    const scene = String(objectValue(state?.scene ?? {}).name || "");
    if (state && (!battleActive || (scene && scene !== "Scene_Battle"))) return false;
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
async function rollbackToCommandWindow(timeoutMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await readStateSafe();
    if (!state || !objectValue(state.battle).active) return true;
    const window = activeWindowOf(state);
    if (!window || window.class === "Window_ActorCommand" || window.class === "Window_PartyCommand") return true;
    await sendSequence([{ action: "cancel" }, { wait_frames: 10 }], Math.min(timeoutMs, 8000)).catch(() => undefined);
    await sleep(250);
  }
  return false;
}

// The engine stops servicing bridge commands inside its own wait loops, so a commit can
// legitimately time out while succeeding. Poll state instead of trusting the send result.
async function commitConfirm(timeoutMs: number): Promise<Record<string, unknown> | null> {
  await sendSequence([{ action: "confirm" }, { wait_frames: 10 }], Math.min(timeoutMs, 12000)).catch(() => undefined);
  await sleep(300);
  return readStateSafe();
}

// RPG Maker answers a choice the actor cannot pay for with a buzzer: the cursor stays put
// and nothing is committed. Checking usability up front means the refusal is reported as a
// clear error instead of costing a turn of real input, and the caller learns why.
async function preflight(action: BattleActionType, skillIndex: number, itemIndex: number): Promise<void> {
  if (action !== "skill" && action !== "magic" && action !== "item") return;
  const options = objectValue(await sendQuery("battle_options", "", 8000).catch(() => null));
  if (options.available !== true) return;
  const actor = objectValue(options.actor);
  const purse = `${actor.name || "the actor"} has ${actor.mp}/${actor.mmp} MP and ${actor.tp} TP`;
  if (action === "item") {
    const items = (Array.isArray(options.items) ? options.items : []).map(objectValue);
    const entry = items[itemIndex];
    if (!entry) throw new Error(`item_index ${itemIndex} does not exist; the battle item list holds ${items.length} entries (${items.map((item, index) => `${index}=${item.name}`).join(", ") || "none"})`);
    if (entry.usable_now !== true) throw new Error(`"${entry.name}" cannot be used right now; call black_souls_battle_options to see what is usable`);
    return;
  }
  const groups = (Array.isArray(options.skill_groups) ? options.skill_groups : []).map(objectValue);
  const group = groups.find((candidate) => candidate.action === action);
  if (!group) throw new Error(`this battler has no "${action}" command; available command groups are ${groups.map((candidate) => candidate.action).join(", ") || "none"}`);
  const skills = (Array.isArray(group.skills) ? group.skills : []).map(objectValue);
  const entry = skills[skillIndex];
  if (!entry) throw new Error(`skill_index ${skillIndex} does not exist in "${group.label}"; it holds ${skills.length} entries (${skills.map((skill, index) => `${index}=${skill.name}`).join(", ") || "none"})`);
  if (entry.usable_now !== true) throw new Error(`"${entry.name}" cannot be used right now: it costs ${entry.mp_cost} MP / ${entry.tp_cost} TP and ${purse}. Pick another skill, or attack to recover TP`);
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
    await sendSequence([{ action: "confirm" }, { wait_frames: 20 }], 8000).catch(() => undefined);
    await sleep(400);
    state = await readStateSafe();
  }
  return state;
}

export async function battleAction(action: BattleActionType, skillIndex = 0, itemIndex = 0, enemyIndex = 0, timeoutMs = 40000): Promise<BattleActionResult> {
  const before = await readState();
  const battleBefore = objectValue(before.battle);
  if (!battleBefore.active) return { ok: false, action, turn_before: turnOf(battleBefore), turn_after: turnOf(battleBefore), battle_still_active: false, battle_ended: false, enemies_after: [], party_after: [], message: "not in battle" };
  const started = Date.now();
  const remaining = () => Math.max(2000, timeoutMs - (Date.now() - started));

  // The enemy target window only lists living enemies, while state reports every troop
  // member including corpses. Translate the caller's battler index into a window position.
  const roster = enemiesOf(before);
  const alive = roster.filter((enemy) => !enemy.dead && !enemy.hidden);
  const requested = roster[enemyIndex];
  let targetSlot = alive.findIndex((enemy) => enemy === requested);
  if (targetSlot < 0) targetSlot = enemyIndex < alive.length ? enemyIndex : 0;

  try {
    const inputReady = await ensureActorCommandWindow(remaining());
    if (!inputReady) {
      const ended = await advanceBattleEnd(remaining());
      const endBattle = objectValue(ended?.battle ?? {});
      return { ok: true, action, turn_before: turnOf(battleBefore), turn_after: turnOf(endBattle), battle_still_active: Boolean(endBattle.active), battle_ended: true, enemies_after: [], party_after: [], message: "the battle ended before this command could be entered; settlement was advanced" };
    }
    await preflight(action, skillIndex, itemIndex);
    const target = COMMAND_TARGET[action];
    await selectCommandSymbol(target.symbol, target.occurrence, remaining());

    let state = await commitConfirm(remaining());
    let window = state ? activeWindowOf(state) : null;
    if (window && (window.class === "Window_BattleSkill" || window.class === "Window_BattleItem")) {
      const submenu = window.class;
      const wanted = submenu === "Window_BattleSkill" ? skillIndex : itemIndex;
      await selectWindowIndex(wanted, remaining());
      state = await confirmAndLeave(submenu, `entry ${wanted} of ${submenu}`, remaining());
      window = state ? activeWindowOf(state) : null;
    }
    if (window && window.class === "Window_BattleEnemy") {
      await selectWindowIndex(targetSlot, remaining());
      state = await confirmAndLeave("Window_BattleEnemy", `target ${targetSlot}`, remaining());
      window = state ? activeWindowOf(state) : null;
    }
    if (window && window.class === "Window_BattleActor") {
      await commitConfirm(remaining());
    }
  } catch (error) {
    const unwound = await rollbackToCommandWindow(8000);
    const recovered = await readStateSafe();
    const stranded = String(activeWindowOf(recovered ?? {})?.class ?? "none");
    const tail = unwound
      ? "the battle menu was rolled back to the command window; no action was committed by this call"
      : `the battle menu could NOT be unwound and is still sitting on ${stranded} - do not send blind confirms, read state first`;
    throw new Error(`${error instanceof Error ? error.message : String(error)} (${tail})`, { cause: error });
  }

  // Let the turn resolve: finished when an input window returns or the battle ends.
  const deadline = Date.now() + remaining();
  let after = await readStateSafe();
  let ended = false;
  while (Date.now() < deadline) {
    if (after) {
      const battle = objectValue(after.battle);
      const scene = String(objectValue(after.scene).name || "");
      if (!battle.active || scene !== "Scene_Battle") { ended = true; break; }
      // Victory settlement keeps both Scene_Battle and $game_party.in_battle true
      // until its text is confirmed. Detect the troop's defeated state here so the
      // caller advances those screens instead of waiting for the full timeout.
      if (allEnemiesDefeated(after)) { ended = true; break; }
      const party = objectValue(after.party);
      const members = (Array.isArray(party.members) ? party.members : []).map(objectValue);
      // Defeat text can leave Scene_Battle and $game_party.in_battle true until the
      // player confirms it. Waiting only for a scene change burns the whole timeout
      // and returns a misleading "battle still active" result after everyone is dead.
      if (members.length > 0 && members.every((member) => Number(member.hp || 0) <= 0)) { ended = true; break; }
      const active = activeWindowOf(after);
      if (active && (active.class === "Window_ActorCommand" || active.class === "Window_PartyCommand")) break;
    }
    await sleep(400);
    after = await readStateSafe();
  }
  if (ended) after = await advanceBattleEnd(Math.max(15000, remaining()));
  if (!after) after = await readState();

  const battleAfter = objectValue(after.battle);
  const party = objectValue(after.party);
  const stillActive = Boolean(battleAfter.active) && String(objectValue(after.scene).name || "") === "Scene_Battle";
  const enemies = (stillActive ? enemiesOf(after) : []).map((enemy) => ({ name: String(enemy.name || ""), hp: Number(enemy.hp || 0), mhp: Number(enemy.mhp || 0), dead: Boolean(enemy.dead) }));
  const members = (Array.isArray(party.members) ? party.members : []).map(objectValue).map((member) => ({ name: String(member.name || ""), hp: Number(member.hp || 0), mhp: Number(member.mhp || 0), mp: Number(member.mp || 0), mmp: Number(member.mmp || 0), tp: Number(member.tp || 0) }));
  const message = !stillActive
    ? `the battle ended and settlement was advanced; current scene is ${String(objectValue(after.scene).name || "unknown")}`
    : action === "flee"
      ? "flee was selected but the battle continues (escape may be blocked in this fight)"
      : "battle action committed; resulting state captured";
  return { ok: true, action, turn_before: turnOf(battleBefore), turn_after: turnOf(battleAfter), battle_still_active: stillActive, battle_ended: !stillActive, enemies_after: enemies, party_after: members, message };
}

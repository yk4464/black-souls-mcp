import { activeWindowOf, readState, selectCommandSymbol, sendSequence } from "./bridge.js";

// Live-calibrated actor command layout (BLACK SOULS): attack / skill(特技) / skill(魔法)
// / guard / item / escape. "magic" targets the second command whose symbol is "skill".
export type BattleActionType = "attack" | "skill" | "magic" | "guard" | "item" | "flee";
export interface BattleActionResult {
  ok: boolean; action: BattleActionType; turn_before: number | null; turn_after: number | null;
  battle_still_active: boolean; enemies_after: Array<{ name: string; hp: number; mhp: number; dead: boolean }>;
  party_after: Array<{ name: string; hp: number; mhp: number }>; message: string;
}

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const turnOf = (battle: Record<string, unknown>): number | null => Number.isFinite(Number(battle.turn)) ? Number(battle.turn) : null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const COMMAND_TARGET: Record<BattleActionType, { symbol: string; occurrence: number }> = {
  attack: { symbol: "attack", occurrence: 0 },
  skill: { symbol: "skill", occurrence: 0 },
  magic: { symbol: "skill", occurrence: 1 },
  guard: { symbol: "guard", occurrence: 0 },
  item: { symbol: "item", occurrence: 0 },
  flee: { symbol: "escape", occurrence: 0 },
};

async function cursor(action: "confirm" | "cancel" | "move_up" | "move_down" | "move_left" | "move_right", waitFrames: number, timeoutMs: number) {
  await sendSequence([{ action }, { wait_frames: waitFrames }], timeoutMs);
  return readState();
}

// Back out of any sub-window until the actor command window is active; when the party
// command window (fight/escape) shows up first, pick "fight" to reach the actor commands.
async function ensureActorCommandWindow(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let state = await readState();
  while (Date.now() < deadline) {
    const window = activeWindowOf(state);
    if (window?.class === "Window_ActorCommand") return;
    if (window?.class === "Window_PartyCommand") {
      await selectCommandSymbol("fight", 0, timeoutMs);
      state = await cursor("confirm", 8, timeoutMs);
      continue;
    }
    if (window) { state = await cursor("cancel", 8, timeoutMs); continue; }
    await sleep(250);
    state = await readState();
  }
  throw new Error("The battle input window did not become available in time");
}

// Closed-loop cursor movement on the active selection window, driven by its real index.
// The enemy window lays targets out horizontally (move_right/left); lists use down/up.
async function selectListIndex(target: number, horizontal: boolean, timeoutMs: number): Promise<void> {
  let stuck = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await readState();
    const window = activeWindowOf(state);
    if (!window) throw new Error("The selection window disappeared while navigating");
    if (window.index === target) return;
    if (target >= window.item_max) throw new Error(`Selection index ${target} is out of range (${window.item_max} entries)`);
    const forward = window.index < target;
    const action = horizontal ? (forward ? "move_right" : "move_left") : (forward ? "move_down" : "move_up");
    const after = activeWindowOf(await cursor(action, 6, timeoutMs));
    if (after && after.index === window.index) {
      stuck += 1;
      if (stuck >= 3) throw new Error(`Selection cursor is stuck at ${window.index} while targeting ${target}`);
    } else stuck = 0;
  }
  throw new Error(`Could not reach selection index ${target}`);
}

export async function battleAction(action: BattleActionType, skillIndex = 0, itemIndex = 0, enemyIndex = 0, timeoutMs = 30000): Promise<BattleActionResult> {
  const before = await readState();
  const battleBefore = objectValue(before.battle);
  if (!battleBefore.active) return { ok: false, action, turn_before: turnOf(battleBefore), turn_after: turnOf(battleBefore), battle_still_active: false, enemies_after: [], party_after: [], message: "not in battle" };
  const started = Date.now();
  const remaining = () => Math.max(2000, timeoutMs - (Date.now() - started));

  await ensureActorCommandWindow(Math.min(timeoutMs, 15000));
  const target = COMMAND_TARGET[action];
  await selectCommandSymbol(target.symbol, target.occurrence, remaining());

  // A confirm can commit the turn instantly, and while the engine plays the turn out it
  // stops servicing bridge commands entirely (its internal wait loops never return to the
  // hooked frame entry). A timed-out sequence at a commit point is therefore expected —
  // recover by polling state instead of failing.
  const readStateSafe = async () => { try { return await readState(); } catch { return null; } };
  const commitConfirm = async () => {
    await sendSequence([{ action: "confirm" }, { wait_frames: 10 }], Math.min(remaining(), 12000)).catch(() => undefined);
    await sleep(300);
    return readStateSafe();
  };

  let state = await commitConfirm();
  let window = state ? activeWindowOf(state) : null;
  if (window && (window.class === "Window_BattleSkill" || window.class === "Window_BattleItem")) {
    await selectListIndex(window.class === "Window_BattleSkill" ? skillIndex : itemIndex, false, remaining());
    state = await commitConfirm();
    window = state ? activeWindowOf(state) : null;
  }
  if (window && window.class === "Window_BattleEnemy") {
    await selectListIndex(enemyIndex, true, remaining());
    state = await commitConfirm();
    window = state ? activeWindowOf(state) : null;
  }
  if (window && window.class === "Window_BattleActor") {
    await commitConfirm();
  }

  // Let the turn play out: done when the battle ends or an input window returns.
  const deadline = Date.now() + remaining();
  let after = await readStateSafe();
  while (Date.now() < deadline) {
    if (after) {
      const battle = objectValue(after.battle);
      if (!battle.active) break;
      const active = activeWindowOf(after);
      if (active && (active.class === "Window_ActorCommand" || active.class === "Window_PartyCommand")) break;
    }
    await sleep(400);
    after = await readStateSafe();
  }
  if (!after) after = await readState();

  const battleAfter = objectValue(after.battle);
  const party = objectValue(after.party);
  const enemies = (Array.isArray(battleAfter.enemies) ? battleAfter.enemies : []).map(objectValue).map((enemy) => ({ name: String(enemy.name || ""), hp: Number(enemy.hp || 0), mhp: Number(enemy.mhp || 0), dead: Boolean(enemy.dead) }));
  const members = (Array.isArray(party.members) ? party.members : []).map(objectValue).map((member) => ({ name: String(member.name || ""), hp: Number(member.hp || 0), mhp: Number(member.mhp || 0) }));
  const stillActive = Boolean(battleAfter.active);
  const message = action === "flee" && stillActive
    ? "flee was selected but the battle continues (escape may be blocked in this fight)"
    : "battle action committed; resulting state captured";
  return { ok: true, action, turn_before: turnOf(battleBefore), turn_after: turnOf(battleAfter), battle_still_active: stillActive, enemies_after: enemies, party_after: members, message };
}

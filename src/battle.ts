import { readState, sendSequence, type SequenceStep } from "./bridge.js";

export type BattleActionType = "attack" | "skill" | "item" | "guard" | "flee";
export interface BattleActionResult {
  ok: boolean; action: BattleActionType; turn_before: number | null; turn_after: number | null;
  battle_still_active: boolean; enemies_after: Array<{ name: string; hp: number; mhp: number; dead: boolean }>;
  party_after: Array<{ name: string; hp: number; mhp: number }>; message: string;
}
const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const turn = (battle: Record<string, unknown>): number | null => Number.isFinite(Number(battle.turn)) ? Number(battle.turn) : null;
const moveDown = (steps: SequenceStep[], count = 0) => { if (count > 0) steps.push({ action: "move_down", repeat: count }); };

export async function battleAction(action: BattleActionType, skillIndex = 0, itemIndex = 0, enemyIndex = 0, timeoutMs = 20000): Promise<BattleActionResult> {
  const before = await readState(); const battleBefore = objectValue(before.battle);
  if (!battleBefore.active) return { ok: false, action, turn_before: turn(battleBefore), turn_after: turn(battleBefore), battle_still_active: false, enemies_after: [], party_after: [], message: "not in battle" };
  const steps: SequenceStep[] = [];
  if (action === "attack") { steps.push({ action: "confirm" }, { wait_frames: 4 }); moveDown(steps, enemyIndex); steps.push({ action: "confirm" }); }
  if (action === "skill") { steps.push({ action: "page_up" }, { wait_frames: 4 }); moveDown(steps, skillIndex); steps.push({ action: "confirm" }, { wait_frames: 4 }); moveDown(steps, enemyIndex); steps.push({ action: "confirm" }); }
  if (action === "item") { steps.push({ action: "page_down" }, { wait_frames: 4 }); moveDown(steps, itemIndex); steps.push({ action: "confirm" }, { wait_frames: 4 }); moveDown(steps, enemyIndex); steps.push({ action: "confirm" }); }
  if (action === "guard") steps.push({ action: "move_down", repeat: 2 }, { action: "confirm" });
  if (action === "flee") steps.push({ action: "cancel" }, { wait_frames: 4 }, { action: "confirm" });
  steps.push({ wait_frames: 30 }); await sendSequence(steps, timeoutMs);
  const after = await readState(); const battleAfter = objectValue(after.battle); const party = objectValue(after.party);
  const enemies = (Array.isArray(battleAfter.enemies) ? battleAfter.enemies : []).map(objectValue).map((enemy) => ({ name: String(enemy.name || ""), hp: Number(enemy.hp || 0), mhp: Number(enemy.mhp || 0), dead: Boolean(enemy.dead) }));
  const members = (Array.isArray(party.members) ? party.members : []).map(objectValue).map((member) => ({ name: String(member.name || ""), hp: Number(member.hp || 0), mhp: Number(member.mhp || 0) }));
  return { ok: true, action, turn_before: turn(battleBefore), turn_after: turn(battleAfter), battle_still_active: Boolean(battleAfter.active), enemies_after: enemies, party_after: members, message: "battle action completed; resulting state captured" };
}

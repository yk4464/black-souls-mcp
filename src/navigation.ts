import { readMap, readState, sendSequence, type Action, type SequenceStep } from "./bridge.js";

export interface MapTile {
  x: number; y: number; passable: { up: boolean; down: boolean; left: boolean; right: boolean };
}
export interface NavigateResult {
  ok: boolean; start: { x: number; y: number }; target: { x: number; y: number };
  steps_taken: number; final_position: { x: number; y: number }; reached: boolean; message: string;
}
export interface InteractResult {
  ok: boolean; event_id: number | null; event_name: string | null; navigated: boolean;
  message_after: string | null; choices_after: string[]; scene_after: string | null; message: string;
}

type Point = { x: number; y: number };
const key = (point: Point) => `${point.x},${point.y}`;
const directions: Array<{ action: Action; field: keyof MapTile["passable"]; dx: number; dy: number }> = [
  { action: "move_up", field: "up", dx: 0, dy: -1 }, { action: "move_down", field: "down", dx: 0, dy: 1 },
  { action: "move_left", field: "left", dx: -1, dy: 0 }, { action: "move_right", field: "right", dx: 1, dy: 0 },
];

export function findPath(tiles: MapTile[], start: Point, target: Point, radius = 6): Action[] | null {
  if (Math.abs(target.x - start.x) > radius || Math.abs(target.y - start.y) > radius) return null;
  if (start.x === target.x && start.y === target.y) return [];
  const tileMap = new Map(tiles.map((tile) => [key(tile), tile]));
  const queue: Array<{ point: Point; path: Action[] }> = [{ point: start, path: [] }];
  const seen = new Set([key(start)]);
  while (queue.length) {
    const current = queue.shift()!; const tile = tileMap.get(key(current.point));
    if (!tile || current.path.length >= 50) continue;
    for (const direction of directions) {
      if (!tile.passable[direction.field]) continue;
      const next = { x: current.point.x + direction.dx, y: current.point.y + direction.dy };
      if (!tileMap.has(key(next)) || seen.has(key(next))) continue;
      const path = [...current.path, direction.action];
      if (next.x === target.x && next.y === target.y) return path;
      seen.add(key(next)); queue.push({ point: next, path });
    }
  }
  return [];
}

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const pointFrom = (value: unknown): Point => { const item = objectValue(value); return { x: Number(item.x || 0), y: Number(item.y || 0) }; };
const sceneFrom = (state: Record<string, unknown>) => { const value = objectValue(state.scene).name; return typeof value === "string" ? value : null; };
const tilesFrom = (map: Record<string, unknown>): MapTile[] => (Array.isArray(map.tiles) ? map.tiles : []).map(objectValue).map((tile) => {
  const passable = objectValue(tile.passable);
  return { x: Number(tile.x), y: Number(tile.y), passable: { up: Boolean(passable.up), down: Boolean(passable.down), left: Boolean(passable.left), right: Boolean(passable.right) } };
});

export async function navigate(targetX: number, targetY: number, timeoutMs = 30000): Promise<NavigateResult> {
  const [map, state] = await Promise.all([readMap(), readState()]);
  const start = pointFrom(state.player); const target = { x: targetX, y: targetY };
  const radius = Math.min(6, Number(map.radius || 6));
  const path = findPath(tilesFrom(map), start, target, radius);
  if (path === null) return { ok: false, start, target, steps_taken: 0, final_position: start, reached: false, message: "target out of current map radius; move closer first" };
  if (!path.length && (start.x !== target.x || start.y !== target.y)) return { ok: false, start, target, steps_taken: 0, final_position: start, reached: false, message: "no passable path to target" };
  if (path.length) {
    const steps: SequenceStep[] = [];
    for (const action of path) steps.push({ action }, { wait_frames: 2 });
    await sendSequence(steps, timeoutMs);
  }
  const finalPosition = pointFrom((await readState()).player); const reached = finalPosition.x === target.x && finalPosition.y === target.y;
  return { ok: reached, start, target, steps_taken: path.length, final_position: finalPosition, reached, message: reached ? "target reached" : "input completed but target was not reached" };
}

export async function interact(eventId?: number, timeoutMs = 20000): Promise<InteractResult> {
  const [map, state] = await Promise.all([readMap(), readState()]); const player = pointFrom(state.player);
  const events = (Array.isArray(map.events) ? map.events : []).map(objectValue);
  let event = eventId === undefined ? null : events.find((item) => Number(item.id) === eventId) || null;
  if (!event) {
    event = events.map((item) => ({ item, distance: Math.abs(Number(item.x) - player.x) + Math.abs(Number(item.y) - player.y) }))
      .filter((entry) => entry.distance <= 2).sort((a, b) => a.distance - b.distance)[0]?.item || null;
  }
  if (!event || (eventId !== undefined && Number(event.id) !== eventId)) return { ok: false, event_id: eventId ?? null, event_name: null, navigated: false, message_after: null, choices_after: [], scene_after: sceneFrom(state), message: "event not found" };
  const target = { x: Number(event.x), y: Number(event.y) }; const tiles = tilesFrom(map);
  const candidates = directions.map((direction) => ({ x: target.x - direction.dx, y: target.y - direction.dy }))
    .map((point) => ({ point, path: findPath(tiles, player, point, 6) })).filter((entry) => entry.path !== null && (entry.path!.length > 0 || key(entry.point) === key(player)))
    .sort((a, b) => a.path!.length - b.path!.length);
  if (!candidates.length) return { ok: false, event_id: Number(event.id), event_name: String(event.name || ""), navigated: false, message_after: null, choices_after: [], scene_after: sceneFrom(state), message: "no passable adjacent tile" };
  const chosen = candidates[0]; let navigated = false;
  if (key(chosen.point) !== key(player)) { const moved = await navigate(chosen.point.x, chosen.point.y, timeoutMs); if (!moved.reached) return { ok: false, event_id: Number(event.id), event_name: String(event.name || ""), navigated: true, message_after: null, choices_after: [], scene_after: sceneFrom(state), message: moved.message }; navigated = true; }
  const dx = target.x - chosen.point.x; const dy = target.y - chosen.point.y;
  const face = directions.find((direction) => direction.dx === dx && direction.dy === dy)?.action;
  const steps: SequenceStep[] = []; if (face) steps.push({ action: face }, { wait_frames: 2 }); steps.push({ action: "confirm" }, { wait_frames: 10 });
  await sendSequence(steps, timeoutMs); const after = await readState(); const message = objectValue(after.message);
  return { ok: true, event_id: Number(event.id), event_name: String(event.name || ""), navigated, message_after: typeof message.text === "string" && message.text ? message.text : null, choices_after: Array.isArray(message.choices) ? message.choices.map(String) : [], scene_after: sceneFrom(after), message: "interaction input completed" };
}

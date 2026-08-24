import { readMap, readState, sendSequence, type Action, type SequenceStep } from "./bridge.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
const directions: Array<{ action: Action; field: keyof MapTile["passable"]; reverse: keyof MapTile["passable"]; dx: number; dy: number }> = [
  { action: "move_up", field: "up", reverse: "down", dx: 0, dy: -1 }, { action: "move_down", field: "down", reverse: "up", dx: 0, dy: 1 },
  { action: "move_left", field: "left", reverse: "right", dx: -1, dy: 0 }, { action: "move_right", field: "right", reverse: "left", dx: 1, dy: 0 },
];

export function findPath(tiles: MapTile[], start: Point, target: Point, radius = 6, blocked = new Set<string>()): Action[] | null {
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
      const nextKey = key(next); const nextTile = tileMap.get(nextKey);
      if (!nextTile || !nextTile.passable[direction.reverse] || blocked.has(nextKey) || seen.has(nextKey)) continue;
      const path = [...current.path, direction.action];
      if (next.x === target.x && next.y === target.y) return path;
      seen.add(nextKey); queue.push({ point: next, path });
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
const blockedEventsFrom = (map: Record<string, unknown>, start: Point): Set<string> => {
  const blocked = new Set((Array.isArray(map.events) ? map.events : []).map(objectValue)
    .filter((event) => event.through !== true && Number(event.priority_type) === 1 && event.erased !== true)
    .map((event) => key({ x: Number(event.x), y: Number(event.y) })));
  blocked.delete(key(start));
  return blocked;
};

// Direction keys mean "move the cursor" in any menu, and confirm activates whatever is
// selected — a stray navigate/interact from Scene_Menu once wrapped the cursor onto
// "end game". Never send movement unless the player is genuinely standing on the map.
export async function requireFieldControl(state: Record<string, unknown>, tool: string): Promise<void> {
  const scene = sceneFrom(state);
  if (scene !== "Scene_Map") throw new Error(`${tool} needs the player on the map, but the current scene is ${scene || "unknown"}. Leave the menu first (black_souls_input with cancel) and retry.`);
  if (objectValue(state.message).busy) throw new Error(`${tool} cannot move the player while a message or choice is on screen; use black_souls_advance_dialogue first.`);
}

export async function navigate(targetX: number, targetY: number, timeoutMs = 30000): Promise<NavigateResult> {
  const [map, state] = await Promise.all([readMap(), readState()]);
  await requireFieldControl(state, "black_souls_navigate");
  const start = pointFrom(state.player); const target = { x: targetX, y: targetY };
  const radius = Math.min(6, Number(map.radius || 6));
  const path = findPath(tilesFrom(map), start, target, radius, blockedEventsFrom(map, start));
  if (path === null) return { ok: false, start, target, steps_taken: 0, final_position: start, reached: false, message: "target out of current map radius; move closer first" };
  if (!path.length && (start.x !== target.x || start.y !== target.y)) return { ok: false, start, target, steps_taken: 0, final_position: start, reached: false, message: "no passable path to target" };
  if (path.length) {
    // Live-measured: one map step takes ~16 frames; injected keys held for a single frame
    // during the walk animation are dropped, so leave 18 frames between steps.
    const steps: SequenceStep[] = [];
    for (const action of path) steps.push({ action }, { wait_frames: 18 });
    await sendSequence(steps, timeoutMs);
  }
  const finalPosition = pointFrom((await readState()).player); const reached = finalPosition.x === target.x && finalPosition.y === target.y;
  return { ok: reached, start, target, steps_taken: path.length, final_position: finalPosition, reached, message: reached ? "target reached" : "input completed but target was not reached" };
}

export async function interact(eventId?: number, timeoutMs = 20000): Promise<InteractResult> {
  const started = Date.now(); const remaining = () => Math.max(2000, timeoutMs - (Date.now() - started));
  let [map, state] = await Promise.all([readMap(), readState()]);
  await requireFieldControl(state, "black_souls_interact");
  const initialPlayer = pointFrom(state.player);
  const initialEvents = (Array.isArray(map.events) ? map.events : []).map(objectValue);
  let selected = eventId === undefined ? null : initialEvents.find((item) => Number(item.id) === eventId) || null;
  if (!selected) {
    selected = initialEvents.map((item) => ({ item, distance: Math.abs(Number(item.x) - initialPlayer.x) + Math.abs(Number(item.y) - initialPlayer.y) }))
      .filter((entry) => entry.distance <= 2).sort((a, b) => a.distance - b.distance)[0]?.item || null;
  }
  if (!selected || (eventId !== undefined && Number(selected.id) !== eventId)) return { ok: false, event_id: eventId ?? null, event_name: null, navigated: false, message_after: null, choices_after: [], scene_after: sceneFrom(state), message: "event not found" };
  const selectedId = Number(selected.id); const selectedName = String(selected.name || ""); let navigated = false;

  // Autonomous events can walk away between the first map read, path traversal and the
  // confirm frame. Re-read their live position and retry a bounded number of times. A
  // call is successful only after an observable response, never merely because keys ran.
  for (let attempt = 0; attempt < 4 && Date.now() - started < timeoutMs; attempt += 1) {
    [map, state] = await Promise.all([readMap(), readState()]);
    await requireFieldControl(state, "black_souls_interact");
    const player = pointFrom(state.player);
    const events = (Array.isArray(map.events) ? map.events : []).map(objectValue);
    let event = events.find((item) => Number(item.id) === selectedId) || null;
    if (!event) return { ok: attempt > 0, event_id: selectedId, event_name: selectedName, navigated, message_after: null, choices_after: [], scene_after: sceneFrom(state), message: attempt > 0 ? "event disappeared after interaction" : "event not found" };
    const target = { x: Number(event.x), y: Number(event.y) }; const tiles = tilesFrom(map); const blocked = blockedEventsFrom(map, player);
    const sameTile = Number(event.priority_type) !== 1 && key(target) === key(player)
      ? [{ point: player, path: [] as Action[] }]
      : [];
    const candidates = [...sameTile, ...directions.map((direction) => ({ x: target.x - direction.dx, y: target.y - direction.dy }))
      .map((point) => ({ point, path: findPath(tiles, player, point, 6, blocked) }))]
      .filter((entry) => entry.path !== null && (entry.path!.length > 0 || key(entry.point) === key(player)))
      .sort((a, b) => a.path!.length - b.path!.length);
    if (!candidates.length) return { ok: false, event_id: selectedId, event_name: selectedName, navigated, message_after: null, choices_after: [], scene_after: sceneFrom(state), message: "no passable adjacent tile" };
    const chosen = candidates[0];
    if (key(chosen.point) !== key(player)) {
      const moved = await navigate(chosen.point.x, chosen.point.y, remaining()); navigated = true;
      if (!moved.reached) continue;
    }

    // The event may have moved during the walk. Only press confirm when it is still on
    // the expected adjacent tile; otherwise loop with its newly observed coordinates.
    map = await readMap(); state = await readState();
    const settledPlayer = pointFrom(state.player);
    const freshEvents = (Array.isArray(map.events) ? map.events : []).map(objectValue);
    event = freshEvents.find((item) => Number(item.id) === selectedId) || null;
    if (!event) return { ok: true, event_id: selectedId, event_name: selectedName, navigated, message_after: null, choices_after: [], scene_after: sceneFrom(state), message: "event disappeared while approaching" };
    const dx = Number(event.x) - settledPlayer.x; const dy = Number(event.y) - settledPlayer.y;
    const same = dx === 0 && dy === 0 && Number(event.priority_type) !== 1;
    const face = directions.find((direction) => direction.dx === dx && direction.dy === dy)?.action;
    if (!same && !face) continue;
    const pageBefore = event.active_page; const mapBefore = Number(objectValue(state.map).id || 0); const sceneBefore = sceneFrom(state);
    const steps: SequenceStep[] = []; if (face) steps.push({ action: face }, { wait_frames: 18 }); steps.push({ action: "confirm" }, { wait_frames: 12 });
    await sendSequence(steps, remaining()); await sleep(300);
    const [after, afterMap] = await Promise.all([readState(), readMap()]); const message = objectValue(after.message); const battle = objectValue(after.battle);
    const afterEvents = (Array.isArray(afterMap.events) ? afterMap.events : []).map(objectValue);
    const afterEvent = afterEvents.find((item) => Number(item.id) === selectedId) || null;
    const reacted = message.busy === true || (Array.isArray(message.choices) && message.choices.length > 0)
      || battle.active === true || sceneFrom(after) !== sceneBefore || Number(objectValue(after.map).id || 0) !== mapBefore
      || !afterEvent || afterEvent.erased === true || afterEvent.active_page !== pageBefore;
    if (reacted) return { ok: true, event_id: selectedId, event_name: selectedName, navigated,
      message_after: typeof message.text === "string" && message.text ? message.text : null,
      choices_after: Array.isArray(message.choices) ? message.choices.map(String) : [], scene_after: sceneFrom(after), message: "interaction produced an observable game response" };
  }
  const after = await readState(); const message = objectValue(after.message);
  return { ok: false, event_id: selectedId, event_name: selectedName, navigated,
    message_after: typeof message.text === "string" && message.text ? message.text : null,
    choices_after: Array.isArray(message.choices) ? message.choices.map(String) : [], scene_after: sceneFrom(after), message: "interaction attempts completed but the game showed no observable response" };
}

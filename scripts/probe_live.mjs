// Live layout probe for calibrating high-level action sequences against the real game.
// Unlike live_e2e.mjs (pass/fail acceptance) this is a measuring instrument: it walks
// menus without committing anything and prints observed window layouts as JSON.
//
// Usage: node scripts/probe_live.mjs <suite> [args]
//   menu           traverse the main menu command window, record index->symbol
//   savefile       enter the save screen via the measured menu, record file_index behavior
//   movement       measure how many wait frames one map step needs; test repeat batching
//   queries        exercise every query tool, record wall time and empty-field report
//   to-battle      walk the known fog route into the scripted battle (map 21 -> 22)
//   battle-layout  traverse battle windows without committing a turn
//   flee           try to end the active battle via the party command window
//
// Requires BLACK_SOULS_ROOT / BLACK_SOULS_DIR to point at a prepared sandbox and the
// game to be running (launch first). Never writes a save slot.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import process from "node:process";
import { findPath } from "../dist/navigation.js";

const suite = process.argv[2];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/index.js")], env: childEnv });
const client = new Client({ name: "black-souls-probe", version: "1.0.0" });
const out = (label, value) => console.log(JSON.stringify({ probe: label, ...value }));

const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(`${name}: ${response.content?.[0]?.text}`);
  return response.structuredContent?.data;
};
const state = () => call("black_souls_get_state");
const seq = (steps, timeout = 20000) => call("black_souls_input_sequence", { steps, timeout_ms: timeout });
const activeWindow = (s) => (s.scene?.windows || []).find((w) => w.active) || null;

async function traverseCommandWindow(label, extraCancel = true) {
  let s = await state();
  const entry = activeWindow(s);
  if (!entry) { out(label, { error: "no active window", scene: s.scene?.name }); return null; }
  const seen = [];
  const max = Math.min(Number(entry.item_max) || 1, 12);
  out(label, { entry_index: entry.index, item_max: entry.item_max, class: entry.class, entry_symbol: entry.current_symbol });
  for (let i = 0; i < max; i += 1) {
    s = await state();
    const w = activeWindow(s);
    seen.push({ index: w?.index, symbol: w?.current_symbol ?? null });
    if (i < max - 1) await seq([{ action: "move_down" }, { wait_frames: 6 }]);
  }
  out(label, { traversal: seen });
  if (extraCancel) return seen;
  return seen;
}

async function walkTo(x, y, maxSteps = 60) {
  for (let step = 0; step < maxSteps; step += 1) {
    const s = await state();
    if (s.message?.busy || s.battle?.active) return { reached: false, reason: "interrupted", player: s.player };
    const px = Number(s.player?.x), py = Number(s.player?.y);
    if (px === x && py === y) return { reached: true, player: s.player };
    const m = await call("black_souls_get_map");
    const radius = Number(m.radius) || 6;
    const tiles = (m.tiles || []).map((t) => ({ x: t.x, y: t.y, passable: t.passable }));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let goal = { x, y };
    if (Math.abs(x - px) > radius || Math.abs(y - py) > radius) {
      const aim = { x: clamp(x, px - radius, px + radius), y: clamp(y, py - radius, py + radius) };
      goal = tiles
        .map((t) => ({ t, d: Math.abs(t.x - aim.x) + Math.abs(t.y - aim.y) + (Math.abs(t.x - px) + Math.abs(t.y - py)) * 0.01 }))
        .sort((a, b) => a.d - b.d)
        .map((e) => ({ x: e.t.x, y: e.t.y }))
        .find((c) => { const q = findPath(tiles, { x: px, y: py }, c, radius); return q && q.length; });
      if (!goal) return { reached: false, reason: "no waypoint", player: s.player };
    }
    const p = findPath(tiles, { x: px, y: py }, goal, radius);
    if (!p || !p.length) return { reached: false, reason: p === null ? "out of radius" : "no path", player: s.player };
    await seq([{ action: p[0] }, { wait_frames: 20 }]);
  }
  return { reached: false, reason: "step budget exhausted" };
}

try {
  await client.connect(transport);
  const boot = await call("black_souls_status");
  if (boot.bridge?.connected !== true) throw new Error("bridge is not connected; launch first");

  if (suite === "menu") {
    let s = await state();
    if (s.scene?.name !== "Scene_Map" || s.message?.busy) throw new Error(`need idle Scene_Map, got ${s.scene?.name} busy=${s.message?.busy}`);
    await seq([{ action: "open_menu" }, { wait_frames: 12 }]);
    s = await state();
    out("menu", { scene_after_open: s.scene?.name, windows: s.scene?.windows });
    await traverseCommandWindow("menu");
    await seq([{ action: "cancel" }, { wait_frames: 12 }]);
    out("menu", { scene_after_cancel: (await state()).scene?.name });
  } else if (suite === "savefile") {
    await seq([{ action: "open_menu" }, { wait_frames: 12 }]);
    let s = await state();
    let w = activeWindow(s);
    let guard = Number(w?.item_max) || 8;
    while (w && w.current_symbol !== "save" && guard-- > 0) {
      await seq([{ action: "move_down" }, { wait_frames: 6 }]);
      s = await state(); w = activeWindow(s);
    }
    out("savefile", { command_reached: w?.current_symbol, index: w?.index });
    if (w?.current_symbol !== "save") throw new Error("save command not found in menu");
    await seq([{ action: "confirm" }, { wait_frames: 16 }]);
    s = await state();
    out("savefile", { scene: s.scene?.name, entry_file_index: s.scene?.file_index, windows: s.scene?.windows });
    for (const step of ["move_down", "move_down", "move_up"]) {
      await seq([{ action: step }, { wait_frames: 6 }]);
      s = await state();
      out("savefile", { after: step, file_index: s.scene?.file_index });
    }
    await seq([{ action: "cancel" }, { wait_frames: 10 }, { action: "cancel" }, { wait_frames: 12 }]);
    out("savefile", { scene_after_exit: (await state()).scene?.name });
  } else if (suite === "movement") {
    for (let i = 0; i < 4; i += 1) {
      const s = await state();
      if (s.scene?.name === "Scene_Map" && !s.message?.busy) break;
      await seq([{ action: "cancel" }, { wait_frames: 12 }]);
    }
    for (const wait of [2, 4, 8, 12, 16, 20]) {
      const guard = await state();
      if (guard.scene?.name !== "Scene_Map" || guard.message?.busy) { out("movement", { wait, error: `bad precondition: ${guard.scene?.name}` }); continue; }
      const before = guard.player;
      const m = await call("black_souls_get_map");
      const tile = (m.tiles || []).find((t) => t.x === before.x && t.y === before.y);
      const dir = ["down", "up", "left", "right"].find((d) => tile?.passable?.[d]);
      if (!dir) { out("movement", { wait, error: "nowhere passable" }); continue; }
      await seq([{ action: `move_${dir}` }, { wait_frames: wait }]);
      const mid = (await state()).player;
      await sleep(400);
      const settled = (await state()).player;
      const moved = settled.x !== before.x || settled.y !== before.y;
      out("movement", { wait, dir, before: { x: before.x, y: before.y }, at_wait_end: { x: mid.x, y: mid.y }, settled: { x: settled.x, y: settled.y }, moved });
      if (moved) await seq([{ action: `move_${{ down: "up", up: "down", left: "right", right: "left" }[dir]}` }, { wait_frames: 24 }]);
    }
    const before = (await state()).player;
    const m = await call("black_souls_get_map");
    const tile = (m.tiles || []).find((t) => t.x === before.x && t.y === before.y);
    const dir = ["down", "up", "left", "right"].find((d) => tile?.passable?.[d]);
    await seq([{ action: `move_${dir}`, repeat: 3 }, { wait_frames: 90 }]);
    const after = (await state()).player;
    out("movement", { repeat_test: 3, dir, displacement: Math.abs(after.x - before.x) + Math.abs(after.y - before.y) });
  } else if (suite === "queries") {
    const timed = async (label, fn) => {
      const startedAt = Date.now();
      try { const value = await fn(); out("query", { label, wall_ms: Date.now() - startedAt, summary: value }); }
      catch (error) { out("query", { label, wall_ms: Date.now() - startedAt, error: String(error).slice(0, 200) }); }
    };
    await timed("variables", async () => await call("black_souls_get_variables", { ids: [1, 2, 3, 4, 5, 6, 7, 8] }));
    await timed("switches", async () => await call("black_souls_get_switches", { ids: [1, 2, 3, 4, 5, 6, 7, 8] }));
    await timed("inventory", async () => {
      const inv = await call("black_souls_get_inventory");
      const flat = [...(inv.weapons || []), ...(inv.armors || [])];
      return { items: (inv.items || []).length, weapons: (inv.weapons || []).length, armors: (inv.armors || []).length,
        sample_items: (inv.items || []).slice(0, 3), atk_def_all_zero: flat.length > 0 && flat.every((e) => !e.atk && !e.def) };
    });
    await timed("party_detail", async () => {
      const p = await call("black_souls_get_party_detail");
      const m = (p.members || [])[0] || {};
      return { members: (p.members || []).length, first: { name: m.name, atk: m.atk, def: m.def, skills: (m.skills || []).length, equips: (m.equips || []).length } };
    });
    await timed("scene_detail", async () => await call("black_souls_get_scene_detail"));
    for (const radius of [6, 12, 20]) {
      await timed(`full_map_r${radius}`, async () => {
        const m = await call("black_souls_get_full_map", { radius });
        return { available: m.available, tiles: (m.tiles || []).length, events: (m.events || []).length, map_id: m.map_id };
      });
    }
    await timed("event_detail", async () => {
      const m = await call("black_souls_get_map");
      const ev = (m.events || [])[0];
      if (!ev) return { skipped: "no nearby events" };
      const d = await call("black_souls_get_event", { event_id: ev.id });
      return { id: ev.id, found: d.found, pages: (d.pages || []).length, self_switches: d.self_switches };
    });
    await timed("eval_status", async () => await call("black_souls_eval_status", { check_conditions: [{ type: "scene", value: "Scene_Map" }, { type: "all_party_dead" }] }));
    await timed("health", async () => { const h = await call("black_souls_health"); return { ok: h.ok, issues: h.issues, state_age_ms: h.state_age_ms }; });
  } else if (suite === "to-battle") {
    let s = await state();
    out("to-battle", { start: s.player, map: s.map?.id });
    if (s.map?.id === 21) {
      const walk = await walkTo(17, 26);
      out("to-battle", { fog_walk: walk });
    }
    for (let i = 0; i < 40; i += 1) {
      s = await state();
      if (s.battle?.active) break;
      if (s.message?.busy) {
        const choices = s.message?.choices || [];
        if (choices.length) { out("to-battle", { choices }); await seq([{ action: "confirm" }, { wait_frames: 20 }]); }
        else await seq([{ action: "confirm" }, { wait_frames: 12 }]);
        continue;
      }
      if (s.map?.id === 22) {
        const walk = await walkTo(9, 25);
        out("to-battle", { approach: walk, map: s.map?.id });
        if (!walk.reached && walk.reason !== "interrupted") break;
        continue;
      }
      if (s.map?.id === 21) {
        const walk = await walkTo(17, 26);
        if (walk.reached) await seq([{ action: "move_up" }, { wait_frames: 20 }, { action: "move_up" }, { wait_frames: 30 }]);
        else if (walk.reason !== "interrupted") break;
        continue;
      }
      await sleep(300);
    }
    s = await state();
    out("to-battle", { battle_active: s.battle?.active, phase: s.battle?.phase, enemies: s.battle?.enemies, map: s.map?.id, player: s.player });
  } else if (suite === "battle-layout") {
    let s = await state();
    if (!s.battle?.active) throw new Error("not in battle");
    for (let i = 0; i < 60 && !activeWindow(s); i += 1) { await sleep(250); s = await state(); }
    out("battle", { phase: s.battle?.phase, windows: s.scene?.windows, enemies: s.battle?.enemies });
    const actor = await traverseCommandWindow("battle-actor-command");
    const backUp = (actor?.length || 1) - 1;
    if (backUp > 0) await seq([{ action: "move_up", repeat: backUp }, { wait_frames: 8 }]);
    await seq([{ action: "confirm" }, { wait_frames: 10 }]);
    s = await state();
    out("battle-enemy-window", { windows: s.scene?.windows });
    await seq([{ action: "move_right" }, { wait_frames: 6 }]);
    out("battle-enemy-window", { after_move_right: activeWindow(await state()) });
    await seq([{ action: "move_left" }, { wait_frames: 6 }, { action: "move_down" }, { wait_frames: 6 }]);
    out("battle-enemy-window", { after_move_down: activeWindow(await state()) });
    await seq([{ action: "cancel" }, { wait_frames: 8 }, { action: "cancel" }, { wait_frames: 10 }]);
    s = await state();
    out("battle-party-command", { windows: s.scene?.windows });
    await traverseCommandWindow("battle-party-command");
    await seq([{ action: "cancel" }, { wait_frames: 8 }]);
    out("battle", { final_windows: (await state()).scene?.windows });
  } else if (suite === "flee") {
    let s = await state();
    if (!s.battle?.active) throw new Error("not in battle");
    await seq([{ action: "cancel" }, { wait_frames: 10 }]);
    s = await state();
    let w = activeWindow(s);
    out("flee", { party_window: w });
    let guard = Number(w?.item_max) || 2;
    while (w && !["escape", "flee", "run"].includes(String(w.current_symbol)) && guard-- > 0) {
      await seq([{ action: "move_down" }, { wait_frames: 6 }]);
      w = activeWindow(await state());
    }
    out("flee", { selected: w?.current_symbol });
    await seq([{ action: "confirm" }, { wait_frames: 60 }]);
    await sleep(1500);
    s = await state();
    out("flee", { battle_active: s.battle?.active, scene: s.scene?.name, message: s.message?.text });
  } else {
    console.error("Unknown suite. Use: menu | savefile | movement | queries | to-battle | battle-layout | flee");
    process.exitCode = 2;
  }
} finally {
  await client.close();
}

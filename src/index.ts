#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ACTIONS, advanceDialogue, bridgeHealth, bridgeStatus, buildSituation, evalStatus, queryArmors, queryFullParty, queryItems, querySwitches, queryVariables, queryWeapons, readMap, readState, sendAction, sendQuery, sendSequence, triggerLoad, triggerSave, waitForCondition } from "./bridge.js";
import { getGameInfo, killGame, launchGame, listSaves } from "./game.js";
import { appendSessionLog, deleteMemory, readGoals, readMemory, readScratchpad, readSessionLog, setActiveGoal, writeGoal, writeMemory, writeScratchpad } from "./memory.js";
import { interact, navigate } from "./navigation.js";
import { battleAction } from "./battle.js";

const SERVER_VERSION = "1.8.0";
const server = new McpServer({ name: "black-souls-mcp", version: SERVER_VERSION });
const outputSchema = { data: z.unknown() };
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: { data: value },
});
const execute = async (operation: () => Promise<unknown>) => {
  try {
    return result(await operation());
  } catch (error) {
    const failure = {
      ok: false,
      server_version: SERVER_VERSION,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
    return { ...result(failure), isError: true };
  }
};

server.registerTool("black_souls_status", {
  description: "Inspect the BLACK SOULS MCP edition and live RGSS3 bridge status.", inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(async () => ({ server_version: SERVER_VERSION, game: await getGameInfo(), bridge: await bridgeStatus() })));

server.registerTool("black_souls_launch", {
  description: "Launch the independent BLACK SOULS MCP edition and wait for its in-game bridge.",
  inputSchema: { wait_ms: z.number().int().min(1000).max(30000).optional() },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ wait_ms }) => execute(() => launchGame(wait_ms)));

server.registerTool("black_souls_get_state", {
  description: "Read current scene, player, party, message, windows, and battle state directly from RGSS3.", inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => readState()));

server.registerTool("black_souls_get_map", {
  description: "Read the current nearby map tiles, passability, and events directly from RGSS3.", inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => readMap()));

server.registerTool("black_souls_input", {
  description: "Inject one allowlisted virtual RPG Maker input into the normal game input loop.",
  inputSchema: {
    action: z.enum(ACTIONS),
    repeat: z.number().int().min(1).max(100).optional(),
    timeout_ms: z.number().int().min(500).max(60000).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ action, repeat, timeout_ms }) => execute(() => sendAction(action, repeat, timeout_ms)));

const stepSchema = z.union([
  z.object({ action: z.enum(ACTIONS), repeat: z.number().int().min(1).max(100).optional() }),
  z.object({ wait_frames: z.number().int().min(1).max(600) }),
]);
server.registerTool("black_souls_input_sequence", {
  description: "Inject up to 200 allowlisted inputs and frame waits as one ordered sequence.",
  inputSchema: { steps: z.array(stepSchema).min(1).max(200), timeout_ms: z.number().int().min(500).max(60000).optional() },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ steps, timeout_ms }) => execute(() => sendSequence(steps, timeout_ms)));

server.registerTool("black_souls_list_saves", {
  description: "List independent MCP-edition save slots and metadata without modifying them.", inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(async () => ({ server_version: SERVER_VERSION, bridge: await bridgeStatus(), saves: await listSaves() })));

server.registerTool("black_souls_kill", {
  description: "Forcefully terminate the running BLACK SOULS process. Safe to call when game is not running.", inputSchema: {}, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => killGame()));

server.registerTool("black_souls_save", {
  description: "Trigger an in-game save to a specific slot (0-indexed) by injecting menu navigation inputs. Only works from Scene_Map.",
  inputSchema: { slot: z.number().int().min(0).max(15), timeout_ms: z.number().int().min(5000).max(60000).optional() }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ slot, timeout_ms }) => execute(() => triggerSave(slot, timeout_ms)));

server.registerTool("black_souls_load", {
  description: "Load a save slot from the title screen or the in-game menu and return the resulting state.",
  inputSchema: { slot: z.number().int().min(0).max(15), timeout_ms: z.number().int().min(5000).max(60000).optional() }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ slot, timeout_ms }) => execute(() => triggerLoad(slot, timeout_ms)));

server.registerTool("black_souls_situation", {
  description: "Get a concise snapshot of the current game situation, contextual action suggestions, and warnings.", inputSchema: {}, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => buildSituation()));

server.registerTool("black_souls_get_variables", {
  description: "Read RPG Maker game variable values by ID. Request up to 64 IDs per call.",
  inputSchema: { ids: z.array(z.number().int().min(1).max(9999)).min(1).max(64) }, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ ids }) => execute(() => queryVariables(ids)));

server.registerTool("black_souls_get_switches", {
  description: "Read RPG Maker boolean switches by ID. Request up to 64 IDs per call.",
  inputSchema: { ids: z.array(z.number().int().min(1).max(9999)).min(1).max(64) }, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ ids }) => execute(() => querySwitches(ids)));

server.registerTool("black_souls_get_inventory", {
  description: "Read the party's current inventory: consumable items, weapons, and armors with counts.", inputSchema: {}, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(async () => {
  const [items, weapons, armors] = await Promise.all([queryItems(), queryWeapons(), queryArmors()]);
  return { items: items.items, weapons: weapons.weapons, armors: armors.armors };
}));

server.registerTool("black_souls_get_party_detail", {
  description: "Read detailed party stats, equipment, and learned skills.", inputSchema: {}, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => queryFullParty()));

const memoryCategory = z.enum(["map", "npc", "item", "boss", "variable", "switch", "strategy", "lore"]);
server.registerTool("black_souls_scratchpad_read", {
  description: "Read the AI agent's current session scratchpad.", inputSchema: {}, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => readScratchpad()));
server.registerTool("black_souls_scratchpad_write", {
  description: "Update notes, flags, or recent actions in the session scratchpad.",
  inputSchema: { notes: z.string().max(8000).optional(), flags: z.record(z.boolean()).optional(), append_action: z.object({ frame: z.number().int(), action: z.string().max(200), result: z.string().max(200) }).optional() }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => execute(() => writeScratchpad(args)));
server.registerTool("black_souls_memory_read", {
  description: "Read long-term game knowledge, optionally filtered by category.", inputSchema: { category: memoryCategory.optional() }, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ category }) => execute(() => readMemory(category)));
server.registerTool("black_souls_memory_write", {
  description: "Store or update one long-term game knowledge entry.",
  inputSchema: { category: memoryCategory, key: z.string().min(1).max(100), value: z.string().min(1).max(1000), confidence: z.enum(["certain", "likely", "uncertain"]), source: z.string().max(200) }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => execute(() => writeMemory(args.category, args.key, args.value, args.confidence, args.source)));
server.registerTool("black_souls_memory_delete", {
  description: "Delete one long-term memory entry.", inputSchema: { category: memoryCategory, key: z.string().min(1).max(100) }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ category, key }) => execute(() => deleteMemory(category, key)));

const goalStatus = z.enum(["active", "completed", "failed", "blocked"]);
const goalInput = { id: z.string().min(1).max(100), title: z.string().max(200), description: z.string().max(1000), status: goalStatus, priority: z.number().int().min(1).max(10), parent_id: z.string().max(100).nullable(), completion_condition: z.string().max(500), notes: z.string().max(500) };
server.registerTool("black_souls_goals_read", {
  description: "Read the persistent objective hierarchy and active goal.", inputSchema: {}, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => readGoals()));
server.registerTool("black_souls_goals_write", {
  description: "Create or update a persistent gameplay goal.", inputSchema: goalInput, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => execute(() => writeGoal(args)));
server.registerTool("black_souls_goals_set_active", {
  description: "Choose the gameplay goal currently being pursued, or clear it.", inputSchema: { id: z.string().max(100).nullable() }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ id }) => execute(() => setActiveGoal(id)));

server.registerTool("black_souls_navigate", {
  description: "Move to a target tile using automatic pathfinding over current passability data.",
  inputSchema: { x: z.number().int().min(0).max(9999), y: z.number().int().min(0).max(9999), timeout_ms: z.number().int().min(2000).max(60000).optional() }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ x, y, timeout_ms }) => execute(() => navigate(x, y, timeout_ms)));
server.registerTool("black_souls_interact", {
  description: "Walk up to and interact with a nearby event, optionally selected by ID.",
  inputSchema: { event_id: z.number().int().min(1).optional(), timeout_ms: z.number().int().min(2000).max(60000).optional() }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ event_id, timeout_ms }) => execute(() => interact(event_id, timeout_ms)));
server.registerTool("black_souls_battle_action", {
  description: "Execute one battle turn and return resulting party and enemy state.",
  inputSchema: { action: z.enum(["attack", "skill", "item", "guard", "flee"]), skill_index: z.number().int().min(0).max(99).optional(), item_index: z.number().int().min(0).max(99).optional(), enemy_index: z.number().int().min(0).max(19).optional(), timeout_ms: z.number().int().min(5000).max(60000).optional() }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => execute(() => battleAction(args.action, args.skill_index, args.item_index, args.enemy_index, args.timeout_ms)));
server.registerTool("black_souls_advance_dialogue", {
  description: "Advance active dialogue until it ends or a choice appears, optionally selecting a choice.",
  inputSchema: { choice_index: z.number().int().min(0).max(19).optional(), max_advances: z.number().int().min(1).max(50).optional(), timeout_ms: z.number().int().min(2000).max(60000).optional() }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => execute(() => advanceDialogue(args.choice_index, args.max_advances, args.timeout_ms)));

server.registerTool("black_souls_get_full_map", {
  description: "Request map tiles, passability, regions, terrain tags, and events up to radius 20.",
  inputSchema: { radius: z.number().int().min(6).max(20).optional() }, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ radius }) => execute(() => sendQuery("full_map", radius ? `radius=${radius}` : "")));
server.registerTool("black_souls_get_event", {
  description: "Inspect an event's pages, trigger conditions, active page, and self-switches.",
  inputSchema: { event_id: z.number().int().min(1).max(9999) }, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ event_id }) => execute(() => sendQuery("event_detail", String(event_id))));
server.registerTool("black_souls_get_scene_detail", {
  description: "Read deeper state for the active map, battle, or menu scene.", inputSchema: {}, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => sendQuery("scene_detail")));

server.registerTool("black_souls_health", {
  description: "Comprehensive bridge health check with diagnosis and recommended recovery action.", inputSchema: {}, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => bridgeHealth()));
server.registerTool("black_souls_wait", {
  description: "Wait until a game condition becomes true before proceeding.",
  inputSchema: { condition: z.discriminatedUnion("type", [z.object({ type: z.literal("scene"), value: z.string() }), z.object({ type: z.literal("not_scene"), value: z.string() }), z.object({ type: z.literal("message_clear") }), z.object({ type: z.literal("battle_end") }), z.object({ type: z.literal("player_stopped") }), z.object({ type: z.literal("frame_advance"), frames: z.number().int().min(1).max(3600) })]), timeout_ms: z.number().int().min(500).max(120000).optional() }, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ condition, timeout_ms }) => execute(() => waitForCondition(condition, timeout_ms)));
server.registerTool("black_souls_session_log_append", {
  description: "Append a significant gameplay event to the persistent session log.",
  inputSchema: { frame: z.number().int().optional(), scene: z.string().optional(), event_type: z.enum(["action", "observation", "error", "milestone", "decision"]), summary: z.string().min(1).max(500) }, outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => execute(() => appendSessionLog({ ...args, frame: args.frame ?? null, scene: args.scene ?? null })));
server.registerTool("black_souls_session_log_read", {
  description: "Read the most recent persistent session log entries.", inputSchema: { last_n: z.number().int().min(1).max(200).optional() }, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ last_n }) => execute(() => readSessionLog(last_n)));

server.registerTool("black_souls_eval_status", {
  description: "Check scenario completion conditions against live game state. Used by the eval runner; returns pass/fail per condition.",
  inputSchema: {
    check_conditions: z.array(z.object({
      type: z.enum(["scene", "map_id", "variable", "switch", "player_x", "player_y", "all_party_dead"]),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      variable_id: z.number().int().min(1).max(9999).optional(),
      switch_id: z.number().int().min(1).max(9999).optional(),
    })).min(1).max(20),
  }, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ check_conditions }) => execute(() => evalStatus(check_conditions)));

await server.connect(new StdioServerTransport());
console.error(`black-souls-mcp ${SERVER_VERSION} listening on stdio`);

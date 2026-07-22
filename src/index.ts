#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ACTIONS, bridgeStatus, readMap, readState, sendAction, sendSequence } from "./bridge.js";
import { getGameInfo, launchGame, listSaves } from "./game.js";

const SERVER_VERSION = "1.1.1";
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

await server.connect(new StdioServerTransport());
console.error(`black-souls-mcp ${SERVER_VERSION} listening on stdio`);

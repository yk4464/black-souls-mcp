import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import process from "node:process";

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js")],
  env: childEnv,
});
const client = new Client({ name: "black-souls-integration", version: "1.0.0" });
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  const expected = [
    "black_souls_status", "black_souls_launch", "black_souls_get_state",
    "black_souls_get_map", "black_souls_input", "black_souls_input_sequence",
    "black_souls_list_saves", "black_souls_kill", "black_souls_save",
    "black_souls_load", "black_souls_situation",
    "black_souls_get_variables", "black_souls_get_switches",
    "black_souls_get_inventory", "black_souls_get_party_detail",
    "black_souls_scratchpad_read", "black_souls_scratchpad_write",
    "black_souls_memory_read", "black_souls_memory_write", "black_souls_memory_delete",
    "black_souls_goals_read", "black_souls_goals_write", "black_souls_goals_set_active",
    "black_souls_navigate", "black_souls_interact", "black_souls_battle_action",
    "black_souls_advance_dialogue",
    "black_souls_get_full_map", "black_souls_get_event", "black_souls_get_scene_detail",
    "black_souls_health", "black_souls_wait", "black_souls_session_log_append", "black_souls_session_log_read",
    "black_souls_eval_status", "black_souls_battle_options",
  ];
  for (const name of expected) if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
  const savesResult = await client.callTool({ name: "black_souls_list_saves", arguments: {} });
  const statusResult = await client.callTool({ name: "black_souls_status", arguments: {} });
  const saves = savesResult.structuredContent?.data?.saves;
  const status = statusResult.structuredContent?.data;
  if (!Array.isArray(saves)) throw new Error("Save listing did not return an array");
  const expectedSaveCount = Number(process.env.BLACK_SOULS_EXPECTED_SAVE_COUNT || 0);
  if (expectedSaveCount > 0 && saves.length < expectedSaveCount) {
    throw new Error(`Expected at least ${expectedSaveCount} saves, found ${saves.length}`);
  }
  if (status?.game?.game !== "BLACK SOULS") throw new Error("Unexpected game identity");
  console.log(JSON.stringify({ tools: names, saves: saves.length, bridge_connected: status?.bridge?.connected }, null, 2));
} finally {
  await client.close();
}

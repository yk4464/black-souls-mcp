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
    "black_souls_list_saves",
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

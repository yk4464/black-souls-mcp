import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import process from "node:process";

const [toolName, cliArgumentText] = process.argv.slice(2);
const argumentText = cliArgumentText ?? process.env.BLACK_SOULS_TOOL_ARGS ?? "{}";
if (!toolName) {
  console.error("Usage: node scripts/call_tool.mjs TOOL_NAME '{\"argument\":\"value\"}'");
  process.exit(2);
}

let args;
try {
  args = JSON.parse(argumentText);
} catch (error) {
  console.error(`Invalid JSON arguments: ${error}`);
  process.exit(2);
}

const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/index.js")] });
const client = new Client({ name: "black-souls-manual-check", version: "1.0.0" });
try {
  await client.connect(transport);
  const response = await client.callTool({ name: toolName, arguments: args });
  if (response.isError) {
    console.error(response.content?.[0]?.text || `${toolName} failed`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(response.structuredContent?.data, null, 2));
  }
} finally {
  await client.close();
}

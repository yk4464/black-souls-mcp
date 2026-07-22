import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
let stdoutBuffer = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  stdout += text;
  stdoutBuffer += text;
  const lines = stdoutBuffer.split(/\r?\n/);
  stdoutBuffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk; });

const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method} timed out after 5000ms`));
  }, 5000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});

const notify = (method, params = {}) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
};

child.once("error", (error) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
});
child.once("exit", (code, signal) => {
  if (!pending.size) return;
  const error = new Error(`MCP server exited before responding (code=${code}, signal=${signal || "none"})`);
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
});

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  assert.equal(initialized.serverInfo.name, "black-souls-mcp");
  notify("notifications/initialized");

  const listed = await request("tools/list", {});
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "black_souls_get_map",
    "black_souls_get_state",
    "black_souls_input",
    "black_souls_input_sequence",
    "black_souls_launch",
    "black_souls_list_saves",
    "black_souls_status",
  ]);

  const status = await request("tools/call", { name: "black_souls_status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.data.server_version, initialized.serverInfo.version);

  const unavailableState = await request("tools/call", { name: "black_souls_get_state", arguments: {} });
  assert.equal(unavailableState.isError, true);
  assert.equal(unavailableState.structuredContent.data.ok, false);
  assert.match(unavailableState.structuredContent.data.error.message, /bridge is not ready/i);

  console.log("MCP handshake, tool discovery, structured status, and structured error handling: OK");
  if (stderr.trim()) console.log(stderr.trim());
} catch (error) {
  console.error({ error: String(error), stdout, stderr });
  process.exitCode = 1;
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  child.kill();
}

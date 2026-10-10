import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Keep the protocol smoke test deterministic even when a real MCP game session is
// currently running in the repository's default runtime directory.
const isolatedRoot = path.join(os.tmpdir(), `black-souls-mcp-smoke-${process.pid}`);
const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    BLACK_SOULS_ROOT: isolatedRoot,
    BLACK_SOULS_DIR: path.join(isolatedRoot, "game"),
    BLACK_SOULS_GAME_EXE_SHA256: "",
  },
});
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
    "black_souls_advance_dialogue",
    "black_souls_battle_action",
    "black_souls_battle_options",
    "black_souls_eval_status",
    "black_souls_get_event",
    "black_souls_get_full_map",
    "black_souls_get_inventory",
    "black_souls_get_map",
    "black_souls_get_party_detail",
    "black_souls_get_scene_detail",
    "black_souls_get_state",
    "black_souls_get_switches",
    "black_souls_get_variables",
    "black_souls_goals_read",
    "black_souls_goals_set_active",
    "black_souls_goals_write",
    "black_souls_health",
    "black_souls_input",
    "black_souls_input_sequence",
    "black_souls_interact",
    "black_souls_kill",
    "black_souls_launch",
    "black_souls_list_saves",
    "black_souls_load",
    "black_souls_memory_delete",
    "black_souls_memory_read",
    "black_souls_memory_write",
    "black_souls_navigate",
    "black_souls_save",
    "black_souls_scratchpad_read",
    "black_souls_scratchpad_write",
    "black_souls_session_log_append",
    "black_souls_session_log_read",
    "black_souls_situation",
    "black_souls_status",
    "black_souls_wait",
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

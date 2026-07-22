import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import process from "node:process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const suiteDeadline = Date.now() + 90000;
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/index.js")] });
const client = new Client({ name: "black-souls-live-e2e", version: "1.0.0" });
const call = async (name, args = {}) => {
  const remaining = suiteDeadline - Date.now();
  if (remaining <= 0) throw new Error("Live E2E exceeded its 90 second deadline");
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${name} exceeded the test deadline`)), remaining);
  });
  let response;
  try {
    response = await Promise.race([client.callTool({ name, arguments: args }), deadline]);
  } finally {
    clearTimeout(timeout);
  }
  if (response.isError) throw new Error(response.content?.[0]?.text || `${name} failed`);
  return response.structuredContent?.data;
};
const waitForScene = async (name, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await call("black_souls_status");
    if (status.bridge?.connected !== true) {
      throw new Error(`Bridge disconnected while waiting for ${name}: ${JSON.stringify(status.bridge)}`);
    }
    const state = await call("black_souls_get_state");
    if (state.scene?.name === name) return state;
    await sleep(100);
  }
  throw new Error(`Scene ${name} did not appear within ${timeoutMs}ms`);
};

try {
  await client.connect(transport);
  const launch = await call("black_souls_launch", { wait_ms: 15000 });
  if (launch.bridge?.connected !== true) throw new Error(`Launch returned without a live bridge: ${JSON.stringify(launch)}`);
  let state = await call("black_souls_get_state");
  if (state.scene?.name === "Scene_Title") {
    const title = state.scene.windows?.find((window) => window.class === "Window_TitleCommand");
    if (title?.current_symbol !== "continue") {
      await call("black_souls_input", { action: "move_down" });
    }
    await call("black_souls_input", { action: "confirm" });
    await waitForScene("Scene_Load");
    await call("black_souls_input_sequence", { steps: [{ action: "confirm" }, { wait_frames: 180 }], timeout_ms: 15000 });
  }
  state = await waitForScene("Scene_Map", 15000);
  const before = { ...state.player };
  const map = await call("black_souls_get_map");
  const tile = map.tiles?.find((entry) => entry.x === before.x && entry.y === before.y);
  const occupied = new Set((map.events || []).map((event) => `${event.x},${event.y}`));
  const directions = [
    ["move_down", "down", 0, 1], ["move_left", "left", -1, 0],
    ["move_right", "right", 1, 0], ["move_up", "up", 0, -1],
  ];
  const choice = directions.find(([, key, dx, dy]) => tile?.passable?.[key] && !occupied.has(`${before.x + dx},${before.y + dy}`));
  if (!choice) throw new Error("No unoccupied passable adjacent tile was found");
  await call("black_souls_input_sequence", { steps: [{ action: choice[0] }, { wait_frames: 20 }] });
  const afterMove = await call("black_souls_get_state");
  if (afterMove.player?.x === before.x && afterMove.player?.y === before.y) throw new Error("Player coordinate did not change");
  await call("black_souls_input_sequence", { steps: [{ action: "open_menu" }, { wait_frames: 30 }] });
  const menu = await waitForScene("Scene_Menu");
  await call("black_souls_input_sequence", { steps: [{ action: "cancel" }, { wait_frames: 30 }] });
  const returned = await waitForScene("Scene_Map");
  console.log(JSON.stringify({
    launch_pid: launch.pid,
    launch_token: returned.launch_token,
    bridge_version: returned.bridge_version,
    map_id: returned.map?.id,
    before,
    after_move: afterMove.player,
    menu_scene: menu.scene.name,
    return_scene: returned.scene.name,
  }, null, 2));
} finally {
  await client.close();
}

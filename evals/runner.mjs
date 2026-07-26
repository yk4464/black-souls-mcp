// Eval runner for black-souls-mcp.
// Usage: node evals/runner.mjs <eval-name> [--max-turns <n>]
//
// Runs one scenario from evals/scenarios/<eval-name>.json against a live game:
//   1. Starts the MCP server and, if needed, launches the game.
//   2. Optionally loads the scenario's save slot.
//   3. Runs a deterministic rule-based agent loop (situation -> decide -> act).
//   4. Checks completion/failure conditions each turn via black_souls_eval_status.
//   5. Writes a result JSON to evals/results/<eval-name>-<timestamp>.json.
//
// The built-in agent is a stub baseline: it advances dialogue, attacks in battle,
// confirms on the title screen, and walks passable directions on the map. Replace
// decideAction() to plug in a real model-driven agent.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const evalsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(evalsDir, "..");

const [scenarioName, ...rest] = process.argv.slice(2);
if (!scenarioName) {
  console.error("Usage: node evals/runner.mjs <eval-name> [--max-turns <n>]");
  process.exit(2);
}
const maxTurnsOverride = (() => {
  const index = rest.indexOf("--max-turns");
  return index >= 0 ? Number(rest[index + 1]) : null;
})();

const scenarioFile = path.join(evalsDir, "scenarios", `${scenarioName}.json`);
const scenario = JSON.parse(await fs.readFile(scenarioFile, "utf8"));
const maxTurns = maxTurnsOverride || scenario.max_turns || 50;

const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "dist", "index.js")],
  env: childEnv,
});
const client = new Client({ name: "black-souls-eval-runner", version: "1.0.0" });

const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  return { data: response.structuredContent?.data, isError: response.isError === true };
};

function decideAction(situation) {
  if (!situation) return { tool: "black_souls_situation", args: {} };
  if (situation.choices?.length) return { tool: "black_souls_advance_dialogue", args: { choice_index: 0 } };
  if (situation.warnings?.includes("dialogue active")) return { tool: "black_souls_advance_dialogue", args: {} };
  if (situation.battle_enemies?.some((enemy) => !enemy.dead)) return { tool: "black_souls_battle_action", args: { action: "attack" } };
  if (situation.scene === "Scene_Title") return { tool: "black_souls_input", args: { action: "confirm" } };
  const open = ["up", "down", "left", "right"].filter((direction) => situation.passable?.[direction]);
  if (open.length) {
    const pick = open[Number(situation.frame || 0) % open.length];
    return { tool: "black_souls_input", args: { action: `move_${pick}` } };
  }
  return { tool: "black_souls_input", args: { action: "confirm" } };
}

async function checkConditions(conditions) {
  const structural = conditions.filter((item) => item.type !== "turns_exceeded");
  if (!structural.length) return { all_passed: false, results: [] };
  const outcome = await call("black_souls_eval_status", { check_conditions: structural });
  if (outcome.isError) return { all_passed: false, results: [], error: outcome.data?.error?.message };
  return outcome.data;
}

const startedAt = Date.now();
const transcript = [];
let completed = false;
let failed = false;
let failReason = null;
let turns = 0;

try {
  await client.connect(transport);
  const status = await call("black_souls_status", {});
  if (status.data?.bridge?.connected !== true) {
    const launch = await call("black_souls_launch", {});
    if (launch.isError) throw new Error(`launch failed: ${launch.data?.error?.message}`);
  }
  if (Number.isInteger(scenario.save_slot)) {
    const load = await call("black_souls_load", { slot: scenario.save_slot });
    transcript.push({ turn: 0, tool: "black_souls_load", args: { slot: scenario.save_slot }, error: load.isError });
  }

  for (turns = 1; turns <= maxTurns; turns += 1) {
    const situation = (await call("black_souls_situation", {})).data;
    const decision = decideAction(situation);
    const outcome = await call(decision.tool, decision.args);
    transcript.push({ turn: turns, scene: situation?.scene ?? null, tool: decision.tool, args: decision.args, error: outcome.isError });

    const completion = await checkConditions(scenario.completion_conditions || []);
    if (completion.all_passed) { completed = true; break; }
    const failures = (scenario.failure_conditions || []).filter((item) => item.type !== "turns_exceeded");
    if (failures.length) {
      const failure = await checkConditions(failures);
      const hit = failure.results?.find((entry) => entry.passed);
      if (hit) { failed = true; failReason = hit.condition.type; break; }
    }
  }
  if (!completed && !failed) { failed = true; failReason = "turns_exceeded"; }
} catch (error) {
  failed = true;
  failReason = String(error);
} finally {
  await client.close().catch(() => undefined);
}

const result = {
  scenario: scenario.name || scenarioName,
  description: scenario.description || "",
  started_at: startedAt,
  finished_at: Date.now(),
  max_turns: maxTurns,
  turns_used: turns,
  completed,
  failed,
  fail_reason: failReason,
  metrics: { turns_to_complete: completed ? turns : null },
  transcript,
};
const resultsDir = path.join(evalsDir, "results");
await fs.mkdir(resultsDir, { recursive: true });
const stamp = new Date(startedAt).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const resultFile = path.join(resultsDir, `${scenarioName}-${stamp}.json`);
await fs.writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ scenario: result.scenario, completed, failed, fail_reason: failReason, turns_used: turns, result_file: resultFile }, null, 2));
process.exitCode = completed ? 0 : 1;

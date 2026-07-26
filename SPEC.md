# black-souls-mcp — Full Development Specification

> **Execution target**: Codex / ChatGPT o3.  
> **How to use**: Feed this file directly. Work through phases in order.
> Each phase ends with a verification command that must exit 0 before the next phase begins.
> Never ask the user for clarification; resolve ambiguity by reading the source files listed below.

---

## 0. Project Context

**Goal**: Enable an AI agent to autonomously play and complete the RPG Maker VX Ace game
"BLACK SOULS" using this MCP server as its sole interface to the game.

**Repository layout (already exists)**
```
src/index.ts          — MCP server entry; all tools registered here
src/bridge.ts         — File-based IPC with RGSS3; snapshot read/write
src/game.ts           — Game launch, integrity check, save metadata
src/config.ts         — Path resolution via env vars
rgss/BlackSoulsBridge.rb  — Ruby 1.9 script injected into RPG Maker VX Ace
scripts/smoke.mjs     — MCP handshake + tool list assertion
scripts/unit.mjs      — Synthetic bridge unit tests (no game required)
scripts/integration.mjs   — Integration smoke (prepared runtime, no game)
scripts/live_e2e.mjs  — Full live E2E (real game required; do NOT modify)
AGENTS.md             — Project config for Codex (you are reading SPEC.md now)
```

**Current server version**: `1.1.1`  
**Current tools (7)**: `black_souls_status`, `black_souls_launch`, `black_souls_get_state`,
`black_souls_get_map`, `black_souls_input`, `black_souls_input_sequence`, `black_souls_list_saves`

**IPC protocol**: Node.js writes `.cmd` files to `BridgeRuntime/inbox/`, game reads and
processes them, writes `.json` responses to `BridgeRuntime/outbox/`. Game writes periodic
JSON snapshots to `BridgeRuntime/state/` and `BridgeRuntime/map/`.

**Ruby environment**: RGSS3 / Ruby 1.9 — no `require`, no `JSON` stdlib, no threads.
Use only the hand-rolled `to_json` already present in `BlackSoulsBridge`.

---

## 0.1 Global Coding Rules (apply to every phase)

- TypeScript: strict mode, ES modules, `fs/promises` only (no sync FS), Zod inline schemas.
- Every new MCP tool: registered in `src/index.ts`, wrapped in `execute()`, returns `result()`.
- Every new tool: `outputSchema: { data: z.unknown() }` — do not change this shape.
- All Node.js file path logic goes in `src/config.ts` or `src/bridge.ts`, never inline.
- Ruby: all new methods inside `module BlackSoulsBridge`; access game objects only via
  `safe_call` / `safe_instance_variable`; every public method body wrapped in
  `rescue => error; append_error(error); nil; end` at the outermost level.
- After EVERY change: `npm run build && npm test` must exit 0.
- Bump `SERVER_VERSION` in `src/index.ts` AND `VERSION` in `rgss/BlackSoulsBridge.rb`
  together on every phase completion (patch for new tools, minor for bridge protocol changes).
- Update `scripts/integration.mjs` expected tool list whenever tools are added.
- Commit message style: `feat(phaseN): short imperative sentence`

---

## Phase 1 — Kill Switch, Save/Load Triggers, Situation Summary

**Version target**: `1.2.0`  
**No Ruby changes required in this phase** — all work is Node.js only.

### 1.1 Tool: `black_souls_kill`

**Purpose**: Forcefully terminate the game process. Required so AI can recover from softlocks,
crashes, or infinite loops without human intervention.

**File**: `src/game.ts` — add `killGame(): Promise<KillResult>`  
**File**: `src/index.ts` — register tool

```typescript
// src/game.ts — add this export
export interface KillResult {
  ok: boolean;
  pid: number | null;
  signal: string;
  message: string;
}

export async function killGame(): Promise<KillResult> {
  // Read BridgeRuntime/info/info-*.json (latest), extract pid
  // If pid found: call process.kill(pid, "SIGTERM") on Windows use taskkill /F /PID
  // Wait up to 2000ms for the process to exit; if still alive send SIGKILL / taskkill /F
  // Return { ok, pid, signal, message }
  // If no pid or process already gone: return { ok: true, pid: null, signal: "none", message: "not running" }
}
```

**MCP registration** (`src/index.ts`):
```typescript
server.registerTool("black_souls_kill", {
  description: "Forcefully terminate the running BLACK SOULS process. Safe to call when game is not running.",
  inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => killGame()));
```

**Tests to add** in `scripts/unit.mjs`:
- Call `killGame()` when no info snapshot exists → must return `{ ok: true, pid: null }`, no throw
- Call `killGame()` with a synthetic info snapshot pointing to a non-existent PID →
  must return `{ ok: true }` without throwing (process already gone)

---

### 1.2 Tool: `black_souls_save`

**Purpose**: Trigger an in-game save by injecting the input sequence that opens the menu,
navigates to save, and confirms. This is a high-level helper built on top of
`sendSequence` — no Ruby change needed for the trigger itself.

**File**: `src/bridge.ts` — add `triggerSave(slot: number, timeoutMs?: number): Promise<SaveResult>`  
**File**: `src/index.ts` — register tool

```typescript
// src/bridge.ts
export interface SaveResult {
  ok: boolean;
  slot: number;
  frame_before: number;
  frame_after: number;
  scene_after: string | null;
  message: string;
}

export async function triggerSave(slot: number, timeoutMs = 30000): Promise<SaveResult> {
  // 1. Read current state snapshot — record frame_before and verify scene is Scene_Map
  //    (save menu is only accessible from the field; throw BridgeError if not)
  // 2. Build input sequence:
  //    open_menu → wait:8 → page_down × (slot) steps to navigate to Save slot → confirm:1 → wait:4 → confirm:1
  //    The exact sequence is slot-dependent:
  //      open_menu:1 → wait:8 → move_down × slot → confirm:1 → wait:6 → confirm:1
  // 3. Call sendSequence(steps, timeoutMs)
  // 4. After sequence completes, read new state snapshot
  // 5. Return SaveResult with frame_before, frame_after, scene_after
  // NOTE: This is best-effort. The caller (AI agent) should verify by reading state after.
}
```

**MCP registration**:
```typescript
server.registerTool("black_souls_save", {
  description: "Trigger an in-game save to a specific slot (0-indexed) by injecting menu navigation inputs. Only works from Scene_Map. Returns state snapshots before and after.",
  inputSchema: {
    slot: z.number().int().min(0).max(15),
    timeout_ms: z.number().int().min(5000).max(60000).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ slot, timeout_ms }) => execute(() => triggerSave(slot, timeout_ms)));
```

---

### 1.3 Tool: `black_souls_load`

**Purpose**: Load a save file from the title screen or in-game load menu.

**File**: `src/bridge.ts` — add `triggerLoad(slot: number, timeoutMs?: number): Promise<LoadResult>`

```typescript
export interface LoadResult {
  ok: boolean;
  slot: number;
  scene_before: string | null;
  scene_after: string | null;
  player_after: { x: number; y: number; map_id: number } | null;
  message: string;
}

export async function triggerLoad(slot: number, timeoutMs = 30000): Promise<LoadResult> {
  // 1. Read current scene from state snapshot
  // 2. If scene is Scene_Title:
  //      confirm:1 → wait:10 → move_down × slot → confirm:1 → wait:30
  // 3. If scene is Scene_Map (in-game continue):
  //      open_menu:1 → wait:8 → navigate to Load → move_down × slot → confirm:1 → wait:30
  // 4. Read new state snapshot and return LoadResult
}
```

**MCP registration**: analogous to `black_souls_save`.

---

### 1.4 Tool: `black_souls_situation`

**Purpose**: Return a concise, AI-readable natural-language summary of the current game
situation. This is the primary tool the AI agent uses to orient itself after each action.
Reduces token usage by avoiding raw state/map dumps.

**File**: `src/bridge.ts` — add `buildSituation(): Promise<SituationSnapshot>`

```typescript
export interface SituationSnapshot {
  ok: boolean;
  scene: string | null;
  location: string | null;          // map display_name or "Battle" or "Menu"
  player: { x: number; y: number; direction: number } | null;
  party: Array<{
    name: string; hp: number; mhp: number; mp: number; mmp: number;
    tp: number; level: number; alive: boolean;
  }>;
  gold: number;
  message_text: string | null;      // current dialogue/choice text if any
  choices: string[];                // current choice list if any
  battle_enemies: Array<{ name: string; hp: number; mhp: number; dead: boolean }>;
  nearby_events: Array<{ id: number; name: string; x: number; y: number; dx: number; dy: number }>;
  passable: { up: boolean; down: boolean; left: boolean; right: boolean } | null;
  suggested_actions: string[];      // non-empty list of contextually sensible actions
  warnings: string[];               // e.g. "HP critical", "in battle", "dialogue active"
  frame: number;
  updated_at: number;
}

export async function buildSituation(): Promise<SituationSnapshot> {
  // Reads both readState() and readMap(), merges into SituationSnapshot
  // suggested_actions logic:
  //   - Scene_Title → ["confirm (start game)", "move_down + confirm (load game)"]
  //   - message.busy && choices.length > 0 → ["confirm (select choice)", "cancel (back)"]
  //   - message.busy && choices.length == 0 → ["confirm (advance text)"]
  //   - battle.active → ["confirm (fight)", "cancel (flee/menu)"]
  //   - Scene_Map, no message → passable directions + "open_menu"
  // warnings:
  //   - any member hp < mhp * 0.25 → "HP critical: <name>"
  //   - any member hp == 0 → "DEAD: <name>"
  //   - battle.active → "in battle"
  //   - message.busy → "dialogue active"
}
```

**MCP registration**:
```typescript
server.registerTool("black_souls_situation", {
  description: "Get a concise snapshot of the current game situation: scene, party health, dialogue, nearby events, passable directions, and contextual action suggestions. Use this before deciding what to do next.",
  inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => buildSituation()));
```

---

### 1.5 Phase 1 Tests

Add to `scripts/unit.mjs`:
1. `buildSituation()` with a state snapshot of `Scene_Title` → `suggested_actions` must
   include at least one entry containing "confirm".
2. `buildSituation()` with `message.busy = true, choices = ["Yes","No"]` →
   `choices` must be `["Yes","No"]`, `suggested_actions` must include "confirm".
3. `buildSituation()` with a party member at hp=1, mhp=100 →
   `warnings` must include a string matching `/HP critical/`.
4. `triggerSave(2)` called when bridge is not ready → must throw with message matching
   `/bridge is not ready/i`.
5. `killGame()` with no info snapshot → must return `{ ok: true, pid: null }`.

Update `scripts/integration.mjs` expected tool list to include:
`black_souls_kill`, `black_souls_save`, `black_souls_load`, `black_souls_situation`

### 1.6 Phase 1 Completion Criteria
- `npm run build && npm test` exits 0
- `scripts/integration.mjs` exits 0 with new tools present in the list
- Server version is `1.2.0` in both `src/index.ts` and `rgss/BlackSoulsBridge.rb`

---

## Phase 2 — RGSS3 Bridge Expansion: Variables, Switches, Inventory, Direct Save/Load

**Version target**: `1.3.0` (minor bump — new bridge protocol features)  
**Ruby changes required**: Yes — `rgss/BlackSoulsBridge.rb`  
**New IPC command type**: `query` (read-only game data request)

### 2.1 New Bridge IPC Command Type: `query`

The existing IPC only handles `input_sequence` commands. Add a second command type `query`
that allows Node.js to request arbitrary game data by name. Queries are answered in the
same outbox `.json` response pattern, but execute instantly (no frame stepping).

**Changes to `rgss/BlackSoulsBridge.rb`**:

In `parse_command`, add a `type` field alongside `steps`:
```ruby
# In parse_command, after reading id and token:
type = values["type"].to_s   # "sequence" (default, existing) or "query"
if type == "query"
  query_name = values["query"].to_s
  raise "invalid query name" unless query_name =~ /\A[a-z_]{1,64}\z/
  return { "id" => id, "type" => "query", "query" => query_name,
           "params" => values["params"].to_s }
end
# ... existing sequence parsing continues unchanged
```

In `process_command`, handle query type before the existing sequence logic:
```ruby
def self.process_command
  @active ||= @queue.shift
  return unless @active
  if @active["type"] == "query"
    result = execute_query(@active["query"], @active["params"])
    atomic_json(OUTBOX + "/" + @active["id"] + ".json", {
      "ok" => true,
      "id" => @active["id"],
      "type" => "query",
      "protocol" => PROTOCOL,
      "bridge_version" => VERSION,
      "pid" => process_id,
      "launch_token" => @launch_token,
      "frame" => Graphics.frame_count,
      "data" => result
    })
    @active = nil
    return
  end
  # ... existing sequence processing unchanged
end
```

Add `execute_query` dispatcher:
```ruby
def self.execute_query(name, params)
  case name
  when "variables"  then query_variables(params)
  when "switches"   then query_switches(params)
  when "items"      then query_items
  when "weapons"    then query_weapons
  when "armors"     then query_armors
  when "full_party" then query_full_party
  else raise "unknown query: #{name}"
  end
rescue => error
  append_error(error)
  { "error" => error.message }
end
```

---

### 2.2 Query: `variables`

Read `$game_variables[n]` for a list of variable IDs.

```ruby
def self.query_variables(params)
  # params is comma-separated list of integer IDs, e.g. "1,2,3,100"
  ids = params.split(",").map(&:to_i).uniq.first(64)
  return { "variables" => {} } unless defined?($game_variables) && $game_variables
  result = {}
  ids.each do |id|
    next unless id > 0
    result[id.to_s] = safe_call($game_variables, :[], id)
  end
  { "variables" => result }
rescue => error
  append_error(error)
  { "variables" => {}, "error" => error.message }
end
```

**New MCP tool** `black_souls_get_variables` in `src/bridge.ts` and `src/index.ts`:
```typescript
// src/bridge.ts
export async function queryVariables(ids: number[]): Promise<Record<string, unknown>> {
  // Send a query command with type=query, query=variables, params=ids.join(",")
  // Wait for outbox response (use same sendCommand pattern as sequences)
  // Return response.data.variables
}
```
```typescript
// src/index.ts
server.registerTool("black_souls_get_variables", {
  description: "Read RPG Maker game variable values by ID. Variables store story progress, flags, counters, and quest states. Request up to 64 IDs per call.",
  inputSchema: { ids: z.array(z.number().int().min(1).max(9999)).min(1).max(64) },
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ ids }) => execute(() => queryVariables(ids)));
```

---

### 2.3 Query: `switches`

Read `$game_switches[n]` (boolean flags) for a list of switch IDs.

```ruby
def self.query_switches(params)
  ids = params.split(",").map(&:to_i).uniq.first(64)
  return { "switches" => {} } unless defined?($game_switches) && $game_switches
  result = {}
  ids.each do |id|
    next unless id > 0
    result[id.to_s] = !!safe_call($game_switches, :[], id)
  end
  { "switches" => result }
rescue => error
  append_error(error)
  { "switches" => {}, "error" => error.message }
end
```

**New MCP tool** `black_souls_get_switches`: identical pattern to `black_souls_get_variables`.

---

### 2.4 Query: `items`, `weapons`, `armors`

Read party inventory.

```ruby
def self.query_items
  return { "items" => [] } unless defined?($game_party) && $game_party
  items = $game_party.items rescue []
  { "items" => items.map { |item|
    { "id" => item.id, "name" => item.name,
      "count" => $game_party.item_number(item),
      "note" => (item.note.to_s.lines.first.to_s.strip rescue "") }
  }}
rescue => error
  append_error(error)
  { "items" => [], "error" => error.message }
end

def self.query_weapons
  return { "weapons" => [] } unless defined?($game_party) && $game_party
  weapons = $game_party.weapons rescue []
  { "weapons" => weapons.map { |w|
    { "id" => w.id, "name" => w.name,
      "count" => $game_party.item_number(w),
      "atk" => (w.atk rescue 0), "note" => (w.note.to_s.lines.first.to_s.strip rescue "") }
  }}
rescue => error
  append_error(error)
  { "weapons" => [], "error" => error.message }
end

def self.query_armors
  return { "armors" => [] } unless defined?($game_party) && $game_party
  armors = $game_party.armors rescue []
  { "armors" => armors.map { |a|
    { "id" => a.id, "name" => a.name,
      "count" => $game_party.item_number(a),
      "def" => (a.def rescue 0), "note" => (a.note.to_s.lines.first.to_s.strip rescue "") }
  }}
rescue => error
  append_error(error)
  { "armors" => [], "error" => error.message }
end
```

**New MCP tools**: `black_souls_get_inventory` (calls all three queries, merges result):
```typescript
server.registerTool("black_souls_get_inventory", {
  description: "Read the party's current inventory: consumable items, weapons, and armors with counts.",
  inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(async () => ({
  items: (await queryItems()).items,
  weapons: (await queryWeapons()).weapons,
  armors: (await queryArmors()).armors,
})));
```

---

### 2.5 Query: `full_party`

Extends the existing `party` state with equip slots, param stats, and learned skills.

```ruby
def self.query_full_party
  return { "members" => [] } unless defined?($game_party) && $game_party
  { "members" => $game_party.members.map { |actor|
    equips = (actor.equips rescue []).map { |e|
      e ? { "id" => e.id, "name" => e.name } : nil
    }
    skills = (actor.skills rescue []).map { |s|
      { "id" => s.id, "name" => s.name, "mp_cost" => (s.mp_cost rescue 0) }
    }
    actor_summary(actor).merge({
      "atk" => safe_call(actor, :atk, 0),
      "def" => safe_call(actor, :def, 0),
      "mat" => safe_call(actor, :mat, 0),
      "mdf" => safe_call(actor, :mdf, 0),
      "agi" => safe_call(actor, :agi, 0),
      "luk" => safe_call(actor, :luk, 0),
      "equips" => equips,
      "skills" => skills
    })
  }}
rescue => error
  append_error(error)
  { "members" => [], "error" => error.message }
end
```

**New MCP tool** `black_souls_get_party_detail`: single tool wrapping this query.

---

### 2.6 Bridge `sendQuery` helper in `src/bridge.ts`

All query tools share a single helper. Add alongside `sendSequence`:

```typescript
export async function sendQuery(
  queryName: string,
  params: string = "",
  timeoutMs: number = 10000,
): Promise<unknown> {
  // 1. Ensure bridge is ready (same check as sendSequence)
  // 2. Generate a unique command ID (same pattern as sequences)
  // 3. Write BridgeRuntime/inbox/<id>.cmd with:
  //      id=<id>
  //      token=<launch_token>
  //      type=query
  //      query=<queryName>
  //      params=<params>
  // 4. Await outbox/<id>.json response within timeoutMs
  // 5. If response.ok === false throw BridgeError(response.error)
  // 6. Return response.data
}
```

---

### 2.7 Phase 2 Tests

Add to `scripts/unit.mjs`:
1. Synthesize an outbox response for a `variables` query → `queryVariables([1,2])` must
   return the correct values without hitting a real game.
2. `sendQuery()` with bridge not ready → throws matching `/bridge is not ready/i`.
3. `sendQuery()` timeout path (no outbox file written) → throws after timeoutMs.
4. `sendQuery()` with `response.ok === false` → throws with the response error message.

Update `scripts/integration.mjs` to include:
`black_souls_get_variables`, `black_souls_get_switches`, `black_souls_get_inventory`,
`black_souls_get_party_detail`

Add `capabilities` field update in `BlackSoulsBridge.initialize_bridge`:
```ruby
"capabilities" => ["state", "map", "input", "input_sequence", "query"]
```

### 2.8 Phase 2 Completion Criteria
- `npm run build && npm test` exits 0
- `scripts/integration.mjs` exits 0
- Version `1.3.0` in both files
- `BridgeRuntime/info/info-*.json` emits `"query"` in capabilities array

---

## Phase 3 — AI Memory System

**Version target**: `1.4.0` (patch — purely Node.js, no Ruby changes)  
**Purpose**: Give the AI agent persistent memory across turns and sessions so it can
accumulate knowledge about the game world, track its own goals, and avoid repeating
failed strategies.

All memory lives under `<BLACK_SOULS_ROOT>/memory/` — never inside `BridgeRuntime/`
(which is game-session ephemeral). Memory files must survive `killGame()` calls.

### 3.1 Memory Architecture

Three layers, each with its own file format:

```
memory/
  scratchpad.json        — working notes for the current session
  longterm.json          — persistent facts keyed by category + key
  goals.json             — hierarchical goal stack (current objective tree)
```

Add `src/memory.ts` — all memory operations live here.

---

### 3.2 `scratchpad.json` — Session Working Memory

**Schema**:
```typescript
interface Scratchpad {
  session_id: string;       // UUID generated at first write each session
  updated_at: number;       // Unix timestamp
  notes: string;            // freeform text, max 8000 chars, AI-managed
  recent_actions: Array<{   // ring buffer, last 50 entries
    frame: number;
    action: string;
    result: string;
  }>;
  flags: Record<string, boolean>;  // quick boolean notes ("chest_opened_map3", etc.)
}
```

**Tools**:

`black_souls_scratchpad_read` — return current scratchpad content  
`black_souls_scratchpad_write` — overwrite notes/flags fields (not recent_actions)

```typescript
// src/memory.ts
export async function readScratchpad(): Promise<Scratchpad>
export async function writeScratchpad(patch: {
  notes?: string;
  flags?: Record<string, boolean>;
  append_action?: { frame: number; action: string; result: string };
}): Promise<Scratchpad>
```

Rules for `writeScratchpad`:
- `notes` max 8000 characters — truncate silently if exceeded
- `flags` is merged (not replaced) with existing flags; set a key to `false` to remove it
- `append_action` appends to `recent_actions` and trims to last 50 entries
- Always updates `updated_at`
- Write is atomic (write to `.tmp`, rename)

MCP registrations:
```typescript
server.registerTool("black_souls_scratchpad_read", {
  description: "Read the AI agent's current session scratchpad: working notes, recent action log, and boolean flags. Use this to recall what you were doing before the last context reset.",
  inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => readScratchpad()));

server.registerTool("black_souls_scratchpad_write", {
  description: "Update the AI agent's session scratchpad. Write notes about current strategy, set/clear boolean flags, or append a recent action to the log.",
  inputSchema: {
    notes: z.string().max(8000).optional(),
    flags: z.record(z.boolean()).optional(),
    append_action: z.object({
      frame: z.number().int(),
      action: z.string().max(200),
      result: z.string().max(200),
    }).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => execute(() => writeScratchpad(args)));
```

---

### 3.3 `longterm.json` — Long-Term Knowledge Base

**Purpose**: Persist facts that survive game restarts and context resets. Examples:
which maps lead where, which NPCs give quests, which items are needed for progression,
what strategies failed against which bosses, discovered variable/switch meanings.

**Schema**:
```typescript
interface LongtermMemory {
  updated_at: number;
  entries: Record<string, Record<string, LongtermEntry>>;
  // entries[category][key] = entry
  // category: "map", "npc", "item", "boss", "variable", "switch", "strategy", "lore"
}

interface LongtermEntry {
  value: string;        // freeform text, max 1000 chars per entry
  updated_at: number;
  confidence: "certain" | "likely" | "uncertain";
  source: string;       // brief provenance note, e.g. "observed frame 4200"
}
```

**Total size cap**: 200 entries across all categories. If exceeded, oldest low-confidence
entries are evicted automatically.

**Tools**:

`black_souls_memory_read` — read entries by category (or all)  
`black_souls_memory_write` — upsert one entry  
`black_souls_memory_delete` — delete one entry by category + key

```typescript
// src/memory.ts
export async function readMemory(category?: string): Promise<LongtermMemory | Record<string, LongtermEntry>>
export async function writeMemory(
  category: string,
  key: string,
  value: string,
  confidence: "certain" | "likely" | "uncertain",
  source: string,
): Promise<LongtermEntry>
export async function deleteMemory(category: string, key: string): Promise<{ deleted: boolean }>
```

MCP registrations:
```typescript
server.registerTool("black_souls_memory_read", {
  description: "Read long-term memory entries. Optionally filter by category: 'map', 'npc', 'item', 'boss', 'variable', 'switch', 'strategy', 'lore'. Returns all entries if category is omitted.",
  inputSchema: {
    category: z.enum(["map","npc","item","boss","variable","switch","strategy","lore"]).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ category }) => execute(() => readMemory(category)));

server.registerTool("black_souls_memory_write", {
  description: "Store a long-term memory entry. Use this to record discovered facts about the game world: map connections, NPC dialogue clues, boss weaknesses, variable/switch meanings, failed strategies.",
  inputSchema: {
    category: z.enum(["map","npc","item","boss","variable","switch","strategy","lore"]),
    key: z.string().min(1).max(100),
    value: z.string().min(1).max(1000),
    confidence: z.enum(["certain","likely","uncertain"]),
    source: z.string().max(200),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => execute(() => writeMemory(args.category, args.key, args.value, args.confidence, args.source)));

server.registerTool("black_souls_memory_delete", {
  description: "Delete a specific long-term memory entry by category and key.",
  inputSchema: {
    category: z.enum(["map","npc","item","boss","variable","switch","strategy","lore"]),
    key: z.string().min(1).max(100),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ category, key }) => execute(() => deleteMemory(category, key)));
```

---

### 3.4 `goals.json` — Goal Stack

**Purpose**: Track the AI's current objective hierarchy so it can resume after interruption,
context resets, or mid-game restarts.

**Schema**:
```typescript
interface GoalStack {
  updated_at: number;
  active_goal_id: string | null;
  goals: Record<string, Goal>;
}

interface Goal {
  id: string;
  title: string;             // max 200 chars
  description: string;       // max 1000 chars
  status: "active" | "completed" | "failed" | "blocked";
  priority: number;          // 1 (highest) to 10 (lowest)
  parent_id: string | null;  // for sub-goals
  created_at: number;
  updated_at: number;
  completion_condition: string;  // human-readable, max 500 chars
  notes: string;             // max 500 chars
}
```

**Tools**:

`black_souls_goals_read` — read full goal stack  
`black_souls_goals_write` — upsert a goal (create or update by id)  
`black_souls_goals_set_active` — set which goal is currently being pursued

```typescript
// src/memory.ts
export async function readGoals(): Promise<GoalStack>
export async function writeGoal(goal: Omit<Goal, "created_at" | "updated_at"> & { id: string }): Promise<Goal>
export async function setActiveGoal(id: string | null): Promise<GoalStack>
```

MCP registrations follow the same pattern. Max 100 goals total; oldest completed/failed
goals are evicted when limit is reached.

---

### 3.5 Phase 3 Tests

Add to `scripts/unit.mjs`:
1. `writeScratchpad({ notes: "x".repeat(9000) })` → stored notes length must be ≤ 8000
2. `writeScratchpad({ append_action: {...} })` called 60 times → `recent_actions.length` must be ≤ 50
3. `writeScratchpad({ flags: { a: true } })` then `writeScratchpad({ flags: { b: true } })` →
   both flags must be present (merge, not replace)
4. `writeMemory(...)` × 201 distinct keys → total entries must be ≤ 200 (eviction works)
5. `writeGoal({ id: "g1", ... })` then `readGoals()` → goal is present
6. `setActiveGoal("nonexistent")` → must throw with message matching `/goal not found/i`
7. All memory writes are atomic: write temp file then rename (verify by checking no `.tmp`
   files remain after each write)

Update `scripts/integration.mjs` expected tool list to include all 8 new memory tools.

### 3.6 Phase 3 Completion Criteria
- `npm run build && npm test` exits 0
- `memory/` directory is created automatically on first write (no manual setup)
- `memory/` path uses `installRoot()` from `src/config.ts`
- Version `1.4.0` in both files

---

## Phase 4 — High-Level AI Helper Tools

**Version target**: `1.5.0` (patch — Node.js only, no Ruby changes)  
**Purpose**: Reduce the number of round-trips the AI needs to accomplish common tasks.
These tools combine multiple lower-level operations into single calls, enabling the AI to
act more efficiently and with less hallucination about game state.

### 4.1 Tool: `black_souls_navigate`

**Purpose**: Move the player to an adjacent target tile in one call, handling pathfinding
entirely on the Node.js side. The AI specifies a target (x, y) and the tool computes
a sequence of directional inputs using BFS over the passability map, sends it, and
confirms arrival.

**File**: `src/navigation.ts` (new file)

```typescript
// src/navigation.ts
import { readMap, sendSequence } from "./bridge.js";
import { readState } from "./bridge.js";

export interface NavigateResult {
  ok: boolean;
  start: { x: number; y: number };
  target: { x: number; y: number };
  steps_taken: number;
  final_position: { x: number; y: number };
  reached: boolean;
  message: string;
}

export async function navigate(
  targetX: number,
  targetY: number,
  timeoutMs: number = 30000,
): Promise<NavigateResult>
```

Implementation requirements:
- Read current map snapshot to get passability grid and player position
- Run BFS from `(player.x, player.y)` to `(targetX, targetY)` using the `passable`
  data in the map snapshot tiles
- If target is out of the current map radius (MAP_RADIUS = 6), return
  `{ ok: false, message: "target out of current map radius; move closer first" }`
- If no path found, return `{ ok: false, message: "no passable path to target" }`
- Convert BFS path to a sequence of `move_up/down/left/right` actions
- Send via `sendSequence()` with appropriate wait frames between steps
- Read final state snapshot and verify player position
- Max path length: 50 steps (guard against pathfinding to distant tiles)

**MCP registration**:
```typescript
server.registerTool("black_souls_navigate", {
  description: "Move the player to a target tile (x, y) using automatic pathfinding over the current map passability data. Target must be within the current map radius (6 tiles). Returns final position and whether target was reached.",
  inputSchema: {
    x: z.number().int().min(0).max(9999),
    y: z.number().int().min(0).max(9999),
    timeout_ms: z.number().int().min(2000).max(60000).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ x, y, timeout_ms }) => execute(() => navigate(x, y, timeout_ms)));
```

---

### 4.2 Tool: `black_souls_interact`

**Purpose**: Face and interact with the nearest event or a specific event by ID.
Equivalent to walking adjacent to an event and pressing confirm, in one call.

**File**: `src/navigation.ts` — add `interact()`

```typescript
export interface InteractResult {
  ok: boolean;
  event_id: number | null;
  event_name: string | null;
  navigated: boolean;
  message_after: string | null;
  choices_after: string[];
  scene_after: string | null;
  message: string;
}

export async function interact(
  eventId?: number,
  timeoutMs: number = 20000,
): Promise<InteractResult>
```

Implementation requirements:
- Read current map snapshot to find events
- If `eventId` specified: find that event; if not found return `{ ok: false, ... }`
- If no `eventId`: find the nearest event within 2 tiles of the player
- Navigate to a tile adjacent to the event using `navigate()`
- Press `confirm` once
- Wait 10 frames then read state snapshot
- Return message/choices from the resulting state

**MCP registration**:
```typescript
server.registerTool("black_souls_interact", {
  description: "Walk up to and interact with a nearby event. Optionally specify event_id to target a specific event; otherwise targets the nearest event within 2 tiles. Returns dialogue or choices shown after interaction.",
  inputSchema: {
    event_id: z.number().int().min(1).optional(),
    timeout_ms: z.number().int().min(2000).max(60000).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ event_id, timeout_ms }) => execute(() => interact(event_id, timeout_ms)));
```

---

### 4.3 Tool: `black_souls_battle_action`

**Purpose**: Execute one full battle turn in one call — select attack/skill/item and
target in a single sequence, then wait for the turn to resolve.

**File**: `src/battle.ts` (new file)

```typescript
// src/battle.ts
export type BattleActionType = "attack" | "skill" | "item" | "guard" | "flee";

export interface BattleActionResult {
  ok: boolean;
  action: BattleActionType;
  turn_before: number | null;
  turn_after: number | null;
  battle_still_active: boolean;
  enemies_after: Array<{ name: string; hp: number; mhp: number; dead: boolean }>;
  party_after: Array<{ name: string; hp: number; mhp: number }>;
  message: string;
}

export async function battleAction(
  action: BattleActionType,
  skillIndex?: number,     // 0-indexed position in skill list (for "skill")
  itemIndex?: number,      // 0-indexed position in item list (for "item")
  enemyIndex?: number,     // 0-indexed enemy target (default: first alive enemy)
  timeoutMs: number = 20000,
): Promise<BattleActionResult>
```

Implementation requirements:
- Read state snapshot; if `battle.active === false` return `{ ok: false, message: "not in battle" }`
- Build input sequence based on action type:
  - `attack`: confirm → wait:4 → navigate enemy selection (enemyIndex × move_down) → confirm
  - `skill`: page_up → wait:4 → navigate skill (skillIndex × move_down) → confirm → wait:4 → navigate enemy → confirm
  - `item`: page_down → wait:4 → navigate item → confirm → wait:4 → navigate enemy → confirm
  - `guard`: move_down × 2 → confirm (assumes guard is 3rd menu option)
  - `flee`: cancel → wait:4 → confirm
- After sequence: wait 30 frames, read new state snapshot
- Return `BattleActionResult` with before/after party and enemy states

**MCP registration**:
```typescript
server.registerTool("black_souls_battle_action", {
  description: "Execute one battle turn: attack, use a skill, use an item, guard, or flee. Automatically navigates battle menus and returns the resulting party/enemy state. Only valid during an active battle.",
  inputSchema: {
    action: z.enum(["attack", "skill", "item", "guard", "flee"]),
    skill_index: z.number().int().min(0).max(99).optional(),
    item_index: z.number().int().min(0).max(99).optional(),
    enemy_index: z.number().int().min(0).max(19).optional(),
    timeout_ms: z.number().int().min(5000).max(60000).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => execute(() => battleAction(
  args.action, args.skill_index, args.item_index, args.enemy_index, args.timeout_ms,
)));
```

---

### 4.4 Tool: `black_souls_advance_dialogue`

**Purpose**: Advance through an active dialogue sequence, optionally selecting a choice,
until the dialogue ends or the next choice appears.

**File**: `src/bridge.ts` — add `advanceDialogue()`

```typescript
export interface DialogueResult {
  ok: boolean;
  lines_advanced: number;
  final_choices: string[];
  dialogue_ended: boolean;
  scene_after: string | null;
  message: string;
}

export async function advanceDialogue(
  choiceIndex?: number,     // if present, select this choice (0-indexed) when choices appear
  maxAdvances: number = 30,
  timeoutMs: number = 30000,
): Promise<DialogueResult>
```

Implementation requirements:
- Read state; if `message.busy === false` return `{ ok: false, message: "no active dialogue" }`
- Loop up to `maxAdvances` times:
  - If `choices.length > 0` and `choiceIndex` specified: navigate to choice → confirm; break
  - If `choices.length > 0` and no `choiceIndex`: return current choices, stop
  - If `message.busy === true` and no choices: press confirm, wait 8 frames, re-read state
  - If `message.busy === false`: dialogue ended, break
- Return `DialogueResult`

**MCP registration**:
```typescript
server.registerTool("black_souls_advance_dialogue", {
  description: "Advance through active dialogue by pressing confirm repeatedly until the dialogue ends or a choice appears. Optionally auto-select a choice by 0-indexed position. Returns final state.",
  inputSchema: {
    choice_index: z.number().int().min(0).max(19).optional(),
    max_advances: z.number().int().min(1).max(50).optional(),
    timeout_ms: z.number().int().min(2000).max(60000).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => execute(() => advanceDialogue(args.choice_index, args.max_advances, args.timeout_ms)));
```

---

### 4.5 Phase 4 Tests

Add to `scripts/unit.mjs`:
1. BFS pathfinding (pure function, no game) — test with a synthetic passability grid:
   - Straight line path → correct action sequence
   - Path around an obstacle → correct detour
   - Unreachable target → returns empty path
   - Target out of radius → returns null
2. `navigate()` when bridge not ready → throws matching `/bridge is not ready/i`
3. `advanceDialogue()` when `message.busy === false` → returns
   `{ ok: false, message: "no active dialogue" }` without sending any commands
4. `battleAction("attack")` when `battle.active === false` → returns `{ ok: false }`

Export the BFS function from `src/navigation.ts` with a name like `findPath` so it can
be tested in isolation without needing a game connection.

Update `scripts/integration.mjs` to include:
`black_souls_navigate`, `black_souls_interact`, `black_souls_battle_action`,
`black_souls_advance_dialogue`

### 4.6 Phase 4 Completion Criteria
- `npm run build && npm test` exits 0
- `findPath` exported and tested in isolation
- Version `1.5.0` in both files

---

## Phase 5 — RGSS3 Extended State: Full Map Scan, Event Inspection, Scene Introspection

**Version target**: `1.6.0` (minor — new bridge query types)  
**Ruby changes required**: Yes — add new query handlers to `BlackSoulsBridge`

### 5.1 Query: `full_map`

The existing `map_hash` snapshot covers only a 6-tile radius. For pathfinding over
longer distances and map discovery, the AI needs the ability to request a full map scan.

```ruby
# In execute_query dispatcher, add:
when "full_map" then query_full_map(params)

def self.query_full_map(params)
  return { "available" => false } unless map_ready? && $game_player
  # params: optional "radius=N" to override, max 20
  radius = [params.to_s[/radius=(\d+)/, 1].to_i, 6].max
  radius = [radius, 20].min
  px = $game_player.x
  py = $game_player.y
  tiles = []
  (py - radius).upto(py + radius) do |y|
    (px - radius).upto(px + radius) do |x|
      next unless x >= 0 && y >= 0 && x < $game_map.width && y < $game_map.height
      tiles << {
        "x" => x, "y" => y,
        "passable" => {
          "down" => $game_map.passable?(x, y, 2),
          "left" => $game_map.passable?(x, y, 4),
          "right" => $game_map.passable?(x, y, 6),
          "up" => $game_map.passable?(x, y, 8)
        },
        "region" => ($game_map.region_id(x, y) rescue 0),
        "terrain_tag" => ($game_map.terrain_tag(x, y) rescue 0)
      }
    end
  end
  events = $game_map.events.values.map { |e| event_summary(e) }.compact
  {
    "available" => true,
    "map_id" => $game_map.map_id,
    "width" => $game_map.width,
    "height" => $game_map.height,
    "display_name" => safe_call($game_map, :display_name, ""),
    "center" => { "x" => px, "y" => py },
    "radius" => radius,
    "tiles" => tiles,
    "events" => events
  }
rescue => error
  append_error(error)
  { "available" => false, "error" => error.message }
end
```

**New MCP tool** `black_souls_get_full_map`:
```typescript
server.registerTool("black_souls_get_full_map", {
  description: "Request a full map scan up to radius tiles from the player (max 20). Returns all tile passability, region IDs, terrain tags, and all events on the map. Use for long-range pathfinding. Larger radius = slower query.",
  inputSchema: {
    radius: z.number().int().min(6).max(20).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ radius }) => execute(() => sendQuery("full_map", radius ? `radius=${radius}` : "")));
```

---

### 5.2 Query: `event_detail`

Inspect a single event's page conditions, commands summary, and self-switch states.
Useful for understanding what triggers doors, NPCs, and cutscenes.

```ruby
when "event_detail" then query_event_detail(params)

def self.query_event_detail(params)
  event_id = params.to_i
  return { "found" => false } unless defined?($game_map) && $game_map
  event = $game_map.events[event_id]
  return { "found" => false } unless event
  data = safe_call(event, :event, nil)
  pages = []
  if data && data.pages
    data.pages.each_with_index do |page, idx|
      cond = page.condition
      pages << {
        "page" => idx + 1,
        "active" => (event.instance_variable_get(:@page) == page rescue false),
        "condition" => {
          "switch1_valid" => cond.switch1_valid,
          "switch1_id" => cond.switch1_id,
          "switch2_valid" => cond.switch2_valid,
          "switch2_id" => cond.switch2_id,
          "variable_valid" => cond.variable_valid,
          "variable_id" => cond.variable_id,
          "variable_value" => cond.variable_value,
          "self_switch_valid" => cond.self_switch_valid,
          "self_switch_ch" => cond.self_switch_ch
        },
        "trigger" => page.trigger,
        "priority_type" => page.priority_type,
        "move_type" => page.move_type,
        "command_count" => page.list ? page.list.length : 0
      }
    end
  end
  self_switches = {}
  ["A","B","C","D"].each do |ch|
    key = [$game_map.map_id, event_id, ch]
    self_switches[ch] = !!($game_self_switches[key] rescue false)
  end
  {
    "found" => true,
    "id" => event_id,
    "name" => data ? data.name : "",
    "x" => event.x, "y" => event.y,
    "direction" => event.direction,
    "pages" => pages,
    "self_switches" => self_switches
  }
rescue => error
  append_error(error)
  { "found" => false, "error" => error.message }
end
```

**New MCP tool** `black_souls_get_event`:
```typescript
server.registerTool("black_souls_get_event", {
  description: "Inspect a specific map event by ID: its pages, trigger conditions (switches, variables, self-switches), current active page, and self-switch states. Essential for understanding puzzle and door logic.",
  inputSchema: {
    event_id: z.number().int().min(1).max(9999),
  },
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ event_id }) => execute(() => sendQuery("event_detail", String(event_id))));
```

---

### 5.3 Query: `scene_detail`

Return deeper scene state: for `Scene_Map` include the current common events active;
for battle scenes include current skill selection state.

```ruby
when "scene_detail" then query_scene_detail

def self.query_scene_detail
  scene = defined?(SceneManager) ? SceneManager.scene : nil
  return { "scene" => nil } unless scene
  base = { "scene" => scene.class.to_s }
  case scene.class.to_s
  when "Scene_Map"
    base.merge({
      "interpreter_running" => ($game_map && $game_map.interpreter &&
        $game_map.interpreter.running? rescue false),
      "common_events_count" => ($game_map.respond_to?(:common_events) ?
        $game_map.common_events.count(&:active?) : 0 rescue 0)
    })
  when "Scene_Battle"
    base.merge({
      "actor_command_window_active" => begin
        w = scene.instance_variable_get(:@actor_command_window)
        w ? !!safe_call(w, :active, false) : false
      rescue; false; end,
      "current_actor_index" => (BattleManager.actor ? BattleManager.actor.index : nil rescue nil),
      "phase" => (BattleManager.instance_variable_get(:@phase) rescue nil)
    })
  else
    base
  end
rescue => error
  append_error(error)
  { "scene" => nil, "error" => error.message }
end
```

**New MCP tool** `black_souls_get_scene_detail`.

---

### 5.4 Phase 5 Tests

Add to `scripts/unit.mjs`:
1. `sendQuery("full_map", "radius=8")` with a synthesized outbox response →
   verify the query command file contains `query=full_map` and `params=radius=8`
2. `sendQuery("event_detail", "5")` command file → contains `query=event_detail` and `params=5`
3. `sendQuery("unknown_query_xyz")` → game returns `{ ok: false, error: "unknown query: ..." }` →
   `sendQuery()` throws with that error message

Update `scripts/integration.mjs` to include:
`black_souls_get_full_map`, `black_souls_get_event`, `black_souls_get_scene_detail`

Update `BlackSoulsBridge.initialize_bridge` capabilities:
```ruby
"capabilities" => ["state", "map", "input", "input_sequence", "query", "query_v2"]
```

### 5.5 Phase 5 Completion Criteria
- `npm run build && npm test` exits 0
- Version `1.6.0` in both files
- `scripts/integration.mjs` exits 0 with new tools listed

---

## Phase 6 — Robustness, Error Recovery, and Bridge Health

**Version target**: `1.7.0` (patch — no Ruby changes)  
**Purpose**: Harden the server for long autonomous sessions where the AI may run for
hours. Add retry logic, watchdog functionality, and structured error telemetry so the
AI can self-diagnose and recover from common failure modes without human help.

### 6.1 Bridge Watchdog: `black_souls_health`

**Purpose**: Single-call diagnostic that tells the AI whether everything is functioning
and, if not, exactly what is wrong and the recommended recovery action.

**File**: `src/bridge.ts` — add `bridgeHealth(): Promise<HealthReport>`

```typescript
export interface HealthReport {
  ok: boolean;
  game_running: boolean;
  bridge_connected: boolean;
  state_age_ms: number | null;       // ms since last state snapshot
  map_age_ms: number | null;
  last_error_log: string | null;     // last line of BridgeRuntime/error.log if any
  inbox_pending: number;             // .cmd files waiting in inbox (stuck commands)
  outbox_orphaned: number;           // .json files in outbox older than 60s (unread responses)
  memory_ok: boolean;                // memory/ directory exists and is writable
  issues: HealthIssue[];
  recommended_action: string;        // one-line instruction for the AI agent
}

export interface HealthIssue {
  code: string;           // e.g. "stale_state", "game_not_running", "stuck_command"
  severity: "critical" | "warning" | "info";
  detail: string;
}
```

Issue detection logic:
- `game_not_running`: bridge not connected and no PID in info snapshot → critical
- `stale_state`: state snapshot age > 5000ms but game appears running → warning
- `scene_transition`: state snapshot has `scene.name === null` for > 3s → info
- `stuck_command`: `.cmd` files in inbox older than 10s → critical
- `orphaned_response`: `.json` files in outbox older than 60s → warning
- `error_log_recent`: `error.log` modified in last 60s → warning
- `memory_unwritable`: cannot write a test file to `memory/` → critical

`recommended_action` mapping:
- If `game_not_running`: `"Call black_souls_launch to start the game"`
- If `stuck_command`: `"Call black_souls_kill then black_souls_launch to reset the bridge"`
- If `stale_state` only: `"Wait 2 seconds and retry; bridge may be recovering from scene transition"`
- If no issues: `"All systems nominal; proceed with gameplay"`

**MCP registration**:
```typescript
server.registerTool("black_souls_health", {
  description: "Comprehensive health check for the game bridge. Returns diagnosis of all subsystems and a recommended recovery action. Call this at the start of every session and whenever a tool returns an unexpected error.",
  inputSchema: {},
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => execute(() => bridgeHealth()));
```

---

### 6.2 Tool: `black_souls_wait`

**Purpose**: Wait for a specific game condition to become true, polling state snapshots
up to a timeout. Replaces brittle hardcoded `wait_frames` in higher-level tools.

**File**: `src/bridge.ts` — add `waitForCondition()`

```typescript
export type WaitCondition =
  | { type: "scene"; value: string }           // wait until scene.name matches
  | { type: "not_scene"; value: string }       // wait until scene changes away
  | { type: "message_clear" }                  // wait until message.busy === false
  | { type: "battle_end" }                     // wait until battle.active === false
  | { type: "player_stopped" }                 // wait until player.moving === false
  | { type: "frame_advance"; frames: number }  // wait for N frames to elapse

export interface WaitResult {
  ok: boolean;
  condition: WaitCondition;
  elapsed_ms: number;
  final_scene: string | null;
  timed_out: boolean;
}

export async function waitForCondition(
  condition: WaitCondition,
  timeoutMs: number = 15000,
  pollIntervalMs: number = 200,
): Promise<WaitResult>
```

**MCP registration**:
```typescript
server.registerTool("black_souls_wait", {
  description: "Wait until a game condition becomes true (scene change, dialogue end, battle end, player stops moving) before proceeding. Prevents race conditions in multi-step sequences.",
  inputSchema: {
    condition: z.discriminatedUnion("type", [
      z.object({ type: z.literal("scene"), value: z.string() }),
      z.object({ type: z.literal("not_scene"), value: z.string() }),
      z.object({ type: z.literal("message_clear") }),
      z.object({ type: z.literal("battle_end") }),
      z.object({ type: z.literal("player_stopped") }),
      z.object({ type: z.literal("frame_advance"), frames: z.number().int().min(1).max(3600) }),
    ]),
    timeout_ms: z.number().int().min(500).max(120000).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ condition, timeout_ms }) => execute(() => waitForCondition(condition, timeout_ms)));
```

---

### 6.3 Tool: `black_souls_session_log`

**Purpose**: Read or write a persistent session log — a chronological record of
significant events the AI has observed during gameplay. Separate from scratchpad
(which is ephemeral notes) and longterm memory (which is curated facts). The session
log is append-only and provides an auditable history.

**File**: `src/memory.ts` — add `appendSessionLog()`, `readSessionLog()`

```typescript
export interface SessionLogEntry {
  timestamp: number;
  session_id: string;
  frame: number | null;
  scene: string | null;
  event_type: "action" | "observation" | "error" | "milestone" | "decision";
  summary: string;           // max 500 chars
}

// Log stored as NDJSON (one JSON object per line) at memory/session.log
// Capped at 2000 lines; oldest entries pruned when limit exceeded

export async function appendSessionLog(entry: Omit<SessionLogEntry, "timestamp">): Promise<void>
export async function readSessionLog(last_n?: number): Promise<SessionLogEntry[]>
```

**MCP registrations**:
```typescript
server.registerTool("black_souls_session_log_append", {
  description: "Append a significant event to the persistent session log. Use this to record milestones (boss defeated, area unlocked), important decisions, observed cutscene content, and errors encountered. The log survives context resets.",
  inputSchema: {
    frame: z.number().int().optional(),
    scene: z.string().optional(),
    event_type: z.enum(["action","observation","error","milestone","decision"]),
    summary: z.string().min(1).max(500),
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args) => execute(() => appendSessionLog(args)));

server.registerTool("black_souls_session_log_read", {
  description: "Read recent session log entries. Returns the last N entries (default 50, max 200) in chronological order. Use this after a context reset to quickly understand what happened recently.",
  inputSchema: {
    last_n: z.number().int().min(1).max(200).optional(),
  },
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ last_n }) => execute(() => readSessionLog(last_n)));
```

---

### 6.4 Phase 6 Tests

Add to `scripts/unit.mjs`:
1. `bridgeHealth()` with no info/state files → `game_running: false`, issues contains
   `{ code: "game_not_running", severity: "critical" }`, `recommended_action` contains
   "black_souls_launch"
2. `bridgeHealth()` with fresh state snapshot but inbox containing a `.cmd` file
   older than 10s → issues contains `{ code: "stuck_command", severity: "critical" }`
3. `waitForCondition({ type: "message_clear" })` when state already has
   `message.busy === false` → resolves immediately with `timed_out: false`
4. `waitForCondition({ type: "scene", value: "Scene_Battle" })` with a state that
   never changes → times out after timeoutMs, returns `{ timed_out: true }`
5. `appendSessionLog(...)` × 2100 → `readSessionLog()` returns ≤ 2000 entries
6. `readSessionLog(10)` → returns exactly 10 entries (the most recent)

Update `scripts/integration.mjs` to include:
`black_souls_health`, `black_souls_wait`, `black_souls_session_log_append`,
`black_souls_session_log_read`

### 6.5 Phase 6 Completion Criteria
- `npm run build && npm test` exits 0
- Version `1.7.0` in both files

---

## Phase 7 — Evals and Autonomous Play Verification

**Version target**: `1.8.0` (patch)  
**Purpose**: Build a repeatable evaluation harness that measures how well the AI agent
can perform specific in-game tasks. Results are stored under `evals/results/` for
comparison across AI model versions and server versions.

### 7.1 Eval Framework: `evals/runner.mjs`

```javascript
// evals/runner.mjs
// Usage: node evals/runner.mjs <eval-name> [--model <model-id>] [--max-turns <n>]
//
// Runs one eval scenario:
//   1. Ensures game is running (calls black_souls_launch if needed)
//   2. Loads the designated save slot for the scenario
//   3. Connects an AI agent (via OpenAI API or a stub)
//   4. Runs the agent loop: each turn = call black_souls_situation → AI decides → execute
//   5. Checks completion conditions (variable/switch values, scene, player position)
//   6. Writes result to evals/results/<eval-name>-<timestamp>.json
//
// The runner is scenario-agnostic; scenarios are defined in evals/scenarios/*.json
```

### 7.2 Eval Scenario Format: `evals/scenarios/*.json`

```json
{
  "name": "title_to_first_save",
  "description": "Start from title screen, load save slot 0, reach the first indoor area",
  "save_slot": 0,
  "max_turns": 50,
  "completion_conditions": [
    { "type": "scene", "value": "Scene_Map" },
    { "type": "map_id", "value": 3 }
  ],
  "failure_conditions": [
    { "type": "turns_exceeded" },
    { "type": "all_party_dead" }
  ],
  "system_prompt_suffix": "Your goal is to load the game and reach map ID 3.",
  "metrics": ["turns_to_complete", "deaths", "gold_spent", "saves_used"]
}
```

Provide at least 5 scenarios covering:
1. `title_to_first_save` — load game from title
2. `basic_navigation` — move from point A to point B
3. `first_battle` — win the first random encounter
4. `first_dialogue` — complete a full NPC conversation
5. `menu_navigation` — open menu, inspect party stats, close menu

### 7.3 Tool: `black_souls_eval_status`

A lightweight tool that reports current eval metrics without connecting to any external
service — used by the eval runner to measure in-game state against scenario conditions.

```typescript
server.registerTool("black_souls_eval_status", {
  description: "Internal tool used by the eval runner to check scenario completion conditions. Returns structured game state optimized for automated condition checking.",
  inputSchema: {
    check_conditions: z.array(z.object({
      type: z.enum(["scene", "map_id", "variable", "switch", "player_x", "player_y", "all_party_dead"]),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      variable_id: z.number().int().optional(),
      switch_id: z.number().int().optional(),
    })).max(20),
  },
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ check_conditions }) => execute(async () => {
  // Read current state, check each condition, return pass/fail per condition
}));
```

### 7.4 Phase 7 Completion Criteria
- `evals/runner.mjs` is executable and produces a valid result JSON
- 5 scenario files exist under `evals/scenarios/`
- `npm run build && npm test` exits 0
- Version `1.8.0` in both files

---

## Final Tool Registry

After all phases, the server exposes **31 tools** total:

| Tool | Phase | Category |
|------|-------|----------|
| `black_souls_status` | existing | meta |
| `black_souls_launch` | existing | meta |
| `black_souls_get_state` | existing | state |
| `black_souls_get_map` | existing | state |
| `black_souls_input` | existing | input |
| `black_souls_input_sequence` | existing | input |
| `black_souls_list_saves` | existing | meta |
| `black_souls_kill` | Phase 1 | meta |
| `black_souls_save` | Phase 1 | action |
| `black_souls_load` | Phase 1 | action |
| `black_souls_situation` | Phase 1 | state |
| `black_souls_get_variables` | Phase 2 | state |
| `black_souls_get_switches` | Phase 2 | state |
| `black_souls_get_inventory` | Phase 2 | state |
| `black_souls_get_party_detail` | Phase 2 | state |
| `black_souls_scratchpad_read` | Phase 3 | memory |
| `black_souls_scratchpad_write` | Phase 3 | memory |
| `black_souls_memory_read` | Phase 3 | memory |
| `black_souls_memory_write` | Phase 3 | memory |
| `black_souls_memory_delete` | Phase 3 | memory |
| `black_souls_goals_read` | Phase 3 | memory |
| `black_souls_goals_write` | Phase 3 | memory |
| `black_souls_goals_set_active` | Phase 3 | memory |
| `black_souls_navigate` | Phase 4 | action |
| `black_souls_interact` | Phase 4 | action |
| `black_souls_battle_action` | Phase 4 | action |
| `black_souls_advance_dialogue` | Phase 4 | action |
| `black_souls_get_full_map` | Phase 5 | state |
| `black_souls_get_event` | Phase 5 | state |
| `black_souls_get_scene_detail` | Phase 5 | state |
| `black_souls_health` | Phase 6 | meta |
| `black_souls_wait` | Phase 6 | action |
| `black_souls_session_log_append` | Phase 6 | memory |
| `black_souls_session_log_read` | Phase 6 | memory |
| `black_souls_eval_status` | Phase 7 | meta |

---

## Dependency Policy

No new npm packages may be added unless listed here. Use only Node.js built-ins
(`fs/promises`, `path`, `crypto`, `child_process`, `os`) plus the already-declared
dependencies (`@modelcontextprotocol/sdk`, `zod`).

If pathfinding or memory eviction requires a data structure, implement it inline —
do not reach for lodash, immutable, or any utility library.

---

## File Structure After All Phases

```
src/
  index.ts       — tool registrations (all 35 tools)
  bridge.ts      — IPC, snapshots, sendQuery, waitForCondition, bridgeHealth
  game.ts        — launch, kill, integrity, saves
  config.ts      — path resolution
  memory.ts      — scratchpad, longterm, goals, session log
  navigation.ts  — navigate, interact, findPath (exported for tests)
  battle.ts      — battleAction, advanceDialogue
rgss/
  BlackSoulsBridge.rb   — bridge v1.8.0 with query support
scripts/
  smoke.mjs
  unit.mjs
  integration.mjs
  live_e2e.mjs          — DO NOT MODIFY
evals/
  runner.mjs
  scenarios/
    title_to_first_save.json
    basic_navigation.json
    first_battle.json
    first_dialogue.json
    menu_navigation.json
memory/                 — auto-created at runtime, gitignored
  scratchpad.json
  longterm.json
  goals.json
  session.log
AGENTS.md
SPEC.md                 — this file
```

---

## Version History Target

| Version | Phase | Key additions |
|---------|-------|---------------|
| 1.1.1 | baseline | 7 tools, basic IPC |
| 1.2.0 | Phase 1 | kill, save, load, situation (+4 tools) |
| 1.3.0 | Phase 2 | query IPC, variables, switches, inventory, party (+4 tools, bridge minor) |
| 1.4.0 | Phase 3 | memory system: scratchpad, longterm, goals (+8 tools) |
| 1.5.0 | Phase 4 | navigate, interact, battle, dialogue (+4 tools) |
| 1.6.0 | Phase 5 | full_map, event_detail, scene_detail (+3 tools, bridge minor) |
| 1.7.0 | Phase 6 | health, wait, session log (+4 tools) |
| 1.8.0 | Phase 7 | eval harness, eval_status (+1 tool) |

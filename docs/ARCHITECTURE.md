# Architecture

## Components

1. `src/` implements the local TypeScript MCP server.
2. `rgss/BlackSoulsBridge.rb` runs inside RGSS3 and serializes game state.
3. `BridgeRuntime` is a per-game-copy file transport with inbox, outbox, state, map, and info snapshots.
4. A launch token, process ID, protocol version, and frame number bind every response to one game generation.

## Data flow

```text
MCP client
  -> stdio request
  -> TypeScript validation
  -> BridgeRuntime/inbox/<command-id>.cmd
  -> RGSS3 frame loop
  -> BridgeRuntime/outbox/<command-id>.json
  -> structured MCP response
```

- The game writes state and map snapshots atomically.
- The MCP server selects the newest valid snapshot and skips malformed or foreign-generation files.
- Input commands contain only allowlisted action names, bounded repeat counts, and unique IDs.
- RGSS3 acknowledges a command only after it has passed through the normal `Input` loop.
- Old runtime directories are archived before a new launch.
- MCP failures use `isError: true` and a stable `structuredContent.data.error` object.

## Command limits

- At most 200 sequence entries.
- Action repeats are limited to 100; individual waits are limited to 600 frames.
- One sequence has a 3,600-frame processing budget.
- The TypeScript and RGSS3 sides both enforce the limits.
- The in-memory RGSS3 queue and pending command inbox are bounded at 128 commands.

If a timeout happens after RGSS3 has consumed the command file, execution may already have started. The timeout message states this explicitly; callers should inspect current state before retrying.

## Process and path binding

The launcher creates a random token before starting the prepared `Game.exe`. A bridge is considered connected only when:

- the process is still alive;
- bridge and state files use the expected protocol;
- process IDs match;
- launch tokens match; and
- the heartbeat is current.

If launch fails or the matching bridge does not appear before the deadline, the newly started process is terminated rather than left running in the background.

## Trust boundary

The service is local and uses `stdio`. `BridgeRuntime` and the prepared game copy are trusted local inputs. Do not point the server at a directory writable by untrusted users.

The Windows background wake path verifies both the process ID and full `Game.exe` path before posting messages to the game window. It does not simulate a mouse or expose a general process-control interface.

## Non-goals

- Screen or OCR automation.
- Direct mutation of game variables, inventory, health, or story flags.
- Distribution of game files or save data.
- Automatic game downloading or resource extraction.
- A network-accessible control API.

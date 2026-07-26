# black-souls-mcp

An MCP server that lets AI agents control and observe BLACK SOULS in real time.

Seven [Model Context Protocol](https://modelcontextprotocol.io/) tools give AI assistants (such as OpenAI Codex) the ability to launch the game, read scene and map state, inject keyboard input, and list save slots. Communication runs over a local file protocol — no network configuration or driver-level modifications required.

---

## How it works

```
AI assistant (Codex)
      │  MCP stdio
      ▼
black-souls-mcp server (Node.js)
      │  file protocol (BridgeRuntime/)
      ▼
BlackSoulsBridge.rb  ←  injected into Scripts.rvdata2
      │  per-frame hook on Scene_Base#update
      ▼
BLACK SOULS (RPG Maker VX Ace / RGSS3)
```

- **Server side (TypeScript)** — receives MCP calls, writes commands to `BridgeRuntime/inbox/` inside the game directory, and reads responses and state snapshots from `BridgeRuntime/outbox/` and `BridgeRuntime/state/`.
- **Game side (RGSS3 Ruby)** — the bridge script runs once per frame, writes state and map snapshots, and reads and executes commands from the inbox.
- **Security design** — commands carry a per-launch token to prevent cross-session replay; input actions are restricted to an allowlist; command queue depth and total sequence frames are bounded.

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| OS | Windows (bridge uses Win32 API and PowerShell) |
| Node.js | 18 or later |
| Python | 3.x (patching tools only) |
| Game | A dedicated MCP copy of BLACK SOULS, separate from the Steam installation |

> **Important**: prepare an independent copy of the game for MCP use. Do not patch the original Steam files.

---

## Quick start

### 1. Install dependencies and build

```powershell
npm ci
npm run build
```

### 2. Prepare the game files

Place a **dedicated copy** of BLACK SOULS under `runtime\game\` (or anywhere; set environment variables to point to it later).

The directory must contain:

```
runtime\game\
  Game.exe
  Game.ini
  Game.rgss3a          ← original asset archive (keep untouched)
  Data\Scripts.rvdata2 ← the bridge script will be injected here
```

### 3. Inject the bridge script

**Option A: binary patcher (recommended, no extra Python packages)**

Rename `Game.rgss3a` to `Game.rgss3a~` to preserve the original, then extract the scripts archive from it:

```powershell
python scripts\extract_rgss3a_file.py `
    runtime\game\Game.rgss3a~ `
    "Data/Scripts.rvdata2" `
    runtime\game\Data\Scripts.rvdata2
```

Inject the bridge:

```powershell
python scripts\patch_rvdata2_binary.py `
    runtime\game\Data\Scripts.rvdata2 `
    rgss\BlackSoulsBridge.rb `
    --title Main `
    --backup runtime\game\Data\Scripts.rvdata2.bak
```

**Option B: rubymarshal patcher**

```powershell
pip install -r requirements-tools.txt

python scripts\patch_rvdata2.py `
    runtime\game\Data\Scripts.rvdata2 `
    rgss\BlackSoulsBridge.rb `
    --title Main `
    --backup runtime\game\Data\Scripts.rvdata2.bak
```

### 4. Register with Codex

```powershell
.\install.ps1
```

The script writes the MCP server block into `~\.codex\config.toml` and backs up the previous config automatically.

**Custom paths:**

```powershell
.\install.ps1 -RuntimeRoot "D:\bs-mcp\runtime" -GameDir "D:\bs-mcp\runtime\game"
```

### 5. Verify the installation

```powershell
.\check.ps1 -IncludeRuntime
```

Restart Codex to load the server.

---

## MCP tools

| Tool | Type | Description |
|------|------|-------------|
| `black_souls_status` | read-only | Server version, game file integrity, and bridge connection status |
| `black_souls_launch` | write | Launch the game and wait for the bridge to become ready (default timeout 12 s) |
| `black_souls_get_state` | read-only | Current scene, player position, party, message window, and battle state |
| `black_souls_get_map` | read-only | Map tiles and events within a 6-tile radius of the player |
| `black_souls_input` | write | Inject a single allowlisted input action (repeat up to 100 times) |
| `black_souls_input_sequence` | write | Inject an ordered sequence of up to 200 steps (actions and frame waits) |
| `black_souls_list_saves` | read-only | List save slots and metadata for the independent game copy |

### Allowed input actions

`move_up` · `move_down` · `move_left` · `move_right` · `confirm` · `cancel` · `open_menu` · `page_up` · `page_down` · `dash`

### Limits

| Item | Limit |
|------|-------|
| Single action repeat | 100 |
| Sequence steps | 200 |
| Sequence total frames | 3 600 |
| Command queue depth | 128 |

---

## Configuration

Set these environment variables, or place them in the `[mcp_servers.black_souls.env]` section of the Codex config:

| Variable | Description | Default |
|----------|-------------|---------|
| `BLACK_SOULS_ROOT` | Runtime root directory | `runtime/` under the repository |
| `BLACK_SOULS_DIR` | Game directory | `$BLACK_SOULS_ROOT/game` |
| `BLACK_SOULS_GAME_EXE_SHA256` | Expected SHA-256 of `Game.exe` for integrity checks | Built-in known hash |
| `BLACK_SOULS_EXPECTED_SAVE_COUNT` | Save count the integration test expects to find | `0` |

See `examples/env.example` and `examples/codex-config.toml` for sample configurations.

---

## Development

```powershell
# Build + smoke test + unit tests (required before every PR)
npm run check

# Type-check only
npm run typecheck

# Integration tests (requires a prepared runtime directory)
npm run test:integration

# Live end-to-end tests (launches the game and sends real input)
npm run test:live

# Source + runtime + Codex registration all-in-one check
.\check.ps1 -IncludeRuntime
```

---

## Uninstall / rollback

**Uninstall** (removes the Codex registration only; game and save files are untouched):

```powershell
.\uninstall.ps1
```

**Roll back to the pre-install Codex config:**

```powershell
.\rollback.ps1
```

Backups are stored in `runtime\backup\` with timestamped names.

---

## Security

This server is designed as a local `stdio` service for a local AI assistant. Wrapping it as a network service requires adding authentication, access controls, and rate limiting.

Report security issues privately via [GitHub Security Advisories](https://github.com/yk4464/black-souls-mcp/security/advisories/new). See [SECURITY.md](SECURITY.md) for details.

---

## License

[MIT](LICENSE) · by [yk4464](https://github.com/yk4464)

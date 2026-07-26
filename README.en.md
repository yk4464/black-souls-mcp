# BLACK SOULS MCP

[简体中文](README.md) · [English](README.en.md)

[![CI](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local MCP server that lets an AI agent operate **BLACK SOULS (RPG Maker VX Ace / RGSS3)** directly. It reads live game state and injects allowlisted keypresses through the game's own input loop — no screenshots, no mouse emulation, no network service.

> [!IMPORTANT]
> This repository contains only the MCP server and bridge source code. It does not contain, download, or redistribute the game, saves, assets, or extracted commercial data. You must provide your own lawfully obtained copy of the game.

## How it works

```
MCP client (Codex, etc.)
    │ stdio
    ▼
Node.js / TypeScript server
    │ atomic file writes + launch token
    ▼
BridgeRuntime/ (inside the game directory)
    │ RGSS3 Input and game objects
    ▼
Your independent BLACK SOULS copy
```

An RGSS3 script embedded in the game runs once per frame, writing state snapshots at roughly 10 Hz. Map snapshots are only emitted when the map or player position changes. Input commands are processed by the game thread one frame at a time, with no dependency on window focus.

## MCP tools

| Tool | Purpose |
|------|---------|
| `black_souls_status` | Check game files, process health, and bridge state |
| `black_souls_launch` | Launch the independent game copy and wait for the bridge |
| `black_souls_get_state` | Read scene, player, party, messages, menus, and battle state |
| `black_souls_get_map` | Read nearby tiles, passability, and events |
| `black_souls_input` | Send one allowlisted keyboard action |
| `black_souls_input_sequence` | Send up to 200 ordered actions and frame waits |
| `black_souls_list_saves` | List save slots in the independent copy |

## Prerequisites

- Windows 10/11
- Node.js 18+
- A lawfully obtained copy of BLACK SOULS
- Python 3.11+ (only needed to patch the bridge script into the game data)

## Quick start

### 1. Clone and build

```powershell
git clone https://github.com/yk4464/black-souls-mcp.git
Set-Location .\black-souls-mcp
npm.cmd ci
npm.cmd run check
```

### 2. Prepare an independent runtime directory

```
runtime/
├─ game/
│  ├─ Game.exe
│  ├─ Game.ini
│  ├─ Game.rgss3a~          ← original archive backup
│  └─ Data/Scripts.rvdata2  ← patched with the bridge script
└─ backup/
```

`runtime/` is gitignored. See [docs/SETUP.zh-CN.md](docs/SETUP.zh-CN.md) for the full copy-preparation and bridge-patching procedure.

### 3. Register with Codex

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

For an external runtime directory:

```powershell
.\install.ps1 -RuntimeRoot 'D:\BlackSoulsRuntime' -GameDir 'D:\BlackSoulsRuntime\game'
```

The installer backs up your current Codex `config.toml` before writing the `black_souls` MCP registration block. Restart Codex afterward.

### 4. Verify

```
black_souls_status    → check files and bridge state
black_souls_launch    → start the game
black_souls_get_state → read current game state
```

Sequence input example:

```json
{
  "steps": [
    { "action": "move_up" },
    { "wait_frames": 12 },
    { "action": "confirm" }
  ]
}
```

## Game executable fingerprint

Get the SHA-256 of your copy's `Game.exe`:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath '.\runtime\game\Game.exe').Hash
```

Set it for the current shell (or add it to `.env`):

```powershell
$env:BLACK_SOULS_GAME_EXE_SHA256 = '<YOUR_SHA256>'
```

Leaving this empty skips fingerprint verification but still checks that required files are present.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BLACK_SOULS_ROOT` | `<repo>/runtime` | Runtime root directory |
| `BLACK_SOULS_DIR` | `{ROOT}/game` | Independent game directory |
| `BLACK_SOULS_GAME_EXE_SHA256` | Built-in value | `Game.exe` SHA-256; empty string skips check |
| `BLACK_SOULS_TEST_TEMP` | System temp | Temporary directory for unit tests |
| `BLACK_SOULS_EXPECTED_SAVE_COUNT` | (none) | Minimum save count for integration tests |

## Tests

```powershell
npm.cmd run check              # build + MCP handshake + synthetic unit tests (run before every PR)
npm.cmd run test:integration   # requires a prepared runtime directory
npm.cmd run test:live          # launches the game and sends real keyboard input
.\check.ps1 -IncludeRuntime    # verify source, game copy, and Codex registration together
```

Live tests (`test:live`) move the player and open menus but do not intentionally save. Keep a save backup before running them.

## Uninstall and rollback

```powershell
.\uninstall.ps1   # remove the registration block from config.toml
.\rollback.ps1    # restore the most recent pre-install backup
```

These scripts only manage Codex registration and config backups; they do not delete game files or saves.

To restore a specific backup:

```powershell
.\rollback.ps1 -ConfigBackup 'D:\BlackSoulsRuntime\backup\config.toml.before-black-souls-....bak'
```

## Security

- Local `stdio` only; no network port is opened.
- Allowlisted input actions with hard limits on queue depth, sequence steps, and total frame budget.
- Game files, saves, runtime snapshots, logs, and dependency caches are gitignored.
- Remove personal paths, save contents, and game files before filing an issue.

Report security issues privately via [GitHub Security Advisory](https://github.com/yk4464/black-souls-mcp/security/advisories/new). Use [Issues](https://github.com/yk4464/black-souls-mcp/issues) for everything else.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `private: true` in `package.json` prevents accidental npm publication; it does not make the MIT-licensed GitHub source private.

## License

Source code is available under the [MIT License](LICENSE). BLACK SOULS, RPG Maker, and related names and assets belong to their respective owners. This is an unofficial community project with no affiliation to the game's creators, publisher, or engine vendor.

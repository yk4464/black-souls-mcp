# BLACK SOULS MCP

[简体中文](README.md) · [English](README.en.md)

[![CI](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local Model Context Protocol bridge for **BLACK SOULS / RPG Maker VX Ace (RGSS3)**. It reads in-engine state and sends allowlisted keyboard actions through the game's normal input loop. It does not require screenshots, mouse emulation, or a network service.

> [!IMPORTANT]
> This repository contains bridge and MCP source code only. It does not contain, download, or redistribute the game, saves, assets, keys, or extracted commercial game data. Users must provide their own lawfully obtained game files.

## Status

- Platform: Windows 10/11
- Transport: local `stdio`
- Engine: RPG Maker VX Ace / RGSS3
- Distribution: source installation; no npm package is currently published
- Game versions: one development-tested `Game.exe` fingerprint is built in; other versions can use a user-supplied fingerprint

## Features

- Read scene, map, position, direction, and passability.
- Read nearby events, messages, choices, and active windows.
- Read party members, levels, HP, MP, states, and gold.
- Read battle phase, battlers, and active battle commands.
- Send movement, confirm, cancel, menu, page, dash, and ordered action sequences.
- Reject stale state and duplicate commands using process, launch-generation, frame, and command identifiers.
- Recover from malformed snapshots and wake a paused background keyboard loop without foreground activation.

Actions still pass through the game's own movement, event, menu, and battle logic. The API does not directly modify health, inventory, variables, or story flags.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `black_souls_status` | Inspect prepared files, the game process, and bridge health. |
| `black_souls_launch` | Launch the prepared independent game copy. |
| `black_souls_get_state` | Read scene, player, party, message, menu, and battle state. |
| `black_souls_get_map` | Read nearby tiles, passability, and events. |
| `black_souls_input` | Send one allowlisted keyboard action. |
| `black_souls_input_sequence` | Submit ordered actions and frame waits. |
| `black_souls_list_saves` | List saves in the independent game copy. |

## Architecture

```text
MCP client
    │ stdio
    ▼
Node.js / TypeScript server
    │ atomic files + launch token
    ▼
BridgeRuntime
    │ RGSS3 Input and game objects
    ▼
User-prepared independent BLACK SOULS copy
```

State is refreshed at roughly 10 Hz. Map snapshots are emitted only when the map or player position changes. Commands are processed by the game thread one frame at a time. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Prerequisites

1. Windows 10/11.
2. Node.js 18 or newer.
3. Your own BLACK SOULS game copy.
4. Python 3.11+ for the bridge patching utility.
5. A `Data/Scripts.rvdata2` prepared from your own copy. This project does not automate game downloading or resource extraction.

## Quick start

### 1. Clone and verify the source

```powershell
git clone https://github.com/yk4464/black-souls-mcp.git
Set-Location .\black-souls-mcp
npm.cmd ci
npm.cmd run check
```

### 2. Prepare an independent runtime

The default layout is:

```text
runtime/
├─ game/
│  ├─ Game.exe
│  ├─ Game.ini
│  ├─ Game.rgss3a~
│  └─ Data/Scripts.rvdata2
└─ backup/
```

`runtime/` is ignored by Git. Follow [docs/SETUP.zh-CN.md](docs/SETUP.zh-CN.md) for the current preparation and bridge-patching procedure.

### 3. Register with Codex

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

For an external runtime:

```powershell
.\install.ps1 `
  -RuntimeRoot 'D:\BlackSoulsRuntime' `
  -GameDir 'D:\BlackSoulsRuntime\game'
```

The installer backs up the current user's Codex `config.toml` before writing the `black_souls` MCP registration. Restart Codex afterward.

### 4. Verify and use

Call `black_souls_status` first, then `black_souls_launch`, `black_souls_get_state`, and `black_souls_get_map`.

Example sequence arguments:

```json
{
  "steps": [
    { "action": "move_up" },
    { "wait_frames": 12 },
    { "action": "confirm" }
  ]
}
```

## Game fingerprint

Calculate the SHA-256 value for your own executable:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath '.\runtime\game\Game.exe').Hash
```

Set it for the current shell:

```powershell
$env:BLACK_SOULS_GAME_EXE_SHA256 = '<YOUR_SHA256>'
```

An empty value skips fingerprint comparison but still checks required files. Do this only after confirming the origin of the game files.

## Tests

```powershell
npm.cmd run check              # build, MCP handshake, discovery, synthetic tests
npm.cmd run test:integration   # requires a prepared runtime
npm.cmd run test:live          # launches the game and sends real keyboard input
.\check.ps1 -IncludeRuntime    # source, runtime, and Codex registration checks
```

Live tests can change the current session's position or menu state but do not intentionally save. Keep your own save backup before running them.

## Limitations

- Game extraction and resource preparation vary by release and are not automated.
- RPG Maker may pause input while in the background. The bridge posts messages only to a verified process and executable path; it does not emulate a mouse or bring the window to the foreground.
- If a timeout says the game may already have consumed a command, read current state before retrying.
- `BridgeRuntime` and the prepared game directory must remain trusted local paths.

## Uninstall and rollback

```powershell
.\uninstall.ps1
.\rollback.ps1
```

These scripts only manage Codex registration and configuration backups. They do not delete games or saves.

## Security and privacy

- Local `stdio` only; no listening port.
- Allowlisted actions with queue, step, and total-frame limits.
- Game data, saves, runtime snapshots, logs, dependencies, and build outputs are ignored by Git.
- Remove personal paths, save contents, and game files before filing an issue.

Report security problems privately through [GitHub Security Advisories](https://github.com/yk4464/black-souls-mcp/security/advisories/new). Use [Issues](https://github.com/yk4464/black-souls-mcp/issues) for other reports.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `private: true` is intentionally kept in `package.json` to prevent accidental npm publication; it does not make the MIT-licensed GitHub source private.

## License and trademarks

Source code in this repository is available under the [MIT License](LICENSE). BLACK SOULS, RPG Maker, related names, and game assets belong to their respective owners. This is an unofficial community project and is not affiliated with the game's creators, publisher, or engine vendor.

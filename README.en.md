# BLACK SOULS MCP

[简体中文](README.md) · [English](README.en.md)

[![CI](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml) [![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/yk4464/black-souls-mcp/blob/main/LICENSE)

An MCP tool for BLACK SOULS. Put plainly, with no detours: it lets agent tools like Claude Code or Codex hook into BLACK SOULS.
Purely for fun. The idea is simple — read the game's internal objects to get state, then feed actions into the game's own key input loop. No screenshots, no mouse simulation, and no vision model, so non-multimodal models work fine.

> [!IMPORTANT]
> This repository contains only the bridge program and MCP source. It does not include, download, or distribute the game itself, saves, assets, keys, or unpacked commercial game data. Prepare your own legally obtained game files before use.

## What can it do?

Once connected, an MCP client can read:

- Scene, map, coordinates, facing, passability
- Nearby events, messages, choice menus
- Party level, HP, MP, states, gold
- Battle phase, units on both sides, currently available commands

It can also drive the character: move, confirm, cancel, page, dash, or submit a whole run of consecutive actions at once — for example "walk forward three steps, then open the menu and check equipment".

Input goes only through the game's own movement / event / menu / battle handling. The interface never writes HP, items, variables, or story switches directly. Commands carry a process ID, launch generation, frame number, and command number, so stale state and duplicate commands are rejected; corrupt snapshots are skipped automatically. When RPG Maker suspends the game in the background, the bridge can resume the keyboard loop without stealing the foreground window.

## How does it compare to screenshot OCR and mouse simulation?

| | Screenshot / OCR | Mouse simulation | BLACK SOULS MCP |
|---|---|---|---|
| State source | Image recognition, easy to misread or miss | Image recognition | Reads game objects directly, frame-accurate |
| Needs window on top / foreground | Usually yes | Yes | No, resumes the input loop in the background |
| Network required | Often needs a vision model service | Depends on implementation | Local stdio only, no ports opened |
| Input path | Simulated clicks / keystrokes | Simulated clicks | Native game input loop, frame-synced |
| Risk of corrupting saves / story | Depends on implementation | Depends on implementation | Never writes HP, items, variables, or story switches directly |

More accurate, faster, less likely to derail, and no multimodal model needed

## MCP tools

36 tools in total, grouped by purpose:

| Group | Tools | Purpose |
|---|---|---|
| Process & diagnostics | `black_souls_status` · `black_souls_launch` · `black_souls_kill` · `black_souls_list_saves` · `black_souls_health` | Check game files and bridge, launch or force-quit the game, list saves, one-call self-diagnosis with a recovery recommendation |
| State reading | `black_souls_get_state` · `black_souls_get_map` · `black_souls_situation` · `black_souls_get_full_map` · `black_souls_get_event` · `black_souls_get_scene_detail` | Scene, characters, messages, menus, battle; nearby or wide-range map; event pages and trigger conditions; deeper scene state |
| Game data | `black_souls_get_variables` · `black_souls_get_switches` · `black_souls_get_inventory` · `black_souls_get_party_detail` | Variables, switches, inventory and equipment, detailed party stats and skills |
| Input | `black_souls_input` · `black_souls_input_sequence` · `black_souls_wait` | Allowlisted keyboard actions, multi-step sequences, waiting for a game condition |
| High-level actions | `black_souls_navigate` · `black_souls_interact` · `black_souls_battle_options` · `black_souls_battle_action` · `black_souls_advance_dialogue` · `black_souls_save` · `black_souls_load` | Automatic pathfinding, walk-up-and-interact, a full listing of every choice available this turn (including each skill and magic submenu entry with its cost and whether it is usable), one-call battle turns (attack / skill / magic / guard / item / flee), dialogue advancing with choice selection, disk-verified saving and loading; all menu navigation is closed-loop against the real cursor and calibrated on the real game |
| AI memory | `black_souls_scratchpad_read/write` · `black_souls_memory_read/write/delete` · `black_souls_goals_read/write/set_active` · `black_souls_session_log_append/read` | Session scratchpad, long-term game knowledge, goal hierarchy, persistent session log — all survive context resets |
| Evals | `black_souls_eval_status` | Scenario completion checks for `evals/runner.mjs` |

## How it works

```
MCP client
    │ stdio
    ▼
Node.js / TypeScript service
    │ atomic files + launch token
    ▼
BridgeRuntime
    │ RGSS3 Input and game objects
    ▼
Your prepared standalone BLACK SOULS copy
```

The bridge script refreshes state roughly 10 times per second; a new map snapshot is generated only when the position or map changes. Commands are processed frame by frame by the game's main thread, independent of window focus and of visual recognition. Query commands (variables, switches, inventory, full map, and so on) travel the same channel and are answered instantly without frame stepping.

## Project status

| | |
|---|---|
| Platform | Windows 10/11 |
| Transport | Local `stdio` |
| Supported engine | RPG Maker VX Ace / RGSS3 |
| Distribution | Install from source; no npm package published yet |
| Game version | Ships one `Game.exe` fingerprint verified during development; other versions can be configured |

## Before you start

You will need:

1. Windows 10/11
2. Node.js 18 or newer
3. Your own copy of BLACK SOULS
4. Python 3.11+ (only for the bridge script writing tools)
5. `Data/Scripts.rvdata2` prepared from your own copy; this project never downloads or unpacks game assets for you

## Quick start

### 1. Get the source and check it

```powershell
git clone https://github.com/yk4464/black-souls-mcp.git
Set-Location .\black-souls-mcp
npm.cmd ci
npm.cmd run check
```

### 2. Prepare the standalone runtime directory

Default layout:

```
runtime/
├─ game/
│  ├─ Game.exe
│  ├─ Game.ini
│  ├─ Game.rgss3a~
│  └─ Data/Scripts.rvdata2
└─ backup/
```

`runtime/` is Git-ignored. Preparation in short: copy your own game files into `runtime/game/`, make sure `Data/Scripts.rvdata2` is extracted (use `scripts/extract_rgss3a_file.py` if needed), then inject `rgss/BlackSoulsBridge.rb` into the script archive:

```powershell
python .\scripts\patch_rvdata2_binary.py .\runtime\game\Data\Scripts.rvdata2 .\rgss\BlackSoulsBridge.rb --backup .\runtime\backup\Scripts.rvdata2.bak
```

`patch_rvdata2_binary.py` uses only the Python standard library and preserves the original byte layout; prefer it. The alternative `patch_rvdata2.py` requires `python -m pip install -r requirements-tools.txt` first.

### 3. Install into Codex

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

Using an external directory:

```powershell
.\install.ps1 `
  -RuntimeRoot 'D:\BlackSoulsRuntime' `
  -GameDir 'D:\BlackSoulsRuntime\game'
```

The install script first backs up the current user's Codex `config.toml`, then writes the `black_souls` MCP registration. Restart Codex when it finishes.

### 4. Verify

After restarting Codex, start with:

```
Call black_souls_status and check the game files and bridge status.
```

Then you can call, in order:

```
black_souls_launch
black_souls_get_state
black_souls_get_map
```

Example arguments for a consecutive action run:

```json
{
  "steps": [
    { "action": "move_up" },
    { "wait_frames": 12 },
    { "action": "confirm" }
  ]
}
```

## Game version fingerprint

Get the SHA-256 of your own `Game.exe`:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath '.\runtime\game\Game.exe').Hash
```

Then set it in the current terminal:

```powershell
$env:BLACK_SOULS_GAME_EXE_SHA256 = '<YOUR_SHA256>'
```

Setting it to an empty string skips the fingerprint comparison but still checks that the required files exist. Only do this once you are confident about where your game files came from.

## Environment variables

| Variable | Description |
|---|---|
| `BLACK_SOULS_ROOT` | Runtime directory; defaults to `<repo>/runtime` |
| `BLACK_SOULS_DIR` | The prepared standalone game directory |
| `BLACK_SOULS_GAME_EXE_SHA256` | Optional `Game.exe` checksum |
| `BLACK_SOULS_TEST_TEMP` | Temporary directory for unit tests |
| `BLACK_SOULS_EXPECTED_SAVE_COUNT` | Optional minimum save count for integration tests |

## Testing

```powershell
npm.cmd run check              # Build, MCP handshake, tool discovery, and synthetic tests
npm.cmd run test:integration   # Requires a prepared runtime directory
npm.cmd run test:live          # Launches the game and performs real keyboard input
.\check.ps1 -IncludeRuntime    # Checks source, game copy, and Codex registration
node evals\runner.mjs menu_navigation   # Run one eval scenario (requires the real game)
```

Live tests change the position or menu state of the current game session, but never save on their own. Keeping a copy of your own saves before running them is still recommended.

## Limitations and troubleshooting

- Asset preparation and unpacking depend on the release you own, so there is no automated download flow
- RPG Maker may suspend the keyboard loop in the background; the service resumes it with a Windows message after verifying the process and path, without simulating the mouse or bringing the window to the foreground
- If a command times out and reports that "the game may already have received it", read the latest state first before deciding whether to retry, to avoid duplicate actions
- This project targets local trusted directories only; do not place `BridgeRuntime` somewhere other users can write

## Uninstall and rollback

```powershell
.\uninstall.ps1
.\rollback.ps1
```

Both touch only the Codex registration and its config backups; neither deletes the game or saves. To roll back to a specific backup:

```powershell
.\rollback.ps1 -ConfigBackup 'D:\BlackSoulsRuntime\backup\config.toml.before-black-souls-....bak'
```

## Security and privacy

- The service uses local `stdio` only and never listens on a network port
- Command actions use a fixed allowlist, with limits on the queue, steps, and total frames
- The repository ignores game files, saves, runtime snapshots, logs, dependency caches, and build output
- Remove personal paths, save contents, and game files before filing an issue

Report security problems privately via [GitHub Security Advisory](https://github.com/yk4464/black-souls-mcp/security/advisories/new); use [Issues](https://github.com/yk4464/black-souls-mcp/issues) for everything else.

## Contributing

Please read [CONTRIBUTING.md](https://github.com/yk4464/black-souls-mcp/blob/main/CONTRIBUTING.md) first. `package.json` keeps `private: true` to prevent accidental npm publishing; this does not affect the MIT-licensed open source on GitHub.

## License and disclaimer

The source in this repository is under the [MIT License](https://github.com/yk4464/black-souls-mcp/blob/main/LICENSE).

BLACK SOULS, RPG Maker, related names, and game assets belong to their respective rights holders. This is an unofficial community tool with no affiliation to the game's authors, publishers, or the engine vendor.

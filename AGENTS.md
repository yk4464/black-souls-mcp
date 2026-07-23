# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the strict TypeScript MCP server: `index.ts` defines the public tools and stable response envelope; `bridge.ts` owns the versioned file protocol, snapshot validation, input queue, and runtime lifecycle; `config.ts` resolves environment-controlled paths; and `game.ts` handles game discovery, integrity and save metadata, and process launch. Compiled output goes to `dist/` and should not be edited. The in-game RGSS3 component is `rgss/BlackSoulsBridge.rb`. Keep server/package versions, `BRIDGE_PROTOCOL`, action names, and command limits synchronized across the TypeScript and RGSS3 sides. Test and maintenance utilities live in `scripts/`; PowerShell setup, verification, rollback, and uninstall entry points remain at the repository root. Keep architecture and setup details in `docs/`, sample configuration in `examples/`, and evaluation data in `evals/`. `runtime/` is local generated state and must stay untracked.

## Build, Test, and Development Commands

- `npm.cmd ci` installs the exact locked dependencies (Node.js 18+).
- `npm.cmd run build` cleans `dist/` and compiles TypeScript.
- `npm.cmd run typecheck` checks types without emitting files.
- `npm.cmd run check` builds, performs the MCP smoke test, and runs synthetic unit tests; run this before every PR.
- `npm.cmd test` runs smoke and synthetic unit tests against the existing `dist/`; build first when running it directly.
- `npm.cmd start` starts the compiled stdio server after a build.
- `npm.cmd run test:integration` exercises a prepared local runtime and also requires a current `dist/` build.
- `npm.cmd run test:live` launches the game from the current `dist/` build and sends real input; it may load a save, move the player, and open menus, so document its scope and result.
- `.\check.ps1 -IncludeRuntime` verifies source, runtime, and Codex registration together.

## Coding Style & Naming Conventions

Follow `.editorconfig`: UTF-8, two-space indentation, final newlines, and LF endings, except CRLF for `.ps1`. TypeScript uses ES modules, ES2022, and strict mode. Use `camelCase` for functions and variables, `PascalCase` for types/classes, and `UPPER_SNAKE_CASE` for constants. Keep modules focused and preserve established error and structured-response shapes. No formatter or linter is configured, so use `npm.cmd run typecheck` and match neighboring code.

## Testing Guidelines

Tests use `node:assert/strict` in `scripts/smoke.mjs` and `scripts/unit.mjs`. Add deterministic, synthetic cases to `unit.mjs`; update the smoke test for MCP handshake or tool-discovery changes. The seven `black_souls_*` tools, their input bounds and annotations, and the `structuredContent.data` / `isError` response shape are public behavior; update smoke tests, README or architecture documentation, and version identifiers when changing them. Run integration tests for tool discovery, status, save-listing, or prepared-runtime changes. Run live tests for launch, state or map snapshots, input, sequencing, or Windows wake changes. There is no numeric coverage threshold, but behavior changes require regression coverage.

## Commit & Pull Request Guidelines

History uses short, sentence-style summaries such as `Update GitHub Actions runtime`; keep each commit focused and reviewable. Open an issue before large changes. PRs must explain what changed and why, list validation performed, and update README, architecture docs, or `CHANGELOG.md` for behavior changes. Never commit game files, extracted data, saves, `BridgeRuntime`, logs, tokens, dependency folders, or personal paths.

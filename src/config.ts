import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ROOT = path.join(projectRoot, "runtime");
export function installRoot(): string { return process.env.BLACK_SOULS_ROOT || DEFAULT_ROOT; }
export function gameDir(): string { return process.env.BLACK_SOULS_DIR || path.join(installRoot(), "game"); }
export function gameExe(): string { return path.join(gameDir(), "Game.exe"); }

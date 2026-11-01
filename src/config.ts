import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ROOT = path.join(projectRoot, "runtime");
export function installRoot(): string { return process.env.BLACK_SOULS_ROOT || DEFAULT_ROOT; }

// 两部作品共用同一个 installRoot，但各自有独立的游戏副本、指纹和记忆目录。
// bs1 的环境变量名与默认目录保持原样，已有安装无需迁移。
export const GAME_IDS = ["bs1", "bs2"] as const;
export type GameId = typeof GAME_IDS[number];
interface GameProfile {
  title: string;
  defaultDirName: string;
  dirEnv: string;
  hashEnv: string;
  knownExeSha256: string;
  memoryDirName: string;
}
export const GAME_PROFILES: Record<GameId, GameProfile> = {
  bs1: {
    title: "BLACK SOULS",
    defaultDirName: "game",
    dirEnv: "BLACK_SOULS_DIR",
    hashEnv: "BLACK_SOULS_GAME_EXE_SHA256",
    knownExeSha256: "E4447454C551B96C833E7ED4C7114F807C86FE32F0757C206BEDDA94AC85BC2B",
    memoryDirName: "memory",
  },
  bs2: {
    title: "BLACK SOULS II",
    defaultDirName: "game2",
    dirEnv: "BLACK_SOULS2_DIR",
    hashEnv: "BLACK_SOULS2_GAME_EXE_SHA256",
    knownExeSha256: "45DD547893F7CCC3D58A045612C1C265313644D390EFF28C8B13684A06EA2BAC",
    memoryDirName: "memory-bs2",
  },
};

export const isGameId = (value: unknown): value is GameId => typeof value === "string" && (GAME_IDS as readonly string[]).includes(value);

const selectionFile = () => path.join(installRoot(), "active_game.txt");
let cachedGame: GameId | null = null;

function gameDirFor(id: GameId): string {
  const profile = GAME_PROFILES[id];
  return process.env[profile.dirEnv] || path.join(installRoot(), profile.defaultDirName);
}

// 选择顺序：持久化的选择 > BLACK_SOULS_GAME 环境变量 > bs1。
// 持久化让 MCP 服务器重启后仍指向正在运行的那一代，而不是悄悄换回默认值。
function resolveActiveGame(): GameId {
  try {
    const stored = fs.readFileSync(selectionFile(), "ascii").trim();
    if (isGameId(stored)) return stored;
    if (stored) console.error(`config: ignoring unrecognized game selection "${stored}" in ${selectionFile()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`config: could not read ${selectionFile()}: ${(error as Error).message}`);
  }
  const fromEnv = process.env.BLACK_SOULS_GAME?.trim();
  if (isGameId(fromEnv)) return fromEnv;
  if (fromEnv) console.error(`config: ignoring BLACK_SOULS_GAME="${fromEnv}"; expected one of ${GAME_IDS.join(", ")}`);
  return "bs1";
}

export function activeGame(): GameId {
  if (cachedGame === null) cachedGame = resolveActiveGame();
  return cachedGame;
}

export function setActiveGame(id: GameId): void {
  fs.mkdirSync(installRoot(), { recursive: true });
  const target = selectionFile();
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${id}\n`, "ascii");
  fs.renameSync(temp, target);
  cachedGame = id;
}

export function gameProfile(id: GameId = activeGame()): GameProfile { return GAME_PROFILES[id]; }
export function gameDir(id: GameId = activeGame()): string { return gameDirFor(id); }
export function gameExe(id: GameId = activeGame()): string { return path.join(gameDir(id), "Game.exe"); }
export function memoryDir(id: GameId = activeGame()): string { return path.join(installRoot(), GAME_PROFILES[id].memoryDirName); }

// 空字符串表示跳过指纹比较（沿用 bs1 原有语义）；未设置时使用内置的已知指纹。
export function expectedExeSha256(id: GameId = activeGame()): string {
  const profile = GAME_PROFILES[id];
  return (process.env[profile.hashEnv] ?? profile.knownExeSha256).trim().toUpperCase();
}

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**black-souls-mcp** 是一个本地 stdio MCP 服务器，让 AI 模型能通过标准的 MCP 工具与正在运行的 BLACK SOULS（RPG Maker VX Ace / RGSS3）游戏交互。服务器与游戏之间的通信完全基于文件系统（无网络、无 socket）。

## 常用命令

本项目只在 Windows 上开发运行。在 bash/PowerShell 中请使用 `npm.cmd` 而非 `npm`。

```bash
# 提交 PR 前的标准命令：清理 + 构建 + smoke + unit
npm.cmd run check

# 单独构建（清理 dist/ 后编译 TypeScript）
npm.cmd run build

# 仅类型检查，不输出文件
npm.cmd run typecheck

# 只跑 smoke + unit（依赖已有的 dist/，改了源码要先 build）
npm.cmd test

# 单独跑某一层测试
node scripts/smoke.mjs        # MCP 握手 / 工具发现 / 错误封装
node scripts/unit.mjs         # 临时目录内的合成文件 IPC 测试
npm.cmd run test:integration  # 需要已准备好的 runtime/game
npm.cmd run test:live         # 会真的启动游戏并发送键盘输入

# 源码 + 游戏副本 + Codex 注册的整体校验
.\check.ps1 -IncludeRuntime

# 手动调用某个 MCP 工具（调试用）
node scripts/call_tool.mjs black_souls_status '{}'
node scripts/call_tool.mjs black_souls_input '{"action":"confirm"}'
```

CI（`.github/workflows/ci.yml`）在 windows-latest + Node 18/22 上运行 `npm run check`、`npm audit --audit-level=high` 和 `npm pack --dry-run`。

### Python 维护脚本

只在需要把 bridge 脚本写进游戏数据时使用，不参与日常构建：

```bash
pip install -r requirements-tools.txt  # rubymarshal==1.2.10

# 从 RGSSAD v3 归档中取出单个文件（支持 SHA-256 校验）
python scripts/extract_rgss3a_file.py Game.rgss3a~ Data/Scripts.rvdata2 out.rvdata2

# 把 rgss/BlackSoulsBridge.rb 写入 Scripts.rvdata2
python scripts/patch_rvdata2_binary.py Scripts.rvdata2 rgss/BlackSoulsBridge.rb --title Main
```

`patch_rvdata2_binary.py` 是保留原字节布局的实现，优先使用它；`patch_rvdata2.py` 是基于 rubymarshal 的备选实现。

## 架构

### 源码结构（`src/`）

| 文件 | 职责 |
|------|------|
| `index.ts` | MCP 服务器入口，注册全部 7 个工具，处理错误格式化 |
| `bridge.ts` | 与运行中游戏的全部文件 IPC 逻辑（读写、健康检查、命令发送） |
| `game.ts` | 游戏启动、存档列表、可执行文件完整性校验 |
| `config.ts` | 路径配置，通过环境变量覆盖 |

### 文件系统 IPC 协议

游戏内嵌的 RGSS3 bridge 脚本在游戏目录下持续写入 `BridgeRuntime/` 目录：

```
BridgeRuntime/
  info/       info-{n}.json       游戏进程元数据（PID、协议版本、launch token）
  state/      state-{n}.json      每帧状态快照（场景、玩家位置、战斗等）
  map/        map-{n}.json        地图格子与事件快照
  inbox/      {uuid}.cmd          MCP 写入的待执行命令（纯文本格式）
  outbox/     {uuid}.json         游戏写入的命令执行结果
  launch.token                    当前启动 token
```

**健康检查**（`bridgeStatus`）验证五个条件全部满足才视为 connected：协议版本一致、launch token 一致、PID 一致、进程存活、心跳时间戳在 60 秒以内。

**命令发送**（`sendSequence`）：将步骤编码为 `action:repeat;wait:frames` 格式写入 `inbox/`，轮询 `outbox/` 等待同 UUID 的响应文件，命令执行后立即删除响应文件。写入采用「临时文件 + rename」的原子模式，两侧都是如此。

**快照轮转**：bridge 不写单个固定文件，而是持续生成带 epoch/PID/帧号的新文件并定期清理旧文件（state 保留 24 个、map 保留 12 个）。TS 侧按 mtime 从新到旧扫描，跳过 JSON 损坏的文件，并丢弃 launch token 不匹配的快照。所以读取端必须容忍「最新文件正在被写/已被删」的竞态——`unit.mjs` 里有专门的并发轮转回归测试。

**Windows 唤醒逻辑**：当进程存活但心跳过期时，bridge 会通过内联 PowerShell 脚本向游戏主窗口发送 Win32 激活消息（WM_ACTIVATEAPP / WM_ACTIVATE / WM_SETFOCUS），使游戏循环恢复心跳。

### 暴露的 MCP 工具

- `black_souls_status` — 检查服务器与游戏 bridge 状态
- `black_souls_launch` — 启动游戏并等待 bridge 就绪
- `black_souls_get_state` — 读取当前游戏状态（场景、玩家、对话、战斗等）
- `black_souls_get_map` — 读取周围地图格子与可通行性
- `black_souls_input` — 注入单个输入动作（最多重复 100 次）
- `black_souls_input_sequence` — 注入最多 200 步的有序输入序列（支持 `wait_frames`）
- `black_souls_list_saves` — 列出存档槽信息

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BLACK_SOULS_ROOT` | `./runtime` | 运行时根目录 |
| `BLACK_SOULS_DIR` | `{ROOT}/game` | 游戏目录（含 `Game.exe`） |
| `BLACK_SOULS_GAME_EXE_SHA256` | 内置哈希值 | 覆盖 `Game.exe` 完整性校验预期值；设为空字符串则跳过比对 |
| `BLACK_SOULS_TEST_TEMP` | 系统 temp | `unit.mjs` 的临时目录位置 |
| `BLACK_SOULS_EXPECTED_SAVE_COUNT` | 无 | 集成测试要求的最少存档数 |

### 响应封装（公开契约）

`index.ts` 里所有工具共用同一个封装：成功时返回 `content[0].text`（JSON 字符串）加 `structuredContent.data`；失败时在此基础上加 `isError: true`，且 `data` 为 `{ ok: false, server_version, error: { name, message } }`。工具名、输入边界、annotations 和这个封装形状都属于公开行为，改动时必须同步更新 `scripts/smoke.mjs`、README 和版本号。

## 需要注意的约定

**跨语言常量必须手工同步。** 以下值在 `src/bridge.ts` 和 `rgss/BlackSoulsBridge.rb` 中各写了一份，没有共享来源，改一侧必须改另一侧：

| 常量 | 值 | 位置 |
|------|-----|------|
| 协议标识 | `black-souls-bridge/1` | `BRIDGE_PROTOCOL` / `PROTOCOL` |
| 版本号 | `1.1.1` | `SERVER_VERSION`（index.ts）/ `VERSION`（rb）/ `package.json` |
| 动作白名单 | 10 个 `move_*` / `confirm` / `cancel` / `open_menu` / `page_*` / `dash` | `ACTIONS` / Ruby 侧动作映射 |
| 队列上限 | 128 | `MAX_PENDING_COMMANDS` / `MAX_QUEUE` |
| 序列步数上限 | 200 | zod schema / `MAX_SEQUENCE_STEPS` |
| 序列帧预算上限 | 3600 | `MAX_SEQUENCE_FRAMES`（两侧同名） |

**命令超时不等于命令未执行。** `sendSequence` 超时后会尝试删除 inbox 文件：删成功说明游戏还没取走，删不掉说明可能已经执行了。错误信息里区分了这两种情况，重试前应先读一次最新状态。

**`dist/` 是构建产物，不要直接编辑。** 单元测试是 `import("../dist/bridge.js")`，所以改了 `src/` 必须先 build 才能测到新代码。

**`runtime/` 是本地生成状态，必须保持未跟踪。** 不要提交游戏文件、存档、`BridgeRuntime/`、日志或 token。

## 代码风格

遵循 `.editorconfig`：UTF-8、两空格缩进、LF 换行、文件末尾留空行，但 `.ps1` 用 CRLF。TypeScript 为 ES modules + ES2022 + strict。函数与变量用 `camelCase`，类型/类用 `PascalCase`，常量用 `UPPER_SNAKE_CASE`。项目没有配置 formatter 或 linter，靠 `npm.cmd run typecheck` 和对照邻近代码来保证一致性。

### 测试层级

- **smoke**（`scripts/smoke.mjs`）：直接发 JSON-RPC 验证 MCP 握手、工具列表、错误格式
- **unit**（`scripts/unit.mjs`）：用临时目录模拟文件 IPC，测试 bridge 状态机、损坏恢复、stale 拒绝、运行时归档、启动完整性校验
- **integration**（`scripts/integration.mjs`）：通过 MCP SDK 客户端调用真实构建产物
- **live e2e**（`scripts/live_e2e.mjs`）：对运行中的游戏进行全链路测试（启动→加载存档→移动→菜单）

### 安装脚本

`install.ps1` 将 MCP 服务器注册到 `~/.codex/config.toml`（Codex MCP 客户端），并自动备份原有配置到 `runtime/backup/`。`uninstall.ps1` 移除注册块，`rollback.ps1` 恢复最近一次备份。

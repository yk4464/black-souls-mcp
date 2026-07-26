# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**black-souls-mcp** 是一个本地 stdio MCP 服务器，让 AI 代理通过 35 个 `black_souls_*` 工具与运行中的 BLACK SOULS（RPG Maker VX Ace / RGSS3）游戏交互。服务器与游戏之间的通信完全基于文件系统（无网络、无 socket）。`AGENTS.md` 是面向所有代理的仓库准则；本文件补充 Claude Code 视角的操作细节，两者冲突时以 `AGENTS.md` 为准。

## 常用命令

本项目只在 Windows 上开发运行。在 bash 中请使用 `npm.cmd` 而非 `npm`。

```bash
npm.cmd run check             # 提交前标准命令：清理 + 构建 + smoke + unit
npm.cmd run build             # 清理 dist/ 后编译 TypeScript
npm.cmd run typecheck         # 仅类型检查
npm.cmd test                  # 只跑 smoke + unit（依赖已有 dist/，改源码先 build）
npm.cmd run test:integration  # 需要已准备好的 runtime/game
npm.cmd run test:live         # 会真的启动游戏并发送键盘输入
node scripts/call_tool.mjs black_souls_status '{}'   # 手动调用单个工具（调试用）
node evals/runner.mjs menu_navigation                # 跑一个评测场景（需真实游戏）
.\check.ps1 -IncludeRuntime   # 源码 + 游戏副本 + Codex 注册整体校验
```

CI（`.github/workflows/ci.yml`）在 windows-latest + Node 18/22 上运行 `npm run check`、`npm audit --audit-level=high` 和 `npm pack --dry-run`。

### Python 维护脚本（仅在写入游戏数据时使用）

```bash
# 从 RGSSAD v3 归档提取单个文件（纯标准库，支持 SHA-256 门禁）
python scripts/extract_rgss3a_file.py Game.rgss3a "Data/Scripts.rvdata2" out.rvdata2

# 把 rgss/BlackSoulsBridge.rb 注入 Scripts.rvdata2（纯标准库、字节保持，优先使用）
python scripts/patch_rvdata2_binary.py Scripts.rvdata2 rgss/BlackSoulsBridge.rb --title Main --backup backup.rvdata2
```

注入语义是**整体替换**标题为 `Main` 的脚本条目；`BlackSoulsBridge.rb` 末尾自带 `rgss_main { SceneManager.run }`，它就是新的 Main，**绝不能删除这一行**。重复注入是幂等安全的。备选 `patch_rvdata2.py` 需要 `pip install -r requirements-tools.txt`（rubymarshal）。

## 架构

### 源码结构（`src/`）

| 文件 | 职责 |
|---|---|
| `index.ts` | MCP 入口；注册全部 35 个工具；`execute()`/`result()` 统一响应封装 |
| `bridge.ts` | 文件 IPC 全部逻辑：快照读取、`sendSequence`、`sendQuery`、save/load/situation/health/wait |
| `game.ts` | 启动（含 Game.exe SHA-256 门禁）、强制结束、存档列表、完整性信息 |
| `config.ts` | 路径解析（环境变量覆盖） |
| `memory.ts` | AI 持久记忆：scratchpad / longterm / goals / session log（`<ROOT>/memory/`，原子写） |
| `navigation.ts` | BFS 寻路 `findPath`（导出可单测）、`navigate`、`interact` |
| `battle.ts` | `battleAction` 一次完成战斗回合 |

游戏内组件是 `rgss/BlackSoulsBridge.rb`（Ruby 1.9 / RGSS3：无 require、无 JSON 库、无线程；手写 `to_json`；新方法必须 `safe_call`/`safe_instance_variable` 访问游戏对象并在最外层 rescue）。

### 文件系统 IPC

游戏目录下的 `BridgeRuntime/`：`info|state|map/` 存快照（`<prefix>-*.json`，state 保留 24 个、map 保留 12 个），`inbox/*.cmd` 收命令，`outbox/<id>.json` 回响应，`launch.token` 绑定启动代次。`bridgeStatus()` 五条件全满足才算 connected：协议版本、launch token、PID 一致、进程存活、心跳 60 秒内。命令编码 `action:repeat;wait:frames`；查询通道用 `type=query` 即时应答不占帧。TS 侧按 mtime 由新到旧扫描快照、跳过损坏 JSON、丢弃 token 不匹配者——读取端必须容忍"最新文件正在写/已被删"竞态（`unit.mjs` 有并发轮转回归测试）。游戏后台被暂停时 `wakeWindowsGameLoop()` 用 PostMessage 恢复键盘循环，不抢前台。

### 响应封装（公开契约）

成功：`content[0].text`（JSON 字符串）+ `structuredContent.data`。失败：额外 `isError: true`，`data` 为 `{ ok: false, server_version, error: { name, message } }`。工具名、输入边界、annotations、封装形状均为公开行为，改动须同步 `scripts/smoke.mjs`、`scripts/integration.mjs`、README 和版本号。

## 需要注意的约定

**跨语言常量必须手工同步**（TypeScript 与 Ruby 两侧）：

| 常量 | TS 侧 | Ruby 侧 |
|---|---|---|
| 协议标识 `black-souls-bridge/1` | `BRIDGE_PROTOCOL` (bridge.ts) | `PROTOCOL` |
| 版本号（当前 `1.9.0`） | `SERVER_VERSION` (index.ts) + `package.json` | `VERSION` |
| 动作白名单（10 个） | `ACTIONS` (bridge.ts) | `ALLOWED_ACTIONS` |
| 队列上限 128 | `MAX_PENDING_COMMANDS` | `MAX_QUEUE` |
| 序列步数上限 200 / 帧预算 3600 | `encodeSteps` | `MAX_SEQUENCE_STEPS` / `MAX_SEQUENCE_FRAMES` |

其他硬约束：

- **命令超时 ≠ 未执行**。`sendSequence` 超时后尝试删 inbox 文件：删成功 = 游戏没取走；删不掉 = 可能已执行。错误信息区分两种情况，重试前先读最新状态。
- **`dist/` 是构建产物**，不要直接编辑；`unit.mjs` 从 `dist/*.js` 导入，改 `src/` 后必须先 build 再 test。
- **`runtime/`、`memory/`、`evals/results/` 保持未跟踪**。绝不提交游戏文件、存档、`BridgeRuntime/`、日志或 token。
- **按键注入只保持 1 帧**，`repeat:N` 展开为"按键、等 1 帧"交替。菜单光标每帧响应所以没问题；地图移动一格约需 16 帧（实测），连续 `repeat` 会被丢弃——地图上要用"单步 + `wait_frames:18`"的节奏。
- 高层动作（save/load/battle）的菜单导航是**闭环**的：`selectCommandSymbol` / `selectSavefileSlot`（bridge.ts）每步回读真实光标。实测布局：主菜单 7 项（save 在符号 `save`）；战斗指令窗 6 项 attack/skill(特技)/skill(魔法)/guard/item/escape；敌人窗横向排列用左右键。改动后用 `scripts/probe_live.mjs` 各套件重新测绘并跑 `test:live`。
- **战斗回合演出期间引擎不处理桥接命令**（内部等待循环不回到 Scene_Base#update），提交类输入必须容忍超时并轮询状态恢复。
- 游戏在后台约 60 秒后暂停帧循环；`readState`/`readMap` 走可唤醒检查自动恢复，`bridgeStatus`/`bridgeHealth` 保持被动只读。

## 代码风格与测试

`.editorconfig`：UTF-8、两空格、LF、文件末尾空行；`.ps1` 用 CRLF。TS 为 ESM + ES2022 + strict；`camelCase`/`PascalCase`/`UPPER_SNAKE_CASE`；无 formatter/linter，靠 `typecheck` 并对照邻近代码。

测试层级：smoke（MCP 握手/工具发现/错误封装）→ unit（临时目录合成 IPC，含损坏恢复、stale 拒绝、记忆系统、寻路）→ integration（SDK 客户端调真实产物）→ live e2e（真实游戏：启动→读档→移动→菜单）。行为改动必须补回归用例。

安装脚本：`install.ps1` 注册到 `~/.codex/config.toml`（带标记块平衡校验）并备份到 `runtime/backup/`；`uninstall.ps1` 移除注册块；`rollback.ps1` 按文件名内嵌时间戳恢复最近备份。

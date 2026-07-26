# black-souls-mcp

让 AI 实时操控和观察 BLACK SOULS 游戏的 MCP 服务器。

通过 7 个 [Model Context Protocol](https://modelcontextprotocol.io/) 工具，AI 助手（如 OpenAI Codex）可以启动游戏、读取场景和地图状态、注入键盘输入并查看存档列表。通信经由本机文件协议进行，不需要修改游戏网络设置或驱动层。

---

## 工作原理

```
AI 助手 (Codex)
      │  MCP stdio
      ▼
black-souls-mcp 服务器 (Node.js)
      │  文件协议 (BridgeRuntime/)
      ▼
BlackSoulsBridge.rb  ←  注入 Scripts.rvdata2
      │  每帧 hook Scene_Base#update
      ▼
BLACK SOULS (RPG Maker VX Ace / RGSS3)
```

- **服务器端（TypeScript）**：接收 MCP 调用，将指令写入游戏目录下的 `BridgeRuntime/inbox/`，从 `BridgeRuntime/outbox/` 和 `BridgeRuntime/state/` 读取响应和状态快照。
- **游戏端（RGSS3 Ruby）**：桥接脚本每帧运行一次，写出状态与地图快照，读取并执行收件箱中的输入指令。
- **安全设计**：命令携带启动代次令牌（launch token）防止跨次重放；输入动作限于白名单；命令队列和序列帧数均有上限。

---

## 前提条件

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows（桥接依赖 Win32 API 和 PowerShell） |
| Node.js | 18 或更高版本 |
| Python | 3.x（仅脚本补丁工具需要） |
| 游戏 | BLACK SOULS MCP 专用副本（独立于 Steam 的游戏文件） |

> **重要**：请为 MCP 准备一份独立的游戏副本，不要直接使用 Steam 库中的原始文件。

---

## 快速开始

### 1. 安装依赖并构建

```powershell
npm ci
npm run build
```

### 2. 准备游戏文件

将 BLACK SOULS 的 **独立副本** 放到 `runtime\game\`（或任意位置，之后通过环境变量指定）。

目录结构应包含：

```
runtime\game\
  Game.exe
  Game.ini
  Game.rgss3a          ← 原始资源包（保持不变）
  Data\Scripts.rvdata2 ← 需要注入桥接脚本
```

### 3. 注入桥接脚本

**方式 A：使用 Python 补丁工具（推荐）**

安装 Python 依赖：

```powershell
pip install -r requirements-tools.txt
```

将 `Game.rgss3a` 重命名为 `Game.rgss3a~`（备份），然后从中提取原始 `Scripts.rvdata2`：

```powershell
python scripts\extract_rgss3a_file.py `
    runtime\game\Game.rgss3a~ `
    "Data/Scripts.rvdata2" `
    runtime\game\Data\Scripts.rvdata2
```

注入桥接脚本：

```powershell
python scripts\patch_rvdata2_binary.py `
    runtime\game\Data\Scripts.rvdata2 `
    rgss\BlackSoulsBridge.rb `
    --title Main `
    --backup runtime\game\Data\Scripts.rvdata2.bak
```

**方式 B：使用 rubymarshal 补丁工具**

```powershell
python scripts\patch_rvdata2.py `
    runtime\game\Data\Scripts.rvdata2 `
    rgss\BlackSoulsBridge.rb `
    --title Main `
    --backup runtime\game\Data\Scripts.rvdata2.bak
```

### 4. 注册到 Codex

```powershell
.\install.ps1
```

脚本会在 `~\.codex\config.toml` 中写入 MCP 服务器配置，并自动备份原有配置。

**自定义路径时：**

```powershell
.\install.ps1 -RuntimeRoot "D:\bs-mcp\runtime" -GameDir "D:\bs-mcp\runtime\game"
```

### 5. 验证安装

```powershell
.\check.ps1 -IncludeRuntime
```

重启 Codex 后即可使用。

---

## MCP 工具

| 工具 | 类型 | 说明 |
|------|------|------|
| `black_souls_status` | 只读 | 查看服务器版本、游戏文件完整性和桥接连接状态 |
| `black_souls_launch` | 写入 | 启动游戏，等待桥接就绪（默认超时 12 秒） |
| `black_souls_get_state` | 只读 | 读取当前场景、玩家位置、队伍、消息窗口、战斗状态 |
| `black_souls_get_map` | 只读 | 读取玩家周围 6 格范围内的地图格和事件 |
| `black_souls_input` | 写入 | 注入单个输入动作（可重复最多 100 次） |
| `black_souls_input_sequence` | 写入 | 注入最多 200 步的输入序列（支持动作和等待帧） |
| `black_souls_list_saves` | 只读 | 列出独立副本的所有存档槽及元数据 |

### 允许的输入动作

`move_up` · `move_down` · `move_left` · `move_right` · `confirm` · `cancel` · `open_menu` · `page_up` · `page_down` · `dash`

### 限制

| 项目 | 上限 |
|------|------|
| 单次输入重复次数 | 100 |
| 序列步骤数 | 200 |
| 序列总帧数 | 3600 帧 |
| 命令队列深度 | 128 |

---

## 配置

通过环境变量（或在 Codex config 的 `[mcp_servers.black_souls.env]` 节）配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BLACK_SOULS_ROOT` | 运行目录根路径 | 仓库下的 `runtime/` |
| `BLACK_SOULS_DIR` | 游戏目录路径 | `$BLACK_SOULS_ROOT/game` |
| `BLACK_SOULS_GAME_EXE_SHA256` | Game.exe 的 SHA-256 哈希（用于完整性校验） | 内置已知哈希 |
| `BLACK_SOULS_EXPECTED_SAVE_COUNT` | 集成测试期望的存档数量 | `0` |

示例配置见 `examples/env.example` 和 `examples/codex-config.toml`。

---

## 开发

```powershell
# 构建 + 冒烟测试 + 单元测试（提交前必跑）
npm run check

# 仅类型检查
npm run typecheck

# 集成测试（需要准备好的 runtime 目录）
npm run test:integration

# 真实游戏 E2E 测试（会启动游戏并发送输入）
npm run test:live

# 源码 + 运行目录 + Codex 注册三合一检查
.\check.ps1 -IncludeRuntime
```

---

## 卸载 / 回滚

**卸载**（仅移除 Codex 注册，不删除游戏或存档）：

```powershell
.\uninstall.ps1
```

**回滚到安装前的 Codex 配置**：

```powershell
.\rollback.ps1
```

备份文件保存在 `runtime\backup\`，按时间戳命名。

---

## 安全说明

本服务器设计为本机 `stdio` 服务，仅供本地 AI 助手连接。若将其包装成网络服务，需另行添加身份验证、访问控制和速率限制。

安全问题请通过 [GitHub Security Advisories](https://github.com/yk4464/black-souls-mcp/security/advisories/new) 私下报告，详见 [SECURITY.md](SECURITY.md)。

---

## 许可

[MIT](LICENSE) · 作者 [yk4464](https://github.com/yk4464)

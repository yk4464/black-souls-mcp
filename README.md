# BLACK SOULS MCP

[简体中文](README.md) · [English](README.en.md)

[![CI](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个面向 **BLACK SOULS / RPG Maker VX Ace（RGSS3）** 的本地 MCP 接入层。它直接读取游戏内部状态，并把白名单键盘动作送进游戏原有的输入循环；无需截图识别、鼠标模拟或网络服务。

> [!IMPORTANT]
> 本仓库只提供桥接与 MCP 源码，不包含、下载或分发游戏本体、存档、素材、密钥及解包后的商业游戏数据。使用者需要自行准备合法取得的游戏文件。

## 项目状态

- 平台：Windows 10/11
- 传输方式：本地 `stdio`
- 支持引擎：RPG Maker VX Ace / RGSS3
- 发布方式：从源码安装；当前未发布 npm 包
- 游戏版本：内置一个开发时验证过的 `Game.exe` 指纹，其他版本可自行配置

## 功能

- 读取当前场景、地图、坐标、方向和通行信息。
- 读取附近事件、消息、选项和活动窗口。
- 读取队伍成员、等级、生命、魔力、状态和金钱。
- 读取战斗阶段、敌我单位及当前战斗指令。
- 执行移动、确认、取消、菜单、翻页、冲刺和连续动作。
- 通过进程 ID、启动代次、帧号和命令编号拒绝旧状态或重复命令。
- 跳过损坏快照，并在 RPG Maker 后台暂停时恢复键盘循环而不抢占前台。

输入只经过游戏自身的移动、事件、菜单和战斗处理；接口不会直接修改生命、物品、变量或剧情开关。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `black_souls_status` | 检查游戏文件、进程和桥接状态。 |
| `black_souls_launch` | 启动准备好的独立游戏副本。 |
| `black_souls_get_state` | 读取场景、角色、消息、菜单和战斗。 |
| `black_souls_get_map` | 读取附近地块、通行信息和事件。 |
| `black_souls_input` | 执行一个白名单键盘动作。 |
| `black_souls_input_sequence` | 一次提交多步动作与等待帧。 |
| `black_souls_list_saves` | 列出独立游戏副本中的存档。 |

## 工作方式

```text
MCP 客户端
    │ stdio
    ▼
Node.js / TypeScript 服务
    │ 原子文件 + 启动令牌
    ▼
BridgeRuntime
    │ RGSS3 Input 与游戏对象
    ▼
使用者准备的 BLACK SOULS 独立副本
```

桥接脚本每秒约更新 10 次状态；地图仅在位置或地图变化时生成新快照。命令由游戏主线程逐帧处理，因此不依赖窗口焦点或视觉识别。详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开始之前

需要准备：

1. Windows 10/11。
2. Node.js 18 或更新版本。
3. 自己的 BLACK SOULS 游戏副本。
4. Python 3.11+，仅用于桥接脚本写入工具。
5. 已从自己的副本准备好 `Data/Scripts.rvdata2`；本项目不自动下载或解包游戏资源。

## 快速开始

### 1. 获取源码并检查

```powershell
git clone https://github.com/yk4464/black-souls-mcp.git
Set-Location .\black-souls-mcp
npm.cmd ci
npm.cmd run check
```

### 2. 准备独立运行目录

默认目录结构：

```text
runtime/
├─ game/
│  ├─ Game.exe
│  ├─ Game.ini
│  ├─ Game.rgss3a~
│  └─ Data/Scripts.rvdata2
└─ backup/
```

`runtime/` 已被 Git 忽略。完整的副本准备、桥接写入和版本校验步骤见 [中文安装指南](docs/SETUP.zh-CN.md)。

### 3. 安装到 Codex

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

使用外部目录：

```powershell
.\install.ps1 `
  -RuntimeRoot 'D:\BlackSoulsRuntime' `
  -GameDir 'D:\BlackSoulsRuntime\game'
```

安装脚本会先备份当前用户的 Codex `config.toml`，再写入 `black_souls` MCP 注册。完成后重启 Codex。

### 4. 验证

重启 Codex 后先调用：

```text
请调用 black_souls_status，检查游戏文件和桥接状态。
```

随后可以依次调用：

```text
black_souls_launch
black_souls_get_state
black_souls_get_map
```

连续动作参数示例：

```json
{
  "steps": [
    { "action": "move_up" },
    { "wait_frames": 12 },
    { "action": "confirm" }
  ]
}
```

## 游戏版本指纹

获取自己的 `Game.exe` SHA-256：

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath '.\runtime\game\Game.exe').Hash
```

然后在当前终端指定：

```powershell
$env:BLACK_SOULS_GAME_EXE_SHA256 = '<YOUR_SHA256>'
```

设为空字符串会跳过指纹比较，但仍会检查必需文件是否存在。只有在确认游戏文件来源后才应这样做。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `BLACK_SOULS_ROOT` | 运行目录；默认 `<仓库>/runtime`。 |
| `BLACK_SOULS_DIR` | 准备好的独立游戏目录。 |
| `BLACK_SOULS_GAME_EXE_SHA256` | 可选的 `Game.exe` 校验值。 |
| `BLACK_SOULS_TEST_TEMP` | 单元测试临时目录。 |
| `BLACK_SOULS_EXPECTED_SAVE_COUNT` | 可选的集成测试最少存档数。 |

## 测试

```powershell
npm.cmd run check              # 构建、MCP 握手、工具发现与合成测试
npm.cmd run test:integration   # 需要已准备的运行目录
npm.cmd run test:live          # 启动游戏并执行真实键盘输入
.\check.ps1 -IncludeRuntime    # 检查源码、游戏副本和 Codex 注册
```

真实测试会改变当前游戏会话中的位置或菜单，但不会主动保存。运行前仍建议保留自己的存档副本。

## 限制与故障提示

- 游戏资源准备与解包方式取决于发行版本，因此未做成自动下载流程。
- RPG Maker 在后台可能暂停键盘循环；服务使用已核对进程和路径的 Windows 消息恢复循环，不模拟鼠标，也不把窗口切到前台。
- 命令超时后若提示“游戏可能已经接收”，应先读取最新状态，再决定是否重试，避免重复动作。
- 本项目仅面向本机可信目录，不应把 `BridgeRuntime` 放到其他用户可写的位置。

## 卸载与回滚

```powershell
.\uninstall.ps1
.\rollback.ps1
```

两者只处理 Codex 注册及其配置备份，不删除游戏或存档。指定某个备份进行回滚：

```powershell
.\rollback.ps1 -ConfigBackup 'D:\BlackSoulsRuntime\backup\config.toml.before-black-souls-....bak'
```

## 安全与隐私

- 服务只使用本地 `stdio`，不会监听网络端口。
- 命令动作使用固定白名单，并限制队列、步骤和总帧数。
- 仓库忽略游戏、存档、运行快照、日志、依赖缓存和构建产物。
- 提交问题前请移除个人路径、存档内容和游戏文件。

安全问题请通过 [GitHub Security Advisory](https://github.com/yk4464/black-souls-mcp/security/advisories/new) 私下报告；其他问题使用 [Issues](https://github.com/yk4464/black-souls-mcp/issues)。

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。`package.json` 中保留 `private: true`，用于防止误发布到 npm；这不影响 GitHub 上的 MIT 开源源码。

## 许可证与声明

本仓库源码采用 [MIT License](LICENSE)。BLACK SOULS、RPG Maker、相关名称和游戏资产归各自权利人所有；本项目是非官方社区工具，与游戏作者、发行商及引擎厂商无隶属关系。

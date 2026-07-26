# BLACK SOULS MCP

[简体中文](README.md) · [English](README.en.md)

[![CI](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

让 AI 直接操作 **BLACK SOULS（RPG Maker VX Ace / RGSS3）** 的本地 MCP 服务器。通过读取游戏内部状态、向游戏原生输入循环注入白名单按键的方式工作，不依赖截图、鼠标模拟或任何网络服务。

> [!IMPORTANT]
> 本仓库只提供 MCP 服务器和 bridge 源码，不含、不下载、不分发游戏本体、存档、素材及解包后的商业数据。使用前需自行准备合法取得的游戏文件。

## 工作原理

```
MCP 客户端（Codex 等）
    │ stdio
    ▼
Node.js / TypeScript 服务器
    │ 原子文件写入 + 启动令牌
    ▼
BridgeRuntime/（游戏目录内）
    │ RGSS3 Input 与游戏对象
    ▼
用户准备的独立 BLACK SOULS 副本
```

游戏内嵌的 RGSS3 bridge 脚本每帧执行一次，约 10 Hz 写入状态快照；地图仅在位置或地图变化时生成新快照；输入命令由游戏主线程逐帧处理，不依赖窗口焦点。

## MCP 工具

| 工具 | 用途 |
|------|------|
| `black_souls_status` | 检查游戏文件、进程和 bridge 状态 |
| `black_souls_launch` | 启动独立游戏副本并等待 bridge 就绪 |
| `black_souls_get_state` | 读取场景、角色、消息、菜单、战斗等状态 |
| `black_souls_get_map` | 读取周围地块、通行性和事件 |
| `black_souls_input` | 注入单个白名单按键动作 |
| `black_souls_input_sequence` | 注入最多 200 步的有序动作序列（支持帧等待） |
| `black_souls_list_saves` | 列出独立副本中的存档槽 |

## 准备工作

- Windows 10/11
- Node.js 18+
- 合法取得的 BLACK SOULS 游戏副本
- Python 3.11+（仅用于将 bridge 脚本写入游戏数据）

## 快速开始

### 1. 获取源码并构建

```powershell
git clone https://github.com/yk4464/black-souls-mcp.git
Set-Location .\black-souls-mcp
npm.cmd ci
npm.cmd run check
```

### 2. 准备独立运行目录

```
runtime/
├─ game/
│  ├─ Game.exe
│  ├─ Game.ini
│  ├─ Game.rgss3a~        ← 原始归档备份
│  └─ Data/Scripts.rvdata2  ← 已注入 bridge 脚本
└─ backup/
```

`runtime/` 已被 Git 忽略。完整的副本准备和 bridge 写入步骤见 [docs/SETUP.zh-CN.md](docs/SETUP.zh-CN.md)。

### 3. 注册到 Codex

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

使用外部目录时：

```powershell
.\install.ps1 -RuntimeRoot 'D:\BlackSoulsRuntime' -GameDir 'D:\BlackSoulsRuntime\game'
```

安装脚本会先备份当前 Codex `config.toml`，再写入 `black_souls` MCP 注册块。安装完成后重启 Codex。

### 4. 验证

```
black_souls_status    → 检查文件与 bridge 状态
black_souls_launch    → 启动游戏
black_souls_get_state → 读取当前状态
```

序列输入示例：

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

获取自己副本的 `Game.exe` SHA-256：

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath '.\runtime\game\Game.exe').Hash
```

在当前终端指定（或写入 `.env`）：

```powershell
$env:BLACK_SOULS_GAME_EXE_SHA256 = '<YOUR_SHA256>'
```

留空则跳过指纹比对，但仍会检查必需文件是否存在。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BLACK_SOULS_ROOT` | `<仓库>/runtime` | 运行时根目录 |
| `BLACK_SOULS_DIR` | `{ROOT}/game` | 独立游戏目录 |
| `BLACK_SOULS_GAME_EXE_SHA256` | 内置值 | `Game.exe` SHA-256 校验；留空跳过比对 |
| `BLACK_SOULS_TEST_TEMP` | 系统 temp | 单元测试临时目录 |
| `BLACK_SOULS_EXPECTED_SAVE_COUNT` | 无 | 集成测试要求的最少存档数 |

## 测试

```powershell
npm.cmd run check              # 构建 + MCP 握手 + 合成单元测试（PR 前必跑）
npm.cmd run test:integration   # 需要已准备好的运行目录
npm.cmd run test:live          # 启动游戏并发送真实按键
.\check.ps1 -IncludeRuntime    # 同时校验源码、游戏副本和 Codex 注册
```

真实测试（`test:live`）会移动角色、打开菜单，但不会主动存档。运行前建议先备份存档。

## 卸载与回滚

```powershell
.\uninstall.ps1   # 从 config.toml 中移除注册块
.\rollback.ps1    # 恢复最近一次安装前的备份
```

两者只处理 Codex 注册和配置备份，不会删除游戏或存档。

如需指定特定备份进行回滚：

```powershell
.\rollback.ps1 -ConfigBackup 'D:\BlackSoulsRuntime\backup\config.toml.before-black-souls-....bak'
```

## 安全

- 仅使用本地 `stdio`，不监听任何网络端口。
- 允许的输入动作为固定白名单，并对队列长度、序列步数和总帧数设有硬限制。
- 游戏文件、存档、运行快照、日志及依赖目录均已被 `.gitignore` 忽略。
- 提交 issue 前请移除路径、存档内容和游戏文件等个人信息。

安全问题请通过 [GitHub Security Advisory](https://github.com/yk4464/black-souls-mcp/security/advisories/new) 私下报告；其他问题使用 [Issues](https://github.com/yk4464/black-souls-mcp/issues)。

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。`package.json` 中保留 `private: true` 仅为防止误发布到 npm，不影响 GitHub 上的 MIT 开源源码。

## 许可证

源码采用 [MIT License](LICENSE)。BLACK SOULS、RPG Maker 及相关名称和游戏素材均为各自权利人所有；本项目是非官方社区工具，与游戏开发者、发行商及引擎厂商无任何关联。

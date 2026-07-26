# BLACK SOULS MCP

[简体中文](README.md) · [English](README.en.md)

[![CI](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yk4464/black-souls-mcp/actions/workflows/ci.yml) [![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/yk4464/black-souls-mcp/blob/main/LICENSE)

一个BLACK SOULS的mcp工具，我用最直白，最简洁，最不绕弯子的话告诉你：就是一个可以让你的Claudecode/Codex等agent工具接入BLACK SOULS的mcp。
纯娱乐。原理很简单，就是读游戏内部对象拿状态，然后把动作送进游戏自带的按键输入循环，不截图、不模拟鼠标、同时也不需要图片模型，所以非图像模型也可以使用。

> [!IMPORTANT]
> 本仓库只包含桥接程序与 MCP 源码，不包含、不下载、也不分发游戏本体、存档、素材、密钥或解包后的商业游戏数据。使用前请自行准备合法获得的游戏文件。

## 能干嘛？

接入后，MCP 客户端能拿到：

- 场景、地图、坐标、朝向、通行信息
- 附近事件、消息、选项菜单
- 队伍等级、生命、魔力、异常状态、金钱
- 战斗阶段、双方单位、当前可用指令

也能操控角色：移动、确认、取消、翻页、冲刺，或者一次提交一整套连续动作，比如"往前走三步，再打开菜单看装备"。

输入只经过游戏自身的移动 / 事件 / 菜单 / 战斗处理逻辑，接口不会直接改生命、物品、变量或剧情开关。命令带着进程 ID、启动代次、帧号和命令编号，旧状态和重复命令会被拒绝；快照损坏会自动跳过；游戏在后台被 RPG Maker 暂停时，桥接能恢复键盘循环，不抢前台窗口。

## 跟截图 OCR和鼠标模拟比，差在哪？

| | 截图 / OCR 方案 | 鼠标模拟方案 | BLACK SOULS MCP |
|---|---|---|---|
| 状态来源 | 图像识别，容易看错、看漏 | 图像识别 | 直接读游戏内部对象，逐帧精确 |
| 需要窗口置顶 / 前台 | 通常需要 | 需要 | 不需要，后台也能恢复输入循环 |
| 是否联网 | 常需要视觉模型服务 | 视实现而定 | 纯本地 stdio，不开端口 |
| 输入路径 | 模拟点击 / 按键 | 模拟点击 | 走游戏原生输入循环，帧同步 |
| 会不会误改存档 / 剧情 | 视实现而定 | 视实现而定 | 不直接改生命、物品、变量、剧情开关 |

更准、更快、更不容易翻车，而且不需要多模态

## MCP 工具

共 35 个工具，按用途分组：

| 分组 | 工具 | 用途 |
|---|---|---|
| 进程与诊断 | `black_souls_status` · `black_souls_launch` · `black_souls_kill` · `black_souls_list_saves` · `black_souls_health` | 检查游戏文件与桥接、启动或强制结束游戏、列出存档、一键自诊断并给出恢复建议 |
| 状态读取 | `black_souls_get_state` · `black_souls_get_map` · `black_souls_situation` · `black_souls_get_full_map` · `black_souls_get_event` · `black_souls_get_scene_detail` | 场景、角色、消息、菜单、战斗；附近或大范围地图；事件页与触发条件；场景深层状态 |
| 游戏数据 | `black_souls_get_variables` · `black_souls_get_switches` · `black_souls_get_inventory` · `black_souls_get_party_detail` | 变量、开关、背包物品与装备、队伍详细属性和技能 |
| 输入 | `black_souls_input` · `black_souls_input_sequence` · `black_souls_wait` | 白名单键盘动作、多步连续动作、等待某个游戏条件成立 |
| 高层动作 | `black_souls_navigate` · `black_souls_interact` · `black_souls_battle_action` · `black_souls_advance_dialogue` · `black_souls_save` · `black_souls_load` | 自动寻路、走到事件旁交互、一次完成战斗指令、推进对话并选择选项、触发存档与读档 |
| AI 记忆 | `black_souls_scratchpad_read/write` · `black_souls_memory_read/write/delete` · `black_souls_goals_read/write/set_active` · `black_souls_session_log_append/read` | 会话便签、长期游戏知识库、目标层级、持久会话日志，跨上下文重置保留 |
| 评测 | `black_souls_eval_status` | 供 `evals/runner.mjs` 检查评测场景的完成条件 |

## 工作原理

```
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

桥接脚本每秒约更新 10 次状态；地图仅在位置或地图变化时生成新快照。命令由游戏主线程逐帧处理，不依赖窗口焦点，也不依赖视觉识别。查询类命令（变量、开关、背包、全图等）走同一条通道即时应答，不占用帧步进。

## 项目状态

| | |
|---|---|
| 平台 | Windows 10/11 |
| 传输方式 | 本地 `stdio` |
| 支持引擎 | RPG Maker VX Ace / RGSS3 |
| 发布方式 | 从源码安装；当前未发布 npm 包 |
| 游戏版本 | 内置一个开发时验证过的 `Game.exe` 指纹，其他版本可自行配置 |

## 开始之前

需要准备：

1. Windows 10/11
2. Node.js 18 或更新版本
3. 自己的 BLACK SOULS 游戏副本
4. Python 3.11+（仅用于桥接脚本写入工具）
5. 已从自己的副本准备好 `Data/Scripts.rvdata2`；本项目不会自动下载或解包游戏资源

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

```
runtime/
├─ game/
│  ├─ Game.exe
│  ├─ Game.ini
│  ├─ Game.rgss3a~
│  └─ Data/Scripts.rvdata2
└─ backup/
```

`runtime/` 已被 Git 忽略。准备步骤概述：把自己的游戏副本复制到 `runtime/game/`，确保 `Data/Scripts.rvdata2` 已解出（可用 `scripts/extract_rgss3a_file.py`），然后用桥接写入工具把 `rgss/BlackSoulsBridge.rb` 注入脚本档：

```powershell
python .\scripts\patch_rvdata2_binary.py .\runtime\game\Data\Scripts.rvdata2 .\rgss\BlackSoulsBridge.rb --backup .\runtime\backup\Scripts.rvdata2.bak
```

`patch_rvdata2_binary.py` 只用 Python 标准库，保持原字节布局，优先使用；备选的 `patch_rvdata2.py` 需要先 `python -m pip install -r requirements-tools.txt`。

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

```
请调用 black_souls_status，检查游戏文件和桥接状态。
```

随后可以依次调用：

```
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
|---|---|
| `BLACK_SOULS_ROOT` | 运行目录；默认 `<仓库>/runtime` |
| `BLACK_SOULS_DIR` | 准备好的独立游戏目录 |
| `BLACK_SOULS_GAME_EXE_SHA256` | 可选的 `Game.exe` 校验值 |
| `BLACK_SOULS_TEST_TEMP` | 单元测试临时目录 |
| `BLACK_SOULS_EXPECTED_SAVE_COUNT` | 可选的集成测试最少存档数 |

## 测试

```powershell
npm.cmd run check              # 构建、MCP 握手、工具发现与合成测试
npm.cmd run test:integration   # 需要已准备的运行目录
npm.cmd run test:live          # 启动游戏并执行真实键盘输入
.\check.ps1 -IncludeRuntime    # 检查源码、游戏副本和 Codex 注册
node evals\runner.mjs menu_navigation   # 运行一个评测场景（需要真实游戏）
```

真实测试会改变当前游戏会话中的位置或菜单，但不会主动保存。运行前仍建议保留自己的存档副本。

## 限制与故障提示

- 游戏资源准备与解包方式取决于发行版本，因此未做成自动下载流程
- RPG Maker 在后台可能暂停键盘循环；服务使用已核对进程和路径的 Windows 消息恢复循环，不模拟鼠标，也不把窗口切到前台
- 命令超时后若提示"游戏可能已经接收"，应先读取最新状态，再决定是否重试，避免重复动作
- 本项目仅面向本机可信目录，不应把 `BridgeRuntime` 放到其他用户可写的位置

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

- 服务只使用本地 `stdio`，不会监听网络端口
- 命令动作使用固定白名单，并限制队列、步骤和总帧数
- 仓库忽略游戏、存档、运行快照、日志、依赖缓存和构建产物
- 提交问题前请移除个人路径、存档内容和游戏文件

安全问题请通过 [GitHub Security Advisory](https://github.com/yk4464/black-souls-mcp/security/advisories/new) 私下报告；其他问题使用 [Issues](https://github.com/yk4464/black-souls-mcp/issues)。

## 参与贡献

请先阅读 [CONTRIBUTING.md](https://github.com/yk4464/black-souls-mcp/blob/main/CONTRIBUTING.md)。`package.json` 中保留 `private: true`，用于防止误发布到 npm；这不影响 GitHub 上的 MIT 开源源码。

## 许可证与声明

本仓库源码采用 [MIT License](https://github.com/yk4464/black-souls-mcp/blob/main/LICENSE)。

BLACK SOULS、RPG Maker、相关名称和游戏资产归各自权利人所有；本项目是非官方社区工具，与游戏作者、发行商及引擎厂商无隶属关系。
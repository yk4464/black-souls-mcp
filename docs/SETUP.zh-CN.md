# 本地准备与安装

本文只描述源码仓库与本地运行目录。仓库不会提供游戏本体、存档或解包后的游戏数据。

## 1. 安装开发依赖

```powershell
git clone https://github.com/yk4464/black-souls-mcp.git
Set-Location .\black-souls-mcp
npm.cmd ci
npm.cmd run check
```

要求 Node.js 18 或更新版本。Python 工具建议使用 Python 3.11+。

## 2. 准备独立游戏副本

默认位置为：

```text
<repo>/runtime/game
```

也可以把独立副本放在其他位置，并通过 `BLACK_SOULS_ROOT`、`BLACK_SOULS_DIR` 或 PowerShell 参数指定。

准备后的目录至少需要：

```text
Game.exe
Game.ini
Game.rgss3a~
Data/Scripts.rvdata2
```

其中 `Data/Scripts.rvdata2` 需要来自使用者自己的游戏副本，且 `Main` 脚本需要替换为本仓库的桥接入口。完整的游戏资源解包方式取决于具体发行版本，因此没有纳入自动安装脚本。

> [!IMPORTANT]
> 以下工具不会下载游戏，也不会判断第三方解包包是否可信。请只处理自己的游戏副本，并始终保留原始文件。

## 3. 写入桥接脚本

推荐使用不依赖第三方 Python 包的字节保持工具，并先指定备份路径：

```powershell
New-Item -ItemType Directory -Force .\runtime\backup | Out-Null
python .\scripts\patch_rvdata2_binary.py `
  .\runtime\game\Data\Scripts.rvdata2 `
  .\rgss\BlackSoulsBridge.rb `
  --title Main `
  --backup .\runtime\backup\Scripts.rvdata2.original
```

该工具只替换目标脚本的压缩内容，并检查目标脚本之外的字节没有变化。

`scripts/patch_rvdata2.py` 是基于 `rubymarshal` 的备用实现。如需使用：

```powershell
python -m pip install -r .\requirements-tools.txt
```

## 4. 游戏版本校验

仓库内置的已知 `Game.exe` SHA-256 对应开发时验证过的版本。其他合法发行版本可以在确认文件来源后设置自己的值：

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath '.\runtime\game\Game.exe').Hash
$env:BLACK_SOULS_GAME_EXE_SHA256 = '<YOUR_SHA256>'
```

设为空字符串会跳过版本指纹比较，但文件是否存在仍会检查。

## 5. 注册 MCP

使用默认 `runtime/game`：

```powershell
.\install.ps1
```

使用外部游戏目录：

```powershell
.\install.ps1 `
  -RuntimeRoot 'D:\BlackSoulsRuntime' `
  -GameDir 'D:\BlackSoulsRuntime\game'
```

脚本会先在运行目录的 `backup` 下保存 Codex 配置副本，再更新 MCP 注册。重启 Codex 后生效。

## 6. 验证

```powershell
.\check.ps1 -IncludeRuntime
npm.cmd run test:integration
```

需要真实操作时再运行：

```powershell
npm.cmd run test:live
```

## 7. 后台键盘循环

RPG Maker VX Ace 在失去焦点后可能暂停内部键盘循环。MCP 在发送动作前会向已核对路径和进程号的游戏窗口发送恢复通知；它不会模拟鼠标，也不会把游戏窗口切到前台。真正的移动和菜单操作仍由 RGSS3 `Input` 完成。

## 8. 卸载和恢复

```powershell
.\uninstall.ps1
.\rollback.ps1
```

这些脚本不处理游戏或存档文件。

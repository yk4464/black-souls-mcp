# Security Policy

## Reporting

请优先使用 [GitHub Security Advisories](https://github.com/yk4464/black-souls-mcp/security/advisories/new) 私下报告安全问题。如果该入口暂时不可用，请创建一个不包含利用细节的 [普通 Issue](https://github.com/yk4464/black-souls-mcp/issues/new)，维护者会提供后续沟通方式。

报告中不要附带游戏文件、存档、访问令牌、Codex 配置或包含个人路径的完整日志。

## Scope

- MCP 命令验证与重复执行保护。
- 路径、进程和启动代次校验。
- `BridgeRuntime` 文件处理。
- 安装、卸载和回滚脚本对 Codex 配置的处理。

本项目只设计为本机 `stdio` 服务。将它包装成网络服务时，需要另行增加身份验证、访问控制和速率限制。

## Dependency note

本项目只创建 MCP SDK 的 `StdioServerTransport`，不启用 SDK 附带的 HTTP 服务。`package.json` 的 `overrides` 用于把间接依赖提升到已修复版本，不使用 `npm audit fix --force` 降级官方 SDK。

CI 使用 `npm audit --audit-level=high` 阻止高危或严重问题进入主分支。

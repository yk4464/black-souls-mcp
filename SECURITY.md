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

当前 MCP SDK 的间接依赖会让 `npm audit` 报告 `@hono/node-server` 的 Windows 静态文件路径问题。本项目只创建 `StdioServerTransport`，没有启用对应的 HTTP 静态文件服务。仓库保持官方 MCP SDK 版本，不使用 `npm audit fix --force` 强制降级；上游发布兼容修复后再正常更新锁文件。

CI 使用 `npm audit --audit-level=high` 阻止高危或严重问题进入主分支；当前已知的中等级报告及其不适用原因保留在本节说明。

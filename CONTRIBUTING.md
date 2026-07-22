# Contributing

感谢参与改进。

English contributors are welcome. Please open an issue if any part of the Chinese setup guide needs clarification.

## 开发流程

1. Fork 并创建功能分支。
2. 运行 `npm ci`。
3. 修改后运行 `npm run check`。
4. 涉及真实游戏桥接时，另外运行 `npm run test:integration`；真实输入测试应在说明中明确记录。
5. 提交聚焦、可复核的变更。

开始较大的修改前，请先在 [Issues](https://github.com/yk4464/black-souls-mcp/issues) 说明目标，避免重复工作。

## 提交内容限制

请勿提交游戏本体、解包数据、存档、截图中的个人信息、`BridgeRuntime`、日志、Codex 配置、访问令牌或依赖目录。提交问题复现时使用合成数据，并移除本机绝对路径。

## 兼容性

- Node.js 18+
- Windows
- RPG Maker VX Ace / RGSS3

桥接协议或工具输出结构发生变化时，请同步更新文档、测试和版本号。

## Pull Request 检查清单

- [ ] `npm.cmd run check` 已通过。
- [ ] 未提交游戏、存档、运行目录、日志或个人路径。
- [ ] 行为变化已更新 README、架构说明或 CHANGELOG。
- [ ] 真实游戏测试的范围与结果已在 PR 中说明。

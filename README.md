# super-agent

DeepSeek《Super-agent 设计探索》（2026-10-31，配套开源原型 `deepseek-ai/dsh-superagent-prototype`）的 Claude Code 协议实现。核心原则：人的注意力是稀缺资源——主会话（Router）只做路由、评估和对外汇报；具体工作由隔离上下文的子代理（Worker）按工单执行，只在结果可审查、需要人决策或确定无法完成时打扰用户。

功能：

- Router/Worker 双层架构：一个工作项一个 Worker，独立工单并行，写操作可用 worktree 隔离后由集成 Worker 汇合。
- 工单台账：`SOURCE_KEY`/`REQUEST_HASH` 幂等去重，状态机含 awaiting_review、awaiting_integration、handed_back、stopped 等终态，落盘跨压缩存活。
- 事件与订阅：订阅线程消息直通 Owner，bot/CI 只作上下文不得授权，第三方请求需用户确认。
- 通信闸门：默认沉默、批量汇报、一次一个问题、GitHub 输出带自动代理声明。
- Watchdog 与失败处理：轮次计数、副作用操作查重、重派携带 PRIOR 状态。

内容：

- `skills/csg` — Router 协议（何时启用、生命周期、台账、分派、事件与订阅、通信闸门、Watchdog、失败处理）
- `agents/super-agent-worker` — 执行器子代理（受限工具，不合并、不关 issue、不嵌套子代理）

## 安装

从 GitHub marketplace（发布后替换 `<owner>/<repo>` 为实际仓库）：

```bash
/plugin install super-agent --marketplace <owner>/<repo>
```

本地目录：

```bash
claude --plugin-dir F:/Project/MyTool/t2/super-agent
```

## 使用

多任务请求自动触发，或显式调用 `/csg <任务>`、说"csg 修登录超时…"。示例：

```
/csg 修登录超时、修导出乱码、更新 README
```

单步小任务不触发，走普通流程。

来源与设计细节见 `skills/csg/SKILL.md` 头部。

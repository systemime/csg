---
description: 为工单订阅 PR 或分支 CI 变化
argument-hint: "T# --pr 34 [--repo owner/name] [--branch name] [--ci]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js *)
---

运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js watch $ARGUMENTS
```

参数形如 `T1 --pr 34`，可再加 `--repo owner/name`、`--branch <name>`、`--ci`。

限制：

- monitor 只在交互会话里运行，需要 Claude Code 2.1.310+；非交互的 `-p` 模式不启动，会话关闭后不再监听，也没有后台进程继续查询。
- PR/CI 查询依赖 `gh` CLI。没安装或没登录时监控不可用，其他功能不受影响。
- 这是定时查询，变化作为会话内事件出现；不要把它说成常驻守护进程。

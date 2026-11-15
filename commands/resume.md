---
description: 解除 Super-agent 全局停止
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js *), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js *)
disable-model-invocation: true
---

运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js resume
```

这只清除全局停止标记，不恢复 `stopped` 工单；`stopped` 是终态。

如果 service 存在，再运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js resume`，恢复领取新 job。正在执行的 job 不受影响。

用一句话回报，并提示：要接着做之前的工作，请重新描述请求，由 Router 建新工单。

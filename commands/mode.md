---
description: 切换 Super-agent 运行模式（observe 或 active）
argument-hint: "observe|active"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js *)
---

`$ARGUMENTS` 必须是 `observe` 或 `active`；缺参数时先问用户选哪一个。

运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js mode $ARGUMENTS
```

- `observe`：主动发现的候选只记录建议，不派 Worker、不改代码、不开 PR；用户明确要求的工作照常处理。
- `active`：按协议正常分派。

切换后用一句话回报当前模式。切换模式不改变已有的停止状态。

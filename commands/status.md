---
description: 查看 Super-agent 台账状态，用一句话汇报结论，只问最阻塞的一个问题
argument-hint: "[--json]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js *), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js *)
---

运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js status $ARGUMENTS
```

如果 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js status --json` 有输出，再记下 service 是否运行、queued/running/awaiting 数量和是否暂停。

汇报要求：

1. 先给一句话结论：是否处于停止状态、几个进行中工单、几个 blocked、几个未确认事件、service 是否运行和暂停。
2. 需要用户决定时，只问最阻塞的一个问题，附上工单给出的选项和默认值；没有就写「暂无需要决定的问题」。
3. 不逐条复述工单和事件；用户追问时再展开。

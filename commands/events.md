---
description: 处理 Super-agent 未确认事件，批量处理可判断的，需决策只问一个，处理完确认
argument-hint: "[--all]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js *)
---

步骤：

1. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js events $ARGUMENTS` 列出未确认事件。
2. 逐条按 `[来源/类型]` 和工单号判断归属：
   - 已处理过或与本工单无关：标为可确认。
   - 属于现有工单且台账信息足够：用 `update T# ...` 写入结论或下一步，多个合并成一次处理。
   - 新候选：记下，不直接扩大旧工单。
   - 需要用户决定：只问最阻塞的一个，其余排队。
3. 从 E1 起直到某个 E 编号的所有事件都处理完后，运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js ack --upto <该编号>`。没处理的事件不要确认。
4. 汇报一句话结论；有需要决定的问题时只问一个。

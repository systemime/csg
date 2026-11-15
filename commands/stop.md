---
description: 停止 Super-agent 工单和运行中的子代理
argument-hint: "[停止原因或工单号 T#]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js *), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js *), TaskStop
disable-model-invocation: true
---

`$ARGUMENTS` 是停止原因或工单号。

步骤：

1. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js status --json`。参数是工单号时，只记该工单状态为 `running` 的 `owner.agent_id`；否则记下所有状态为 `running` 的工单的 `owner.agent_id`。
2. 参数以工单号开头（形如 `T1 ...`）时，第一个词是工单号，其余是原因，运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js stop T1 --reason "<原因>"`；否则整个参数是原因，运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js stop --reason "<原因>"`。没有给原因就写「用户要求停止」。
3. 只对第 1 步记下的 agent_id 调用 TaskStop；已经结束或无法停止的跳过。停单个工单时不要停其他工单的 Worker。
4. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js status --json`；service 存在时运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js pause --reason "<原因>"`，暂停领取新 job。正在执行的 job 不会中断，如实说明。
5. 用一句话报告：停止了哪些工单、哪些子代理已停、service 是否暂停、哪些外部动作已经发生。

停止不会撤回已推送的提交、已开的 PR 或已发的评论；如实说明这些动作仍然存在，不要声称已撤销。不要恢复或重启工单。

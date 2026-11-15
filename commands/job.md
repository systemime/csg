---
description: 向 Super-agent 确定性服务提交测试、合并、部署或诊断 job
argument-hint: "test --command <cmd> | merge --branch <b> [--target main] | deploy --command <cmd> | agent --prompt <text>"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js *)
---

`$ARGUMENTS` 是 job 参数。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js enqueue --type <type> --project <当前项目> <参数>
```

- `test --command "<配置里的测试命令>"`：运行测试 job。
- `merge --branch <分支> [--target <目标分支>]`：合并 job；默认目标来自 service 配置。
- `deploy --command "<配置里的部署命令>"`：部署 job；默认需要用户批准。
- `agent --prompt "<任务>" [--role <role>]`：需要模型判断时使用；默认关闭。

返回 job id 和状态。`queued` 表示排队，`awaiting` 表示等用户批准；不要把排队说成已执行。部署后提醒用户用 `/super-agent:service approve <job>` 批准。命令必须在 service 配置的允许列表里，不在列表里会执行失败。

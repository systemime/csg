---
description: 管理 Super-agent 确定性服务：初始化、状态、任务、批准、安装
argument-hint: "init|status|list|result <job>|approve <job>|install|start|stop|pause|resume"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js *), AskUserQuestion
disable-model-invocation: true
---

`$ARGUMENTS` 是 service 子命令。

1. `init`：运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js init --project <当前项目>`，把当前项目加入允许列表。
2. `status`：运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js status`，一句话报告是否运行、队列数量、暂停状态。
3. `list`：运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js list`，按状态分组，不逐条贴长输出。
4. `result <job>`：运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js result <job>`，给结论、证据路径和下一步。
5. `approve <job>`：只有用户明确要求批准时执行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js approve <job> --by user`；不要替用户批准。
6. `pause` / `resume`：运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js pause --reason "<原因>"` 或 `resume`；暂停后 service 不再领取新 job，正在跑的 job 继续。
7. `install`：运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js install` 只生成 launchd、systemd、Windows 计划任务文件和安装命令，不执行安装。生成后用 AskUserQuestion 问用户是否现在执行对应平台的安装命令；用户选是再执行，选否只给路径。
8. `start` / `stop`：手动启动或停止当前 Node service 进程；`start` 是临时后台进程，不是开机自启。

不要修改 `~/.claude/settings.json`，不要自动注册计划任务。部署和 PR 合并仍按 service 配置执行；批准只能由用户做。

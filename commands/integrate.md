---
description: 为原工单新建集成工单，派 Integrator 汇合分支、跑检查并开 PR
argument-hint: "T#"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js *), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js *), Agent
---

`$ARGUMENTS` 是原工单号（形如 `T1`）。

步骤：

1. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js status --json`，读原工单的 `state`、`source_key`、`source`、`artifacts.branch`、`artifacts.worktree`、`artifacts.pr` 和 `stop`。
2. 没有完成分支时直接说明，不派工。`STOP` 禁止合并时只交付分支名和 diff，原工单保持当前状态，不标完成。
3. 新建集成工单，不要拿原工单号直接派 Integrator；原工单在集成期间保持当前状态（通常是 `awaiting_integration`）：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js add \
     --source-key "integration:T1:<分支或PR>" \
     --title "集成 T1 到 <目标分支>" \
     --source "集成目标 <目标分支>；分支 <分支>；worktree <路径>；检查 <检查命令>；原请求：<原文>" \
     --json
   ```

   把 `T1`、分支、目标分支、检查命令和原请求换成实际值。读输出里的 `ticket.id`（如 `T2`）；如果已有同 `source_key` 的工单，复用返回的工单号。
4. 先运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js status --json`。service 已启用且当前项目在允许列表时，直接提交确定性合并 job，不派 Integrator：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js enqueue \
     --type merge \
     --project <当前项目> \
     --branch <分支名> \
     --target <目标分支> \
     --ticket T2
   ```

   记下 job id，告诉用户「已排队」，不要说已合并。service 不可用或已暂停时，才派 `super-agent:super-agent-integrator`，brief 前两行必须是：

   ```text
   TICKET: T2
   SOURCE_KEY: integration:T1:<分支或PR>
   ```

   其余写 `INTEGRATE_TICKET: T1`、分支、worktree、目标、PR、检查命令和原请求；要求独立分支或 worktree 汇合，跑检查，开 PR，不直接推默认分支，不合并 PR。
5. 等 service 结果：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/csg-service.js result <job>
   ```

   成功时更新集成工单的证据、分支和 PR；只有 PR 已合并或集成分支已经合入目标，才把原工单标为完成；PR 已打开但未合并时，原工单保持 `awaiting_integration`：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js update T1 --state done --evidence "集成完成，PR #<编号> <链接>"
   ```

   失败时读 result 里的 `worktree` 和检查输出；需要冲突处理或诊断时，再派 Integrator，把 worktree 路径和失败输出放进 brief。集成工单开了 PR 后运行 `csg.js watch <集成工单号> --pr <编号>`。给用户一句话和 PR 链接。

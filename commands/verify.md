---
description: 派只读 Verifier 复核工单证据
argument-hint: "T#"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js *), Agent
---

`$ARGUMENTS` 是工单号（形如 `T1`）。

步骤：

1. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/csg.js status --json`，按工单号取出 `source_key`、`source`、`evidence`、`changed`、`artifacts`（branch/PR/worktree）和未决问题。不要自己读大段代码。
2. 派 `super-agent:super-agent-verifier`。brief 用下面的纯文本格式，前两行必须原样保留字段名，缺 `TICKET` 或 `SOURCE_KEY` 会被 PreToolUse 钩子拒绝：

   ```text
   TICKET: T1
   SOURCE_KEY: <从 status --json 原样复制>
   EVIDENCE: <证据路径或命令与结果摘要>
   FILES: <要复核的文件、diff 或 PR 路径>
   SOURCE: <原始请求逐字引用>
   QUESTION: <要复核的具体问题；没有写 none>
   ```

   把 `T1`、`SOURCE_KEY` 和尖括号占位符换成台账里的实际值。要求只读复核：不改文件、不给实现方案，只返回 `VERDICT`。
3. 收到 `VERDICT` 后按结论处理：
   - 通过：用 `update T# --evidence "<VERDICT 摘要和证据路径>" ...` 更新台账。如果工单停在 `ready`，补齐证据后按 `artifacts` 转 `awaiting_review`、`awaiting_integration` 或 `done`。再给用户一句话。
   - 不通过：状态允许时用 `update T# --state blocked --question "<具体问题>" ...` 更新台账，只问这一个问题。

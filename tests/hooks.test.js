'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  hook,
  hookJson,
  initProject,
  readLedger,
  runCli,
  runCliJson,
  submitReport,
} = require('./helpers');

function denied(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), '', 'hook 应输出 permissionDecision');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  return output.hookSpecificOutput.permissionDecisionReason;
}

function notDenied(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '', `不应 deny，实际输出: ${result.stdout}`);
}

function stoppedProject(t) {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '任务一', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);
  const stop = runCli(root, ['stop']);
  assert.equal(stop.status, 0, stop.stderr);
  return root;
}

function projectWithRunningTicket(t) {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '任务一', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);
  return root;
}

const preToolUse = (extra) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: {
    subagent_type: 'super-agent:super-agent-worker',
    prompt: 'TICKET: T1\nSOURCE_KEY: k1',
  },
  ...extra,
});

test('PreToolUse: 缺少 TICKET/SOURCE_KEY 的 worker 派工被 deny', (t) => {
  const root = initProject(t);
  const result = hook(root, 'pre-tool-use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'super-agent:super-agent-worker', prompt: '实现登录修复' },
  });
  assert.match(denied(result), /TICKET 或 SOURCE_KEY/);
});

test('PreToolUse: proposed 工单派工被 deny', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '候选任务', '--state', 'proposed', '--json']);

  const result = hook(root, 'pre-tool-use', preToolUse());
  assert.match(denied(result), /proposed/);
});

test('PreToolUse: 已有 owner 且 running 的工单再次派工被 deny', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '实现登录修复', '--json']);

  const started = hook(root, 'post-tool-use', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'super-agent:super-agent-worker',
      prompt: 'TICKET: T1\nSOURCE_KEY: k1',
    },
    tool_response: { agentId: 'a1', status: 'running' },
  });
  assert.equal(started.status, 0, started.stderr);

  const ticket = readLedger(root).tickets[0];
  assert.equal(ticket.state, 'running');
  assert.equal(ticket.owner.agent_id, 'a1');

  const result = hook(root, 'pre-tool-use', preToolUse());
  assert.match(denied(result), /已有 Worker a1/);
});

test('PreToolUse: stop 后子代理 Bash 被 deny', (t) => {
  const root = stoppedProject(t);
  const result = hook(root, 'pre-tool-use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    agent_id: 'a1',
    agent_type: 'super-agent:super-agent-worker',
  });
  assert.match(denied(result), /停止/);
});

test('PreToolUse: stop 后主会话 Agent 被 deny', (t) => {
  const root = stoppedProject(t);
  const result = hook(root, 'pre-tool-use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'super-agent:super-agent-worker', prompt: 'TICKET: T1\nSOURCE_KEY: k1' },
  });
  assert.match(denied(result), /停止/);
});

test('PreToolUse: stop 后主会话 Bash 不被 deny（Router 要能执行 resume）', (t) => {
  const root = stoppedProject(t);
  const result = hook(root, 'pre-tool-use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node scripts/csg.js resume' },
  });
  notDenied(result);
});

test('PreToolUse: Worker 的 git stash 与 gh pr merge 被 deny', (t) => {
  const root = projectWithRunningTicket(t);
  const base = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    agent_id: 'a1',
    agent_type: 'super-agent:super-agent-worker',
  };

  const stash = hook(root, 'pre-tool-use', { ...base, tool_input: { command: 'git stash push -m wip' } });
  assert.match(denied(stash), /stash/);

  const merge = hook(root, 'pre-tool-use', { ...base, tool_input: { command: 'gh pr merge 34 --squash' } });
  assert.match(denied(merge), /合并/);
});

test('PreToolUse: 集成 Worker 的 git merge 不被 deny', (t) => {
  const root = projectWithRunningTicket(t);
  const result = hook(root, 'pre-tool-use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    agent_id: 'a2',
    agent_type: 'super-agent:super-agent-integrator',
    tool_input: { command: 'git merge --no-ff t1-fix' },
  });
  notDenied(result);
});

test('PreToolUse: Worker 不能写 .claude/super-agent/', (t) => {
  const root = projectWithRunningTicket(t);
  const result = hook(root, 'pre-tool-use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    agent_id: 'a1',
    agent_type: 'super-agent:super-agent-worker',
    tool_input: {
      file_path: path.join(root, '.claude', 'super-agent', 'ledger.json'),
      content: '{}',
    },
  });
  assert.match(denied(result), /台账/);
});

test('PreToolUse: Verifier 是只读代理，Write 被 deny', (t) => {
  const root = projectWithRunningTicket(t);
  const result = hook(root, 'pre-tool-use', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    agent_id: 'v1',
    agent_type: 'super-agent:super-agent-verifier',
    tool_input: {
      file_path: path.join(root, 'src', 'app.js'),
      content: 'x',
    },
  });
  assert.match(denied(result), /只读/);
});

test('UserPromptSubmit: 有未确认事件时输出 additionalContext 和事件摘要', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '核对配置', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);
  submitReport(root, 'TICKET: T1\nSTATE: ready\nSUMMARY: 已完成');

  const output = hookJson(root, 'user-prompt-submit', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-1',
    prompt: '继续',
  });

  assert.ok(output, '应输出 additionalContext');
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /未确认事件/);
  assert.match(context, /ready_without_evidence/);
  assert.match(context, /T1 报 ready 但没有证据/);
});

test('SessionStart: 有台账时注入工单摘要，没有台账时不输出', (t) => {
  const root = initProject(t);
  const empty = hookJson(root, 'session-start', {
    hook_event_name: 'SessionStart',
    session_id: 'sess-start',
    source: 'startup',
  });
  assert.ok(empty, '有台账时应注入摘要');
  assert.match(empty.hookSpecificOutput.additionalContext, /当前没有进行中的工单/);

  runCliJson(root, ['add', '--source-key', 'k1', '--source', '修复登录超时', '--json']);
  const output = hookJson(root, 'session-start', {
    hook_event_name: 'SessionStart',
    session_id: 'sess-start',
    source: 'compact',
  });
  assert.match(output.hookSpecificOutput.additionalContext, /T1 open/);
  assert.match(output.hookSpecificOutput.additionalContext, /上下文|台账/);
});

test('UserPromptSubmit: 同一会话连续两次提交，第二次不再重复注入', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '核对配置', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);
  submitReport(root, 'TICKET: T1\nSTATE: ready\nSUMMARY: 已完成');

  const input = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-repeat',
    prompt: '继续',
  };

  const first = hook(root, 'user-prompt-submit', input);
  assert.notEqual(first.stdout.trim(), '', '第一次提交应注入摘要');

  const second = hook(root, 'user-prompt-submit', input);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), '', `第二次提交不应重复注入，实际输出: ${second.stdout}`);
});

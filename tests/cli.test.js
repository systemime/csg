'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../scripts/lib/store');
const {
  initProject,
  makeProject,
  readEvents,
  readLedger,
  runCli,
  runCliJson,
  submitReport,
} = require('./helpers');

const superAgentDir = (root) => path.join(root, '.claude', 'super-agent');

test('findProjectRoot 从子目录向上找到含 .git 的项目根', (t) => {
  const root = makeProject(t);
  fs.mkdirSync(path.join(root, '.git'));
  const nested = path.join(root, 'src', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(store.findProjectRoot(nested), root);
});

test('init 生成 ledger.json、ledger.md、.gitignore，重复执行幂等', (t) => {
  const root = makeProject(t);

  const first = runCli(root, ['init']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^created /);

  const dir = superAgentDir(root);
  for (const name of ['ledger.json', 'ledger.md', '.gitignore']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} 应存在`);
  }
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n!.gitignore\n');

  const before = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');
  const second = runCli(root, ['init']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^exists /);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'), before);
  assert.equal(readLedger(root).tickets.length, 0);
  assert.equal(readLedger(root).mode, 'active');
});

test('add 自动分配 T1，同一 SOURCE_KEY 第二次返回 duplicate 且不新增工单', (t) => {
  const root = initProject(t);

  const first = runCliJson(root, ['add', '--source-key', 'msg-1:t1:0', '--source', '修复登录超时', '--json']);
  assert.equal(first.duplicate, false);
  assert.equal(first.ticket.id, 'T1');
  assert.equal(first.ticket.state, 'open');
  assert.equal(first.ticket.source_key, 'msg-1:t1:0');
  assert.match(first.ticket.request_hash, /^[0-9a-f]{12}$/);

  const second = runCliJson(root, ['add', '--source-key', 'msg-1:t1:0', '--source', '改写后的请求文本', '--json']);
  assert.equal(second.duplicate, true);
  assert.equal(second.ticket.id, 'T1');

  const ledger = readLedger(root);
  assert.equal(ledger.tickets.length, 1);
  assert.equal(ledger.tickets[0].source_key, 'msg-1:t1:0');
});

test('add 遇到相同 REQUEST_HASH 返回 warning 但仍建新工单', (t) => {
  const root = initProject(t);

  runCliJson(root, ['add', '--source-key', 'k1', '--source', '修复登录超时', '--json']);
  const second = runCliJson(root, ['add', '--source-key', 'k2', '--source', '修复登录超时', '--json']);
  assert.equal(second.duplicate, false);
  assert.equal(second.ticket.id, 'T2');
  assert.equal(second.same_hash, 'T1');

  const third = runCli(root, ['add', '--source-key', 'k3', '--source', '修复登录超时']);
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /warning: same request_hash as T1/);
  assert.equal(readLedger(root).tickets.length, 3);
});

test('update 接受连字符参数 --owner-agent、--artifact-pr、--subagent-type', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '修复登录超时', '--json']);

  const result = runCli(root, [
    'update', 'T1', '--state', 'running',
    '--owner-agent', 'agent-1',
    '--artifact-pr', '34',
    '--subagent-type', 'super-agent:super-agent-worker',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const ticket = readLedger(root).tickets[0];
  assert.equal(ticket.state, 'running');
  assert.equal(ticket.owner.agent_id, 'agent-1');
  assert.equal(ticket.owner.subagent_type, 'super-agent:super-agent-worker');
  assert.equal(ticket.artifacts.pr, '34');
});

test('状态机：running 可以到 ready，running 直接到 awaiting_review 被拒绝', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '修复登录超时', '--json']);

  const running = runCli(root, ['update', 'T1', '--state', 'running']);
  assert.equal(running.status, 0, running.stderr);
  assert.equal(readLedger(root).tickets[0].state, 'running');

  const invalid = runCli(root, ['update', 'T1', '--state', 'awaiting_review']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid transition: running -> awaiting_review/);
  assert.equal(readLedger(root).tickets[0].state, 'running');

  const ready = runCli(root, ['update', 'T1', '--state', 'ready']);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(readLedger(root).tickets[0].state, 'ready');
});

test('状态机：stopped 是终态，不能复活', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '修复登录超时', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);

  const stop = runCli(root, ['stop', 'T1']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(readLedger(root).tickets[0].state, 'stopped');

  const revive = runCli(root, ['update', 'T1', '--state', 'running']);
  assert.notEqual(revive.status, 0);
  assert.match(revive.stderr, /invalid transition: stopped -> running/);
  assert.equal(readLedger(root).tickets[0].state, 'stopped');

  const resume = runCli(root, ['resume', 'T1']);
  assert.notEqual(resume.status, 0);
  assert.match(resume.stderr, /stopped 是终态/);
});

test('report 解析 TICKET/STATE，带 PR 的 ready 转为 awaiting_review', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '修复登录超时', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);

  const text = [
    'TICKET: T1',
    'STATE: ready',
    'SUMMARY: 登录超时修复完成',
    'CHANGED: src/login.ts:42',
    'ARTIFACTS: PR #34',
    'EVIDENCE: node --test tests/login 通过',
    'NEXT: 等待评审',
  ].join('\n');

  const result = submitReport(root, text);
  assert.equal(result.applied, true);
  assert.equal(result.state, 'awaiting_review');

  const ticket = readLedger(root).tickets[0];
  assert.equal(ticket.state, 'awaiting_review');
  assert.match(String(ticket.artifacts.pr), /34/);
  assert.equal(ticket.evidence, 'node --test tests/login 通过');
  assert.equal(ticket.changed, 'src/login.ts:42');
});

test('report 的 ready 带分支但无 PR 时转为 awaiting_integration', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '拆分导出模块', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);

  const result = submitReport(root, [
    'TICKET: T1',
    'STATE: ready',
    'SUMMARY: 分支完成',
    'ARTIFACTS: branch: t1-export-fix',
    'EVIDENCE: node --test tests/export 通过',
  ].join('\n'));

  assert.equal(result.applied, true);
  assert.equal(result.state, 'awaiting_integration');
  const ticket = readLedger(root).tickets[0];
  assert.equal(ticket.state, 'awaiting_integration');
  assert.equal(ticket.artifacts.branch, 't1-export-fix');
});

test('report 的 ready 无 PR、无分支时转为 done', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '更新文档链接', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);

  const result = submitReport(root, [
    'TICKET: T1',
    'STATE: ready',
    'SUMMARY: 文档链接已更新',
    'EVIDENCE: node --test tests/docs 通过',
  ].join('\n'));

  assert.equal(result.applied, true);
  assert.equal(result.state, 'done');
  assert.equal(readLedger(root).tickets[0].state, 'done');
});

test('report 的 ready 无 EVIDENCE 记录 ready_without_evidence 事件且状态保持 ready', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '核对配置', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);

  const result = submitReport(root, 'TICKET: T1\nSTATE: ready\nSUMMARY: 已完成');
  assert.equal(result.applied, true);
  assert.equal(result.state, 'ready');
  assert.equal(result.evidence_missing, true);

  const events = runCliJson(root, ['events', '--json']);
  const event = events.find((item) => item.type === 'ready_without_evidence');
  assert.ok(event, '应写入 ready_without_evidence 事件');
  assert.equal(event.ticket, 'T1');
  assert.equal(event.notified, false);
  assert.equal(readLedger(root).tickets[0].state, 'ready');
});

test('report 的 blocked 无 QUESTION 记录 blocked_without_question 事件', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '部署预发环境', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);

  const result = submitReport(root, [
    'TICKET: T1',
    'STATE: blocked',
    'SUMMARY: 缺少部署凭据',
    'EVIDENCE: 尝试部署返回 403',
    'QUESTION: 无',
  ].join('\n'));

  assert.equal(result.applied, true);
  assert.equal(result.state, 'blocked');

  const events = runCliJson(root, ['events', '--json']);
  const event = events.find((item) => item.type === 'blocked_without_question');
  assert.ok(event, '应写入 blocked_without_question 事件');
  assert.equal(event.ticket, 'T1');
  assert.equal(readLedger(root).tickets[0].state, 'blocked');
  assert.equal(readLedger(root).tickets[0].question, '');
});

test('重复提交同一报告不重复更新工单', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '修复登录超时', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);

  const text = [
    'TICKET: T1',
    'STATE: ready',
    'SUMMARY: 登录超时修复完成',
    'ARTIFACTS: PR #34',
    'EVIDENCE: node --test tests/login 通过',
  ].join('\n');

  const first = submitReport(root, text);
  assert.equal(first.applied, true);
  const before = readLedger(root).tickets[0];
  const eventsBefore = readEvents(root).length;

  const second = submitReport(root, text);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'duplicate');

  const after = readLedger(root).tickets[0];
  assert.equal(after.state, before.state);
  assert.equal(after.report_hash, before.report_hash);
  assert.equal(after.history.length, before.history.length);
  assert.equal(after.artifacts.report, before.artifacts.report);
  assert.equal(readEvents(root).length, eventsBefore);
});

test('全局 stop 标记 stopped 并停止活动工单，resume 后旧工单仍是 stopped', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '任务一', '--json']);
  runCliJson(root, ['add', '--source-key', 'k2', '--source', '任务二', '--json']);
  runCli(root, ['update', 'T1', '--state', 'running']);

  const stop = runCliJson(root, ['stop', '--json', '--reason', '用户要求停止']);
  assert.equal(stop.scope, 'all');
  assert.deepEqual([...stop.stopped].sort(), ['T1', 'T2']);

  let ledger = readLedger(root);
  assert.equal(ledger.stopped, true);
  assert.equal(ledger.stop_reason, '用户要求停止');
  assert.deepEqual(ledger.tickets.map((ticket) => ticket.state), ['stopped', 'stopped']);

  const resume = runCli(root, ['resume']);
  assert.equal(resume.status, 0, resume.stderr);
  assert.match(resume.stdout, /2 stopped ticket/);

  ledger = readLedger(root);
  assert.equal(ledger.stopped, false);
  assert.equal(ledger.stop_reason, '');
  assert.deepEqual(ledger.tickets.map((ticket) => ticket.state), ['stopped', 'stopped']);
});

test('statusline 输出 open、blocked、events 计数', (t) => {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '任务一', '--json']);
  runCliJson(root, ['add', '--source-key', 'k2', '--source', '任务二', '--json']);
  runCli(root, ['update', 'T2', '--state', 'blocked', '--question', '需要选择方案']);
  store.appendEvent(root, { source: 'test', type: 'note', ticket: 'T2', summary: '一条未确认事件' });

  const result = runCli(root, ['statusline'], {
    input: JSON.stringify({ workspace: { current_dir: root }, cwd: root }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SA /);
  assert.match(result.stdout, /2 open/);
  assert.match(result.stdout, /1 blocked/);
  assert.match(result.stdout, /1 events/);
});

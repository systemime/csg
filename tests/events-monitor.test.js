'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../scripts/lib/store');
const {
  hookJson,
  initProject,
  makeFakeGh,
  readEvents,
  readLedger,
  runCli,
  runCliJson,
} = require('./helpers');

const prPayload = (checkConclusion) => ({
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [{ state: checkConclusion, conclusion: checkConclusion }],
  url: 'https://example.test/pull/1',
  headRefName: 't1-login-fix',
});

function monitorProject(t) {
  const root = initProject(t);
  runCliJson(root, ['add', '--source-key', 'k1', '--source', '修复登录超时', '--json']);
  const watch = runCli(root, ['watch', 'T1', '--pr', '1']);
  assert.equal(watch.status, 0, watch.stderr);

  const gh = makeFakeGh(root);
  gh.setPr(prPayload('SUCCESS'));
  return { root, gh };
}

function runMonitor({ root, gh }) {
  return runCli(root, ['monitor'], { env: gh.env });
}

test('appendEvent 分配递增 seq，并按 dedupe_key 去重', (t) => {
  const root = initProject(t);

  const first = store.appendEvent(root, { source: 'test', type: 'note', ticket: 'T1', summary: '第一条', dedupe_key: 'dup-1' });
  const second = store.appendEvent(root, { source: 'test', type: 'note', ticket: 'T1', summary: '第二条', dedupe_key: 'dup-1' });
  const third = store.appendEvent(root, { source: 'test', type: 'note', ticket: 'T1', summary: '第三条' });

  assert.equal(first.added, true);
  assert.equal(first.event.seq, 1);
  assert.equal(second.added, false);
  assert.equal(second.event.seq, 1);
  assert.equal(third.added, true);
  assert.equal(third.event.seq, 2);
  assert.deepEqual(readEvents(root).map((event) => event.summary), ['第一条', '第三条']);
});

test('ack --upto 只确认到指定 seq，events 不再返回已确认事件', (t) => {
  const root = initProject(t);
  for (const summary of ['一', '二', '三']) {
    store.appendEvent(root, { source: 'test', type: 'note', summary });
  }

  const ack = runCli(root, ['ack', '--upto', '2']);
  assert.equal(ack.status, 0, ack.stderr);
  assert.match(ack.stdout, /acked through E2/);
  assert.equal(readLedger(root).ack_seq, 2);

  let events = runCliJson(root, ['events', '--json']);
  assert.deepEqual(events.map((event) => event.seq), [3]);

  const ackAll = runCli(root, ['ack']);
  assert.match(ackAll.stdout, /acked through E3/);
  events = runCliJson(root, ['events', '--json']);
  assert.deepEqual(events, []);
});

test('monitor 第一次只记基线，第二次 CI 失败产生 notified 的 ci 事件', (t) => {
  const ctx = monitorProject(t);

  const first = runMonitor(ctx);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(readEvents(ctx.root), [], '第一次监控不应产生事件');

  const watchStateFile = path.join(ctx.root, '.claude', 'super-agent', 'watch-state.json');
  const watchState = JSON.parse(fs.readFileSync(watchStateFile, 'utf8'));
  assert.equal(watchState['T1:pr:1'].signals.checks, 'passed');
  assert.equal(watchState['T1:pr:1'].signals.state, 'OPEN');

  ctx.gh.setPr(prPayload('FAILURE'));
  const second = runMonitor(ctx);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /checks failed/);

  const events = runCliJson(ctx.root, ['events', '--json']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ci');
  assert.equal(events[0].ticket, 'T1');
  assert.equal(events[0].notified, true);
  assert.match(events[0].summary, /T1 PR #1 checks failed/);
  assert.match(events[0].summary, /https:\/\/example\.test\/pull\/1/);
});

test('monitor 标记 notified 的事件不出现在 UserPromptSubmit 摘要', (t) => {
  const ctx = monitorProject(t);
  runMonitor(ctx);
  ctx.gh.setPr(prPayload('FAILURE'));
  const second = runMonitor(ctx);
  assert.equal(second.status, 0, second.stderr);

  const output = hookJson(ctx.root, 'user-prompt-submit', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'monitor-session',
    prompt: '继续',
  });

  assert.ok(output, '仍应输出工单摘要');
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /T1 open/);
  assert.doesNotMatch(context, /checks failed/);
  assert.doesNotMatch(context, /monitor\/ci/);
  assert.doesNotMatch(context, /未确认事件/);
});

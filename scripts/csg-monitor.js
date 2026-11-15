#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./lib/store');

const DEFAULT_INTERVAL = 60;
const FIRST_DELAY_MS = 3000;
let ghChecked = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function print(line) {
  process.stdout.write(`[csg] ${store.sanitizeText(line)}\n`);
}

function ghAvailable() {
  if (ghChecked !== null) return ghChecked;
  const result = spawnSync('gh', ['--version'], { encoding: 'utf8', timeout: 5000 });
  ghChecked = result.status === 0;
  return ghChecked;
}

function ghJson(args, cwd) {
  const result = spawnSync('gh', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  });
  if (result.error || result.status !== 0) {
    const message = String(result.stderr || result.error || 'gh failed').trim().split(/\r?\n/)[0];
    return { error: message };
  }
  try {
    return { value: JSON.parse(result.stdout) };
  } catch {
    return { error: 'gh returned invalid JSON' };
  }
}

function aggregateChecks(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return 'none';
  const states = rollup.map((item) => String(item.conclusion || item.state || '').toUpperCase());
  if (states.some((state) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state))) return 'failed';
  if (states.some((state) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', ''].includes(state))) return 'pending';
  return 'passed';
}

function readWatchState(root) {
  return store.readJson(store.paths(root).watchState, {}) || {};
}

function writeWatchState(root, state) {
  store.writeAtomic(store.paths(root).watchState, `${JSON.stringify(state, null, 2)}\n`);
}

function activeWatches(ledger) {
  return ledger.tickets.filter((ticket) =>
    store.ACTIVE.has(ticket.state) &&
    ticket.watch &&
    (ticket.watch.pr || (ticket.watch.branch && ticket.watch.ci)));
}

function pollServiceResults(root, state) {
  const dir = path.join(root, '.claude', 'super-agent', 'service-results');
  if (!store.exists(dir)) return 0;
  state.serviceResults = state.serviceResults || {};
  let printed = 0;
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  for (const name of files) {
    if (state.serviceResults[name]) continue;
    const record = store.readJson(path.join(dir, name), null);
    if (!record || !record.summary) continue;
    print(`job ${record.id} ${record.state}: ${record.summary}`);
    state.serviceResults[name] = record.finished_at || store.nowIso();
    printed += 1;
  }
  return printed;
}

function prSignals(pr) {
  return {
    state: String(pr.state || 'UNKNOWN'),
    mergeable: String(pr.mergeable || 'UNKNOWN'),
    review: String(pr.reviewDecision || 'none'),
    checks: aggregateChecks(pr.statusCheckRollup),
  };
}

function signalSummary(ticket, pr, key, value) {
  const url = pr.url ? ` ${pr.url}` : '';
  switch (key) {
    case 'checks':
      return `${ticket.id} PR #${ticket.watch.pr} checks ${value}${url}`;
    case 'mergeable':
      return `${ticket.id} PR #${ticket.watch.pr} mergeable=${value}${url}`;
    case 'review':
      return `${ticket.id} PR #${ticket.watch.pr} review=${value}${url}`;
    default:
      return `${ticket.id} PR #${ticket.watch.pr} state=${value}${url}`;
  }
}

function emitChange(root, ticket, pr, key, value, signalState) {
  const stateKey = `${ticket.id}:pr:${ticket.watch.pr}`;
  const previous = signalState[stateKey] || { signals: {}, revision: 0 };
  previous.revision = (previous.revision || 0) + 1;
  previous.signals[key] = value;
  previous.url = pr.url || previous.url || '';
  signalState[stateKey] = previous;

  const event = store.appendEvent(root, {
    source: 'monitor',
    type: key === 'checks' ? 'ci' : `pr_${key}`,
    ticket: ticket.id,
    summary: signalSummary(ticket, pr, key, value),
    dedupe_key: `${stateKey}:${key}:${value}:${previous.revision}`,
    notified: true,
  });
  if (event.added) print(signalSummary(ticket, pr, key, value));
}

function pollPr(root, ticket, state, errors) {
  const pr = ticket.watch.pr;
  const args = [
    'pr', 'view', String(pr),
    '--json', 'state,isDraft,mergeable,reviewDecision,statusCheckRollup,url,headRefName',
  ];
  if (ticket.watch.repo) args.push('--repo', ticket.watch.repo);
  const result = ghJson(args, root);
  if (result.error) {
    const key = `${ticket.id}:pr:${pr}`;
    const previous = state[key] || {};
    if (previous.error !== result.error) {
      previous.error = result.error;
      state[key] = previous;
      print(`${ticket.id} PR #${pr} 查询失败: ${result.error}`);
    }
    errors.add(result.error);
    return;
  }
  const data = result.value || {};
  const signals = prSignals(data);
  const key = `${ticket.id}:pr:${pr}`;
  const previous = state[key];
  if (!previous || !previous.signals) {
    state[key] = { signals, revision: 0, url: data.url || '' };
    return;
  }
  delete previous.error;
  for (const [name, value] of Object.entries(signals)) {
    if (previous.signals[name] !== value) {
      emitChange(root, ticket, data, name, value, state);
    }
  }
}

function pollBranchRun(root, ticket, state, errors) {
  const branch = ticket.watch.branch;
  const args = [
    'run', 'list', '--branch', branch, '--limit', '1',
    '--json', 'databaseId,status,conclusion,workflowName,url',
  ];
  if (ticket.watch.repo) args.push('--repo', ticket.watch.repo);
  const result = ghJson(args, root);
  if (result.error) {
    errors.add(result.error);
    return;
  }
  const run = Array.isArray(result.value) ? result.value[0] : null;
  if (!run) return;
  const key = `${ticket.id}:branch:${branch}`;
  const previous = state[key];
  const signals = {
    status: String(run.status || 'unknown'),
    conclusion: String(run.conclusion || ''),
  };
  if (!previous || !previous.signals) {
    state[key] = { signals, revision: 0, url: run.url || '' };
    return;
  }
  for (const [name, value] of Object.entries(signals)) {
    if (previous.signals[name] !== value) {
      previous.revision = (previous.revision || 0) + 1;
      previous.signals[name] = value;
      const summary = `${ticket.id} ${run.workflowName || 'CI'} ${name}=${value || 'none'}${run.url ? ` ${run.url}` : ''}`;
      const event = store.appendEvent(root, {
        source: 'monitor',
        type: 'ci',
        ticket: ticket.id,
        summary,
        dedupe_key: `${key}:${name}:${value}:${previous.revision}`,
        notified: true,
      });
      if (event.added) print(summary);
    }
  }
}

function poll(root) {
  const state = readWatchState(root);
  const serviceResults = pollServiceResults(root, state);
  const ledger = store.readLedger(root);
  if (!ledger) {
    if (serviceResults) writeWatchState(root, state);
    return { watches: 0, serviceResults };
  }
  const normalized = store.normalizeLedger(ledger);
  const watches = activeWatches(normalized);
  if (!watches.length) {
    writeWatchState(root, state);
    return { watches: 0, serviceResults };
  }
  if (!ghAvailable()) {
    print('gh CLI 未安装，PR/CI 监控不可用；安装 gh 并登录后重启会话。');
    writeWatchState(root, state);
    return { watches: watches.length, serviceResults, noGh: true };
  }
  const errors = new Set();
  for (const ticket of watches) {
    if (ticket.watch.pr) pollPr(root, ticket, state, errors);
    if (ticket.watch.branch && ticket.watch.ci && !ticket.watch.pr) {
      pollBranchRun(root, ticket, state, errors);
    }
  }
  writeWatchState(root, state);
  return { watches: watches.length, serviceResults, errors: [...errors] };
}

async function run(root) {
  const once = process.env.CSG_MONITOR_ONCE === '1';
  const interval = Math.max(15, Number.parseInt(process.env.CSG_MONITOR_INTERVAL || '', 10) || DEFAULT_INTERVAL);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  if (!once) await sleep(FIRST_DELAY_MS);
  for (;;) {
    if (stopping) return;
    const result = poll(root);
    if (result.noGh) return;
    if (once) return;
    const waitMs = interval * 1000;
    let waited = 0;
    while (waited < waitMs && !stopping) {
      const step = Math.min(1000, waitMs - waited);
      await sleep(step);
      waited += step;
    }
  }
}

module.exports = { aggregateChecks, poll, run };

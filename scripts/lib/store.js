'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const TERMINAL = new Set(['done', 'stopped', 'dropped', 'handed_back']);
const ACTIVE = new Set(['proposed', 'open', 'running', 'waiting', 'blocked', 'failed', 'ready', 'awaiting_review', 'awaiting_integration']);

const STATES = [
  'proposed', 'open', 'running', 'waiting', 'blocked', 'failed', 'handed_back',
  'ready', 'awaiting_review', 'awaiting_integration', 'done', 'stopped', 'dropped',
];

const TRANSITIONS = {
  proposed: ['open', 'dropped'],
  open: ['running', 'waiting', 'blocked', 'failed', 'handed_back', 'ready', 'stopped', 'dropped'],
  running: ['waiting', 'blocked', 'failed', 'handed_back', 'ready', 'stopped', 'dropped'],
  waiting: ['running', 'blocked', 'failed', 'handed_back', 'ready', 'stopped', 'dropped'],
  blocked: ['running', 'waiting', 'failed', 'handed_back', 'ready', 'stopped', 'dropped'],
  failed: ['running', 'waiting', 'blocked', 'handed_back', 'ready', 'stopped', 'dropped'],
  handed_back: ['done'],
  ready: ['awaiting_review', 'awaiting_integration', 'done', 'waiting', 'blocked', 'stopped'],
  awaiting_review: ['done', 'blocked', 'waiting', 'stopped'],
  awaiting_integration: ['done', 'blocked', 'waiting', 'stopped'],
  done: ['running'],
  stopped: [],
  dropped: ['done'],
};

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shortHash(value, length = 12) {
  return sha256(value).slice(0, length);
}

function normalizeRequest(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function requestHash(request, target) {
  return shortHash(`${normalizeRequest(request)}|${String(target || '').trim()}`);
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, '.git')) || exists(path.join(dir, '.claude'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function projectRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return findProjectRoot(process.cwd());
}

function paths(root) {
  const base = path.join(root, '.claude', 'super-agent');
  return {
    root,
    base,
    ledger: path.join(base, 'ledger.json'),
    markdown: path.join(base, 'ledger.md'),
    events: path.join(base, 'events.jsonl'),
    artifacts: path.join(base, 'artifacts'),
    sessions: path.join(base, 'sessions'),
    lock: path.join(base, '.lock'),
    watchState: path.join(base, 'watch-state.json'),
    gitignore: path.join(base, '.gitignore'),
  };
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDirs(p) {
  fs.mkdirSync(p.base, { recursive: true });
  fs.mkdirSync(p.artifacts, { recursive: true });
  fs.mkdirSync(p.sessions, { recursive: true });
  if (!exists(p.gitignore)) {
    fs.writeFileSync(p.gitignore, '*\n!.gitignore\n');
  }
}

function withLock(root, fn) {
  const p = paths(root);
  fs.mkdirSync(p.base, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(p.lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(p.lock);
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.rmdirSync(p.lock);
          continue;
        }
      } catch {
        // lock vanished between stat and read; retry
      }
      if (Date.now() - started > 5000) throw new Error('ledger lock timeout');
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(p.lock);
    } catch {
      // another process already removed a stale lock
    }
  }
}

function defaultLedger() {
  const ts = nowIso();
  return {
    version: VERSION,
    created_at: ts,
    updated_at: ts,
    mode: 'active',
    stopped: false,
    stop_reason: '',
    stop_ts: '',
    next_ticket: 1,
    ack_seq: 0,
    events_count: 0,
    tickets: [],
    agents: {},
  };
}

function readLedger(root) {
  return readJson(paths(root).ledger, null);
}

function normalizeLedger(ledger) {
  const base = defaultLedger();
  const merged = { ...base, ...(ledger || {}) };
  merged.tickets = Array.isArray(merged.tickets) ? merged.tickets : [];
  merged.agents = merged.agents && typeof merged.agents === 'object' ? merged.agents : {};
  merged.next_ticket = Number.isInteger(merged.next_ticket) && merged.next_ticket > 0 ? merged.next_ticket : 1;
  merged.ack_seq = Number.isInteger(merged.ack_seq) ? merged.ack_seq : 0;
  merged.events_count = Number.isInteger(merged.events_count) ? merged.events_count : 0;
  return merged;
}

function init(root, options = {}) {
  return withLock(root, () => {
    const p = paths(root);
    ensureDirs(p);
    const existing = readLedger(root);
    if (existing === null && exists(p.ledger) && !options.reset) {
      throw new Error('ledger.json exists but is not valid JSON; fix it or run init --reset');
    }
    if (existing && !options.reset) {
      const ledger = normalizeLedger(existing);
      writeAtomic(p.markdown, renderMarkdown(ledger, readEvents(root)));
      return { created: false, ledger };
    }
    const ledger = defaultLedger();
    writeAtomic(p.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
    writeAtomic(p.markdown, renderMarkdown(ledger, readEvents(root)));
    return { created: true, ledger };
  });
}

function mutate(root, fn) {
  return withLock(root, () => {
    const p = paths(root);
    ensureDirs(p);
    const raw = readLedger(root);
    if (raw === null && exists(p.ledger)) {
      throw new Error('ledger.json exists but is not valid JSON; fix it before changing state');
    }
    const ledger = normalizeLedger(raw);
    const result = fn(ledger);
    ledger.updated_at = nowIso();
    writeAtomic(p.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
    writeAtomic(p.markdown, renderMarkdown(ledger, readEvents(root)));
    return result === undefined ? ledger : result;
  });
}

function findTicket(ledger, id) {
  if (!ledger || !id) return null;
  return ledger.tickets.find((ticket) => ticket.id === id) || null;
}

function requireTicket(ledger, id) {
  const ticket = findTicket(ledger, id);
  if (!ticket) throw new Error(`ticket not found: ${id}`);
  return ticket;
}

function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

function transition(ticket, to, note) {
  if (!STATES.includes(to)) throw new Error(`unknown state: ${to}`);
  const from = ticket.state;
  if (from === to) return false;
  if (!canTransition(from, to)) {
    throw new Error(`invalid transition: ${from} -> ${to}`);
  }
  ticket.state = to;
  ticket.history = Array.isArray(ticket.history) ? ticket.history : [];
  ticket.history.push({ ts: nowIso(), from, to, note: note || '' });
  if (ticket.history.length > 30) ticket.history = ticket.history.slice(-30);
  return true;
}

function createTicket(ledger, input) {
  const id = input.id || `T${ledger.next_ticket++}`;
  if (findTicket(ledger, id)) throw new Error(`ticket already exists: ${id}`);
  const ts = nowIso();
  const ticket = {
    id,
    state: input.state || 'open',
    title: input.title || firstLine(input.source) || id,
    source_key: input.source_key || '',
    request_hash: input.request_hash || '',
    source: input.source || '',
    scope: input.scope || 'derive-from-source',
    constraints: input.constraints || 'none',
    stop: input.stop || 'none',
    changed: '',
    owner: { agent_id: '', name: '', subagent_type: '' },
    evidence: '',
    artifacts: { pr: '', branch: '', worktree: '', report: '', log: '' },
    question: '',
    options: '',
    default: '',
    next: '',
    ack: '',
    attempts: 0,
    last_error: '',
    rounds: 0,
    unresolved: '',
    stop_complied: '',
    watch: { pr: 0, repo: '', branch: '', ci: false },
    evidence_missing: false,
    report_hash: '',
    created_at: ts,
    updated_at: ts,
    history: [{ ts, from: null, to: input.state || 'open', note: 'created' }],
  };
  if (!STATES.includes(ticket.state)) throw new Error(`unknown state: ${ticket.state}`);
  ledger.tickets.push(ticket);
  return ticket;
}

function touchTicket(ticket) {
  ticket.updated_at = nowIso();
}

function updateTicket(ticket, patch) {
  const allowed = [
    'title', 'scope', 'constraints', 'stop', 'changed', 'evidence', 'question', 'options',
    'default', 'next', 'ack', 'unresolved', 'stop_complied', 'last_error', 'evidence_missing',
    'report_hash',
  ];
  for (const key of allowed) {
    if (patch[key] !== undefined) ticket[key] = patch[key];
  }
  for (const key of ['attempts', 'rounds']) {
    if (patch[key] !== undefined && patch[key] !== '') {
      const value = Number.parseInt(patch[key], 10);
      if (Number.isFinite(value) && value >= 0) ticket[key] = value;
    }
  }
  for (const key of ['pr', 'branch', 'worktree', 'report', 'log']) {
    if (patch[`artifact_${key}`] !== undefined) ticket.artifacts[key] = patch[`artifact_${key}`];
  }
  if (patch.owner_agent !== undefined) ticket.owner.agent_id = patch.owner_agent;
  if (patch.owner_name !== undefined) ticket.owner.name = patch.owner_name;
  if (patch.subagent_type !== undefined) ticket.owner.subagent_type = patch.subagent_type;
  if (patch.pr !== undefined) ticket.watch.pr = Number.parseInt(patch.pr, 10) || 0;
  if (patch.repo !== undefined) ticket.watch.repo = patch.repo;
  if (patch.branch !== undefined) ticket.watch.branch = patch.branch;
  if (patch.ci !== undefined) ticket.watch.ci = patch.ci === true || patch.ci === 'true' || patch.ci === '1';
  touchTicket(ticket);
}

function firstLine(value) {
  return String(value || '').trim().split(/\r?\n/)[0].slice(0, 120);
}

function browserSafeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
}

function sessionPath(root, sessionId) {
  return path.join(paths(root).sessions, `${browserSafeId(sessionId || 'unknown')}.json`);
}

function readSession(root, sessionId) {
  return readJson(sessionPath(root, sessionId), null) || {
    session_id: sessionId || '',
    started_at: nowIso(),
    last_event_seq: 0,
    last_digest: '',
    updated_at: '',
  };
}

function writeSession(root, sessionId, data) {
  const p = paths(root);
  fs.mkdirSync(p.sessions, { recursive: true });
  const merged = { ...readSession(root, sessionId), ...data, updated_at: nowIso() };
  writeAtomic(sessionPath(root, sessionId), `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

function readEvents(root) {
  const file = paths(root).events;
  if (!exists(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore a partial line from a crashed writer
    }
  }
  return events;
}

function appendEvent(root, input) {
  return withLock(root, () => {
    const p = paths(root);
    ensureDirs(p);
    const raw = readLedger(root);
    if (raw === null && exists(p.ledger)) {
      throw new Error('ledger.json exists but is not valid JSON; fix it before appending events');
    }
    const ledger = normalizeLedger(raw);
    const events = readEvents(root);
    const dedupeKey = input.dedupe_key || '';
    if (dedupeKey) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const duplicate = events.find((event) =>
        event.dedupe_key === dedupeKey && new Date(event.ts).getTime() >= cutoff);
      if (duplicate) return { added: false, event: duplicate };
    }
    const seq = events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0) + 1;
    const event = {
      seq,
      id: `E${seq}`,
      ts: nowIso(),
      source: input.source || 'unknown',
      type: input.type || 'event',
      ticket: input.ticket || '',
      summary: sanitizeText(input.summary).slice(0, 500),
      payload: input.payload || null,
      dedupe_key: dedupeKey,
      notified: input.notified === true,
      delivered: false,
    };
    fs.appendFileSync(p.events, `${JSON.stringify(event)}\n`);
    ledger.events_count = seq;
    ledger.updated_at = nowIso();
    writeAtomic(p.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
    writeAtomic(p.markdown, renderMarkdown(ledger, [...events, event]));
    return { added: true, event };
  });
}

function listEvents(root, options = {}) {
  const ledger = normalizeLedger(readLedger(root));
  const since = Number.isFinite(options.since) ? options.since : 0;
  return readEvents(root)
    .filter((event) => event.seq > since)
    .filter((event) => !options.unackedOnly || event.seq > ledger.ack_seq)
    .filter((event) => !options.excludeNotified || !event.notified)
    .slice(0, options.limit || 500);
}

function ackEvents(root, upto) {
  return mutate(root, (ledger) => {
    const max = readEvents(root).reduce((value, event) => Math.max(value, Number(event.seq) || 0), 0);
    const target = upto === undefined ? max : Math.min(Number(upto) || 0, max);
    ledger.ack_seq = Math.max(ledger.ack_seq, target);
    return ledger.ack_seq;
  });
}

function saveArtifact(root, name, text) {
  const p = paths(root);
  fs.mkdirSync(p.artifacts, { recursive: true });
  const file = path.join(p.artifacts, browserSafeId(name));
  writeAtomic(file, String(text || ''));
  return path.relative(root, file);
}

function sanitizeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeCell(value) {
  return sanitizeText(value).replace(/\|/g, '\\|');
}

function short(value, length = 80) {
  const text = sanitizeText(value);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function renderMarkdown(ledger, events = []) {
  const lines = [];
  lines.push('# Super-agent ledger');
  lines.push('');
  lines.push(`模式: ${ledger.mode || 'active'} · 停止: ${ledger.stopped ? `是（${ledger.stop_reason || '用户要求停止'}）` : '否'} · 更新: ${ledger.updated_at || ''}`);
  lines.push('');
  lines.push('| ID | 状态 | Owner | SOURCE_KEY | 范围/变更 | STOP | 证据 | QUESTION / NEXT | 尝试/轮次 | 订阅/产物 |');
  lines.push('|----|------|-------|------------|-----------|------|------|-----------------|-----------|-----------|');
  for (const ticket of ledger.tickets) {
    const scope = [ticket.scope, ticket.changed].filter(Boolean).join(' → ');
    const question = [ticket.question, ticket.next].filter(Boolean).join(' | ');
    const attempts = `${ticket.attempts || 0} / ${ticket.rounds || 0}`;
    const artifacts = [
      ticket.artifacts && ticket.artifacts.pr ? `PR:${ticket.artifacts.pr}` : '',
      ticket.artifacts && ticket.artifacts.branch ? `branch:${ticket.artifacts.branch}` : '',
      ticket.artifacts && ticket.artifacts.worktree ? `worktree:${ticket.artifacts.worktree}` : '',
      ticket.watch && ticket.watch.pr ? `watch:PR#${ticket.watch.pr}` : '',
      ticket.watch && ticket.watch.branch ? `watch:${ticket.watch.branch}` : '',
    ].filter(Boolean).join(' · ');
    lines.push('| ' + [
      ticket.id,
      ticket.state,
      ticket.owner && ticket.owner.agent_id ? `${ticket.owner.name || ticket.owner.agent_id} (${ticket.owner.agent_id})` : '',
      ticket.source_key,
      scope,
      ticket.stop,
      short(ticket.evidence, 100),
      short(question, 120),
      attempts,
      short(artifacts, 100),
    ].map(escapeCell).join(' | ') + ' |');
  }
  lines.push('');
  const pending = ledger.tickets.filter((ticket) => ticket.state === 'proposed');
  if (pending.length) {
    lines.push(`未确认的 proposed: ${pending.map((ticket) => ticket.id).join(', ')}。必须确认或丢弃，不能让 proposed 悬挂。`);
    lines.push('');
  }
  const blocked = ledger.tickets.filter((ticket) => ticket.state === 'blocked' && ticket.question);
  if (blocked.length) {
    lines.push('等待用户决定:');
    for (const ticket of blocked) {
      lines.push(`- ${ticket.id}: ${ticket.question}${ticket.options ? ` · 选项: ${ticket.options}` : ''}${ticket.default ? ` · 默认: ${ticket.default}` : ''}`);
    }
    lines.push('');
  }
  const recentEvents = (events || []).filter((event) => event.seq > (ledger.ack_seq || 0)).slice(-10);
  if (recentEvents.length) {
    lines.push('最近未确认事件:');
    for (const event of recentEvents) {
      lines.push(`- E${event.seq} [${event.source}/${event.type}] ${event.ticket || '-'} ${event.summary}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function statusSummary(ledger, events) {
  const open = ledger.tickets.filter((ticket) => ACTIVE.has(ticket.state) && ticket.state !== 'proposed');
  const blocked = ledger.tickets.filter((ticket) => ticket.state === 'blocked');
  const proposed = ledger.tickets.filter((ticket) => ticket.state === 'proposed');
  const unacked = events.filter((event) => event.seq > (ledger.ack_seq || 0));
  return { open, blocked, proposed, unacked };
}

module.exports = {
  ACTIVE,
  STATES,
  TERMINAL,
  TRANSITIONS,
  appendEvent,
  ackEvents,
  browserSafeId,
  canTransition,
  createTicket,
  defaultLedger,
  escapeCell,
  exists,
  findProjectRoot,
  findTicket,
  firstLine,
  init,
  listEvents,
  mutate,
  normalizeLedger,
  normalizeRequest,
  nowIso,
  paths,
  projectRoot,
  readEvents,
  readJson,
  readLedger,
  readSession,
  renderMarkdown,
  requestHash,
  requireTicket,
  sanitizeText,
  saveArtifact,
  sessionPath,
  shortHash,
  short,
  statusSummary,
  touchTicket,
  transition,
  updateTicket,
  withLock,
  writeAtomic,
  writeSession,
};

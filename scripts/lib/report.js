'use strict';

const crypto = require('crypto');
const store = require('./store');

const FIELDS = [
  'STATE', 'TICKET', 'SUMMARY', 'CHANGED', 'ARTIFACTS', 'SCOPE', 'STOP_COMPLIED',
  'EVIDENCE', 'UNRESOLVED', 'QUESTION', 'OPTIONS', 'DEFAULT', 'ACK', 'ATTEMPTS',
  'ROUNDS', 'NEXT',
];

const REPORT_STATES = {
  progress: 'running',
  waiting: 'waiting',
  ready: 'ready',
  blocked: 'blocked',
  failed: 'failed',
  handed_back: 'handed_back',
  stopped: 'stopped',
  dropped: 'dropped',
};

function parseReport(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = line.match(/^\s*([A-Z][A-Z_]+)\s*:/);
    return Boolean(match && FIELDS.includes(match[1]));
  });
  if (start < 0) return null;
  const report = {};
  let current = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) break;
    const match = line.match(/^([A-Z][A-Z_]+)\s*:\s*(.*)$/);
    if (match && FIELDS.includes(match[1])) {
      current = match[1];
      report[current] = match[2].trim();
      continue;
    }
    if (current && line.trim()) {
      report[current] = `${report[current]} ${line.trim()}`.trim();
    }
  }
  if (!report.STATE) return null;
  return report;
}

function clean(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '';
  if (/^(无|none|n\/a|-|无。|没有)$/i.test(text)) return '';
  return text.replace(/\s+/g, ' ');
}

function parseNumber(value) {
  const match = String(value || '').match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : undefined;
}

function parseArtifacts(text) {
  const raw = String(text || '');
  const result = {};
  const prUrl = raw.match(/https?:\/\/[^\s)]+\/pull\/(\d+)/i);
  const prNumber = raw.match(/\bPR\s*#?\s*(\d+)\b/i) || raw.match(/#(\d+)/);
  if (prUrl) result.pr = prUrl[0];
  else if (prNumber) result.pr = prNumber[1];
  const branch = raw.match(/\bbranch\s*[:=#]?\s*([A-Za-z0-9._\/-]+)/i);
  if (branch) result.branch = branch[1];
  const worktree = raw.match(/\bworktree\s*[:=]?\s*([^\s,;·]+)/i);
  if (worktree) result.worktree = worktree[1];
  const log = raw.match(/\b(?:log|report)\s*[:=]\s*([^\s,;·]+)/i);
  if (log) result.log = log[1];
  return result;
}

function normalizeState(value) {
  const key = String(value || '').split('|')[0].trim().toLowerCase();
  return REPORT_STATES[key] || '';
}

function reportHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function resolveTicket(ledger, report, meta) {
  if (report && report.TICKET) {
    const ticket = store.findTicket(ledger, report.TICKET);
    if (ticket) return ticket;
  }
  if (meta && meta.agent_id && ledger.agents && ledger.agents[meta.agent_id]) {
    const ticket = store.findTicket(ledger, ledger.agents[meta.agent_id].ticket);
    if (ticket) return ticket;
  }
  return null;
}

function applyReport(root, input) {
  const text = String(input.text || '');
  const report = parseReport(text);
  if (!report) return { applied: false, reason: 'no-report' };

  const hash = reportHash(text);
  const artifact = store.saveArtifact(root, `report-${Date.now()}-${hash}.md`, text);
  const events = [];
  let outcome = null;

  const result = store.mutate(root, (ledger) => {
    const ticket = resolveTicket(ledger, report, input);
    if (!ticket) {
      return { applied: false, reason: 'no-ticket', ticket: null };
    }
    if (ticket.report_hash === hash) {
      return { applied: false, reason: 'duplicate', ticket };
    }

    const nextState = normalizeState(report.STATE);
    if (!nextState) {
      return { applied: false, reason: `unknown-state:${report.STATE}`, ticket };
    }

    ticket.report_hash = hash;
    store.updateTicket(ticket, {
      evidence: clean(report.EVIDENCE) || ticket.evidence,
      changed: clean(report.CHANGED) || ticket.changed,
      unresolved: clean(report.UNRESOLVED),
      question: clean(report.QUESTION),
      options: clean(report.OPTIONS),
      default: clean(report.DEFAULT),
      next: clean(report.NEXT),
      ack: clean(report.ACK),
      stop_complied: clean(report.STOP_COMPLIED),
      attempts: parseNumber(report.ATTEMPTS),
      rounds: parseNumber(report.ROUNDS),
      artifact_report: artifact,
    });

    const artifacts = parseArtifacts(report.ARTIFACTS);
    for (const [key, value] of Object.entries(artifacts)) {
      if (value) ticket.artifacts[key] = value;
    }
    if (!ticket.artifacts.log && report.ARTIFACTS) {
      ticket.artifacts.log = clean(report.ARTIFACTS);
    }

    if (report.EVIDENCE && !ticket.evidence) {
      ticket.evidence = clean(report.EVIDENCE);
    }
    ticket.evidence_missing = !clean(report.EVIDENCE) && !ticket.evidence;

    if (input.agent_id) {
      ticket.owner.agent_id = input.agent_id;
      ticket.owner.subagent_type = input.agent_type || ticket.owner.subagent_type;
      ledger.agents[input.agent_id] = {
        ticket: ticket.id,
        type: input.agent_type || '',
        started_at: (ledger.agents[input.agent_id] && ledger.agents[input.agent_id].started_at) || store.nowIso(),
        last_report_at: store.nowIso(),
      };
    }

    let target = nextState;
    if (nextState === 'ready') {
      if (ticket.evidence_missing) {
        events.push({
          source: 'hook',
          type: 'ready_without_evidence',
          ticket: ticket.id,
          summary: `${ticket.id} 报 ready 但没有证据，交给 Router 复核`,
          dedupe_key: `ready-no-evidence:${ticket.id}:${hash}`,
        });
      } else if (ticket.artifacts.pr) {
        target = 'awaiting_review';
      } else if (ticket.artifacts.branch || ticket.artifacts.worktree) {
        target = 'awaiting_integration';
      } else {
        target = 'done';
      }
    }

    if (nextState === 'blocked' && !clean(report.QUESTION)) {
      events.push({
        source: 'hook',
        type: 'blocked_without_question',
        ticket: ticket.id,
        summary: `${ticket.id} 报 blocked 但没有具体问题`,
        dedupe_key: `blocked-no-question:${ticket.id}:${hash}`,
      });
    }

    if (nextState === 'ready' || nextState === 'blocked' || nextState === 'failed' || nextState === 'handed_back') {
      ticket.owner.agent_id = ticket.owner.agent_id || (input.agent_id || '');
    }

    try {
      if (nextState === 'ready') {
        if (ticket.state !== 'ready') store.transition(ticket, 'ready', `report:${report.STATE}`);
        if (target !== 'ready') store.transition(ticket, target, `report:${report.STATE}`);
      } else {
        store.transition(ticket, target, `report:${report.STATE}`);
      }
    } catch (error) {
      ticket.history = ticket.history || [];
      ticket.history.push({
        ts: store.nowIso(),
        from: ticket.state,
        to: target,
        note: `report ignored: ${error.message}`,
      });
      events.push({
        source: 'hook',
        type: 'invalid_transition',
        ticket: ticket.id,
        summary: `${ticket.id} 报告状态 ${report.STATE} 与当前状态 ${ticket.state} 冲突`,
        dedupe_key: `invalid-transition:${ticket.id}:${hash}`,
      });
      return { applied: false, reason: 'invalid-transition', ticket, target };
    }

    outcome = {
      applied: true,
      ticket,
      state: ticket.state,
      report,
      artifact,
      evidence_missing: ticket.evidence_missing,
    };
    return outcome;
  });

  for (const event of events) {
    store.appendEvent(root, event);
  }
  return outcome || result || { applied: false, reason: 'not-applied' };
}

function markUnreported(root, input) {
  const events = [];
  const result = store.mutate(root, (ledger) => {
    const ticket = resolveTicket(ledger, {}, input);
    if (!ticket) return { updated: false, reason: 'no-ticket' };
    if (ticket.handback_at && Date.now() - new Date(ticket.handback_at).getTime() < 10 * 60 * 1000) {
      return { updated: false, reason: 'handback-delivered' };
    }
    if (ticket.state !== 'running' && ticket.state !== 'waiting') {
      return { updated: false, reason: `state:${ticket.state}` };
    }
    ticket.attempts = (ticket.attempts || 0) + 1;
    ticket.last_error = 'Worker 结束时没有按 REPORT 格式回报';
    try {
      store.transition(ticket, 'failed', 'missing-report');
    } catch {
      ticket.state = 'failed';
    }
    events.push({
      source: 'hook',
      type: 'worker_report_missing',
      ticket: ticket.id,
      summary: `${ticket.id} 的 Worker 结束但没有回报，已标记 failed`,
      dedupe_key: `missing-report:${ticket.id}:${input.agent_id || Date.now()}`,
    });
    return { updated: true, ticket };
  });
  for (const event of events) store.appendEvent(root, event);
  return result;
}

module.exports = {
  FIELDS,
  REPORT_STATES,
  applyReport,
  clean,
  markUnreported,
  normalizeState,
  parseArtifacts,
  parseReport,
  reportHash,
  resolveTicket,
};

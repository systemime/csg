#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const report = require('./lib/report');
const service = require('./lib/service');

function parseFlags(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`csg: ${message}\n`);
  process.exit(1);
}

function rootFrom(input) {
  if (process.env.CLAUDE_PROJECT_DIR) return store.projectRoot(process.env.CLAUDE_PROJECT_DIR);
  return store.findProjectRoot((input && input.cwd) || process.cwd());
}

function hookOutput(eventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
}

function denyPre(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function listActive(ledger) {
  return ledger.tickets.filter((ticket) => store.ACTIVE.has(ticket.state) && ticket.state !== 'proposed');
}

function ticketLine(ticket) {
  const parts = [`${ticket.id} ${ticket.state}`];
  if (ticket.title) parts.push(`(${store.short(ticket.title, 60)})`);
  if (ticket.owner && ticket.owner.agent_id) parts.push(`owner=${ticket.owner.name || ticket.owner.agent_id}`);
  if (ticket.scope) parts.push(`scope=${ticket.scope}`);
  if (ticket.changed) parts.push(`changed=${ticket.changed}`);
  if (ticket.evidence) parts.push(`evidence=${store.short(ticket.evidence, 120)}`);
  if (ticket.question) parts.push(`question=${ticket.question}`);
  if (ticket.options) parts.push(`options=${ticket.options}`);
  if (ticket.default) parts.push(`default=${ticket.default}`);
  if (ticket.next) parts.push(`next=${ticket.next}`);
  if (ticket.stop && ticket.stop !== 'none') parts.push(`STOP=${ticket.stop}`);
  if (ticket.artifacts && ticket.artifacts.pr) parts.push(`PR=${ticket.artifacts.pr}`);
  if (ticket.artifacts && ticket.artifacts.branch) parts.push(`branch=${ticket.artifacts.branch}`);
  if (ticket.watch && ticket.watch.pr) parts.push(`watch=PR#${ticket.watch.pr}`);
  return store.sanitizeText(parts.join(' · '));
}

function buildDigest(root, ledger, options = {}) {
  const session = store.readSession(root, options.sessionId || '');
  const unacked = store.listEvents(root, {
    unackedOnly: true,
    excludeNotified: options.excludeNotified === true,
    limit: 30,
  });
  // Keep all unacked events in the digest until Router acknowledges them. Otherwise
  // the digest changes once an event is delivered and the same state is injected twice.
  const fresh = unacked;
  const active = listActive(ledger);
  const lines = [];
  lines.push(`Super-agent 台账: ${path.relative(root, store.paths(root).ledger)}（CLI: node ${path.join(__dirname, 'csg.js')}）`);
  lines.push(`模式: ${ledger.mode}; 停止: ${ledger.stopped ? `是（${ledger.stop_reason || '用户要求停止'}）` : '否'}`);
  if (ledger.stopped) {
    lines.push('停止状态由用户设置。只有用户明确解除后，Router 才能清除；不得派新工单、启动 Worker 或恢复已停止工单。');
  }
  if (!active.length) {
    lines.push('当前没有进行中的工单。');
  } else {
    lines.push('进行中的工单:');
    for (const ticket of active.slice(0, 20)) {
      lines.push(`- ${ticketLine(ticket)}`);
    }
  }
  const proposed = ledger.tickets.filter((ticket) => ticket.state === 'proposed');
  if (proposed.length) {
    lines.push(`未确认的 proposed: ${proposed.map((ticket) => ticket.id).join(', ')}。proposed 必须先确认或丢弃。`);
  }
  if (fresh.length) {
    lines.push('未确认事件:');
    for (const event of fresh.slice(0, 15)) {
      lines.push(`- E${event.seq} [${event.source}/${event.type}] ${event.ticket || '-'} ${event.summary}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > 4000) text = `${text.slice(0, 3900)}\n…（台账过长，完整内容见 ledger.md）`;
  return { text, fresh, session };
}

function hookSessionStart(input) {
  const root = rootFrom(input);
  const ledger = store.readLedger(root);
  if (!ledger) return null;
  const normalized = store.normalizeLedger(ledger);
  const digest = buildDigest(root, normalized, { sessionId: input.session_id || '' });
  const maxSeq = digest.fresh.reduce((max, event) => Math.max(max, event.seq), 0);
  if (maxSeq) {
    store.writeSession(root, input.session_id || '', {
      last_event_seq: maxSeq,
      last_digest: digest.text,
      source: input.source || '',
    });
  } else {
    store.writeSession(root, input.session_id || '', {
      last_digest: digest.text,
      source: input.source || '',
    });
  }
  return hookOutput('SessionStart', digest.text);
}

function hookUserPromptSubmit(input) {
  const root = rootFrom(input);
  const ledger = store.readLedger(root);
  if (!ledger) return null;
  const normalized = store.normalizeLedger(ledger);
  const digest = buildDigest(root, normalized, {
    sessionId: input.session_id || '',
    excludeNotified: true,
  });
  const session = digest.session;
  if (digest.text === session.last_digest) return null;
  const maxSeq = digest.fresh.reduce((max, event) => Math.max(max, event.seq), 0);
  store.writeSession(root, input.session_id || '', {
    last_event_seq: maxSeq || session.last_event_seq || 0,
    last_digest: digest.text,
  });
  return hookOutput('UserPromptSubmit', digest.text);
}

function aggregateChecks(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return 'none';
  const states = rollup.map((item) => String(item.conclusion || item.state || '').toUpperCase());
  if (states.some((state) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state))) return 'failed';
  if (states.some((state) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', ''].includes(state))) return 'pending';
  return 'passed';
}

function checkAgentBrief(ledger, input) {
  const toolInput = input.tool_input || {};
  const subagent = String(toolInput.subagent_type || '');
  if (!/(?:super-agent:)?super-agent-(worker|verifier|integrator)/.test(subagent)) return null;
  const isVerifier = /verifier/.test(subagent);
  const prompt = String(toolInput.prompt || '');
  const ticketMatch = prompt.match(/^\s*TICKET:\s*(T\d+)/m);
  const sourceMatch = prompt.match(/^\s*SOURCE_KEY:\s*(\S+)/m);
  if (!ticketMatch || !sourceMatch) {
    return 'Super-agent 工单 brief 缺少 TICKET 或 SOURCE_KEY。补齐后重派；不要用实现计划代替 brief。';
  }
  const ticket = store.findTicket(ledger, ticketMatch[1]);
  if (!ticket) {
    return `工单 ${ticketMatch[1]} 不在台账中。先用 csg.js add 建单，再派 Worker。`;
  }
  if (sourceMatch[1] !== ticket.source_key) {
    return `brief 的 SOURCE_KEY=${sourceMatch[1]} 与工单 ${ticket.id} 的 ${ticket.source_key} 不一致。改用台账里的值。`;
  }
  if (ledger.mode === 'observe' && !isVerifier) {
    return '当前是 observe 模式，只记录建议，不派 Worker 或 Integrator。用户明确要求执行时先切到 active。';
  }
  if (ticket.state === 'proposed') {
    return `工单 ${ticket.id} 仍是 proposed。必须先让用户确认，或丢弃后重来。`;
  }
  if (ticket.state === 'stopped' || ticket.state === 'done' || ticket.state === 'dropped' || ticket.state === 'handed_back') {
    return `工单 ${ticket.id} 已 ${ticket.state}。终态工单不能复活；按新工单处理，或让用户明确解除停止。`;
  }
  if (!isVerifier && (ticket.state === 'ready' || ticket.state === 'awaiting_review' || ticket.state === 'awaiting_integration')) {
    return `工单 ${ticket.id} 已 ${ticket.state}，不应重新派 Worker。评审反馈用 SendMessage 恢复原 Worker；需要合并改动时新建集成工单。`;
  }
  if (!isVerifier && ticket.owner && ticket.owner.agent_id && ticket.state === 'running') {
    return `工单 ${ticket.id} 已有 Worker ${ticket.owner.agent_id}。用 SendMessage 恢复同一 Worker；需要换人先 TaskStop。`;
  }
  return null;
}

function shellMutationReason(command, agentType) {
  const isIntegrator = /integrator/.test(agentType);
  const rules = [
    [/\.claude\/super-agent\//i, 'Worker 不能直接改 Super-agent 台账；把结果写进 REPORT，由 Router 更新。'],
    [/\bcsg\.js\s+(?:add|update|stop|resume|mode|watch|ack|report|init)\b/i, 'Worker 不能改 Super-agent 台账；把结果写进 REPORT，由 Router 更新。'],
    [/\bcsg-service\.js\s+(?:approve|install|uninstall|run|start|stop|pause|resume|init)\b/i, '只有用户能管理 Super-agent service；代理只能 status/list/result/enqueue。'],
    [/\bgit\s+stash\b/i, 'Worker 不得 stash 用户改动；需要保留现场时报告 blocked。'],
    [/\bgit\s+reset\s+--hard\b/i, 'Worker 不得 reset --hard，可能覆盖用户改动。'],
    [/\bgit\s+clean\b/i, 'Worker 不得 git clean，可能删除未跟踪文件。'],
    [/\bgit\s+checkout\s+--\s/i, 'Worker 不得用 checkout -- 覆盖文件。'],
    [/\bgit\s+restore\b/i, 'Worker 不得用 restore 覆盖文件。'],
    [/\bgit\s+push\b[^\n]*(--force|-f)\b/i, 'Worker 不得 force push。'],
    [/\bgh\s+pr\s+merge\b/i, '代理不得合并 PR；合并交给用户或仓库规则指定的账号。'],
    [/\bgh\s+pr\s+close\b/i, '代理不得关闭 PR。'],
    [/\bgh\s+issue\s+close\b/i, '代理不得关闭 issue。'],
    [/\b(npm|cargo|yarn|pnpm)\s+publish\b/i, '发布操作需要用户明确授权；报告 blocked。'],
    [/\bgh\s+release\s+create\b/i, '发布操作需要用户明确授权；报告 blocked。'],
    [/\bdocker\s+push\b/i, '推送镜像需要用户明确授权；报告 blocked。'],
  ];
  if (!isIntegrator) {
    rules.push([
      /\bgit\s+(merge|rebase|cherry-pick)\b/i,
      '只有集成 Worker 可以做 merge/rebase/cherry-pick；本工单报告 handed_back 或等集成阶段。',
    ]);
    rules.push([
      /\bgit\s+(checkout|switch)\b/i,
      'Worker 不得切换分支或 checkout；需要独立工作区时由 Router 用 worktree 隔离。',
    ]);
  }
  for (const [pattern, reason] of rules) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

function hookPreToolUse(input) {
  const routed = service.routeToolCall(input);
  if (routed) return routed;
  const root = rootFrom(input);
  const ledger = store.readLedger(root);
  if (!ledger) return null;
  const normalized = store.normalizeLedger(ledger);
  const tool = String(input.tool_name || '');
  const toolInput = input.tool_input || {};
  const agentId = input.agent_id || '';
  const agentType = String(input.agent_type || '');
  const isAgentCall = Boolean(agentId);
  const isSuperAgent = /super-agent-(worker|verifier|integrator)/.test(agentType);

  if (normalized.stopped && isAgentCall) {
    return denyPre('用户已要求停止（Super-agent STOP）。停止期间 Worker 不得继续执行；等待用户明确解除停止。');
  }

  if (normalized.stopped && tool === 'Agent') {
    return denyPre('用户已要求停止（Super-agent STOP）。停止期间不派新工单；用户明确解除后再派。');
  }

  if (tool === 'AskUserQuestion' && isAgentCall) {
    return denyPre('Worker 不直接向用户提问。把问题写进 REPORT 的 QUESTION 并报 blocked。');
  }

  if (tool === 'Agent' && isSuperAgent) {
    const subagent = String(toolInput.subagent_type || '');
    if (/integrator|verifier/.test(agentType) || /worker/.test(agentType)) {
      if (!/(?:super-agent:)?super-agent-verifier$/.test(subagent)) {
        return denyPre('Worker 不得派其他 Worker；工单内子任务顺序执行。需要并行时由 Router 拆新工单。');
      }
    }
  }

  if (tool === 'Agent' && !isAgentCall) {
    const subagent = String(toolInput.subagent_type || '');
    if (normalized.mode === 'observe' && !/verifier/i.test(subagent)) {
      return denyPre('当前是 observe 模式，只记录建议，不派 Worker、Integrator 或通用代理。用户明确要求执行时先切到 active。');
    }
    const reason = checkAgentBrief(normalized, input);
    if (reason) return denyPre(reason);
  }

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const filePath = String(toolInput.file_path || toolInput.notebook_path || '');
    const base = path.resolve(store.paths(root).base);
    const resolved = filePath ? path.resolve(filePath) : '';
    if (resolved && (resolved === base || resolved.startsWith(`${base}${path.sep}`))) {
      return denyPre('Super-agent 台账由 CLI 维护，不要手改 ledger.json、ledger.md 或事件文件。用 csg.js 的 add/update/report/ack。');
    }
    if (isAgentCall && /verifier/.test(agentType)) {
      return denyPre('Verifier 是只读代理，不能修改文件。把发现写进 VERDICT 报告。');
    }
  }

  if (tool === 'Bash' && isAgentCall) {
    const reason = shellMutationReason(String(toolInput.command || ''), agentType);
    if (reason) return denyPre(reason);
  }

  return null;
}

function handleAgentPostToolUse(root, input) {
  const response = input.tool_response || {};
  const toolInput = input.tool_input || {};
  const agentId = response.agentId || '';
  if (!agentId) return;
  const prompt = String(toolInput.prompt || response.prompt || '');
  const ticketId = (prompt.match(/^\s*TICKET:\s*(T\d+)/m) || [])[1] || '';
  const subagent = String(toolInput.subagent_type || '');
  if (!/(?:super-agent:)?super-agent-(worker|verifier|integrator)/.test(subagent) && !ticketId) return;

  const events = [];
  store.mutate(root, (ledger) => {
    const ticket = ticketId ? store.findTicket(ledger, ticketId) : null;
    if (!ticket) {
      if (ticketId) {
        events.push({
          source: 'hook',
          type: 'agent_unattached',
          ticket: ticketId,
          summary: `Worker ${agentId} 引用了台账中不存在的 ${ticketId}`,
          dedupe_key: `agent-unattached:${ticketId}:${agentId}`,
        });
      }
      return;
    }
    const isVerifier = /verifier/.test(subagent);
    if (!isVerifier && ticket.owner.agent_id && ticket.owner.agent_id !== agentId && ticket.state === 'running') {
      events.push({
        source: 'hook',
        type: 'duplicate_worker',
        ticket: ticket.id,
        summary: `${ticket.id} 已有 Worker ${ticket.owner.agent_id}，又启动了 ${agentId}`,
        dedupe_key: `duplicate-worker:${ticket.id}:${agentId}`,
      });
      return;
    }
    ledger.agents[agentId] = {
      ticket: ticket.id,
      type: subagent,
      started_at: store.nowIso(),
      last_report_at: (ledger.agents[agentId] && ledger.agents[agentId].last_report_at) || '',
    };
    if (response.outputFile) ticket.artifacts.log = response.outputFile;
    if (!isVerifier) {
      ticket.owner.agent_id = agentId;
      ticket.owner.subagent_type = subagent || ticket.owner.subagent_type;
      if (response.description) ticket.owner.name = response.description;
      if (ticket.state === 'open' || ticket.state === 'waiting' || ticket.state === 'blocked' || ticket.state === 'failed') {
        try {
          store.transition(ticket, 'running', `agent:${agentId}`);
        } catch {
          // keep the reported state; the report hook will surface the conflict
        }
      }
      store.updateTicket(ticket, {});
    }
  });
  for (const event of events) store.appendEvent(root, event);

  if (response.status === 'completed' && Array.isArray(response.content)) {
    const text = response.content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n');
    if (text) report.applyReport(root, { text, agent_id: agentId, agent_type: subagent });
  }
}

function hookPostToolUse(input) {
  const root = rootFrom(input);
  const ledger = store.readLedger(root);
  if (!ledger) return null;
  if (input.tool_name === 'Agent') {
    handleAgentPostToolUse(root, input);
    return null;
  }
  if (input.tool_name === 'SubagentHandback') {
    const text = String((input.tool_input || {}).message || '');
    if (text) {
      const result = report.applyReport(root, {
        text,
        agent_id: input.agent_id || '',
        agent_type: input.agent_type || '',
      });
      if (result && result.ticket) {
        store.mutate(root, (current) => {
          const ticket = store.findTicket(current, result.ticket.id);
          if (ticket) ticket.handback_at = store.nowIso();
        });
      }
    }
  }
  return null;
}

function hookSubagentStop(input) {
  const root = rootFrom(input);
  const ledger = store.readLedger(root);
  if (!ledger) return null;
  const normalized = store.normalizeLedger(ledger);
  const known = /super-agent-(worker|verifier|integrator)/.test(String(input.agent_type || ''))
    || Boolean(input.agent_id && normalized.agents[input.agent_id]);
  if (!known) return null;
  const text = String(input.last_assistant_message || '');
  if (report.parseReport(text)) {
    report.applyReport(root, {
      text,
      agent_id: input.agent_id || '',
      agent_type: input.agent_type || '',
    });
    return null;
  }
  if (/super-agent-(worker|integrator)/.test(String(input.agent_type || ''))) {
    report.markUnreported(root, {
      agent_id: input.agent_id || '',
      agent_type: input.agent_type || '',
    });
  }
  return null;
}

function hookPreCompact(input) {
  const root = rootFrom(input);
  const ledger = store.readLedger(root);
  if (!ledger) return null;
  store.mutate(root, () => undefined);
  return null;
}

function runHook(eventName) {
  const input = parseJson(readStdin()) || {};
  if (process.env.CSG_SERVICE_JOB) return;
  let output = null;
  switch (eventName) {
    case 'session-start':
      output = hookSessionStart(input);
      break;
    case 'user-prompt-submit':
      output = hookUserPromptSubmit(input);
      break;
    case 'pre-tool-use':
      output = hookPreToolUse(input);
      break;
    case 'post-tool-use':
      output = hookPostToolUse(input);
      break;
    case 'subagent-stop':
      output = hookSubagentStop(input);
      break;
    case 'pre-compact':
      output = hookPreCompact(input);
      break;
    default:
      break;
  }
  if (output) writeJson(output);
}

function cmdInit(flags) {
  const root = rootFrom({});
  const result = store.init(root, { reset: flags.reset === true });
  const relative = path.relative(root, store.paths(root).ledger);
  if (flags.json) {
    writeJson({ created: result.created, ledger: relative, mode: result.ledger.mode });
  } else {
    process.stdout.write(`${result.created ? 'created' : 'exists'} ${relative}\n`);
  }
}

function cmdHash(flags) {
  const request = flags.request || flags._[0] || '';
  const target = flags.target || '';
  process.stdout.write(`${store.requestHash(request, target)}\n`);
}

function cmdAdd(flags) {
  const root = rootFrom({});
  const input = {
    id: flags.id,
    state: flags.state || 'open',
    title: flags.title,
    source_key: flags['source-key'] || flags.source_key,
    request_hash: flags['request-hash'] || flags.request_hash,
    source: flags.source || flags._.join(' '),
    scope: flags.scope,
    constraints: flags.constraints,
    stop: flags.stop,
  };
  if (!input.source_key) fail('missing --source-key');
  if (!input.source) fail('missing --source');
  if (!input.request_hash) input.request_hash = store.requestHash(input.source, '');

  const result = store.mutate(root, (ledger) => {
    const duplicate = ledger.tickets.find((ticket) => ticket.source_key === input.source_key);
    if (duplicate) return { duplicate: true, ticket: duplicate };
    const sameHash = ledger.tickets.find((ticket) => ticket.request_hash === input.request_hash);
    const ticket = store.createTicket(ledger, input);
    return { duplicate: false, ticket, same_hash: sameHash ? sameHash.id : '' };
  });
  if (flags.json) {
    writeJson(result);
  } else {
    process.stdout.write(`${result.ticket.id} ${result.ticket.state}${result.duplicate ? ' (duplicate source_key)' : ''}${result.same_hash ? ` warning: same request_hash as ${result.same_hash}` : ''}\n`);
  }
}

function cmdUpdate(flags) {
  const root = rootFrom({});
  const id = flags._[0];
  if (!id) fail('missing ticket id');
  const result = store.mutate(root, (ledger) => {
    const ticket = store.requireTicket(ledger, id);
    const patch = {};
    for (const [key, value] of Object.entries(flags)) {
      if (key === '_') continue;
      patch[key.replace(/-/g, '_')] = value;
    }
    if (patch.state) {
      store.transition(ticket, patch.state, patch.note || 'manual');
      delete patch.state;
    }
    store.updateTicket(ticket, patch);
    return { ticket };
  });
  if (flags.json) writeJson(result);
  else process.stdout.write(`${result.ticket.id} ${result.ticket.state}\n`);
}

function cmdStop(flags) {
  const root = rootFrom({});
  const reason = flags.reason || 'user stop';
  const id = flags._[0];
  const result = store.mutate(root, (ledger) => {
    if (id) {
      const ticket = store.requireTicket(ledger, id);
      store.transition(ticket, ticket.state === 'proposed' ? 'dropped' : 'stopped', reason);
      ticket.last_error = reason;
      ticket.owner = { agent_id: '', name: '', subagent_type: '' };
      return { scope: id, ticket };
    }
    ledger.stopped = true;
    ledger.stop_reason = reason;
    ledger.stop_ts = store.nowIso();
    const stopped = [];
    for (const ticket of ledger.tickets) {
      if (store.ACTIVE.has(ticket.state)) {
        try {
          store.transition(ticket, ticket.state === 'proposed' ? 'dropped' : 'stopped', reason);
          ticket.owner = { agent_id: '', name: '', subagent_type: '' };
          stopped.push(ticket.id);
        } catch {
          // a terminal ticket cannot be stopped again
        }
      }
    }
    return { scope: 'all', stopped };
  });
  if (flags.json) writeJson(result);
  else process.stdout.write(`stopped ${result.scope}${result.stopped ? `: ${result.stopped.join(', ')}` : ''}\n`);
}

function cmdResume(flags) {
  const root = rootFrom({});
  const id = flags._[0];
  if (id) fail('stopped 是终态；不能恢复旧工单。请为该线程上的新请求新建工单。');
  const ledger = store.mutate(root, (current) => {
    current.stopped = false;
    current.stop_reason = '';
    current.stop_ts = '';
    return current;
  });
  process.stdout.write(`resumed; ${ledger.tickets.filter((ticket) => ticket.state === 'stopped').length} stopped ticket(s) stay terminal\n`);
}

function cmdMode(flags) {
  const root = rootFrom({});
  const mode = flags._[0] || flags.mode;
  if (!['observe', 'active'].includes(mode)) fail('mode must be observe or active');
  store.mutate(root, (ledger) => {
    ledger.mode = mode;
  });
  process.stdout.write(`mode ${mode}\n`);
}

function cmdWatch(flags) {
  const root = rootFrom({});
  const id = flags._[0];
  if (!id) fail('missing ticket id');
  const ticket = store.mutate(root, (ledger) => {
    const current = store.requireTicket(ledger, id);
    if (flags.pr !== undefined) current.watch.pr = Number.parseInt(flags.pr, 10) || 0;
    if (flags.repo !== undefined) current.watch.repo = flags.repo;
    if (flags.branch !== undefined) current.watch.branch = flags.branch;
    if (flags.ci !== undefined) current.watch.ci = true;
    store.touchTicket(current);
    return current;
  });
  process.stdout.write(`${ticket.id} watch PR=${ticket.watch.pr || '-'} branch=${ticket.watch.branch || '-'} ci=${ticket.watch.ci}\n`);
}

function cmdStatus(flags) {
  const root = rootFrom({});
  const ledger = store.readLedger(root);
  if (!ledger) fail('no ledger; run init');
  const normalized = store.normalizeLedger(ledger);
  const events = store.listEvents(root, { unackedOnly: true, limit: 100 });
  const summary = store.statusSummary(normalized, events);
  if (flags.json) {
    writeJson({ ledger: normalized, events });
    return;
  }
  process.stdout.write(`mode=${normalized.mode} stopped=${normalized.stopped} open=${summary.open.length} blocked=${summary.blocked.length} proposed=${summary.proposed.length} unacked_events=${summary.unacked.length}\n`);
  for (const ticket of normalized.tickets.slice(0, 50)) {
    process.stdout.write(`${ticketLine(ticket)}\n`);
  }
  for (const event of summary.unacked.slice(-10)) {
    process.stdout.write(`E${event.seq} [${event.source}/${event.type}] ${event.ticket || '-'} ${event.summary}\n`);
  }
}

function seqNumber(value) {
  const match = String(value === undefined || value === null ? '' : value).match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function cmdEvents(flags) {
  const root = rootFrom({});
  const since = seqNumber(flags.since) || 0;
  const events = store.listEvents(root, {
    since,
    unackedOnly: flags.all !== true,
    limit: 200,
  });
  if (flags.json) {
    writeJson(events);
    return;
  }
  for (const event of events) {
    process.stdout.write(`E${event.seq} [${event.source}/${event.type}] ${event.ticket || '-'} ${event.summary}\n`);
  }
  if (!events.length) process.stdout.write('no events\n');
}

function cmdAck(flags) {
  const root = rootFrom({});
  const upto = seqNumber(flags.upto);
  const seq = store.ackEvents(root, upto);
  process.stdout.write(`acked through E${seq}\n`);
}

function cmdReport(flags) {
  const root = rootFrom({});
  if (!store.readLedger(root)) fail('no ledger; run init first');
  const text = flags.file ? fs.readFileSync(flags.file, 'utf8') : readStdin();
  const result = report.applyReport(root, {
    text,
    agent_id: flags['agent-id'] || '',
    agent_type: flags['agent-type'] || '',
  });
  if (flags.json) writeJson(result);
  else if (result.applied) process.stdout.write(`${result.ticket.id} ${result.state}${result.evidence_missing ? ' (evidence missing)' : ''}\n`);
  else process.stdout.write(`not applied: ${result.reason || 'unknown'}\n`);
}

function cmdRender() {
  const root = rootFrom({});
  const ledger = store.readLedger(root);
  if (!ledger) fail('no ledger');
  process.stdout.write(store.renderMarkdown(store.normalizeLedger(ledger), store.readEvents(root)));
}

function usage() {
  process.stdout.write(`csg.js — Super-agent 台账与钩子

用法:
  csg.js hook <session-start|user-prompt-submit|pre-tool-use|post-tool-use|subagent-stop|pre-compact>
  csg.js init [--reset] [--json]
  csg.js hash --request <text> --target <path|url>
  csg.js add --source-key <key> [--request-hash <hash>] --source <text> [--title <text>] [--state open|proposed]
  csg.js update <T#> [--state <state>] [--owner-agent <id>] [--evidence <text>] [--question <text>] ...
  csg.js report [--file <path>] [--agent-id <id>] [--agent-type <type>] [--json]
  csg.js stop [T#] [--reason <text>] [--json]
  csg.js resume
  csg.js mode <observe|active>
  csg.js watch <T#> [--pr <n>] [--repo <owner/name>] [--branch <name>] [--ci]
  csg.js status [--json]
  csg.js events [--all] [--since <seq>] [--json]
  csg.js ack [--upto <seq>]
  csg.js render
  csg.js monitor
  csg.js statusline
`);
}

function main(argv) {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }
  if (command === 'hook') {
    if (!subcommand) fail('missing hook event');
    try {
      runHook(subcommand);
    } catch (error) {
      if (process.env.CSG_DEBUG) {
        try {
          const root = rootFrom({});
          fs.mkdirSync(store.paths(root).base, { recursive: true });
          fs.appendFileSync(path.join(store.paths(root).base, 'debug.log'), `${store.nowIso()} hook ${subcommand}: ${error.stack || error.message}\n`);
        } catch {
          // never break the session because debug logging failed
        }
      }
      process.exit(0);
    }
    return;
  }
  if (command === 'monitor') {
    require('./csg-monitor').run(rootFrom({})).catch((error) => {
      process.stderr.write(`csg monitor: ${error.message}\n`);
      process.exit(1);
    });
    return;
  }
  if (command === 'statusline') {
    require('./csg-statusline').run();
    return;
  }

  const flags = parseFlags([subcommand, ...rest].filter((value) => value !== undefined));
  switch (command) {
    case 'init':
      cmdInit(flags);
      break;
    case 'hash':
      cmdHash(flags);
      break;
    case 'add':
      cmdAdd(flags);
      break;
    case 'update':
      cmdUpdate(flags);
      break;
    case 'stop':
      cmdStop(flags);
      break;
    case 'resume':
      cmdResume(flags);
      break;
    case 'mode':
      cmdMode(flags);
      break;
    case 'watch':
      cmdWatch(flags);
      break;
    case 'status':
      cmdStatus(flags);
      break;
    case 'events':
      cmdEvents(flags);
      break;
    case 'ack':
      cmdAck(flags);
      break;
    case 'report':
      cmdReport(flags);
      break;
    case 'render':
      cmdRender();
      break;
    default:
      usage();
      process.exit(1);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`csg: ${error.message}\n`);
  process.exit(1);
}

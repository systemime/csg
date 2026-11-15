'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const JOB_TYPES = new Set(['test', 'merge', 'deploy', 'agent']);
const OPEN_STATES = ['queued', 'running', 'awaiting'];

function serviceHome() {
  return path.resolve(process.env.CSG_SERVICE_HOME
    || path.join(os.homedir(), '.claude', 'super-agent', 'service'));
}

function servicePaths() {
  const base = serviceHome();
  return {
    base,
    config: path.join(base, 'service.json'),
    paused: path.join(base, 'paused.json'),
    pid: path.join(base, 'service.pid'),
    log: path.join(base, 'service.log'),
    runtime: path.join(base, 'runtime'),
    supervisor: path.join(base, 'supervisor'),
    jobs: path.join(base, 'jobs'),
    queued: path.join(base, 'jobs', 'queued'),
    running: path.join(base, 'jobs', 'running'),
    awaiting: path.join(base, 'jobs', 'awaiting'),
    done: path.join(base, 'jobs', 'done'),
    failed: path.join(base, 'jobs', 'failed'),
    results: path.join(base, 'results'),
    logs: path.join(base, 'logs'),
    locks: path.join(base, 'locks'),
    worktrees: path.join(base, 'worktrees'),
  };
}

function ensureDirs() {
  const p = servicePaths();
  for (const dir of [p.base, p.jobs, p.queued, p.running, p.awaiting, p.done, p.failed,
    p.results, p.logs, p.locks, p.worktrees, p.runtime, p.supervisor]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

function nowIso() {
  return new Date().toISOString();
}

function canonical(value) {
  let text = String(value || '');
  if (text === '~') text = os.homedir();
  else if (text.startsWith(`~${path.sep}`) || text.startsWith('~/')) {
    text = path.join(os.homedir(), text.slice(2));
  }
  try {
    return fs.realpathSync(path.resolve(text));
  } catch {
    return path.resolve(text);
  }
}

function newId() {
  return `j-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    intercept: {
      main: true,
      agents: true,
    },
    test: {
      parallel: 4,
      timeoutSec: 1800,
      commands: [
        'npm test',
        'pnpm test',
        'yarn test',
        'bun test',
        'pytest',
        'go test ./...',
        'cargo test',
        'make test',
        'node --test',
      ],
    },
    merge: {
      enabled: true,
      targetBranch: 'main',
      remote: 'origin',
      push: true,
      createPr: true,
      keepWorktree: false,
      requireApproval: false,
      allowPrMerge: false,
      checks: [],
    },
    deploy: {
      enabled: true,
      requireApproval: true,
      timeoutSec: 1800,
      commands: [],
    },
    agent: {
      enabled: false,
      timeoutSec: 1800,
      role: 'super-agent:super-agent-integrator',
      permissionMode: 'acceptEdits',
    },
    allowedProjects: [],
    retentionDays: 7,
  };
}

function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergeConfig(base[key] && typeof base[key] === 'object' ? base[key] : {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readConfig() {
  const file = servicePaths().config;
  if (!store.exists(file)) return null;
  const raw = store.readJson(file, null);
  if (!raw) return null;
  return mergeConfig(defaultConfig(), raw);
}

function writeConfig(config) {
  const p = ensureDirs();
  store.writeAtomic(p.config, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function initConfig(project) {
  const existing = readConfig() || defaultConfig();
  const target = canonical(project || process.cwd());
  const allowed = new Set(existing.allowedProjects.map(canonical));
  allowed.add(target);
  existing.allowedProjects = [...allowed];
  existing.enabled = true;
  return writeConfig(existing);
}

function readProjectConfig(project) {
  const file = path.join(project, '.claude', 'super-agent', 'service.json');
  if (!store.exists(file)) return {};
  return store.readJson(file, {}) || {};
}

function configForProject(project) {
  const global = readConfig();
  if (!global) return null;
  return mergeConfig(global, readProjectConfig(project));
}

function isAllowedProject(config, project) {
  if (!config || !Array.isArray(config.allowedProjects)) return false;
  const target = canonical(project);
  return config.allowedProjects.some((item) => canonical(item) === target);
}

function readPaused() {
  return store.readJson(servicePaths().paused, null);
}

function setPaused(reason, by) {
  const p = ensureDirs();
  if (!reason) {
    try {
      fs.unlinkSync(p.paused);
    } catch {
      // already running
    }
    return { paused: false };
  }
  const data = { paused: true, reason, by: by || 'user', ts: nowIso() };
  store.writeAtomic(p.paused, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

function jobFile(state, id) {
  const p = servicePaths();
  return path.join(p[state], `${id}.json`);
}

function writeJob(state, job) {
  const p = ensureDirs();
  const target = jobFile(state, job.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function readJobsIn(state) {
  const p = servicePaths();
  const dir = p[state];
  if (!store.exists(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => store.readJson(path.join(dir, name), null))
    .filter(Boolean);
}

function listJobs(states = OPEN_STATES) {
  return states.flatMap((state) => readJobsIn(state).map((job) => ({ ...job, state })))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

function findJob(id) {
  for (const state of ['queued', 'running', 'awaiting', 'done', 'failed']) {
    const job = store.readJson(jobFile(state, id), null);
    if (job) return { job, state, file: jobFile(state, id) };
  }
  return null;
}

function moveJob(job, fromState, toState) {
  ensureDirs();
  const from = jobFile(fromState, job.id);
  const to = jobFile(toState, job.id);
  const tmp = `${from}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, from);
    fs.renameSync(from, to);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    writeJob(toState, job);
    try { fs.unlinkSync(from); } catch { /* already moved */ }
  }
}

function dedupeKeyFor(type, project, payload) {
  return `${type}:${canonical(project)}:${JSON.stringify(payload || {})}`;
}

function enqueue(input) {
  const p = ensureDirs();
  const type = String(input.type || '');
  if (!JOB_TYPES.has(type)) throw new Error(`unknown job type: ${type}`);
  const project = canonical(input.project || process.cwd());
  const globalConfig = readConfig();
  if (!globalConfig) throw new Error('service config not found; run service init');
  if (!isAllowedProject(globalConfig, project)) throw new Error(`project not allowed: ${project}`);
  const config = mergeConfig(globalConfig, readProjectConfig(project));

  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const dedupeKey = input.dedupeKey || dedupeKeyFor(type, project, payload);
  for (const job of listJobs(OPEN_STATES)) {
    if (job.dedupe_key === dedupeKey) return { duplicate: true, job };
  }

  const requireApproval = type === 'deploy'
    ? config.deploy.requireApproval !== false
    : type === 'merge' && config.merge.requireApproval === true;
  const ts = nowIso();
  const job = {
    id: newId(),
    type,
    project,
    payload,
    role: input.role || (type === 'deploy' ? 'deployer' : type === 'test' ? 'tester' : 'integrator'),
    origin: input.origin && typeof input.origin === 'object' ? input.origin : {},
    dedupe_key: dedupeKey,
    state: requireApproval ? 'awaiting' : 'queued',
    approval: { required: requireApproval, approved_by: '', approved_at: '' },
    attempts: 0,
    created_at: ts,
    started_at: '',
    finished_at: '',
    result: null,
    error: '',
  };
  writeJob(job.state, job);
  return { duplicate: false, job };
}

function approveJob(id, by) {
  const found = findJob(id);
  if (!found) throw new Error(`job not found: ${id}`);
  if (found.state !== 'awaiting') throw new Error(`job ${id} is ${found.state}, not awaiting`);
  const job = found.job;
  job.approval = { required: true, approved_by: by || 'user', approved_at: nowIso() };
  job.state = 'queued';
  moveJob(job, 'awaiting', 'queued');
  return job;
}

function projectResultDir(project) {
  return path.join(project, '.claude', 'super-agent', 'service-results');
}

function projectLedger(project) {
  return path.join(project, '.claude', 'super-agent', 'ledger.json');
}

function resultSummary(job, state, result) {
  const type = job.type;
  if (state === 'done') {
    if (type === 'merge') return `service ${job.id} 合并完成${result.pr ? `，PR ${result.pr}` : ''}${result.branch ? `，分支 ${result.branch}` : ''}`;
    if (type === 'deploy') return result.summary || `service ${job.id} 部署完成`;
    if (type === 'test') return result.summary || `service ${job.id} 测试完成`;
    return `service ${job.id} 完成`;
  }
  return `service ${job.id} 失败: ${result.summary || job.error || 'unknown error'}`;
}

function writeResult(job, state, result) {
  const p = ensureDirs();
  const record = {
    id: job.id,
    type: job.type,
    project: job.project,
    state,
    summary: resultSummary(job, state, result),
    result,
    error: job.error || '',
    finished_at: nowIso(),
  };
  const globalResult = path.join(p.results, `${job.id}.json`);
  store.writeAtomic(globalResult, `${JSON.stringify(record, null, 2)}\n`);
  try {
    fs.chmodSync(globalResult, 0o600);
  } catch {
    // Windows ignores POSIX modes
  }
  try {
    const projectDir = projectResultDir(job.project);
    fs.mkdirSync(projectDir, { recursive: true });
    const target = path.join(projectDir, `${job.id}.json`);
    store.writeAtomic(target, `${JSON.stringify(record, null, 2)}\n`);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Windows ignores POSIX modes
    }
  } catch {
    // the global result is still available
  }
  if (store.exists(projectLedger(job.project))) {
    try {
      store.appendEvent(job.project, {
        source: 'service',
        type: state === 'done' ? 'job_done' : 'job_failed',
        ticket: String(job.payload.ticket || ''),
        summary: record.summary,
        dedupe_key: `service:${job.id}`,
        notified: false,
        payload: { job: job.id, type: job.type, state },
      });
    } catch {
      // result files still carry the outcome
    }
  }
  return record;
}

function finishJob(job, state, result) {
  const p = ensureDirs();
  job.state = state;
  job.finished_at = nowIso();
  job.result = result;
  job.error = state === 'failed' ? String(result.summary || result.error || 'failed') : '';
  moveJob(job, 'running', state === 'done' ? 'done' : 'failed');
  writeResult(job, state, result);
  return job;
}

function parseMergeBranch(command) {
  const prefix = '(?:^|[;&|]\\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*';
  const match = String(command || '').match(new RegExp(`${prefix}git\\s+merge(?=\\s|$)([^&|;]*)`, 'i'));
  if (!match) return null;
  const tokens = match[1].trim().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => ['--abort', '--continue', '--quit', '--skip'].includes(token))) return null;
  const takesValue = new Set(['-m', '--message', '-s', '--strategy', '-X', '--strategy-option', '--into-name']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^['"]|['"]$/g, '');
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return null;
}

function parsePrMerge(command) {
  const prefix = '(?:^|[;&|]\\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*';
  const match = String(command || '').match(new RegExp(`${prefix}gh\\s+pr\\s+merge\\s+(\\d+)`, 'i'));
  return match ? Number.parseInt(match[1], 10) : 0;
}

function deployCommandFor(config, command) {
  if (!config.deploy || config.deploy.enabled === false) return null;
  const text = String(command || '').trim();
  return (config.deploy.commands || []).find((item) =>
    text === item || text.startsWith(`${item} `)) || null;
}

function inferTicket(project, input) {
  if (!input || !input.agent_id) return '';
  const ledger = store.readLedger(project);
  if (!ledger) return '';
  const ticket = (ledger.tickets || []).find((item) =>
    item.owner && item.owner.agent_id === input.agent_id);
  return ticket ? ticket.id : '';
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function routeToolCall(input) {
  if (process.env.CSG_SERVICE_JOB) return null;
  if (!input || String(input.tool_name || '') !== 'Bash') return null;
  const globalConfig = readConfig();
  if (!globalConfig || !globalConfig.enabled) return null;
  if (input.agent_id && globalConfig.intercept && globalConfig.intercept.agents === false) return null;
  if (!input.agent_id && globalConfig.intercept && globalConfig.intercept.main === false) return null;

  const project = canonical(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  if (!isAllowedProject(globalConfig, project)) return null;
  const ledger = store.readLedger(project);
  if (ledger && ledger.stopped) {
    return deny('Super-agent 已停止，merge/deploy 不会进入队列；用户解除停止后再执行。');
  }
  const config = mergeConfig(globalConfig, readProjectConfig(project));
  const command = String((input.tool_input || {}).command || '');
  if (/^\s*(?:node\s+)?(?:"[^"]*csg-service\.js"|\S*csg-service\.js)\s+/i.test(command)) return null;

  const origin = {
    session_id: input.session_id || '',
    agent_id: input.agent_id || '',
    agent_type: input.agent_type || '',
    source: 'hook',
  };

  try {
    const pr = parsePrMerge(command);
    if (pr && config.merge && config.merge.enabled !== false) {
      if (config.merge.allowPrMerge !== true) {
        return deny('PR 合并由 service 管理，但 merge.allowPrMerge 未开启。先在 service.json 打开，或由用户直接处理。');
      }
      const result = enqueue({
        type: 'merge',
        project,
        payload: { pr, target: config.merge.targetBranch || 'main', ticket: inferTicket(project, input) },
        origin,
      });
      return deny(`已转交 Super-agent service，job ${result.job.id}。PR 合并由服务统一执行；用 /super-agent:service result ${result.job.id} 查看结果。`);
    }

    const branch = parseMergeBranch(command);
    if (branch && config.merge && config.merge.enabled !== false) {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
        return deny(`分支名 ${branch} 不符合安全规则；改用 /super-agent:job merge --branch <branch> 指定。`);
      }
      const result = enqueue({
        type: 'merge',
        project,
        payload: { branch, target: config.merge.targetBranch || 'main', ticket: inferTicket(project, input) },
        origin,
      });
      return deny(`已转交 Super-agent service，job ${result.job.id}。本地合并由服务统一执行；用 /super-agent:service result ${result.job.id} 查看结果。`);
    }

    const deployCommand = deployCommandFor(config, command);
    if (deployCommand) {
      const result = enqueue({
        type: 'deploy',
        project,
        payload: { command: deployCommand, ticket: inferTicket(project, input) },
        origin,
      });
      const approval = result.job.approval && result.job.approval.required
        ? `部署需用户批准：/super-agent:service approve ${result.job.id}`
        : '服务排队执行';
      return deny(`已转交 Super-agent service，job ${result.job.id}；${approval}。`);
    }
  } catch (error) {
    return deny(`Super-agent service 不可用：${error.message}。先运行 /super-agent:service init 或检查配置。`);
  }
  return null;
}

function cleanupOld(dir, days) {
  if (!store.exists(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      // ignore a file removed by another process
    }
  }
  return removed;
}

function cleanup(days) {
  const p = servicePaths();
  return {
    done: cleanupOld(p.done, days),
    failed: cleanupOld(p.failed, days),
    results: cleanupOld(p.results, days),
  };
}

module.exports = {
  JOB_TYPES,
  OPEN_STATES,
  approveJob,
  canonical,
  cleanup,
  configForProject,
  defaultConfig,
  deployCommandFor,
  enqueue,
  ensureDirs,
  findJob,
  finishJob,
  initConfig,
  isAllowedProject,
  listJobs,
  moveJob,
  nowIso,
  parseMergeBranch,
  parsePrMerge,
  projectResultDir,
  readConfig,
  readPaused,
  readProjectConfig,
  routeToolCall,
  serviceHome,
  servicePaths,
  setPaused,
  writeConfig,
  writeJob,
};

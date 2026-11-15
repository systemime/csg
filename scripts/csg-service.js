#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const service = require('./lib/service');
const store = require('./lib/store');

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

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`csg-service: ${message}\n`);
  process.exit(1);
}

function projectRoot(flags) {
  const explicit = flags.project || process.env.CLAUDE_PROJECT_DIR;
  if (explicit) return service.canonical(explicit);
  return service.canonical(store.findProjectRoot(process.cwd()));
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  const file = service.servicePaths().pid;
  if (!store.exists(file)) return 0;
  const value = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

function acquirePid() {
  const p = service.ensureDirs();
  const existing = readPid();
  if (existing && existing !== process.pid && isAlive(existing)) {
    throw new Error(`service already running (pid ${existing})`);
  }
  fs.writeFileSync(p.pid, `${process.pid}\n`, { mode: 0o600 });
  return () => {
    try {
      if (readPid() === process.pid) fs.unlinkSync(p.pid);
    } catch {
      // already removed
    }
  };
}

function runCommand(command, cwd, timeoutSec, env) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 2 * 1024 * 1024;
    const append = (current, chunk) => (current.length >= cap ? current : (current + chunk.toString()).slice(0, cap));
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    }, Math.max(1, timeoutSec) * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr, timedOut });
    });
  });
}

function runBinary(bin, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, stdout, stderr }));
  });
}

function trimOutput(text, limit = 4000) {
  const value = String(text || '');
  return value.length > limit ? value.slice(-limit) : value;
}

function logPaths(job) {
  const p = service.servicePaths();
  return {
    stdout: path.join(p.logs, `${job.id}.stdout.log`),
    stderr: path.join(p.logs, `${job.id}.stderr.log`),
  };
}

function saveLogs(job, result) {
  const p = service.servicePaths();
  fs.mkdirSync(p.logs, { recursive: true });
  const files = logPaths(job);
  fs.writeFileSync(files.stdout, result.stdout || '', { mode: 0o600 });
  fs.writeFileSync(files.stderr, result.stderr || '', { mode: 0o600 });
  return { stdout_path: files.stdout, stderr_path: files.stderr };
}

function shellResult(result) {
  return {
    exit_code: result.code,
    timed_out: result.timedOut,
    summary: trimOutput(result.stderr || result.stdout || `exit ${result.code}`, 500),
    stdout_tail: trimOutput(result.stdout),
    stderr_tail: trimOutput(result.stderr),
  };
}

function testCommandAllowed(config, command) {
  const text = String(command || '').trim();
  return (config.test.commands || []).some((item) => text === String(item).trim());
}

function deployCommandAllowed(config, command) {
  const text = String(command || '').trim();
  return (config.deploy.commands || []).some((item) => text === item);
}

async function mergeJob(job, config) {
  const payload = job.payload || {};
  const project = job.project;
  const merge = config.merge || {};
  if (payload.pr) {
    if (merge.allowPrMerge !== true) {
      return { ok: false, result: { summary: 'PR 合并未开启 merge.allowPrMerge' } };
    }
    const result = await runBinary('gh', ['pr', 'merge', String(payload.pr), '--merge'], project);
    const resultData = shellResult(result);
    return { ok: result.code === 0, result: { ...resultData, pr: payload.pr } };
  }

  const branch = String(payload.branch || '');
  const target = String(payload.target || merge.targetBranch || 'main');
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
    return { ok: false, result: { summary: `非法分支: ${branch}` } };
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(target) || target.includes('..') || target.startsWith('-')) {
    return { ok: false, result: { summary: `非法目标分支: ${target}` } };
  }

  const inside = await runBinary('git', ['rev-parse', '--is-inside-work-tree'], project);
  if (inside.code !== 0) return { ok: false, result: { summary: `不是 git 仓库: ${project}` } };

  const remote = String(merge.remote || 'origin');
  const remoteRef = `${remote}/${target}`;
  const remoteCheck = await runBinary('git', ['rev-parse', '--verify', remoteRef], project);
  const targetRef = remoteCheck.code === 0 ? remoteRef : target;
  const targetCheck = await runBinary('git', ['rev-parse', '--verify', targetRef], project);
  if (targetCheck.code !== 0) return { ok: false, result: { summary: `目标分支不存在: ${targetRef}` } };

  const worktree = path.join(service.servicePaths().worktrees, job.id);
  const integrationBranch = `csg/integrate-${job.id}`;
  try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* none */ }
  const add = await runBinary('git', ['worktree', 'add', '-b', integrationBranch, worktree, targetRef], project);
  if (add.code !== 0) {
    return { ok: false, result: { ...shellResult(add), summary: `创建 worktree 失败: ${trimOutput(add.stderr, 300)}` } };
  }

  const mergeResult = await runBinary('git', ['merge', '--no-ff', branch, '-m', `Merge ${branch} into ${target} (service ${job.id})`], worktree);
  if (mergeResult.code !== 0) {
    return {
      ok: false,
      result: {
        ...shellResult(mergeResult),
        summary: `合并冲突或失败: ${branch} -> ${target}`,
        conflict: true,
        worktree,
        branch: integrationBranch,
      },
    };
  }

  const checks = [];
  for (const command of merge.checks || []) {
    const check = await runCommand(command, worktree, config.test.timeoutSec || 1800, { CSG_SERVICE_JOB: job.id });
    checks.push({ command, ...shellResult(check) });
    if (check.code !== 0 || check.timedOut) {
      return {
        ok: false,
        result: {
          summary: `合并后检查失败: ${command}`,
          checks,
          worktree,
          branch: integrationBranch,
        },
      };
    }
  }

  let push = null;
  if (merge.push !== false) {
    push = await runBinary('git', ['push', '-u', remote, integrationBranch], worktree);
    if (push.code !== 0) {
      return {
        ok: false,
        result: {
          ...shellResult(push),
          summary: `推送集成分支失败: ${trimOutput(push.stderr, 300)}`,
          checks,
          worktree,
          branch: integrationBranch,
        },
      };
    }
  }

  let pr = '';
  if (merge.createPr !== false) {
    const gh = spawnSync('gh', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (gh.status === 0) {
      const created = await runBinary('gh', [
        'pr', 'create', '--base', target, '--head', integrationBranch,
        '--title', `Integrate ${branch} into ${target}`,
        '--body', `This is by an automated agent, not a human.\n\nSuper-agent service job ${job.id}.`,
      ], worktree);
      if (created.code === 0) {
        pr = (created.stdout.match(/https?:\/\/\S+/g) || [])[0] || '';
      }
    }
  }

  if (merge.keepWorktree !== true) {
    await runBinary('git', ['worktree', 'remove', '--force', worktree], project);
  }

  return {
    ok: true,
    result: {
      summary: `合并完成: ${branch} -> ${target}`,
      branch: integrationBranch,
      target,
      pr,
      checks,
      worktree: merge.keepWorktree === true ? worktree : '',
    },
  };
}

async function execute(job) {
  const config = service.configForProject(job.project);
  if (!config) throw new Error('service config missing');
  if (job.type === 'test') {
    const command = String(job.payload.command || '');
    if (!testCommandAllowed(config, command)) throw new Error(`测试命令不在允许列表: ${command}`);
    const result = await runCommand(command, job.project, config.test.timeoutSec || 1800, { CSG_SERVICE_JOB: job.id });
    const data = shellResult(result);
    const logs = saveLogs(job, result);
    if (result.code !== 0 || result.timedOut) {
      return { state: 'failed', result: { ...data, ...logs, summary: data.summary || '测试失败' } };
    }
    return { state: 'done', result: { ...data, ...logs, summary: '测试通过' } };
  }

  if (job.type === 'deploy') {
    if (job.approval && job.approval.required && !job.approval.approved_by) {
      return { state: 'failed', result: { summary: '部署未获用户批准' } };
    }
    const command = String(job.payload.command || '');
    if (!deployCommandAllowed(config, command)) throw new Error(`部署命令不在允许列表: ${command}`);
    const result = await runCommand(command, job.project, config.deploy.timeoutSec || 1800, {
      CSG_SERVICE_JOB: job.id,
      CSG_PROJECT: job.project,
      CSG_APPROVED_BY: job.approval.approved_by || '',
    });
    const data = shellResult(result);
    const logs = saveLogs(job, result);
    if (result.code !== 0 || result.timedOut) {
      return { state: 'failed', result: { ...data, ...logs, summary: data.summary || '部署失败' } };
    }
    return { state: 'done', result: { ...data, ...logs, summary: '部署完成' } };
  }

  if (job.type === 'merge') {
    const merged = await mergeJob(job, config);
    return { state: merged.ok ? 'done' : 'failed', result: merged.result };
  }

  if (job.type === 'agent') {
    if (!config.agent || config.agent.enabled !== true) {
      return { state: 'failed', result: { summary: 'agent job 未开启' } };
    }
    const prompt = String(job.payload.prompt || '');
    if (!prompt) return { state: 'failed', result: { summary: '缺少 prompt' } };
    const role = job.payload.role || config.agent.role || 'super-agent:super-agent-integrator';
    const bin = process.env.CLAUDE_BIN || 'claude';
    const args = ['-p', prompt, '--agent', role, '--output-format', 'text'];
    if (config.agent.permissionMode) args.push('--permission-mode', config.agent.permissionMode);
    const result = await new Promise((resolve) => {
      const child = spawn(bin, args, {
        cwd: job.project,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: { ...process.env, CSG_SERVICE_JOB: job.id },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, (config.agent.timeoutSec || 1800) * 1000);
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code === null ? -1 : code, stdout, stderr }); });
    });
    const logs = saveLogs(job, result);
    if (result.code !== 0) {
      return { state: 'failed', result: { exit_code: result.code, ...logs, summary: trimOutput(result.stderr || result.stdout, 500) } };
    }
    return { state: 'done', result: { exit_code: 0, ...logs, summary: trimOutput(result.stdout, 1000) } };
  }

  throw new Error(`unsupported job type: ${job.type}`);
}

async function runJob(job) {
  job.state = 'running';
  job.started_at = service.nowIso();
  job.attempts = (job.attempts || 0) + 1;
  service.moveJob(job, 'queued', 'running');
  try {
    const result = await execute(job);
    service.finishJob(job, result.state, result.result);
    return result.state;
  } catch (error) {
    service.finishJob(job, 'failed', { summary: error.message, exit_code: -1 });
    return 'failed';
  }
}

function canStart(job, runningJobs, config) {
  if (job.type === 'test') {
    const count = runningJobs.filter((item) => item.type === 'test').length;
    return count < (config.test.parallel || 1);
  }
  if (job.type === 'merge') {
    return !runningJobs.some((item) => item.type === 'merge' && item.project === job.project);
  }
  if (job.type === 'deploy') return !runningJobs.some((item) => item.type === 'deploy');
  if (job.type === 'agent') return !runningJobs.some((item) => item.type === 'agent');
  return false;
}

function startJob(job, active) {
  const promise = runJob(job)
    .catch((error) => {
      try {
        service.finishJob(job, 'failed', { summary: error.message });
      } catch {
        // best effort
      }
    })
    .finally(() => {
      active.delete(job.id);
    });
  active.set(job.id, promise);
  return promise;
}

async function tick(active) {
  if (service.readPaused()) return 0;
  const running = service.listJobs(['running']);
  const queued = service.listJobs(['queued']);
  let started = 0;
  for (const job of queued) {
    if (active.has(job.id)) continue;
    const config = service.configForProject(job.project);
    if (!config || config.enabled === false) continue;
    const ledger = store.readLedger(job.project);
    if (ledger && ledger.stopped) continue;
    if (!canStart(job, running, config)) continue;
    running.push(job);
    startJob(job, active);
    started += 1;
  }
  return started;
}

async function runOnce() {
  const active = new Map();
  for (;;) {
    const started = await tick(active);
    if (!active.size) {
      if (!started) break;
      continue;
    }
    await Promise.all([...active.values()]);
  }
}

async function runLoop() {
  const release = acquirePid();
  const p = service.ensureDirs();
  const active = new Map();
  const wakeups = [];
  let stopping = false;
  let watcher = null;
  const stop = () => { stopping = true; release(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    watcher = fs.watch(p.queued, { persistent: false }, () => {
      for (const wake of wakeups.splice(0)) wake();
    });
  } catch (error) {
    fs.appendFileSync(p.log, `${service.nowIso()} watch: ${error.message}\n`);
  }
  for (;;) {
    if (stopping) break;
    try {
      await tick(active);
    } catch (error) {
      fs.appendFileSync(p.log, `${service.nowIso()} tick: ${error.stack || error.message}\n`);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      wakeups.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (watcher) watcher.close();
  if (active.size) await Promise.allSettled([...active.values()]);
  return 0;
}

function cmdInit(flags) {
  const project = projectRoot(flags);
  const config = service.initConfig(project);
  process.stdout.write(`service config: ${service.servicePaths().config}\nallowed project: ${project}\n`);
  if (flags.json) writeJson({ config });
}

function cmdStatus(flags) {
  const p = service.servicePaths();
  const config = service.readConfig();
  const pid = readPid();
  const counts = {};
  for (const state of ['queued', 'running', 'awaiting', 'done', 'failed']) {
    counts[state] = service.listJobs([state]).length;
  }
  const data = {
    running: Boolean(pid && isAlive(pid)),
    pid,
    paused: Boolean(service.readPaused()),
    config: config ? p.config : '',
    allowedProjects: config ? config.allowedProjects : [],
    counts,
  };
  if (flags.json) writeJson(data);
  else {
    process.stdout.write(`service ${data.running ? `running pid=${pid}` : 'stopped'} paused=${data.paused}\n`);
    process.stdout.write(`queued=${counts.queued} running=${counts.running} awaiting=${counts.awaiting} done=${counts.done} failed=${counts.failed}\n`);
    if (!config) process.stdout.write('config missing; run init\n');
  }
}

function cmdList(flags) {
  const states = flags.state ? [String(flags.state)] : ['awaiting', 'queued', 'running', 'done', 'failed'];
  const jobs = service.listJobs(states);
  if (flags.json) writeJson(jobs);
  else {
    for (const job of jobs) {
      process.stdout.write(`${job.id} ${job.state} ${job.type} ${job.project} ${job.error || ''}\n`);
    }
    if (!jobs.length) process.stdout.write('no jobs\n');
  }
}

function cmdResult(flags) {
  const id = flags._[0];
  if (!id) fail('missing job id');
  const file = path.join(service.servicePaths().results, `${id}.json`);
  const result = store.readJson(file, null);
  if (!result) fail(`result not found: ${id}`);
  if (flags.json) writeJson(result);
  else process.stdout.write(`${result.summary}\n`);
}

function cmdApprove(flags) {
  const id = flags._[0];
  if (!id) fail('missing job id');
  const job = service.approveJob(id, flags.by || 'user');
  process.stdout.write(`approved ${job.id}; queued\n`);
}

function cmdEnqueue(flags) {
  const type = flags.type;
  if (!type) fail('missing --type');
  const project = projectRoot(flags);
  const payload = {};
  if (flags.branch) payload.branch = flags.branch;
  if (flags.target) payload.target = flags.target;
  if (flags.command) payload.command = flags.command;
  if (flags.pr) payload.pr = Number.parseInt(flags.pr, 10);
  if (flags.prompt) payload.prompt = flags.prompt;
  if (flags.ticket) payload.ticket = flags.ticket;
  if (type === 'test' || type === 'deploy') {
    if (!payload.command) fail(`missing --command for ${type}`);
  }
  if (type === 'merge' && !payload.branch && !payload.pr) fail('missing --branch or --pr');
  if (type === 'agent' && !payload.prompt) fail('missing --prompt');
  const result = service.enqueue({
    type,
    project,
    payload,
    role: flags.role,
    origin: { source: 'cli', session_id: process.env.CLAUDE_SESSION_ID || '' },
  });
  if (flags.json) writeJson(result);
  else process.stdout.write(`${result.job.id} ${result.job.state}${result.duplicate ? ' (duplicate)' : ''}\n`);
}

function cmdPause(flags) {
  if (!service.readConfig()) {
    process.stdout.write('service not configured\n');
    return;
  }
  const reason = flags.reason || 'user pause';
  const data = service.setPaused(reason, flags.by || 'user');
  process.stdout.write(`service paused: ${data.reason}\n`);
}

function cmdResume() {
  if (!service.readConfig()) {
    process.stdout.write('service not configured\n');
    return;
  }
  service.setPaused('');
  process.stdout.write('service resumed\n');
}

function cmdStart() {
  if (!service.readConfig()) {
    fail('service not configured; run init first');
  }
  const p = service.ensureDirs();
  const pid = readPid();
  if (pid && isAlive(pid)) {
    process.stdout.write(`service already running pid=${pid}\n`);
    return;
  }
  const out = fs.openSync(p.log, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'csg-service.js'), 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  process.stdout.write(`service started pid=${child.pid}; log=${p.log}\n`);
}

function cmdStop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    process.stdout.write('service not running\n');
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  process.stdout.write(`stopped pid=${pid}\n`);
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function copyRuntime() {
  const p = service.ensureDirs();
  fs.mkdirSync(path.join(p.runtime, 'lib'), { recursive: true });
  for (const file of ['csg-service.js']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(p.runtime, file));
  }
  for (const file of ['service.js', 'store.js']) {
    fs.copyFileSync(path.join(__dirname, 'lib', file), path.join(p.runtime, 'lib', file));
  }
  return p.runtime;
}

function writeSupervisorFiles() {
  const p = service.ensureDirs();
  const runtime = copyRuntime();
  const node = process.execPath;
  const script = path.join(runtime, 'csg-service.js');
  const log = p.log;
  const home = p.base;
  const pathEnv = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.systemime.csg-service</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(script)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(home)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>
    <key>CSG_SERVICE_HOME</key><string>${xmlEscape(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict></plist>
`;
  fs.writeFileSync(path.join(p.supervisor, 'com.systemime.csg-service.plist'), plist);
  const systemd = `[Unit]
Description=Super-agent deterministic service
After=network.target

[Service]
Type=simple
ExecStart="${node}" "${script}" run
WorkingDirectory=${home}
Environment="PATH=${pathEnv}"
Environment="CSG_SERVICE_HOME=${home}"
Restart=always
RestartSec=3
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(path.join(p.supervisor, 'csg-service.service'), systemd);
  const cmdWrapper = path.join(p.supervisor, 'run-service.cmd');
  fs.writeFileSync(cmdWrapper, `@echo off\r\nset "CSG_SERVICE_HOME=${home}"\r\n"${node}" "${script}" run\r\n`);
  const ps = `$ErrorActionPreference = 'Stop'
$wrapper = '${String(cmdWrapper).replace(/'/g, "''")}'
$task = 'csg-service'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $wrapper + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Description 'Super-agent deterministic service' -Force
Write-Host "Registered scheduled task $task"
`;
  fs.writeFileSync(path.join(p.supervisor, 'install-windows.ps1'), ps);
  const psRemove = `$task = 'csg-service'
Unregister-ScheduledTask -TaskName $task -Confirm:$false
Write-Host "Removed scheduled task $task"
`;
  fs.writeFileSync(path.join(p.supervisor, 'uninstall-windows.ps1'), psRemove);
  fs.writeFileSync(path.join(p.supervisor, 'run.sh'), `#!/bin/sh
exec "${node}" "${script}" run
`);
  fs.chmodSync(path.join(p.supervisor, 'run.sh'), 0o755);
  fs.writeFileSync(path.join(p.supervisor, 'run.ps1'), `& "${node}" "${script}" run\n`);
  return { runtime, supervisor: p.supervisor, node, script, log };
}

function cmdInstall() {
  const info = writeSupervisorFiles();
  process.stdout.write(`generated:\n`);
  process.stdout.write(`  ${path.join(info.supervisor, 'com.systemime.csg-service.plist')}\n`);
  process.stdout.write(`  ${path.join(info.supervisor, 'csg-service.service')}\n`);
  process.stdout.write(`  ${path.join(info.supervisor, 'install-windows.ps1')}\n`);
  process.stdout.write(`  ${path.join(info.supervisor, 'run.sh')}\n`);
  process.stdout.write(`runtime: ${info.runtime}\n`);
  process.stdout.write(`\nmacOS:\n  cp "${path.join(info.supervisor, 'com.systemime.csg-service.plist')}" ~/Library/LaunchAgents/\n  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.systemime.csg-service.plist\n`);
  process.stdout.write(`\nLinux:\n  mkdir -p ~/.config/systemd/user\n  cp "${path.join(info.supervisor, 'csg-service.service')}" ~/.config/systemd/user/\n  systemctl --user daemon-reload && systemctl --user enable --now csg-service\n`);
  process.stdout.write(`\nWindows:\n  powershell -ExecutionPolicy Bypass -File "${path.join(info.supervisor, 'install-windows.ps1')}"\n`);
  process.stdout.write(`\nNot installed automatically. Confirm before running the commands above.\n`);
}

function cmdCleanup(flags) {
  const config = service.readConfig();
  const days = Number.parseInt(flags.days || (config && config.retentionDays) || 7, 10);
  const removed = service.cleanup(days);
  process.stdout.write(`removed done=${removed.done} failed=${removed.failed} results=${removed.results}\n`);
}

function cmdLogs(flags) {
  const lines = Number.parseInt(flags.lines || 80, 10);
  const file = service.servicePaths().log;
  if (!store.exists(file)) {
    process.stdout.write('no log\n');
    return;
  }
  const content = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  process.stdout.write(`${content.slice(-lines).join('\n')}\n`);
}

function usage() {
  process.stdout.write(`csg-service.js — Super-agent 确定性服务

用法:
  csg-service.js init [--project <path>]
  csg-service.js status [--json]
  csg-service.js list [--state <state>] [--json]
  csg-service.js result <job> [--json]
  csg-service.js approve <job> [--by <name>]
  csg-service.js enqueue --type test|merge|deploy|agent --project <path> [--command <cmd>] [--branch <b>] [--pr <n>] [--prompt <text>] [--json]
  csg-service.js run [--once]
  csg-service.js start
  csg-service.js stop
  csg-service.js pause [--reason <text>]
  csg-service.js resume
  csg-service.js install
  csg-service.js cleanup [--days <n>]
  csg-service.js logs [--lines <n>]
`);
}

function main(argv) {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') { usage(); return; }
  const flags = parseFlags([subcommand, ...rest].filter((value) => value !== undefined));
  switch (command) {
    case 'init': cmdInit(flags); break;
    case 'status': cmdStatus(flags); break;
    case 'list': cmdList(flags); break;
    case 'result': cmdResult(flags); break;
    case 'approve': cmdApprove(flags); break;
    case 'enqueue': cmdEnqueue(flags); break;
    case 'run':
      if (!service.readConfig()) fail('service not configured; run init first');
      if (flags.once) {
        const pid = readPid();
        if (pid && isAlive(pid)) fail(`service already running (pid ${pid})`);
        runOnce().catch((error) => { fail(error.stack || error.message); });
      } else {
        runLoop().catch((error) => { fail(error.stack || error.message); });
      }
      break;
    case 'start': cmdStart(); break;
    case 'stop': cmdStop(); break;
    case 'pause': cmdPause(flags); break;
    case 'resume': cmdResume(); break;
    case 'install': cmdInstall(); break;
    case 'cleanup': cmdCleanup(flags); break;
    case 'logs': cmdLogs(flags); break;
    default: usage(); process.exit(1);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`csg-service: ${error.message}\n`);
  process.exit(1);
}

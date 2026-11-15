'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { makeProject } = require('./helpers');

const rootDir = path.resolve(__dirname, '..');
const csg = path.join(rootDir, 'scripts', 'csg.js');
const serviceCli = path.join(rootDir, 'scripts', 'csg-service.js');

function serviceHome(root) {
  return path.join(root, '.service-home');
}

function envFor(root) {
  return {
    ...process.env,
    CLAUDE_PROJECT_DIR: root,
    CSG_SERVICE_HOME: serviceHome(root),
  };
}

function runService(root, args, options = {}) {
  const result = spawnSync(process.execPath, [serviceCli, ...args], {
    cwd: root,
    env: { ...envFor(root), ...(options.env || {}) },
    encoding: 'utf8',
    input: options.input,
  });
  if (result.error) throw result.error;
  return result;
}

function runServiceJson(root, args, options = {}) {
  const result = runService(root, args, options);
  if (result.status !== 0) throw new Error(`service ${args.join(' ')}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function hook(root, input) {
  return spawnSync(process.execPath, [csg, 'hook', 'pre-tool-use'], {
    cwd: root,
    env: envFor(root),
    encoding: 'utf8',
    input: JSON.stringify(input),
  });
}

function serviceConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(serviceHome(root), 'service.json'), 'utf8'));
}

function writeServiceConfig(root, config) {
  fs.writeFileSync(path.join(serviceHome(root), 'service.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function jobsIn(root, state) {
  const dir = path.join(serviceHome(root), 'jobs', state);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

function initGitProject(root) {
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'csg@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'CSG Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'main\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'main'], { cwd: root });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: root });
  execFileSync('git', ['checkout', '-b', 'feature'], { cwd: root });
  fs.writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'feature'], { cwd: root });
  execFileSync('git', ['checkout', 'main'], { cwd: root });
}

test('service init 把项目加入允许列表，状态可读', (t) => {
  const root = makeProject(t);
  const result = runService(root, ['init', '--project', root]);
  assert.equal(result.status, 0, result.stderr);
  const config = serviceConfig(root);
  assert.equal(config.enabled, true);
  assert.ok(config.allowedProjects.includes(fs.realpathSync(root)));

  const status = runServiceJson(root, ['status', '--json']);
  assert.equal(status.running, false);
  assert.equal(status.counts.queued, 0);
});

test('主会话 git merge 被转成 service job 并拒绝直接执行', (t) => {
  const root = makeProject(t);
  runService(root, ['init', '--project', root]);

  const result = hook(root, {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: root,
    tool_name: 'Bash',
    tool_input: { command: 'git merge feature' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /job j-/);

  const queued = jobsIn(root, 'queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, 'merge');
  assert.equal(queued[0].payload.branch, 'feature');
});

test('service 未配置时 hook 不拦截', (t) => {
  const root = makeProject(t);
  const result = hook(root, {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: root,
    tool_name: 'Bash',
    tool_input: { command: 'git merge feature' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('deploy 默认等用户批准，批准后进入队列', (t) => {
  const root = makeProject(t);
  runService(root, ['init', '--project', root]);
  const config = serviceConfig(root);
  config.deploy.commands = ['./deploy.sh'];
  writeServiceConfig(root, config);

  const queued = runServiceJson(root, ['enqueue', '--type', 'deploy', '--project', root, '--command', './deploy.sh', '--json']);
  assert.equal(queued.job.state, 'awaiting');
  const id = queued.job.id;

  const approved = runService(root, ['approve', id, '--by', 'user']);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(jobsIn(root, 'queued').length, 1);
  assert.equal(jobsIn(root, 'queued')[0].approval.approved_by, 'user');
});

test('test job 只执行允许列表里的命令并写结果', (t) => {
  const root = makeProject(t);
  runService(root, ['init', '--project', root]);
  const config = serviceConfig(root);
  config.test.commands.push('node -e "console.log(\'ok\')"');
  writeServiceConfig(root, config);

  const queued = runServiceJson(root, ['enqueue', '--type', 'test', '--project', root, '--command', 'node -e "console.log(\'ok\')"', '--json']);
  const run = runService(root, ['run', '--once']);
  assert.equal(run.status, 0, run.stderr);

  const resultFile = path.join(serviceHome(root), 'results', `${queued.job.id}.json`);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.state, 'done');
  assert.match(result.summary, /测试通过/);
});

test('merge job 使用独立 worktree 合并并保留集成分支', (t) => {
  const root = makeProject(t);
  initGitProject(root);
  runService(root, ['init', '--project', root]);
  const config = serviceConfig(root);
  config.merge.push = false;
  config.merge.createPr = false;
  config.merge.checks = [];
  writeServiceConfig(root, config);

  const queued = runServiceJson(root, [
    'enqueue', '--type', 'merge', '--project', root,
    '--branch', 'feature', '--target', 'main', '--json',
  ]);
  const run = runService(root, ['run', '--once']);
  assert.equal(run.status, 0, run.stderr);

  const result = JSON.parse(fs.readFileSync(path.join(serviceHome(root), 'results', `${queued.job.id}.json`), 'utf8'));
  assert.equal(result.state, 'done', result.summary);
  assert.match(result.result.branch, /^csg\/integrate-/);
  const branches = execFileSync('git', ['branch', '--list', 'csg/integrate-*'], { cwd: root, encoding: 'utf8' });
  assert.match(branches, /csg\/integrate-/);
});

test('service install 只生成启动文件，不执行安装', (t) => {
  const root = makeProject(t);
  runService(root, ['init', '--project', root]);
  const result = runService(root, ['install']);
  assert.equal(result.status, 0, result.stderr);
  const supervisor = path.join(serviceHome(root), 'supervisor');
  for (const name of ['com.systemime.csg-service.plist', 'csg-service.service', 'install-windows.ps1']) {
    assert.ok(fs.existsSync(path.join(supervisor, name)), `${name} 应生成`);
  }
  assert.match(result.stdout, /Not installed automatically/);
});

test('monitor 打印新的 service 结果', (t) => {
  const root = makeProject(t);
  const resultDir = path.join(root, '.claude', 'super-agent', 'service-results');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(path.join(resultDir, 'j-test.json'), JSON.stringify({
    id: 'j-test',
    state: 'done',
    summary: 'service j-test 测试完成',
    finished_at: new Date().toISOString(),
  }));
  const result = spawnSync(process.execPath, [csg, 'monitor'], {
    cwd: root,
    env: { ...envFor(root), CSG_MONITOR_ONCE: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /job j-test done: service j-test 测试完成/);
});

test('hooks.json 包含 LLM 意图分析 prompt hook', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(rootDir, 'hooks', 'hooks.json'), 'utf8'));
  const groups = hooks.hooks.PreToolUse;
  const prompts = groups.flatMap((group) => group.hooks || []).filter((item) => item.type === 'prompt');
  assert.ok(prompts.length >= 5, '应有多个 prompt 意图 hook');
  assert.ok(prompts.some((item) => String(item.prompt).includes('tool_input.command')));
});

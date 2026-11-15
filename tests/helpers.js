'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.resolve(__dirname, '..', 'scripts', 'csg.js');

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(root, args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      CSG_SERVICE_HOME: path.join(root, '.csg-service'),
      ...(options.env || {}),
    },
    input: options.input,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function runCliJson(root, args, options = {}) {
  const result = runCli(root, args, options);
  if (result.status !== 0) {
    throw new Error(`csg ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function initProject(t) {
  const root = makeProject(t);
  const result = runCli(root, ['init']);
  if (result.status !== 0) throw new Error(`init failed: ${result.stderr}`);
  return root;
}

function readLedger(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'super-agent', 'ledger.json'), 'utf8'));
}

function readEvents(root) {
  const file = path.join(root, '.claude', 'super-agent', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function hook(root, event, input, options = {}) {
  return runCli(root, ['hook', event], { ...options, input: JSON.stringify(input) });
}

function hookJson(root, event, input, options = {}) {
  const result = hook(root, event, input, options);
  if (result.status !== 0) {
    throw new Error(`hook ${event} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function submitReport(root, text) {
  return runCliJson(root, ['report', '--json'], { input: text });
}

function makeFakeGh(root) {
  const binDir = path.join(root, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const stateFile = path.join(root, 'gh-pr.json');
  const script = path.join(binDir, 'gh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "gh version 2.0.0"',
    '  exit 0',
    'fi',
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  exec /bin/cat "$GH_STUB_FILE"',
    'fi',
    'exit 0',
  ].join('\n') + '\n');
  fs.chmodSync(script, 0o755);
  return {
    stateFile,
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      GH_STUB_FILE: stateFile,
      CSG_MONITOR_ONCE: '1',
    },
    setPr(pr) {
      fs.writeFileSync(stateFile, `${JSON.stringify(pr)}\n`);
    },
  };
}

module.exports = {
  cli,
  hook,
  hookJson,
  initProject,
  makeFakeGh,
  makeProject,
  readEvents,
  readLedger,
  runCli,
  runCliJson,
  submitReport,
};

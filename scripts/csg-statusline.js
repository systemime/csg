#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');

function run() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const cwd = (input.workspace && input.workspace.current_dir)
    || (input.workspace && input.workspace.project_dir)
    || input.cwd
    || process.cwd();
  const root = process.env.CLAUDE_PROJECT_DIR || store.findProjectRoot(cwd);
  const ledger = store.readLedger(root);
  if (!ledger) return;
  const normalized = store.normalizeLedger(ledger);
  const open = normalized.tickets.filter((ticket) => store.ACTIVE.has(ticket.state) && ticket.state !== 'proposed');
  const blocked = normalized.tickets.filter((ticket) => ticket.state === 'blocked').length;
  const events = store.listEvents(root, { unackedOnly: true, limit: 100 }).filter((event) => !event.notified);
  const parts = [];
  if (normalized.stopped) parts.push('STOP');
  parts.push(`${open.length} open`);
  if (blocked) parts.push(`${blocked} blocked`);
  parts.push(`${events.length} events`);
  const ids = open.slice(0, 4).map((ticket) => `${ticket.id}:${ticket.state}`).join(' ');
  process.stdout.write(`SA ${parts.join(' · ')}${ids ? ` · ${ids}` : ''}\n`);
}

module.exports = { run };

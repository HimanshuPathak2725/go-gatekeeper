'use strict';
/**
 * system_shell.js — Gatekeeper Universal System Shell Wrapper
 *
 * Provides full OS command support by routing commands through
 * PowerShell (Windows) or bash (Unix/macOS).
 *
 * Protocol:
 *  - Reads newline-delimited commands from stdin
 *  - Streams stdout/stderr from each command to process.stdout/stderr
 *  - Writes "$ " prompt after each command completes
 */

const { spawn }  = require('child_process');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const readline   = require('readline');

const IS_WIN = process.platform === 'win32';

let cwd  = process.cwd();
let busy = false;

/* ─── PROMPT ─────────────────────────────────────────────── */
function writePrompt() {
  process.stdout.write('\n$ ');
}

/* ─── SYSTEM COMMAND ─────────────────────────────────────── */
function runSystem(line, done) {
  let exe, args;

  if (IS_WIN) {
    // PowerShell gives us ls, cat, grep aliases + full Windows commands
    exe  = 'powershell.exe';
    args = [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-OutputFormat', 'Text',
      '-Command', line
    ];
  } else {
    exe  = '/bin/bash';
    args = ['-c', line];
  }

  const child = spawn(exe, args, {
    cwd,
    env : { ...process.env, TERM: 'dumb' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));

  child.on('close', () => done());
  child.on('error', err => {
    const cmd = line.trim().split(/\s+/)[0];
    process.stderr.write(`${cmd}: command not found\n`);
    done();
  });
}

/* ─── BUILT-IN COMMANDS ──────────────────────────────────── */
function handleBuiltin(line) {
  // Simple tokenizer (respects single/double quotes)
  const tokens = [];
  let cur = '', inQ = false, qCh = '';
  for (const ch of line) {
    if (inQ) {
      if (ch === qCh) inQ = false; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      inQ = true; qCh = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur.length) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur.length) tokens.push(cur);
  if (!tokens.length) return true;

  const [cmd, ...args] = tokens;

  switch (cmd.toLowerCase()) {

    // ── cd ──
    case 'cd': {
      let target = args[0] || os.homedir();
      if (target === '~')                     target = os.homedir();
      else if (/^~[/\\]/.test(target))       target = path.join(os.homedir(), target.slice(2));
      const dest = path.isAbsolute(target) ? target : path.resolve(cwd, target);
      try {
        if (fs.statSync(dest).isDirectory()) { cwd = dest; try { process.chdir(dest); } catch(_){} }
        else process.stderr.write(`cd: not a directory: ${target}\n`);
      } catch(_) { process.stderr.write(`cd: no such file or directory: ${target}\n`); }
      return true;
    }

    // ── pwd ──
    case 'pwd':
      process.stdout.write(cwd + '\n');
      return true;

    // ── echo ──
    case 'echo':
      process.stdout.write(args.join(' ') + '\n');
      return true;

    // ── clear / cls ──
    case 'clear':
    case 'cls':
      return true; // client clears the UI

    // ── exit ──
    case 'exit':
    case 'quit':
      process.exit(0);
      return true;

    // ── share / invite ──
    case 'share':
    case 'invite':
    case 'gk-share': {
      const code = process.env.GATEKEEPER_SESSION_CODE || '??????';
      const ip   = process.env.GATEKEEPER_IP   || 'localhost';
      const port = process.env.GATEKEEPER_PORT  || '8080';
      const url  = `http://${ip}:${port}?role=guest&code=${code}`;

      const inner = 58;
      const hr    = '─'.repeat(inner);
      const blank = ' '.repeat(inner);
      const row   = (s) => '│ ' + s + ' '.repeat(Math.max(0, inner - 1 - s.length)) + ' │';

      process.stdout.write([
        '',
        '┌' + hr + '┐',
        row('  GATEKEEPER — GUEST INVITE LINK'),
        '├' + hr + '┤',
        row(''),
        row('  Link  : ' + url),
        row('  Code  : ' + code),
        row(''),
        row('  Share the link above with your collaborator.'),
        row('  Every command they run will need your approval.'),
        row(''),
        '└' + hr + '┘',
        '',
      ].join('\n'));
      return true;
    }

    // ── whoami ──
    case 'whoami':
      process.stdout.write('host (gatekeeper owner)\n');
      return true;

    // ── status ──
    case 'status': {
      const code = process.env.GATEKEEPER_SESSION_CODE || '?';
      const ip   = process.env.GATEKEEPER_IP   || 'localhost';
      const port = process.env.GATEKEEPER_PORT  || '8080';
      process.stdout.write([
        `  session : ${code}`,
        `  host    : ${ip}:${port}`,
        `  shell   : ${IS_WIN ? 'powershell' : 'bash'}`,
        '',
      ].join('\n'));
      return true;
    }

    // ── help ──
    case 'help':
      process.stdout.write([
        ''
      ].join('\n'));
      return true;

    default:
      return false;
  }
}

/* ─── MAIN REPL LOOP ─────────────────────────────────────── */

// Initial prompt (no leading newline for the very first one)
process.stdout.write('$ ');

const rl = readline.createInterface({
  input   : process.stdin,
  output  : null,
  terminal: false
});

rl.on('line', rawLine => {
  if (busy) return;
  const line = rawLine.trim();
  if (!line) { writePrompt(); return; }

  if (handleBuiltin(line)) { writePrompt(); return; }

  busy = true;
  runSystem(line, () => { busy = false; writePrompt(); });
});

rl.on('close', () => process.exit(0));

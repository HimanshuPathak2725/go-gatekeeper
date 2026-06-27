'use strict';
/**
 * Gatekeeper Shell — Terminal Client v3
 * - Fixed output buffering (no more character-by-character splits)
 * - Inline approval bar instead of big modal popup
 */

document.addEventListener('DOMContentLoaded', () => {

  /* ── DOM ────────────────────────────────────────────── */
  const tBody        = document.getElementById('tBody');
  const outputLog    = document.getElementById('outputLog');
  const inputDisplay = document.getElementById('inputDisplay');
  const hiddenInput  = document.getElementById('hiddenInput');
  const cursor       = document.getElementById('cursor');
  const ps1Wrap      = document.getElementById('ps1Wrap');
  const ps1User      = document.getElementById('ps1User');
  const ps1Path      = document.getElementById('ps1Path');
  const tTitle       = document.getElementById('tTitle');
  const tRole        = document.getElementById('tRole');
  const footLeft     = document.getElementById('footLeft');
  const footMid      = document.getElementById('footMid');
  const footRight    = document.getElementById('footRight');

  // Approval bar (host)
  const apvBar  = document.getElementById('apvBar');
  const apvCmd  = document.getElementById('apvCmd');

  // Guest waiting bar
  const waitBar = document.getElementById('waitBar');
  const waitMsg = document.getElementById('waitMsg');

  // Error banner
  const errBanner = document.getElementById('errBanner');
  const errMsg    = document.getElementById('errMsg');

  /* ── Role ───────────────────────────────────────────── */
  const params = new URLSearchParams(location.search);
  const role   = params.get('role') === 'host' ? 'host' : 'guest';
  const code   = params.get('code') || '';

  tRole.textContent = role.toUpperCase();
  tRole.classList.add(role);
  ps1User.textContent = role === 'host' ? 'host' : 'guest';
  tTitle.textContent  = `gatekeeper \u2014 ${role}`;

  if (role === 'host') {
    footRight.textContent = 'share \u00b7 help \u00b7 status';
  } else {
    footRight.textContent = 'commands need host approval';
  }

  /* ── State ──────────────────────────────────────────── */
  let isReady       = false;
  let isApprPending = false;
  let roomCode      = '';   // assigned by server after host connects
  let roomGuestURL  = '';   // full guest URL for this room

  const cmdHistory = [];
  let histIdx  = -1;
  let histTemp = '';
  let tabLast  = '';
  let tabCount = 0;

  let cwdLabel = '~'; // shadow cwd for prompt display

  /* ── Output buffer ──────────────────────────────────── */
  /**
   * We accumulate shell output in outputBuf.
   * system_shell.js writes:
   *   - "$ "      at startup (initial prompt, no leading \n)
   *   - "\n$ "    after each command completes
   *
   * We flush ONLY when:
   *   (a) we have a complete prompt at the end  → mark isReady, render before
   *   (b) we have a full line ending with \n    → render that line(s)
   *
   * We NEVER flush partial lines. This prevents "p", "e", "r" on separate rows.
   */
  let outBuf = '';

  function pushOutput(text, cls) {
    if (!text) return;
    outBuf += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    drainBuf(cls);
  }

  function drainBuf(cls) {
    // Loop until we can't extract anything more
    // eslint-disable-next-line no-constant-condition
    while (true) {

      // ── Case A: initial "$ " prompt (startup only)
      if (outBuf === '$ ' || outBuf === '$ \n') {
        outBuf = '';
        isReady = true;
        scrollBot();
        break;
      }

      // ── Case B: "\n$ " at the end of buffer (command finished)
      const pi = outBuf.lastIndexOf('\n$ ');
      if (pi !== -1 && pi + 3 >= outBuf.length - 1) {
        // Everything before the prompt is output content
        const body = outBuf.slice(0, pi);
        outBuf = outBuf.slice(pi + 3).trimStart(); // skip past "\n$ "
        if (body) renderBlock(body, cls);
        isReady = true;
        scrollBot();
        // Continue loop — outBuf might have more
        continue;
      }

      // ── Case C: flush complete lines, keep last 3 chars buffered
      //           (so we never split "\n$ " across renders)
      const GUARD = 3; // length of "\n$ "
      if (outBuf.length > GUARD) {
        const candidate = outBuf.slice(0, outBuf.length - GUARD);
        const lastNL    = candidate.lastIndexOf('\n');
        if (lastNL >= 0) {
          const toRender = outBuf.slice(0, lastNL);
          outBuf = outBuf.slice(lastNL + 1); // skip past that \n
          if (toRender.trim()) renderBlock(toRender, cls);
          scrollBot();
          continue;
        }
      }

      break; // nothing more to drain right now
    }
  }

  function renderBlock(text, cls) {
    if (!text) return;
    const clean = text.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!clean) return;
    const el = document.createElement('pre');
    el.className = `ln${cls ? ' ' + cls : ''}`;
    el.textContent = clean;
    outputLog.appendChild(el);
  }

  /* ── WebSocket ──────────────────────────────────────── */
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ws?role=${role}&code=${code}`;
  let ws = null;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      isReady = true;
      outputLog.innerHTML = '';
      footLeft.textContent = 'gatekeeper';

      if (role === 'guest') {
        writeLn('Connected as GUEST \u2014 commands need host approval before running.', 'warn');
        writeLn('', '');
      }
      // host greeting + room info comes via room_info message from server
      hiddenInput.focus();
    };

    ws.onclose = ev => {
      isReady = false;
      hiddenInput.disabled = true;
      footMid.textContent = 'disconnected';
      if (ev.code === 1006 || ev.code === 1005) {
        showError('Connection refused \u2014 invalid or missing session code.');
      } else {
        writeLn('\nSession disconnected.', 'err');
      }
    };

    ws.onerror = () => {};

    ws.onmessage = ev => {
      try { route(JSON.parse(ev.data)); }
      catch (e) { console.error('ws parse:', e); }
    };
  }

  connect();

  /* ── Message router ─────────────────────────────────── */
  function route(msg) {
    switch (msg.type) {

      case 'stdout':
        pushOutput(msg.data, '');
        break;

      case 'stderr':
        pushOutput(msg.data, 'err');
        break;

      case 'status':
        if (role === 'guest') {
          if (msg.msg) {
            waitMsg.textContent   = msg.msg;
            waitBar.style.display = 'flex';
            footMid.textContent   = '\u23f3 waiting';
            isReady = false;
          } else {
            waitBar.style.display = 'none';
            footMid.textContent   = '';
            isReady = true;
            hiddenInput.focus();
          }
        }
        break;

      case 'room_info':
        // Server assigned a room to this host
        roomCode     = msg.roomCode || '';
        roomGuestURL = msg.guestURL || '';
        // Update title and footer
        tTitle.textContent  = `gatekeeper — host [${roomCode}]`;
        footLeft.textContent = `room ${roomCode}`;
        writeLn(`Room created. Code: ${roomCode}`, 'ok');
        writeLn(`Type  share  to print the guest invite link.`, 'dim');
        writeLn('', '');
        break;

      case 'approval_request': {
        if (role === 'host') {
          isApprPending = true;
          showApprovalBar(msg.command, msg.queue || 0);
        }
        break;
      }

      case 'completions':
        handleCompletions(msg.hits, msg.prefix);
        break;

      case 'exit':
        writeLn('\n[process exited]', 'dim');
        isReady = false;
        break;
    }
  }

  /* ── Approval bar (host) ────────────────────────────── */
  function showApprovalBar(cmd, queueLen) {
    apvCmd.textContent = cmd;
    apvBar.classList.remove('hidden');
    const keysEl = apvBar.querySelector('.apv-keys');
    if (keysEl) {
      const queueNote = queueLen > 0
        ? ` &nbsp;<span style="color:var(--dim)">(+${queueLen} more queued)</span>`
        : '';
      keysEl.innerHTML =
        `[ <span class="k-y">y</span> ] approve` +
        ` &nbsp; [ <span class="k-n">n</span> ] deny` +
        queueNote;
    }
    footMid.textContent = '\u26a0 approval pending';
  }

  function hideApprovalBar() {
    apvBar.classList.add('hidden');
    footMid.textContent = '';
    isApprPending = false;
  }

  function doApprove() {
    hideApprovalBar();
    ws.send(JSON.stringify({ type: 'approve_command' }));
  }

  function doDeny() {
    hideApprovalBar();
    ws.send(JSON.stringify({ type: 'deny_command' }));
  }

  /* ── Keyboard ───────────────────────────────────────── */
  document.addEventListener('click', () => {
    if (!hiddenInput.disabled) hiddenInput.focus();
  });
  hiddenInput.focus();

  hiddenInput.addEventListener('input', () => {
    inputDisplay.textContent = hiddenInput.value;
  });

  hiddenInput.addEventListener('keydown', e => {

    // Approval: y/n when bar is shown (host only)
    if (role === 'host' && isApprPending) {
      if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); doApprove(); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); doDeny();    return; }
    }

    if (!isReady) { e.preventDefault(); return; }

    switch (e.key) {

      case 'Enter': {
        e.preventDefault();
        const cmd = hiddenInput.value;
        tabLast = ''; tabCount = 0; histIdx = -1;
        hiddenInput.value = '';
        inputDisplay.textContent = '';

        if (!cmd.trim()) return;

        // client-side clear
        if (cmd.trim() === 'clear' || cmd.trim() === 'cls') {
          outputLog.innerHTML = '';
          if (role === 'host') ws.send(JSON.stringify({ type: 'stdin', data: 'clear\n' }));
          return;
        }

        cmdHistory.push(cmd);
        echoCmd(cmd);
        isReady = false;

        if (role === 'host') {
          ws.send(JSON.stringify({ type: 'stdin', data: cmd + '\n' }));
        } else {
          ws.send(JSON.stringify({ type: 'submit_command', command: cmd }));
        }
        scrollBot();
        break;
      }

      case 'Tab':
        e.preventDefault();
        ws.send(JSON.stringify({ type: 'complete', command: hiddenInput.value }));
        break;

      case 'ArrowUp':
        e.preventDefault();
        navHist(1);
        break;

      case 'ArrowDown':
        e.preventDefault();
        navHist(-1);
        break;

      case 'c':
        if (e.ctrlKey) {
          e.preventDefault();
          const partial = hiddenInput.value;
          hiddenInput.value = '';
          inputDisplay.textContent = '';
          echoCmd((partial || '') + '^C');
          histIdx = -1;
          if (role === 'host') ws.send(JSON.stringify({ type: 'stdin', data: '\x03' }));
        }
        break;

      case 'l':
        if (e.ctrlKey) {
          e.preventDefault();
          outputLog.innerHTML = '';
        }
        break;
    }
  });

  /* ── Tab completion ─────────────────────────────────── */
  function handleCompletions(hits, prefix) {
    const line = hiddenInput.value;
    if (!hits || hits.length === 0) { flashCursor(); tabLast = ''; tabCount = 0; return; }

    if (hits.length === 1) {
      const sp = line.lastIndexOf(' ');
      hiddenInput.value = (sp !== -1 ? line.slice(0, sp + 1) : '') + hits[0];
      inputDisplay.textContent = hiddenInput.value;
      tabLast = ''; tabCount = 0;
      return;
    }

    // common prefix
    const stripped = hits.map(h => h.replace(/[ /]$/, ''));
    const common = stripped.reduce((a, b) => {
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    }, stripped[0]);

    if (common.length > prefix.length) {
      const sp = line.lastIndexOf(' ');
      hiddenInput.value = (sp !== -1 ? line.slice(0, sp + 1) : '') + common;
      inputDisplay.textContent = hiddenInput.value;
      tabLast = ''; tabCount = 0;
      return;
    }

    // double-tab → list
    if (line === tabLast) tabCount++; else { tabLast = line; tabCount = 1; }
    if (tabCount === 1) { flashCursor(); return; }

    echoCmd(line);
    writeLn(stripped.sort().join('  '), 'dim');
    tabCount = 0;
    scrollBot();
  }

  /* ── History ────────────────────────────────────────── */
  function navHist(dir) {
    if (!cmdHistory.length) return;
    if (histIdx === -1) histTemp = hiddenInput.value;
    histIdx = Math.min(Math.max(histIdx + dir, -1), cmdHistory.length - 1);
    const val = histIdx === -1 ? histTemp : cmdHistory[cmdHistory.length - 1 - histIdx];
    hiddenInput.value = val;
    inputDisplay.textContent = val;
  }

  /* ── Helpers ────────────────────────────────────────── */
  function echoCmd(cmd) {
    const div = document.createElement('div');
    div.className = 'ln cmd';
    const ps = ps1Wrap.cloneNode(true);
    const sp = document.createElement('span');
    sp.textContent = cmd;
    div.appendChild(ps);
    div.appendChild(sp);
    outputLog.appendChild(div);

    // update shadow cwd
    const t = cmd.trim().split(/\s+/);
    if (t[0] === 'cd' && t[1]) {
      if (t[1] === '~') cwdLabel = '~';
      else if (t[1] === '..') {
        const parts = cwdLabel.replace(/^~\/?/, '').split('/').filter(Boolean);
        parts.pop();
        cwdLabel = parts.length ? '~/' + parts.join('/') : '~';
      } else {
        const leaf = t[1].replace(/\\/g, '/').split('/').pop() || t[1];
        cwdLabel = cwdLabel === '~' ? '~/' + leaf : cwdLabel + '/' + leaf;
      }
      ps1Path.textContent = cwdLabel;
    }
  }

  function writeLn(text, cls) {
    const d = document.createElement('div');
    d.className = `ln${cls ? ' ' + cls : ''}`;
    d.textContent = text;
    outputLog.appendChild(d);
    scrollBot();
  }

  function showError(msg) {
    errMsg.textContent = msg;
    errBanner.classList.remove('hidden');
    footMid.textContent = 'error';
  }

  function scrollBot() { tBody.scrollTop = tBody.scrollHeight; }

  function flashCursor() {
    cursor.style.background = 'var(--yellow)';
    setTimeout(() => { cursor.style.background = ''; }, 120);
  }

}); // DOMContentLoaded

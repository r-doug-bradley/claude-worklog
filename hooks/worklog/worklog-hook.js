#!/usr/bin/env node
// Worklog capture for Claude Code.
//
// Registered on SessionEnd and PreCompact in ~/.claude/settings.json.
// Hook mode (no args): reads the hook JSON from stdin, checks the session's cwd
// against the include list, then starts itself detached in "extract" mode and
// exits at once so Claude Code never waits on it.
// Extract mode: reads only the transcript lines not processed before, asks a
// small model (claude -p) to pull out decisions and shipped work, and appends
// the result to <logDir>/YYYY-MM-DD.md.
// Sweep mode: `node worklog-hook.js sweep [hours]` catches sessions whose
// SessionEnd never fired.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const CONFIG_PATH = path.join(HERE, 'worklog.config.json');

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const expand = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
  return {
    name: (raw.name || '').trim() || 'the developer',
    include: (raw.include || []).map((p) => path.resolve(expand(p)).toLowerCase()),
    logDir: path.resolve(expand(raw.logDir || '~/.claude/worklog')),
    model: raw.model || 'haiku',
    minChars: raw.minChars || 3000,
    maxChars: raw.maxChars || 120000,
    useLogin: raw.useLogin !== false,
  };
}

function isIncluded(cwd, include) {
  if (!cwd) return false;
  const c = path.resolve(cwd).toLowerCase();
  // Also matches sibling worktrees named <root>-<suffix> (e.g. MyRepo-1234).
  return include.some((root) => c === root || c.startsWith(root + path.sep) || c.startsWith(root + '-'));
}

// ---------- hook mode ----------
function hookMode() {
  // The extractor runs claude -p, which ends its own session and fires this hook again.
  if (process.env.WORKLOG_CHILD === '1') return;

  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    try {
      const evt = JSON.parse(input || '{}');
      const cfg = loadConfig();
      if (!evt.transcript_path || !isIncluded(evt.cwd, cfg.include)) return;
      const child = spawn(
        process.execPath,
        [__filename, 'extract', evt.transcript_path, evt.cwd, evt.session_id || 'unknown', evt.hook_event_name || ''],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    } catch (e) {
      // Never block or fail the session over logging.
    }
  });
}

// ---------- extract mode ----------
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function readNewTurns(transcriptPath, fromLine, maxChars) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  const turns = [];
  for (let i = fromLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isMeta || (rec.type !== 'user' && rec.type !== 'assistant')) continue;
    const t = textOf(rec.message && rec.message.content).trim();
    if (!t || t.startsWith('<command-') || t.startsWith('<local-command')) continue;
    const who = rec.type === 'user' ? 'USER' : 'CLAUDE';
    turns.push(`${who}: ${t.length > 2500 ? t.slice(0, 2500) + ' […]' : t}`);
  }
  let text = turns.join('\n\n');
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return { text, lineCount: lines.length };
}

function buildPrompt(name) {
  return `You are reading part of a Claude Code session transcript. The person typing (USER) is ${name}, a software engineer.
The record is for ${name}'s weekly review and the status update built from it.
Your job is to remove housekeeping noise, not to be stingy: ${name} makes the final cut at review.

Step 1, silently: list every decision the USER made or approved, and score each 1–3.
- 3 = significant judgment: architecture or data-model choice, product behaviour users see, security or compliance stance, a cost/performance/reliability trade-off, a choice other teams or future code inherit, or rejecting an easier path for a stated reason.
- 2 = a real trade-off, but local to one feature or file.
- 1 = housekeeping: merges, rebases, cleanup, renames, formatting, dependency or project-file tidying, local environment fiddling, routine bug fixes with no trade-off, visual polish (animation, spacing, colours, icons) unless it changes what a user can do.
Drop everything scored 1. Keep every 2 and 3. If unsure between 1 and 2, keep it as a 2.

Step 2, output this exact markdown, omitting any empty section:

#### Decisions
- **[3 or 2]** **Decided:** what was chosen, in first person. **Over:** the alternative actually considered. **Why:** the reason or trade-off, one sentence. **For:** who it helps or what it unblocks (customers, another team, a release), only as stated in the transcript, else "not stated". **Number:** a result with its source in brackets — (production), (test environment), (local test) or (estimate) — else "none yet; would measure by <what>".

#### Shipped or moved forward
- One line per user-visible feature or meaningful fix, at feature level, with the ticket number if one is mentioned. Say "done", "in progress" or "blocked". No commit hashes, branch names, file lists, merges or local-only setup.

Rules:
- A decision counts only if the USER made or approved it. Ignore Claude's suggestions they didn't take.
- Never include passwords, keys, tokens, connection strings or personal data.
- "Over" must be an option someone actually raised or that was a realistic easier path. If none was discussed, write "no alternative discussed"; never invent one.
- Never upgrade a number: a test or local result is not a production result, and an estimate is not a measurement.
- Describe features in plain words. If an internal codename appears, add what it is in a few words the first time.
- If nothing scores 2 or 3 and nothing user-visible moved, reply with exactly: NONE

Transcript:
`;
}

function extractMode(transcriptPath, cwd, sessionId, eventName) {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.logDir, { recursive: true });
  const statePath = path.join(cfg.logDir, '.state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}

  const from = state[sessionId] || 0;
  const { text, lineCount } = readNewTurns(transcriptPath, from, cfg.maxChars);
  if (text.length < cfg.minChars) return; // too little new talk to bother; try again next time

  // Child gets a clean env: no parent-session variables, and (by default) no
  // ANTHROPIC_API_KEY, so it signs in with the claude.ai login.
  const env = { ...process.env, WORKLOG_CHILD: '1' };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  if (cfg.useLogin) delete env.ANTHROPIC_API_KEY;

  const model = String(cfg.model).replace(/[^\w.-]/g, '');
  const res = spawnSync(`claude -p --model ${model}`, {
    input: buildPrompt(cfg.name) + text,
    cwd: cfg.logDir, // outside the repo: no project CLAUDE.md or project hooks
    env,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    timeout: 5 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const out = (res.stdout || '').trim();
  if (res.status !== 0 || !out) {
    // Leave the state alone so the next SessionEnd or PreCompact retries these lines.
    fs.appendFileSync(path.join(cfg.logDir, 'errors.log'),
      `${new Date().toISOString()} ${sessionId} exit=${res.status} ${`${res.stdout || ''} ${res.stderr || ''}`.trim().slice(0, 500)}\n`);
    return;
  }
  state[sessionId] = lineCount;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (out === 'NONE') return;

  const now = new Date();
  const day = now.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
  const time = now.toTimeString().slice(0, 5);
  const repo = path.basename(cwd);
  const file = path.join(cfg.logDir, `${day}.md`);
  // BOM so Windows PowerShell's Get-Content reads the file as UTF-8.
  const header = fs.existsSync(file) ? '' : `﻿# Worklog ${day}\n\n`;
  fs.appendFileSync(file,
    `${header}### ${time} · ${repo} · session ${sessionId.slice(0, 8)}${eventName === 'PreCompact' ? ' (pre-compact)' : ''}\n\n${out}\n\n`);
}

// ---------- sweep mode ----------
// Catches sessions whose SessionEnd never fired (window closed, still open, crashed).
// Usage: node worklog-hook.js sweep [hours=24]. Safe to repeat: each session only
// sends lines it hasn't processed before.
function cwdOf(transcriptPath) {
  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(64 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  return m ? JSON.parse(`"${m[1]}"`) : null;
}

function sweepMode(hours) {
  const cfg = loadConfig();
  const root = path.join(os.homedir(), '.claude', 'projects');
  const since = Date.now() - hours * 3600 * 1000;
  let done = 0;
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(full, f);
      if (fs.statSync(p).mtimeMs < since) continue;
      const cwd = cwdOf(p);
      if (!isIncluded(cwd, cfg.include)) continue;
      extractMode(p, cwd, f.replace(/\.jsonl$/, ''), 'Sweep');
      done++;
    }
  }
  console.log(`worklog sweep: checked ${done} session(s) from the last ${hours}h`);
}

function logError(e) {
  try {
    const cfg = loadConfig();
    fs.mkdirSync(cfg.logDir, { recursive: true });
    fs.appendFileSync(path.join(cfg.logDir, 'errors.log'), `${new Date().toISOString()} ${e.stack}\n`);
  } catch {}
}

if (process.argv[2] === 'extract') {
  try { extractMode(process.argv[3], process.argv[4], process.argv[5], process.argv[6]); } catch (e) { logError(e); }
} else if (process.argv[2] === 'sweep') {
  try { sweepMode(Number(process.argv[3]) || 24); } catch (e) { logError(e); console.error(e.message); }
} else {
  hookMode();
}

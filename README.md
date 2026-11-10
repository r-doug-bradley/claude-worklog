# claude-worklog

Captures the decisions and shipped work from your Claude Code sessions into a daily markdown log, then turns them into a short decision record and a Friday status update.

- **Hook:** when a session ends (or before it compacts), it sends the new part of the transcript to a small model through `claude -p` and appends decisions and shipped work to `~/.claude/worklog/YYYY-MM-DD.md`. It runs detached, so the session never waits on it.
- **Skill:** `/worklog` reviews the raw log (keep or drop each item), `/worklog note <text>` records something decided outside Claude, and `/worklog friday` drafts a three-line update.

Everything stays on your machine. The only call out is `claude -p`, which runs on your normal Claude Code login.

## Install

Requires Node and the `claude` CLI on your PATH.

1. Copy the files:
   - `hooks/worklog/` → `~/.claude/hooks/worklog/`
   - `skills/worklog/` → `~/.claude/skills/worklog/`
2. In `~/.claude/hooks/worklog/`, copy `worklog.config.example.json` to `worklog.config.json` and fill in:
   - `name`: your name, as the model should refer to you
   - `gitAuthor`: what `git log --author` should match
   - `include`: the repos to log. Sessions anywhere else are ignored. A sibling folder named `<repo>-<suffix>` (a git worktree) also matches.
3. Add the hooks to `~/.claude/settings.json`, merging with any `hooks` you already have:

   ```json
   {
     "hooks": {
       "SessionEnd": [
         { "hooks": [ { "type": "command", "command": "node \"/home/you/.claude/hooks/worklog/worklog-hook.js\"" } ] }
       ],
       "PreCompact": [
         { "hooks": [ { "type": "command", "command": "node \"/home/you/.claude/hooks/worklog/worklog-hook.js\"" } ] }
       ]
     }
   }
   ```

   Use the full path, because `~` isn't expanded inside quotes. On Windows, use forward slashes, e.g. `C:/Users/you/.claude/hooks/worklog/worklog-hook.js`.
4. Optional, but it makes captures much better: add this to `~/.claude/CLAUDE.md`:

   ```markdown
   # Worklog
   - State design and product decisions in one sentence so the worklog hook can find them:
     "Decision: X over Y, because Z." Include a number if there is one.
   - When work ships, name the number (before/after, and how it was measured).
   - Remind me once at the end of real work to finish with /exit so the SessionEnd hook fires.
   ```

## Use

- Leave sessions with `/exit`. Closing the terminal window may skip SessionEnd.
- `/worklog` daily, `/worklog friday` on Fridays.
- Missed sessions: `node ~/.claude/hooks/worklog/worklog-hook.js sweep 24` processes the last 24 hours. It's safe to repeat, because each session only sends lines it hasn't sent before.

## Settings

| Key | Default | What |
|---|---|---|
| `model` | `haiku` | Model for extraction. `sonnet` gives better judgment for a little more cost. |
| `minChars` | `3000` | Skip a capture until this much new conversation exists. |
| `maxChars` | `120000` | Only the last N characters of new conversation are sent. |
| `useLogin` | `true` | Removes `ANTHROPIC_API_KEY` from the child process so it uses your claude.ai login. |
| `logDir` | `~/.claude/worklog` | Where logs go. |

## Troubleshooting

No daily file after a day of work? Check `~/.claude/worklog/errors.log`, that your repo is in `include`, and that the hook lines are in `~/.claude/settings.json`.

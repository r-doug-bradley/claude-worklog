---
name: worklog
description: "Daily review of captured decisions and shipped work, quick decision capture, and the Friday status update. Usage: /worklog (daily review) · /worklog note <text> · /worklog friday"
---

# Worklog

The SessionEnd hook (`~/.claude/hooks/worklog/worklog-hook.js`) writes decisions and changes from work sessions into `~/.claude/worklog/YYYY-MM-DD.md`. This skill turns that raw log into a short list of kept decisions and a weekly status update.

Settings come from `~/.claude/hooks/worklog/worklog.config.json` (`name`, `gitAuthor`, `include`, `logDir`).

Files in the log folder (`logDir`, default `~/.claude/worklog/`):
- `YYYY-MM-DD.md`: raw captures (hook output and notes)
- `decisions.md`: kept decision records
- `.last-review`: date of the last daily review

## `/worklog note <text>`

Append immediately to today's file under `### HH:MM · note`, as a `#### Decisions` bullet if it reads like a decision, otherwise under `#### Shipped or moved forward`. Rewrite it into the decision format only if the meaning is obvious; never invent options or numbers. Confirm in one line.

## `/worklog` (daily review, about 5 minutes)

1. Read `.last-review` (default: yesterday). Load every daily file dated after it, up to today.
2. Gather shipped work for the same window. For each repo in `include`:
   `git -C <repo> log --since=<date> --author=<gitAuthor> --oneline --no-merges`
   If a ticket-tracker tool is available, add tickets resolved in the window.
3. Merge duplicates (the hook may capture the same decision twice; a commit and a captured change may be the same thing).
4. Show a compact list: decisions first, then shipped work, each numbered.
5. Ask with AskUserQuestion (multiSelect, up to 4 items per question, batches if more) how to tag each: **Keep** · **Drop**.
6. Append kept decisions to `decisions.md`: `- YYYY-MM-DD · repo · Decided … Over … Why … For … Number (source) …`. Keep "For" and the number's source label from the capture; never upgrade a test or local number to production.
7. Write today's date to `.last-review`. Finish with one line: how many were kept, and how many kept decisions still lack a number.

## `/worklog friday`

1. Load the week's daily files, this week's `decisions.md` entries, and git activity for the week.
2. Draft a three-line status update in the user's own voice (short, plain, no corporate phrasing):
   - what shipped this week
   - what it means for users or the business (build it from the "For" fields; if they all say "not stated", ask rather than invent it)
   - one decision or help needed, with a date
3. List this week's kept decisions that still lack a number, and suggest how to get one.
4. Do not send anything. The user pastes the update themselves.

## Rules

- Don't overclaim: say "building" for anything not shipped, "led" where others built it, and quote only measured numbers.
- Never record credentials, keys or personal data.

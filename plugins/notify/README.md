# notify

Smart notifications for Claude Code. Instead of a single beep, `notify` figures
out **what just happened** in a turn and tells you — with a native desktop
popup, a per-status sound, and a terminal bell.

Pure Node, **zero dependencies** (Node ships with Claude Code). Works on
**macOS, Windows, Linux**. No config required — sensible defaults work out of the
box.

## What it tells you

It classifies each turn from the session transcript into one of these statuses:

| Status                   | When                                                        |
| ------------------------ | ----------------------------------------------------------- |
| ✅ `task_complete`        | Claude finished a turn that did real work (edits, commands) |
| 🔍 `review_complete`      | Claude only read/searched and wrote a substantial summary   |
| ❓ `question`             | Claude is asking you something / needs input or permission  |
| 📋 `plan_ready`           | Claude presented a plan for approval (ExitPlanMode)         |
| ⏱️ `session_limit_reached`| The session/usage limit was hit                             |
| 🔴 `api_error`            | Auth/401 error (e.g. needs `/login`)                        |
| 🔴 `api_error_overloaded` | API overloaded / other API error                           |

Anything it can't confidently classify is `unknown` → it stays silent.

## How it works

Four hooks all run one dispatcher, `scripts/notify.js <Event>`, fed the hook
JSON on stdin:

| Hook           | matcher                        | drives                          |
| -------------- | ------------------------------ | ------------------------------- |
| `PreToolUse`   | `ExitPlanMode\|AskUserQuestion`| plan-ready / question (instant) |
| `Notification` | `permission_prompt`            | question                        |
| `Stop`         | —                              | transcript classification       |
| `SubagentStop` | —                              | transcript classification       |

The dispatcher reads the transcript at `transcript_path`, classifies the turn,
applies suppression/dedup, builds a message (title + `branch · folder` subtitle
+ body with an action summary like `📝 2 new  ✏️ 1 edited  ▶ 3 cmds  ⏱ 41s`),
and fires the desktop popup + sound + bell. **It never blocks or errors your
session** — every path is fail-open and exits 0.

Desktop popup per OS:

| OS      | Mechanism                                                  |
| ------- | --------------------------------------------------------- |
| macOS   | `terminal-notifier` if installed, else `osascript`        |
| Linux   | `notify-send` (libnotify)                                 |
| Windows | PowerShell toast                                          |

Sound uses the same cross-platform player set as before (`afplay` / `paplay` /
`pw-play` / `aplay` / `ffplay` / `play` / PowerShell). If no player or notifier
is present, that channel is silently skipped.

## Configuration (optional)

Drop a JSON file at `~/.claude/claude-notify/config.json`. Anything you omit
falls back to the defaults — see [`config.example.json`](config.example.json)
for the full default shape. Highlights:

```jsonc
{
  "desktop": {
    "enabled": true,
    "sound": true,
    "terminalBell": true,
    "volume": 1.0,            // 0.0–1.0, best-effort
    "appIcon": "",            // optional path, ${ENV} expanded
    "clickToFocus": true
  },
  "suppressQuestionAfterAnyNotificationSeconds": 7,
  "suppressQuestionAfterTaskCompleteSeconds": 12,
  "notifyOnSubagentStop": false,
  "suppressForSubagents": true,
  "notifyOnTextResponse": true,
  "respectJudgeMode": true,
  "suppressFilters": [
    // suppress notifications matching ALL fields in a filter (OR across filters)
    { "status": "question", "gitBranch": "main" },
    { "folder": "scratch" }
  ],
  "statuses": {
    "question": { "enabled": true, "title": "❓ Question", "sound": "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav" }
    // ...per-status title / sound / enabled / desktop.enabled overrides
  }
}
```

- **Per-status sounds:** by default two bundled sounds are mapped (`complete.wav`
  for task/review, `notification.wav` for the rest). Point any status `sound` at
  your own file — including OS sounds like
  `/System/Library/Sounds/Glass.aiff` (macOS) or `/usr/share/sounds/...` (Linux).
  `${CLAUDE_PLUGIN_ROOT}` and other `${ENV}` vars are expanded.
- **Suppression:** `question` notifications are throttled for a few seconds after
  any other notification / after a task completes. `suppressFilters` let you mute
  by status, git branch, and/or folder.
- **Subagents:** off by default (`suppressForSubagents`); set
  `notifyOnSubagentStop: true` to also notify when subagents finish.

## Click-to-focus (best-effort)

Clicking a notification tries to bring your terminal forward. This is
best-effort and pure-Node:

- **macOS:** app-level activation of the terminal (via `terminal-notifier
  -execute` + `osascript`). Not exact-window.
- **Linux:** best-effort on X11 (`xdotool`/`wmctrl` by `$WINDOWID`) if those
  tools are installed; otherwise skipped.
- **Windows:** not supported.
- Multiplexer pane switching (tmux/wezterm/kitty/zellij) is attempted via their
  own CLIs where detected.

## Testing it yourself

Dry-run prints the resolved notification instead of firing anything:

```bash
cd plugins/notify
T=$(ls -t ~/.claude/projects/*/*.jsonl | head -1)
printf '{"hook_event_name":"Stop","session_id":"smoke","transcript_path":"%s","cwd":"%s"}' "$T" "$PWD" \
  | NOTIFY_DRY_RUN=1 node scripts/notify.js Stop
```

Run the test suite:

```bash
cd plugins/notify && node --test
```

## Note

`Stop` fires at the end of **every** assistant turn — Claude Code has no
"big-task-only" event — so `notify` leans on classification + suppression to
keep the noise down.

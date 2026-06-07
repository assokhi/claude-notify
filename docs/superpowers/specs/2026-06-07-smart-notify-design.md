# Smart Notify — design

Date: 2026-06-07
Status: approved (design)

## Summary

Turn the current sounds-only plugin (`notify-sounds`) into a **smart notifier**
(`notify`) that classifies *what just happened* in a Claude Code turn by parsing
the session transcript, then delivers a native desktop popup + a per-status sound
+ a terminal bell. It is a faithful port of the *logic* of
[claude-notifications-go](https://github.com/777genius/claude-notifications-go),
kept in **pure Node, zero runtime dependencies** (Node ships with Claude Code).

Remote/webhook channels (Slack/Discord/Telegram/…) are intentionally **out of
scope** for this iteration — the user wants desktop delivery only — but the
channel layer is kept pluggable so a webhook channel can be added later without
touching the classifier.

### Decisions locked during brainstorming

- **Scope:** full-featured port of the classification + suppression behavior;
  desktop popups + sound only.
- **Stack:** pure Node, zero-dep. No Go binary, no native compilation, no
  downloaded binaries.
- **Plugin rename:** `notify-sounds` → `notify` (dir, `plugin.json`,
  `marketplace.json`, README, install path `notify@claude-notify`). The old
  plugin is ~2 commits old / effectively unreleased, so the breaking rename is
  acceptable.
- **Click-to-focus:** best-effort, **no native helper**. App-level activation +
  multiplexer pane-switch via CLIs. Degrades silently when tools/permissions are
  absent. Exact-window macOS AX focus is explicitly NOT attempted.
- **Sounds:** map the existing two bundled wavs to statuses; every status sound
  is overridable in config (including pointing at OS system sounds).

## Goals

- Classify each turn into one of: `task_complete`, `review_complete`,
  `question`, `plan_ready`, `session_limit_reached`, `api_error`,
  `api_error_overloaded`, `unknown` (silent).
- Native desktop notification per OS (macOS / Linux / Windows), with a useful
  title/subtitle/body derived from the transcript.
- Per-status sound + terminal bell.
- Noise control: dedup, cooldowns, and user-defined suppression filters.
- Never block or error the Claude Code session — every hook path is fail-open
  and exits 0.

## Non-goals (this iteration)

- Webhook / chat / email channels (architecture stays pluggable for later).
- Exact-window focus on macOS (needs native AX APIs; impossible in pure Node).
- Windows click-to-focus.
- In-process audio decoding/mixing (we shell out to native players).

## Grounding facts (verified)

- Transcript at `transcript_path` is JSONL. Each line has a top-level `type`
  (`user`, `assistant`, plus meta types like `last-prompt`, `mode`,
  `permission-mode`, `attachment`, `file-history-snapshot`, `ai-title` — all
  skipped). `message.content` is either a string (user text) or an array of
  blocks `{type, name, input, text}`. Tool calls are blocks with
  `type === "tool_use"` carrying `name` and `input`. `timestamp` is an ISO/
  RFC3339 string. Lines also carry top-level `gitBranch` and `cwd`. Error
  messages carry `isApiErrorMessage` (bool) and `error` (string) — absent on
  normal lines. (Confirmed against a real transcript on disk.)
- Hook stdin JSON reliably provides: `hook_event_name`, `session_id`,
  `transcript_path`, `cwd`, and (for PreToolUse) `tool_name`. We only depend on
  those fields.
- `${CLAUDE_PLUGIN_ROOT}` is available to plugin hook commands; default hook
  timeout is generous (we still return fast by spawning side effects detached).

## Module layout

```
plugins/notify/
  .claude-plugin/plugin.json        # hooks block → node scripts/notify.js <Event>
  scripts/
    notify.js                       # entry: read stdin JSON, dispatch by event, never throw, exit 0
    lib/
      config.js          # load+merge config, defaults, ${env} expansion, per-status resolution
      transcript.js      # safe JSONL read+parse, helpers (last user ts, assistant window, tools)
      classify.js        # the ported state machine → status string
      summary.js         # message body per status + action suffix + 150-char trim
      state.js           # per-session state file in temp dir (read/merge/write, GC)
      dedup.js           # lock files: 2s throttle per (session,event), 5s content lock, 180s dup msg
      suppress.js        # question cooldowns (7s/12s) + suppressFilters matching
      git.js             # branch from transcript gitBranch, fallback `git -C cwd ...`
      session-label.js   # deterministic session_id -> short human label
      channels/
        desktop.js       # native popup per OS + terminal bell
        sound.js         # per-status sound playback + best-effort volume
      focus.js           # best-effort click-to-focus (app activate + multiplexer CLIs)
  sounds/
    notification.wav     # existing
    complete.wav         # existing
  config.example.json
  README.md
```

Each lib has one job and a small surface so it can be unit-tested in isolation.
`notify.js` is the only side-effecting orchestrator; everything under `lib/`
except `channels/` and `focus.js` is pure (deterministic given inputs) and
directly testable.

## Hook wiring (`plugin.json`)

Hooks are inlined in `plugin.json` (this repo already learned the lesson that
string-path hook files don't load — see commit f9faa5c). Four hook events:

| Event          | matcher                      | command                                            |
| -------------- | ---------------------------- | -------------------------------------------------- |
| `PreToolUse`   | `ExitPlanMode\|AskUserQuestion` | `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.js" PreToolUse` |
| `Notification` | `permission_prompt`          | `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.js" Notification` |
| `Stop`         | (none)                       | `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.js" Stop` |
| `SubagentStop` | (none)                       | `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.js" SubagentStop` |

If the `Notification` matcher turns out not to be honored by the installed
Claude Code version (older builds fire `Notification` with no matcher), the
classifier still returns `question` for any Notification event, so behavior is
correct either way — the matcher is an optimization, not a correctness
dependency.

The event name is passed as `argv[2]`; the full hook JSON is read from stdin.

## Pipeline (orchestration order in `notify.js`)

Ported from the Go `HandleHook` order, adapted:

1. Parse stdin JSON; derive `event`, `sessionId` (`"unknown"` if empty),
   `transcriptPath`, `cwd`.
2. Load config. If `respectJudgeMode` (default true) and
   `process.env.CLAUDE_HOOK_JUDGE_MODE === "true"` → exit 0 (let background-Claude
   integrations suppress us).
3. If `clickToFocus` and event ∈ {PreToolUse, Notification}: capture terminal
   focus hints into session state (cheap; enables click later).
4. Early duplicate check (2s throttle lock for this session+event) → maybe exit.
5. If desktop disabled entirely → exit.
6. Compute status (with subagent/judge gates). `unknown` → exit.
7. `suppressFilters` match (status / git branch / folder) → maybe exit.
8. Acquire 2s send lock → maybe exit.
9. If status is `question`: cooldown checks — 7s-after-any-notification, then
   12s-after-task-complete → maybe exit.
10. If status is `task_complete`: record `last_task_complete_ts`.
11. Build message (title, subtitle, body + action suffix).
12. Acquire 5s content lock → exit if held.
13. 180s duplicate-message check vs `last_notification_message` → maybe exit.
14. Write `last_notification_*` to state.
15. Fire enabled channels: desktop popup + sound + terminal bell (each detached;
    `focus.js` wired as the click action where supported).

Every step is wrapped so any throw → log to stderr (non-fatal) → exit 0.

### Subagent / judge gates (step 6)

- Stop/SubagentStop abort if `suppressForSubagents` (default true) AND
  `transcript_path` contains a `/subagents/` segment.
- SubagentStop additionally aborts unless `notifyOnSubagentStop` (default false).

## Classification (`classify.js`)

Status constants: `task_complete`, `review_complete`, `question`, `plan_ready`,
`session_limit_reached`, `api_error`, `api_error_overloaded`, `unknown`.

Tool sets (verbatim from the reference):

- **active (mutating):** `Write`, `Edit`, `Bash`, `NotebookEdit`, `SlashCommand`,
  `KillShell`
- **read-like (review trigger):** `Read`, `Grep`, `Glob`
- `ExitPlanMode` → plan; `AskUserQuestion` → question.
- Known caveat preserved: `Bash` is always "active" even for read-only commands.

Routing by event:

- **PreToolUse**: `tool_name === "ExitPlanMode"` → `plan_ready`;
  `"AskUserQuestion"` → `question`; else `unknown`. Also write interactive-tool
  hints to state.
- **Notification**: always `question`.
- **Stop / SubagentStop**: transcript state machine below.

Transcript state machine (strict order):

1. Parse JSONL into messages (skip meta/unparseable lines).
2. **Session-limit (highest priority):** scan text of the last 3 assistant
   messages; case-insensitive contains `"session limit reached"` or
   `"session limit has been reached"` → `session_limit_reached`.
3. **API error:** consider messages with `isApiErrorMessage === true` whose
   `timestamp >= last user timestamp`. If any: take the last one — structured
   `error === "authentication_failed"` → `api_error`; else text contains `"401"`
   AND (`"authentication_error"` OR `"run /login"`) → `api_error`; else
   `api_error_overloaded`.
4. **Last real user timestamp:** last message with `type === "user"` whose
   content is a string, or whose content array's first block is `type === "text"`
   (i.e. exclude tool_result-only user messages).
5. Keep only `assistant` messages with `timestamp` after that. None → `unknown`.
6. Keep the **last 15**.
7. Extract tool_use blocks (name + positional order).
8. If any tools, in priority:
   - last tool `ExitPlanMode` → `plan_ready`
   - last tool `AskUserQuestion` → `question`
   - `ExitPlanMode` present AND ≥1 tool after its position → `task_complete`
   - read-like count ≥ 1 AND zero active tools anywhere in window AND combined
     text of last 5 assistant messages length > 200 → `review_complete`
   - last tool is active → `task_complete`
   - any tool at all → `task_complete`
9. No tools: `notifyOnTextResponse` (default true) → `task_complete`, else
   `unknown`.

Length comparisons use byte length to match the reference (`Buffer.byteLength`).
Timestamp comparison parses ISO strings; if parse fails, fall back to string
compare (the reference relies on RFC3339 lexical ordering).

## Message building (`summary.js`)

All bodies are markdown-stripped and truncated to **150** chars at a
sentence/word boundary.

Body per status:

- **question:** `AskUserQuestion.input.questions[0].question` if the question
  tool is within ~60s of the last assistant message; else shortest text
  containing `?` among the last 8 assistant messages; else first sentence of the
  last text; else `"Claude needs your input to continue"`.
- **plan_ready:** first non-empty line of `ExitPlanMode.input.plan`; else
  `"Plan is ready for review"`.
- **review_complete:** a sentence containing a review keyword
  (`review`/`analysis`/`analyzed`); else `"Reviewed N file(s)"` from the `Read`
  count; else `"Code review completed"`.
- **task_complete:** last assistant text (first sentence if ≥150 chars); else
  `"Task completed successfully"`.
- **session_limit_reached:** `"Session limit reached. Please start a new conversation."`
- **api_error:** `"Please run /login"`.
- **api_error_overloaded:** the actual error text or `"API error occurred"`.

**Action suffix** appended to the body (counts since last user message, joined by
two spaces): `Write`→`📝 N new`, `Edit`→`✏️ N edited`, `Bash`→`▶ N cmds`, plus
duration `⏱ <dur>` (last-user → last-assistant; formatted `Ns` / `Nm Ns` /
`Nh Nm`).

Title/subtitle (rendered by `desktop.js`):

- **title:** `"<status emoji+label> [<session label>]"` (e.g. `✅ Completed [blue-otter]`)
- **subtitle:** `"<branch> · <folder>"` (middle dot). When no branch:
  just `<folder>`, no subtitle.
- **body:** the summary text above.

## State (`state.js`)

File: `<tmpdir>/claude-notify-state-<sessionId>.json`. Fields (unix seconds for
timestamps):

```jsonc
{
  "session_id": "...",
  "last_interactive_tool": "AskUserQuestion|ExitPlanMode|",
  "last_ts": 0,
  "last_task_complete_ts": 0,
  "last_notification_ts": 0,
  "last_notification_status": "...",
  "last_notification_message": "...",
  "cwd": "...",
  "focus_hint": { /* terminal/multiplexer hints captured in step 3 */ }
}
```

Read-merge-write (never clobber unrelated fields). GC: state files older than
60s are deleted opportunistically after Stop.

## Dedup (`dedup.js`)

Temp-dir lock files keyed by session:

- **2s throttle, per (session, event):** `claude-notify-<session>-<event>.lock`.
  Phase 1 (top of pipeline): if exists and age < 2s → duplicate, abort. Phase 2
  (before send): atomic create; exists and age < 2s → not acquired, abort; stale
  (≥ 2s) → remove + recreate. The lock is intentionally never released (it ages
  out) — this throttles rapid repeats.
- **5s content lock:** `claude-notify-<session>-content.lock`, acquired right
  before the dup-content check to serialize the Stop-vs-Notification race;
  released on exit.
- **180s duplicate message:** compare normalized new body
  (`trim → strip trailing "." → lowercase`) to `last_notification_message` within
  a 180s window; equal → skip.

Lock files older than 60s are GC'd after Stop.

## Suppression (`suppress.js`)

- **Question cooldowns** (only when status === `question`):
  1. suppress if `now - last_notification_ts < suppressQuestionAfterAnyNotificationSeconds`
     (default 7).
  2. suppress if `now - last_task_complete_ts < suppressQuestionAfterTaskCompleteSeconds`
     (default 12).
  - A configured value ≤ 0, or a missing timestamp, means no suppression.
- **suppressFilters:** array of `{ name?, status?, gitBranch?, folder? }`. Within
  one filter the present fields are AND-ed (absent = wildcard); `gitBranch: ""`
  means "no branch / detached" (distinct from absent = any). Across filters it is
  OR (any match suppresses). Each filter must declare ≥1 condition.

## Config (`config.js`)

Path: `~/.claude/claude-notify/config.json`. Loaded and deep-merged over
`DefaultConfig()`, so omitted keys take defaults. `${ENV}` (and `${CLAUDE_PLUGIN_ROOT}`)
expanded in `desktop.appIcon` and each `statuses.*.sound`.

```jsonc
{
  "desktop": {
    "enabled": true,
    "sound": true,
    "terminalBell": true,
    "volume": 1.0,              // 0.0–1.0, best-effort
    "appIcon": "",             // optional path, ${env} expanded
    "clickToFocus": true
  },
  "suppressQuestionAfterTaskCompleteSeconds": 12,
  "suppressQuestionAfterAnyNotificationSeconds": 7,
  "notifyOnSubagentStop": false,
  "suppressForSubagents": true,
  "notifyOnTextResponse": true,
  "respectJudgeMode": true,
  "suppressFilters": [],
  "statuses": {
    "task_complete":         { "enabled": true, "title": "✅ Completed",               "sound": "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav" },
    "review_complete":       { "enabled": true, "title": "🔍 Review",                  "sound": "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav" },
    "question":              { "enabled": true, "title": "❓ Question",                "sound": "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav" },
    "plan_ready":            { "enabled": true, "title": "📋 Plan",                    "sound": "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav" },
    "session_limit_reached": { "enabled": true, "title": "⏱️ Session Limit Reached",  "sound": "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav" },
    "api_error":             { "enabled": true, "title": "🔴 API Error: 401",         "sound": "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav" },
    "api_error_overloaded":  { "enabled": true, "title": "🔴 API Error",             "sound": "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav" }
  }
}
```

Per-status resolution: a desktop notification fires for status `s` iff
`desktop.enabled` AND `statuses[s].enabled` (default true) AND
`statuses[s].desktop.enabled` (default true). Sound path falls back to the
status default, then to the two bundled wavs. `${CLAUDE_PLUGIN_ROOT}` is expanded
to the plugin install dir. Validation: clamp/validate `volume` to 0–1, cooldowns ≥ 0,
each suppressFilter has ≥1 condition; invalid config → warn to stderr and fall
back to defaults (never crash).

## Channels

### desktop.js (native popup + terminal bell)

- **Terminal bell:** if `terminalBell`, write BEL (`\a`) to `/dev/tty` (best
  effort; ignore failure). Lights tab/bell indicators independent of the popup.
- **macOS:** prefer `terminal-notifier` if on PATH (supports `-execute` for
  click-to-focus); else `osascript -e 'display notification "body" with title
  "..." subtitle "..."'`. Sound handled separately by `sound.js` (popup is
  silent / `-nosound`).
- **Linux:** `notify-send "<title>" "<body>"` (with `--icon`, `--urgency`
  critical for error/limit statuses). No popup if `notify-send` absent.
- **Windows:** PowerShell toast via `System.Windows.Forms`/`BurntToast`-free
  approach — use the `Windows.UI.Notifications` toast XML through PowerShell, or
  fall back to a balloon tip. If none works, stay silent.
- All popup spawns are detached (`stdio: ignore`, `unref()`), so the hook
  returns immediately.

### sound.js (per-status sound + volume)

Extends the current `play.js` candidate-list approach. Selects the sound path
for the resolved status. Best-effort volume:

- macOS: `afplay -v <0–1> <file>`
- Linux: `paplay` (no simple volume flag — apply via `--volume=<0–65536>` when
  available) → `pw-play` → `aplay -q` → `ffplay` → `play`
- Windows: PowerShell `SoundPlayer` (volume not supported; ignore volume)

First player that spawns wins; none available → silent, never errors. Detached.

### focus.js (best-effort click-to-focus)

Wired as the notification's click action only where supported:

- **macOS:** `terminal-notifier -execute '<cmd>'` where `<cmd>` activates the
  terminal app by bundle id (`osascript -e 'tell application id "<id>" to
  activate'`). Bundle id resolved from `TERM_PROGRAM` / `__CFBundleIdentifier`
  via a mapping table (iTerm2, Terminal, Ghostty, kitty, WezTerm, Warp,
  Alacritty, Hyper, VS Code). App-level only — not exact window.
- **Linux:** on X11, capture `$WINDOWID` during PreToolUse/Notification (step 3),
  and on click run `xdotool windowactivate --sync <id>` then `wmctrl -i -a <id>`
  if those tools exist. Wayland/GNOME best-effort via `busctl --user call
  org.gnome.Shell ... ActivateWindowByTitle` when the extension is present. All
  optional; silent if absent.
- **Multiplexer pane switch** (both OSes, detected by env, first wins): tmux
  (`tmux select-window`), wezterm (`wezterm cli activate-pane --pane-id`), kitty
  (focus by id via `--listen-on` socket), zellij (tab/session). Pure CLI, safe.
- **Windows:** not attempted.

Because Linux click callbacks require a process alive when the user clicks,
`notify-send` action support is limited; we treat Linux focus as best-effort and
accept that it may only work via `--wait`-capable setups or the multiplexer CLIs
fired at notify time. No daemon is shipped.

## Git branch (`git.js`)

Prefer the top-level `gitBranch` field already present on transcript lines
(cheapest). Fallback: `git -C <cwd> rev-parse --abbrev-ref HEAD`, trimmed; treat
`HEAD` (detached) or any error as no branch (`""`). Branch is used in the
subtitle and as a `suppressFilters` key.

## Session label (`session-label.js`)

Deterministic `session_id` → short, stable, human label (e.g. two-word
adjective-animal from a fixed wordlist, indexed by a hash of the id). Same id
always yields the same label. Shown in the notification title bracket.

## Error handling

The whole point: never disturb the session. `notify.js` wraps the pipeline in
try/catch, writes diagnostics to stderr only, and always `process.exit(0)`. Any
missing/oversized/garbled transcript → `unknown` → silent. Any missing native
player/notifier → silent. No throw ever propagates to Claude Code.

Performance: transcript may be large (hundreds of KB+). Read the file once and
parse; only retain the last 15 post-user assistant messages. (A tail-read
optimization is possible later but not required within the hook timeout.)

## Testing

`node:test` (built-in, zero-dep) + `node:assert`. Unit tests:

- `classify.test.js` — fixture JSONL transcripts (captured from real sessions
  + hand-built edge cases) asserting each status path: plan_ready, question,
  task_complete (with/without ExitPlanMode-then-tool), review_complete
  (read-only + >200 chars vs short text vs Bash present), session_limit,
  api_error variants, unknown (no post-user assistant).
- `suppress.test.js` — cooldown windows (7s/12s, ≤0 disables), suppressFilters
  AND/OR and the `gitBranch:""` vs absent distinction.
- `summary.test.js` — body selection per status, 150-char truncation, action
  suffix counts + duration formatting.
- `config.test.js` — default merge, `${env}` expansion, per-status resolution,
  invalid-config fallback.
- `transcript.test.js` — meta-line skipping, last-real-user-timestamp logic,
  tool extraction order.

Channels/focus are side-effecting: covered by a `NOTIFY_DRY_RUN=1` mode in
`notify.js` that prints the resolved `{status, title, subtitle, body, sound,
channels}` payload as JSON instead of firing — used for manual smoke tests and
a thin integration test that pipes a fixture hook JSON to `notify.js`.

## Migration / rename

- Move `plugins/notify-sounds/` → `plugins/notify/`.
- Update `plugin.json` (`name: "notify"`, new description, version `2.0.0`,
  expanded keywords, the 4-hook block).
- Update `.claude-plugin/marketplace.json` plugin entry (`name`, `source`,
  `description`).
- Rewrite both READMEs (root + plugin) for the new feature set, config, and
  install path `notify@claude-notify`.
- Keep the two existing wav files.

## Out of scope (documented for later)

- Webhook channels (Slack/Discord/Telegram/ntfy/email) — channel interface is
  shaped to accept them later.
- Native macOS exact-window AX focus (would need a bundled Swift helper).
- In-process audio decode/volume mixing.
- Windows click-to-focus.

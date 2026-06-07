#!/usr/bin/env node
"use strict";
// notify.js — orchestrator. Entry point for every hook event.
// Usage: node notify.js <Event>   (the hook JSON arrives on stdin)
// Pipeline order ported from claude-notifications-go HandleHook (see design spec).
// Hard rule: never throw, never block — always exit 0.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LIB = path.join(__dirname, "lib");
const transcript = require(path.join(LIB, "transcript"));
const classify = require(path.join(LIB, "classify"));
const configMod = require(path.join(LIB, "config"));
const summary = require(path.join(LIB, "summary"));
const state = require(path.join(LIB, "state"));
const suppress = require(path.join(LIB, "suppress"));
const dedup = require(path.join(LIB, "dedup"));
const gitMod = require(path.join(LIB, "git"));
const sessionLabel = require(path.join(LIB, "session-label"));
const desktop = require(path.join(LIB, "channels", "desktop"));
const sound = require(path.join(LIB, "channels", "sound"));
const focus = require(path.join(LIB, "focus"));

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (e) {
    return "";
  }
}

// Best-effort PATH probe for the desktop channel (terminal-notifier detection).
function onPath(bin, plat) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const exts = plat === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, bin + ext), fs.constants.X_OK);
        return true;
      } catch (e) {
        /* keep looking */
      }
    }
  }
  return false;
}

function main() {
  const event = process.argv[2] || "";
  let hook = {};
  try {
    hook = JSON.parse(readStdin()) || {};
  } catch (e) {
    hook = {};
  }

  const sessionId = hook.session_id || "unknown";
  const transcriptPath = hook.transcript_path || "";
  const cwd = hook.cwd || process.cwd();
  const toolName = hook.tool_name || "";
  const dryRun = process.env.NOTIFY_DRY_RUN === "1";
  const plat = os.platform();

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, "..");
  const config = configMod.load({ pluginRoot });
  const desk = config.desktop || {};

  // 1. Judge-mode bail (lets background-Claude integrations suppress us).
  if (config.respectJudgeMode !== false && process.env.CLAUDE_HOOK_JUDGE_MODE === "true") return;

  // 2. Capture click-to-focus hints early (cheap) so a later click can act.
  if (desk.clickToFocus && (event === "PreToolUse" || event === "Notification")) {
    try {
      state.write(sessionId, { focus_hint: focus.captureHints(process.env, plat), cwd });
    } catch (e) {
      /* best effort */
    }
  }

  // 3. Early duplicate throttle (2s lock per session+event).
  if (dedup.isRecentDuplicate(sessionId, event, {})) return;

  // 4. Desktop disabled entirely → nothing to do.
  if (desk.enabled === false) return;

  // Load transcript entries (Stop/SubagentStop need them; others may lack a path).
  let entries = [];
  if (transcriptPath) {
    const text = transcript.read(transcriptPath);
    if (text) entries = transcript.parseLines(text);
  }

  // Subagent gating.
  if (event === "Stop" || event === "SubagentStop") {
    if (config.suppressForSubagents !== false && transcriptPath.indexOf("/subagents/") !== -1) return;
    if (event === "SubagentStop" && config.notifyOnSubagentStop !== true) return;
  }

  // PreToolUse: remember the interactive tool.
  if (event === "PreToolUse" && (toolName === "ExitPlanMode" || toolName === "AskUserQuestion")) {
    state.write(sessionId, { last_interactive_tool: toolName, last_ts: nowSec(), cwd });
  }

  // 5. Classify.
  const status = classify.classifyEvent({ event, toolName, entries, config });
  if (!status || status === classify.STATUS.UNKNOWN) return;
  if (!configMod.statusEnabled(config, status)) return;

  // Context for filters / subtitle.
  const branch = gitMod.branch({ entries, cwd });
  const folder = path.basename(cwd || "");

  // 7. suppressFilters.
  if (suppress.shouldFilter(config, { status, gitBranch: branch, folder })) return;

  // 8. Acquire 2s send lock.
  if (!dedup.acquire(sessionId, event, {})) return;

  // 9. Question cooldowns.
  if (status === classify.STATUS.QUESTION && suppress.shouldSuppressQuestion(state.read(sessionId, {}), config, nowSec())) {
    return;
  }

  // 10. Record task-complete time.
  if (status === classify.STATUS.TASK_COMPLETE) {
    state.write(sessionId, { last_task_complete_ts: nowSec() });
  }

  // 11. Build the message.
  const title = configMod.titleFor(config, status) + " [" + sessionLabel.label(sessionId) + "]";
  const subtitle = summary.subtitle({ branch, folder });
  let body = summary.bodyFor({ status, entries });
  const suffix = summary.actionSuffix(entries);
  if (suffix) body = body + "  " + suffix;
  body = summary.truncate(summary.stripMarkdown(body), 150);

  // 12-14. Content lock → dup-message check → persist last_notification_*.
  if (!dedup.acquireContentLock(sessionId, {})) return;
  let isDup = false;
  try {
    if (dedup.isDuplicateMessage(state.read(sessionId, {}), body, {})) {
      isDup = true;
    } else {
      state.write(sessionId, {
        session_id: sessionId,
        last_notification_ts: nowSec(),
        last_notification_status: status,
        last_notification_message: body,
        cwd,
      });
    }
  } finally {
    dedup.release(sessionId, "content", {});
  }
  if (isDup) return;

  // 15. Fire channels.
  const urgent =
    status === classify.STATUS.API_ERROR ||
    status === classify.STATUS.API_ERROR_OVERLOADED ||
    status === classify.STATUS.SESSION_LIMIT;
  const icon = desk.appIcon || "";
  const soundPath = desk.sound === false ? "" : configMod.soundFor(config, status);
  const hints = state.read(sessionId, {}).focus_hint || {};
  const clickCmd =
    desk.clickToFocus && plat === "darwin"
      ? focus.clickCommandString(hints, { platform: plat, env: process.env })
      : "";

  if (dryRun) {
    process.stdout.write(
      JSON.stringify({ event, status, title, subtitle, body, sound: soundPath, urgent, clickCmd }, null, 2) + "\n"
    );
    return;
  }

  try {
    desktop.notify(
      { title, subtitle, body, icon, urgent, clickCmd },
      { platform: plat, probe: (bin) => onPath(bin, plat) }
    );
  } catch (e) {
    /* best effort */
  }
  if (desk.sound !== false && soundPath) {
    try {
      sound.play(soundPath, { platform: plat, volume: desk.volume });
    } catch (e) {
      /* best effort */
    }
  }
  if (desk.terminalBell !== false) {
    try {
      desktop.bell();
    } catch (e) {
      /* best effort */
    }
  }
  // On Linux a click callback needs a live process/daemon (not shipped); hints
  // are captured for future use but focus fires only on macOS via clickCmd.

  try {
    state.gc({});
    dedup.gc({});
  } catch (e) {
    /* best effort */
  }
}

try {
  main();
} catch (e) {
  try {
    process.stderr.write("[notify] " + ((e && e.stack) || e) + "\n");
  } catch (_) {
    /* give up quietly */
  }
}
process.exit(0);

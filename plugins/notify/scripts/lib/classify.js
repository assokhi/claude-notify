"use strict";

// Ported Stop-event state machine + event dispatcher.
// Depends on the sibling transcript helpers (pure JSONL accessors).
const transcript = require("./transcript");

const STATUS = {
  TASK_COMPLETE: "task_complete",
  REVIEW_COMPLETE: "review_complete",
  QUESTION: "question",
  PLAN_READY: "plan_ready",
  SESSION_LIMIT: "session_limit_reached",
  API_ERROR: "api_error",
  API_ERROR_OVERLOADED: "api_error_overloaded",
  UNKNOWN: "unknown",
};

// Mutating tools (verbatim from the reference). Bash is always treated as
// "active" even for read-only commands — a deliberately preserved caveat.
const ACTIVE_TOOLS = ["Write", "Edit", "Bash", "NotebookEdit", "SlashCommand", "KillShell"];

// Read-like tools that, alone, can trigger a review classification.
const READLIKE_TOOLS = ["Read", "Grep", "Glob"];

// a >= b, parsing ISO timestamps; fall back to lexical (RFC3339-ordered) compare.
// A null/undefined lower bound (b) means "no bound" -> always true.
function tsGte(a, b) {
  if (b == null) return true;
  if (a == null) return false;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!isNaN(da) && !isNaN(db)) return da >= db;
  return String(a) >= String(b);
}

function lastAssistantEntries(entries, n) {
  const asst = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && e.type === "assistant"
  );
  return asst.slice(-n);
}

// Full Stop / SubagentStop transcript state machine.
// opts: { notifyOnTextResponse: boolean }
function classifyStop(entries, opts) {
  const options = opts || {};
  const list = Array.isArray(entries) ? entries : [];

  // 2. Session limit (highest priority): scan text of the last 3 assistant msgs.
  for (const e of lastAssistantEntries(list, 3)) {
    const t = transcript.textOf(e).toLowerCase();
    if (
      t.includes("session limit reached") ||
      t.includes("session limit has been reached")
    ) {
      return STATUS.SESSION_LIMIT;
    }
  }

  // 4. Last real user timestamp (needed by the api-error gate below too).
  const userTs = transcript.lastUserTimestamp(list);

  // 3. API error: api-error messages at/after the last user timestamp.
  let lastApiErr = null;
  for (const e of list) {
    if (transcript.isApiErrorEntry(e) && tsGte(e.timestamp, userTs)) lastApiErr = e;
  }
  if (lastApiErr) {
    const errField = typeof lastApiErr.error === "string" ? lastApiErr.error : "";
    if (errField === "authentication_failed") return STATUS.API_ERROR;
    const hay = (transcript.textOf(lastApiErr) + " " + errField).toLowerCase();
    if (
      hay.includes("401") &&
      (hay.includes("authentication_error") || hay.includes("run /login"))
    ) {
      return STATUS.API_ERROR;
    }
    return STATUS.API_ERROR_OVERLOADED;
  }

  // 5. Keep only assistant messages after the last real user timestamp.
  const after = transcript.assistantEntriesAfter(list, userTs);
  if (after.length === 0) return STATUS.UNKNOWN;

  // 6. Keep the last 15.
  const windowMsgs = after.slice(-15);

  // 7. Extract tool_use blocks in positional order across the window.
  const tools = [];
  for (const e of windowMsgs) {
    for (const tu of transcript.toolUsesOf(e)) tools.push(tu.name);
  }

  // 8. Tools present -> resolve by priority.
  if (tools.length > 0) {
    const last = tools[tools.length - 1];

    if (last === "ExitPlanMode") return STATUS.PLAN_READY;
    if (last === "AskUserQuestion") return STATUS.QUESTION;

    // ExitPlanMode present AND >=1 tool after its position -> plan then work done.
    const epmIdx = tools.lastIndexOf("ExitPlanMode");
    if (epmIdx !== -1 && epmIdx < tools.length - 1) return STATUS.TASK_COMPLETE;

    const readlikeCount = tools.filter((t) => READLIKE_TOOLS.includes(t)).length;
    const activeCount = tools.filter((t) => ACTIVE_TOOLS.includes(t)).length;
    if (readlikeCount >= 1 && activeCount === 0) {
      const last5 = windowMsgs
        .slice(-5)
        .map((e) => transcript.textOf(e))
        .join("\n");
      if (Buffer.byteLength(last5, "utf8") > 200) return STATUS.REVIEW_COMPLETE;
    }

    if (ACTIVE_TOOLS.includes(last)) return STATUS.TASK_COMPLETE;

    // Any tool at all.
    return STATUS.TASK_COMPLETE;
  }

  // 9. No tools: a text-only response.
  return options.notifyOnTextResponse ? STATUS.TASK_COMPLETE : STATUS.UNKNOWN;
}

// Event dispatcher.
// args: { event, toolName, entries, config }
function classifyEvent(args) {
  const a = args || {};
  const event = a.event;
  const toolName = a.toolName;
  const entries = a.entries;
  const config = a.config || {};

  if (event === "PreToolUse") {
    if (toolName === "ExitPlanMode") return STATUS.PLAN_READY;
    if (toolName === "AskUserQuestion") return STATUS.QUESTION;
    return STATUS.UNKNOWN;
  }
  if (event === "Notification") return STATUS.QUESTION;
  if (event === "Stop" || event === "SubagentStop") {
    return classifyStop(entries, { notifyOnTextResponse: config.notifyOnTextResponse });
  }
  return STATUS.UNKNOWN;
}

module.exports = {
  STATUS,
  ACTIVE_TOOLS,
  READLIKE_TOOLS,
  classifyStop,
  classifyEvent,
};
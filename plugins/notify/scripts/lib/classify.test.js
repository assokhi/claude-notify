"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const classify = require("./classify");
const { STATUS } = classify;

// ---- inline fixture builders (real transcript helpers are exercised too) ----

// monotonically increasing ISO timestamps
let _clock = Date.parse("2026-06-07T12:00:00.000Z");
function ts() {
  _clock += 1000;
  return new Date(_clock).toISOString();
}

function userText(text, t) {
  return { type: "user", timestamp: t || ts(), message: { content: text } };
}

// a user message that is ONLY a tool_result (must NOT count as a real user msg)
function userToolResult(t) {
  return {
    type: "user",
    timestamp: t || ts(),
    message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
  };
}

function asstText(text, t) {
  return {
    type: "assistant",
    timestamp: t || ts(),
    message: { content: [{ type: "text", text: text }] },
  };
}

// assistant message carrying optional leading text then a list of tool_use blocks
function asstTools(names, text, t) {
  const content = [];
  if (text) content.push({ type: "text", text: text });
  for (const name of names) {
    content.push({ type: "tool_use", name: name, input: {} });
  }
  return { type: "assistant", timestamp: t || ts(), message: { content: content } };
}

function apiErr(opts, t) {
  const o = opts || {};
  return {
    type: "assistant",
    timestamp: t || ts(),
    isApiErrorMessage: true,
    error: o.error,
    message: { content: o.text != null ? o.text : "" },
  };
}

const big = "x".repeat(250); // 250 ascii bytes > 200
const small = "short text"; // < 200 bytes

// ---------------------------------------------------------------------------
// exports / constants
// ---------------------------------------------------------------------------

test("STATUS values match the canonical status strings", () => {
  assert.equal(STATUS.TASK_COMPLETE, "task_complete");
  assert.equal(STATUS.REVIEW_COMPLETE, "review_complete");
  assert.equal(STATUS.QUESTION, "question");
  assert.equal(STATUS.PLAN_READY, "plan_ready");
  assert.equal(STATUS.SESSION_LIMIT, "session_limit_reached");
  assert.equal(STATUS.API_ERROR, "api_error");
  assert.equal(STATUS.API_ERROR_OVERLOADED, "api_error_overloaded");
  assert.equal(STATUS.UNKNOWN, "unknown");
});

test("ACTIVE_TOOLS and READLIKE_TOOLS are the verbatim sets", () => {
  assert.deepEqual(classify.ACTIVE_TOOLS, [
    "Write",
    "Edit",
    "Bash",
    "NotebookEdit",
    "SlashCommand",
    "KillShell",
  ]);
  assert.deepEqual(classify.READLIKE_TOOLS, ["Read", "Grep", "Glob"]);
});

// ---------------------------------------------------------------------------
// 2. session limit (highest priority)
// ---------------------------------------------------------------------------

test("session limit: 'session limit reached' in last assistant msg", () => {
  const entries = [
    userText("hi"),
    asstText("Sorry, your SESSION LIMIT REACHED for now."),
  ];
  assert.equal(classify.classifyStop(entries, {}), STATUS.SESSION_LIMIT);
});

test("session limit: 'session limit has been reached' phrasing", () => {
  const entries = [
    userText("hi"),
    asstText("Your session limit has been reached, sorry."),
  ];
  assert.equal(classify.classifyStop(entries, {}), STATUS.SESSION_LIMIT);
});

test("session limit beats api error when both present", () => {
  const entries = [
    userText("hi"),
    apiErr({ error: "authentication_failed" }),
    asstText("session limit reached"),
  ];
  assert.equal(classify.classifyStop(entries, {}), STATUS.SESSION_LIMIT);
});

test("session limit only scans the last 3 assistant messages", () => {
  // limit phrase is on the 4th-from-end assistant message -> ignored
  const entries = [
    userText("do it"),
    asstText("session limit reached"), // A1 (4th from end)
    asstText("working..."), // A2
    asstText("still working..."), // A3
    asstTools(["Write"], "done", null), // A4 (newest)
  ];
  // not session limit; the trailing Write makes it task_complete
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

// ---------------------------------------------------------------------------
// 3. api error variants
// ---------------------------------------------------------------------------

test("api_error: structured error authentication_failed", () => {
  const entries = [userText("hi"), apiErr({ error: "authentication_failed" })];
  assert.equal(classify.classifyStop(entries, {}), STATUS.API_ERROR);
});

test("api_error: text 401 + authentication_error", () => {
  const entries = [
    userText("hi"),
    apiErr({ text: "HTTP 401 authentication_error from provider" }),
  ];
  assert.equal(classify.classifyStop(entries, {}), STATUS.API_ERROR);
});

test("api_error: text 401 + run /login", () => {
  const entries = [
    userText("hi"),
    apiErr({ text: "Got a 401, please run /login again" }),
  ];
  assert.equal(classify.classifyStop(entries, {}), STATUS.API_ERROR);
});

test("api_error_overloaded: generic api error without 401/auth markers", () => {
  const entries = [
    userText("hi"),
    apiErr({ text: "Overloaded: upstream is busy", error: "overloaded_error" }),
  ];
  assert.equal(
    classify.classifyStop(entries, {}),
    STATUS.API_ERROR_OVERLOADED
  );
});

test("api error before the last user ts is ignored", () => {
  const t0 = ts();
  const tErr = ts();
  const tUser = ts();
  const tAsst = ts();
  const entries = [
    userText("first", t0),
    apiErr({ error: "authentication_failed" }, tErr), // before the LAST user msg
    userText("second", tUser),
    asstTools(["Write"], "done", tAsst),
  ];
  // error predates last user ts -> normal classification -> task_complete
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

test("last (not first) qualifying api error wins", () => {
  const entries = [
    userText("hi"),
    apiErr({ error: "authentication_failed" }), // earlier
    apiErr({ text: "Overloaded", error: "overloaded_error" }), // later -> wins
  ];
  assert.equal(
    classify.classifyStop(entries, {}),
    STATUS.API_ERROR_OVERLOADED
  );
});

test("api error with no user message at all is still considered", () => {
  const entries = [apiErr({ error: "authentication_failed" })];
  assert.equal(classify.classifyStop(entries, {}), STATUS.API_ERROR);
});

// ---------------------------------------------------------------------------
// 5. no assistant after last user -> unknown
// ---------------------------------------------------------------------------

test("unknown: no assistant message after the last user message", () => {
  const tAsst = ts();
  const tUser = ts();
  const entries = [asstText("old reply", tAsst), userText("new prompt", tUser)];
  assert.equal(classify.classifyStop(entries, {}), STATUS.UNKNOWN);
});

test("tool_result-only user messages do not count as the user boundary", () => {
  // last "real" user msg is the text one; the tool_result user after it is skipped,
  // so the assistant reply still counts as "after the user".
  const entries = [
    userText("please write"),
    asstTools(["Write"], "ok", null),
    userToolResult(),
    asstText("done"),
  ];
  // real user ts is the text msg; both assistants are after it; last tool none on
  // newest msg but a Write exists in window -> task_complete
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

// ---------------------------------------------------------------------------
// 8. tool priority
// ---------------------------------------------------------------------------

test("plan_ready: last tool is ExitPlanMode", () => {
  const entries = [userText("plan it"), asstTools(["Read", "ExitPlanMode"], "", null)];
  assert.equal(classify.classifyStop(entries, {}), STATUS.PLAN_READY);
});

test("question: last tool is AskUserQuestion", () => {
  const entries = [userText("hmm"), asstTools(["AskUserQuestion"], "", null)];
  assert.equal(classify.classifyStop(entries, {}), STATUS.QUESTION);
});

test("task_complete: ExitPlanMode present with a tool after it", () => {
  const entries = [
    userText("go"),
    asstTools(["ExitPlanMode"], "", null),
    asstTools(["Write"], "", null),
  ];
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

test("review_complete: read-like only, zero active, >200 bytes of text", () => {
  const entries = [userText("review"), asstTools(["Read", "Grep"], big, null)];
  assert.equal(classify.classifyStop(entries, {}), STATUS.REVIEW_COMPLETE);
});

test("not review: read-like only but text <= 200 bytes -> task_complete", () => {
  const entries = [userText("review"), asstTools(["Read", "Grep"], small, null)];
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

test("not review: Bash present counts as active even with big text", () => {
  const entries = [userText("review"), asstTools(["Read", "Bash"], big, null)];
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

test("review uses combined text of last 5 assistant messages", () => {
  // tools on an early message, big text spread so that last-5 join exceeds 200
  const entries = [
    userText("review"),
    asstTools(["Read"], "a".repeat(120), null),
    asstText("b".repeat(120)),
  ];
  assert.equal(classify.classifyStop(entries, {}), STATUS.REVIEW_COMPLETE);
});

test("task_complete: last tool is active (Write)", () => {
  const entries = [userText("go"), asstTools(["Read", "Write"], "", null)];
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

test("task_complete: any-tool fallback (last readlike, active earlier, short text)", () => {
  // Write earlier (active>0 -> no review), last tool Read (not active) -> any-tool fallback
  const entries = [userText("go"), asstTools(["Write", "Read"], small, null)];
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

test("each active tool individually yields task_complete", () => {
  for (const tool of classify.ACTIVE_TOOLS) {
    const entries = [userText("go"), asstTools([tool], "", null)];
    assert.equal(
      classify.classifyStop(entries, {}),
      STATUS.TASK_COMPLETE,
      `tool ${tool} should be task_complete`
    );
  }
});

// ---------------------------------------------------------------------------
// 6. last-15 window truncation
// ---------------------------------------------------------------------------

test("last-15 window: a tool older than 15 messages back is dropped", () => {
  const entries = [userText("go")];
  // oldest assistant carries the only tool (a Write)
  entries.push(asstTools(["Write"], "first", null));
  // then 15 text-only assistant messages (window = these 15, Write dropped)
  for (let i = 0; i < 15; i++) entries.push(asstText("reply " + i));
  // with notifyOnTextResponse false: no tools in window -> unknown (proves drop)
  assert.equal(
    classify.classifyStop(entries, { notifyOnTextResponse: false }),
    STATUS.UNKNOWN
  );
});

test("last-15 window: a tool inside the window is kept", () => {
  const entries = [userText("go")];
  for (let i = 0; i < 14; i++) entries.push(asstText("reply " + i));
  entries.push(asstTools(["Write"], "last", null)); // newest, inside window
  assert.equal(
    classify.classifyStop(entries, { notifyOnTextResponse: false }),
    STATUS.TASK_COMPLETE
  );
});

// ---------------------------------------------------------------------------
// 9. no tools -> text response gate
// ---------------------------------------------------------------------------

test("no tools + notifyOnTextResponse true -> task_complete", () => {
  const entries = [userText("hi"), asstText("Here is my answer.")];
  assert.equal(
    classify.classifyStop(entries, { notifyOnTextResponse: true }),
    STATUS.TASK_COMPLETE
  );
});

test("no tools + notifyOnTextResponse false -> unknown", () => {
  const entries = [userText("hi"), asstText("Here is my answer.")];
  assert.equal(
    classify.classifyStop(entries, { notifyOnTextResponse: false }),
    STATUS.UNKNOWN
  );
});

test("no tools + missing opts -> unknown (falsy notifyOnTextResponse)", () => {
  const entries = [userText("hi"), asstText("Here is my answer.")];
  assert.equal(classify.classifyStop(entries), STATUS.UNKNOWN);
});

// ---------------------------------------------------------------------------
// timestamp fallback (non-ISO lexical compare)
// ---------------------------------------------------------------------------

test("non-parseable timestamps fall back to lexical compare", () => {
  const entries = [
    userText("go", "0002"),
    asstTools(["Write"], "done", "0003"), // lexically after the user
  ];
  assert.equal(classify.classifyStop(entries, {}), STATUS.TASK_COMPLETE);
});

// ---------------------------------------------------------------------------
// classifyEvent dispatcher
// ---------------------------------------------------------------------------

test("classifyEvent PreToolUse ExitPlanMode -> plan_ready", () => {
  assert.equal(
    classify.classifyEvent({ event: "PreToolUse", toolName: "ExitPlanMode" }),
    STATUS.PLAN_READY
  );
});

test("classifyEvent PreToolUse AskUserQuestion -> question", () => {
  assert.equal(
    classify.classifyEvent({ event: "PreToolUse", toolName: "AskUserQuestion" }),
    STATUS.QUESTION
  );
});

test("classifyEvent PreToolUse other tool -> unknown", () => {
  assert.equal(
    classify.classifyEvent({ event: "PreToolUse", toolName: "Write" }),
    STATUS.UNKNOWN
  );
});

test("classifyEvent Notification -> question", () => {
  assert.equal(classify.classifyEvent({ event: "Notification" }), STATUS.QUESTION);
});

test("classifyEvent Stop delegates to classifyStop with config flag (true)", () => {
  const entries = [userText("hi"), asstText("answer")];
  assert.equal(
    classify.classifyEvent({
      event: "Stop",
      entries,
      config: { notifyOnTextResponse: true },
    }),
    STATUS.TASK_COMPLETE
  );
});

test("classifyEvent Stop delegates to classifyStop with config flag (false)", () => {
  const entries = [userText("hi"), asstText("answer")];
  assert.equal(
    classify.classifyEvent({
      event: "Stop",
      entries,
      config: { notifyOnTextResponse: false },
    }),
    STATUS.UNKNOWN
  );
});

test("classifyEvent SubagentStop delegates to classifyStop", () => {
  const entries = [userText("hi"), asstTools(["Write"], "", null)];
  assert.equal(
    classify.classifyEvent({ event: "SubagentStop", entries, config: {} }),
    STATUS.TASK_COMPLETE
  );
});

test("classifyEvent unknown event -> unknown", () => {
  assert.equal(classify.classifyEvent({ event: "PostToolUse" }), STATUS.UNKNOWN);
});

test("classifyEvent with no args -> unknown (never throws)", () => {
  assert.equal(classify.classifyEvent(), STATUS.UNKNOWN);
});
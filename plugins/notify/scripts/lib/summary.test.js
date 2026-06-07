"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const summary = require("./summary");
const { stripMarkdown, truncate, bodyFor, actionSuffix, subtitle } = summary;

const blen = (s) => Buffer.byteLength(s, "utf8");

// helpers to build transcript entries inline
function user(text, ts) {
  return { type: "user", message: { content: text }, timestamp: ts };
}
function assistantText(text, ts) {
  return { type: "assistant", message: { content: [{ type: "text", text }] }, timestamp: ts };
}
function assistantTools(blocks, ts) {
  return { type: "assistant", message: { content: blocks }, timestamp: ts };
}
function tool(name, input) {
  return { type: "tool_use", name, input: input || {} };
}

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------
test("stripMarkdown removes bold and italic markers", () => {
  assert.equal(stripMarkdown("**bold** and *italic*"), "bold and italic");
});
test("stripMarkdown removes inline code backticks", () => {
  assert.equal(stripMarkdown("run `npm test` now"), "run npm test now");
});
test("stripMarkdown removes heading and blockquote markers", () => {
  assert.equal(stripMarkdown("## Title"), "Title");
  assert.equal(stripMarkdown("> quoted line"), "quoted line");
});
test("stripMarkdown unwraps links to their text", () => {
  assert.equal(stripMarkdown("see [the docs](https://x.com/y)"), "see the docs");
});
test("stripMarkdown returns '' for non-strings", () => {
  assert.equal(stripMarkdown(null), "");
  assert.equal(stripMarkdown(undefined), "");
  assert.equal(stripMarkdown(42), "");
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------
test("truncate returns trimmed string when within limit", () => {
  assert.equal(truncate("hello world", 150), "hello world");
  assert.equal(truncate("   padded   ", 150), "padded");
});
test("truncate non-string -> ''", () => {
  assert.equal(truncate(null), "");
  assert.equal(truncate(undefined), "");
});
test("truncate cuts at a word boundary (no periods)", () => {
  const s = "word ".repeat(60); // 300 chars, no sentence punctuation
  const out = truncate(s, 150);
  assert.ok(blen(out) <= 150, "byte length within limit");
  assert.ok(s.replace(/\s+$/, "").startsWith(out), "result is a prefix");
  assert.ok(!/\s$/.test(out), "no trailing whitespace");
  assert.ok(!out.includes("wor ") && out.endsWith("word"), "ends on a whole word");
});
test("truncate prefers a sentence boundary past the halfway point", () => {
  const first = "This first sentence is intentionally written to be quite long so it clears the halfway threshold here.";
  const s = first + " " + "extra ".repeat(40);
  const out = truncate(s, 150);
  assert.ok(blen(out) <= 150);
  assert.ok(out.endsWith("."), "ends at a sentence boundary");
  assert.equal(out, first);
});
test("truncate is byte-safe with multibyte characters", () => {
  const s = "\u{1F600}".repeat(10); // 10 emoji, 4 bytes each = 40 bytes
  const out = truncate(s, 10);
  assert.equal(out, "\u{1F600}\u{1F600}"); // only 2 fit in 10 bytes
  assert.equal(blen(out), 8);
});
test("truncate keeps every byte budget for ascii hard cut", () => {
  const s = "x".repeat(400);
  const out = truncate(s, 150);
  assert.equal(blen(out), 150);
});

// ---------------------------------------------------------------------------
// bodyFor: task_complete
// ---------------------------------------------------------------------------
test("bodyFor task_complete uses last assistant text", () => {
  const entries = [
    user("do it", "2026-06-07T10:00:00Z"),
    assistantText("All done and tested.", "2026-06-07T10:00:10Z"),
  ];
  assert.equal(bodyFor({ status: "task_complete", entries }), "All done and tested.");
});
test("bodyFor task_complete strips markdown from the body", () => {
  const entries = [assistantText("**Done!** Fixed the `bug`.", "2026-06-07T10:00:10Z")];
  assert.equal(bodyFor({ status: "task_complete", entries }), "Done! Fixed the bug.");
});
test("bodyFor task_complete uses first sentence when text >= 150 bytes", () => {
  const longTail = "Then a lot of additional detail follows here that makes the whole message exceed the one hundred and fifty byte threshold comfortably indeed.";
  const entries = [assistantText("Completed the refactor cleanly. " + longTail, "t")];
  assert.equal(bodyFor({ status: "task_complete", entries }), "Completed the refactor cleanly.");
});
test("bodyFor task_complete falls back to default when no text", () => {
  const entries = [assistantTools([tool("Write")], "t")];
  assert.equal(bodyFor({ status: "task_complete", entries }), "Task completed successfully");
  assert.equal(bodyFor({ status: "task_complete", entries: [] }), "Task completed successfully");
});

// ---------------------------------------------------------------------------
// bodyFor: review_complete
// ---------------------------------------------------------------------------
test("bodyFor review_complete returns the sentence with a review keyword", () => {
  const entries = [
    user("look at it", "2026-06-07T10:00:00Z"),
    assistantText("Opened the files. I reviewed the auth module carefully. Looks fine.", "t"),
  ];
  assert.equal(
    bodyFor({ status: "review_complete", entries }),
    "I reviewed the auth module carefully."
  );
});
test("bodyFor review_complete falls back to Read count", () => {
  const entries = [
    user("review code", "2026-06-07T10:00:00Z"),
    assistantTools([tool("Read"), tool("Read"), tool("Read")], "2026-06-07T10:00:05Z"),
    assistantText("Here are my notes about it.", "2026-06-07T10:00:06Z"),
  ];
  assert.equal(bodyFor({ status: "review_complete", entries }), "Reviewed 3 file(s)");
});
test("bodyFor review_complete final default", () => {
  const entries = [
    user("hi", "2026-06-07T10:00:00Z"),
    assistantText("Here is some unrelated prose.", "t"),
  ];
  assert.equal(bodyFor({ status: "review_complete", entries }), "Code review completed");
});

// ---------------------------------------------------------------------------
// bodyFor: question
// ---------------------------------------------------------------------------
test("bodyFor question prefers AskUserQuestion within 60s", () => {
  const entries = [
    user("hi", "2026-06-07T10:00:00Z"),
    assistantTools(
      [tool("AskUserQuestion", { questions: [{ question: "Which database should I use?" }] })],
      "2026-06-07T10:00:30Z"
    ),
  ];
  assert.equal(bodyFor({ status: "question", entries }), "Which database should I use?");
});
test("bodyFor question falls back to shortest assistant text containing '?'", () => {
  const entries = [
    user("hi", "2026-06-07T10:00:00Z"),
    assistantText("I have been thinking carefully and I wonder which option you prefer here?", "t1"),
    assistantText("Proceed?", "t2"),
  ];
  assert.equal(bodyFor({ status: "question", entries }), "Proceed?");
});
test("bodyFor question falls back to first sentence of last text", () => {
  const entries = [
    user("hi", "2026-06-07T10:00:00Z"),
    assistantText("I need more details to continue. There is more here.", "t"),
  ];
  assert.equal(bodyFor({ status: "question", entries }), "I need more details to continue.");
});
test("bodyFor question default when nothing usable", () => {
  const entries = [user("hi", "2026-06-07T10:00:00Z")];
  assert.equal(bodyFor({ status: "question", entries }), "Claude needs your input to continue");
});

// ---------------------------------------------------------------------------
// bodyFor: plan_ready
// ---------------------------------------------------------------------------
test("bodyFor plan_ready uses first non-empty line of the plan", () => {
  const entries = [
    assistantTools(
      [tool("ExitPlanMode", { plan: "\n\nRefactor the auth module\nThen add tests" })],
      "t"
    ),
  ];
  assert.equal(bodyFor({ status: "plan_ready", entries }), "Refactor the auth module");
});
test("bodyFor plan_ready default when no plan present", () => {
  const entries = [assistantTools([tool("ExitPlanMode", {})], "t")];
  assert.equal(bodyFor({ status: "plan_ready", entries }), "Plan is ready for review");
  assert.equal(bodyFor({ status: "plan_ready", entries: [] }), "Plan is ready for review");
});

// ---------------------------------------------------------------------------
// bodyFor: fixed-string statuses + api errors + unknown
// ---------------------------------------------------------------------------
test("bodyFor session_limit_reached fixed string", () => {
  assert.equal(
    bodyFor({ status: "session_limit_reached", entries: [] }),
    "Session limit reached. Please start a new conversation."
  );
});
test("bodyFor api_error fixed string", () => {
  assert.equal(bodyFor({ status: "api_error", entries: [] }), "Please run /login");
});
test("bodyFor api_error_overloaded uses error text then default", () => {
  const entries = [
    { type: "assistant", isApiErrorMessage: true, error: "Overloaded, please retry", message: { content: [] }, timestamp: "t" },
  ];
  assert.equal(bodyFor({ status: "api_error_overloaded", entries }), "Overloaded, please retry");
  assert.equal(bodyFor({ status: "api_error_overloaded", entries: [] }), "API error occurred");
});
test("bodyFor unknown / unrecognized -> ''", () => {
  assert.equal(bodyFor({ status: "unknown", entries: [] }), "");
  assert.equal(bodyFor({ status: "nonsense", entries: [] }), "");
  assert.equal(bodyFor({}), "");
});

// ---------------------------------------------------------------------------
// actionSuffix
// ---------------------------------------------------------------------------
test("actionSuffix counts writes/edits/bash + duration in order", () => {
  const entries = [
    user("do stuff", "2026-06-07T10:00:00Z"),
    assistantTools([tool("Write"), tool("Bash")], "2026-06-07T10:00:05Z"),
    assistantTools([tool("Edit"), tool("Edit"), { type: "text", text: "done" }], "2026-06-07T10:00:42Z"),
  ];
  assert.equal(actionSuffix(entries), "📝 1 new  ✏️ 2 edited  ▶ 1 cmds  ⏱ 42s");
});
test("actionSuffix only counts tools after the last user message", () => {
  const entries = [
    user("first", "2026-06-07T10:00:00Z"),
    assistantTools([tool("Write")], "2026-06-07T10:00:01Z"),
    user("second", "2026-06-07T10:01:00Z"),
    assistantTools([tool("Edit")], "2026-06-07T10:01:03Z"),
  ];
  assert.equal(actionSuffix(entries), "✏️ 1 edited  ⏱ 3s");
});
test("actionSuffix duration formats minutes", () => {
  const entries = [
    user("go", "2026-06-07T10:00:00Z"),
    assistantText("ok", "2026-06-07T10:02:15Z"),
  ];
  assert.equal(actionSuffix(entries), "⏱ 2m 15s");
});
test("actionSuffix duration formats hours", () => {
  const entries = [
    user("go", "2026-06-07T10:00:00Z"),
    assistantText("ok", "2026-06-07T12:05:00Z"),
  ];
  assert.equal(actionSuffix(entries), "⏱ 2h 5m");
});
test("actionSuffix duration under a minute uses seconds", () => {
  const entries = [
    user("go", "2026-06-07T10:00:00Z"),
    assistantText("ok", "2026-06-07T10:00:07Z"),
  ];
  assert.equal(actionSuffix(entries), "⏱ 7s");
});
test("actionSuffix returns '' when nothing to report", () => {
  assert.equal(actionSuffix([user("hi", "2026-06-07T10:00:00Z")]), "");
  assert.equal(actionSuffix([]), "");
  assert.equal(actionSuffix(null), "");
});
test("actionSuffix omits duration when there is no user timestamp", () => {
  // No user-text entry -> lastUserTimestamp is null -> all assistants counted,
  // but duration cannot be computed, so only the count parts appear.
  const entries = [assistantTools([tool("Write")], "2026-06-07T10:00:01Z")];
  assert.equal(actionSuffix(entries), "📝 1 new");
});

// ---------------------------------------------------------------------------
// subtitle
// ---------------------------------------------------------------------------
test("subtitle joins branch and folder with middle dot", () => {
  assert.equal(subtitle({ branch: "main", folder: "claude-notify" }), "main · claude-notify");
});
test("subtitle with folder only returns folder", () => {
  assert.equal(subtitle({ folder: "claude-notify" }), "claude-notify");
  assert.equal(subtitle({ branch: "", folder: "proj" }), "proj");
});
test("subtitle with branch only (no folder) returns ''", () => {
  assert.equal(subtitle({ branch: "main" }), "");
});
test("subtitle with nothing returns ''", () => {
  assert.equal(subtitle({}), "");
  assert.equal(subtitle(), "");
});
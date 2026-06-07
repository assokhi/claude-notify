"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tx = require("./transcript");

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------
test("read: returns file contents for a real file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tx-read-"));
  const p = path.join(dir, "t.jsonl");
  fs.writeFileSync(p, "hello world", "utf8");
  assert.equal(tx.read(p), "hello world");
});

test("read: returns null on missing file (never throws)", () => {
  const p = path.join(os.tmpdir(), "tx-nope-" + Date.now() + ".jsonl");
  assert.equal(tx.read(p), null);
});

test("read: returns null on a directory path (read error)", () => {
  assert.equal(tx.read(os.tmpdir()), null);
});

// ---------------------------------------------------------------------------
// parseLines()
// ---------------------------------------------------------------------------
test("parseLines: parses non-blank lines and skips blanks", () => {
  const text = '{"type":"user"}\n\n   \n{"type":"assistant"}\n';
  const out = tx.parseLines(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, "user");
  assert.equal(out[1].type, "assistant");
});

test("parseLines: skips unparseable lines but keeps valid ones (meta-line tolerance)", () => {
  const text =
    '{"type":"user"}\n' +
    "this is not json\n" +
    '{"type":"mode","mode":"plan"}\n' + // meta line, still valid JSON
    "{broken json\n" +
    '{"type":"assistant"}';
  const out = tx.parseLines(text);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.type), ["user", "mode", "assistant"]);
});

test("parseLines: non-string input returns []", () => {
  assert.deepEqual(tx.parseLines(null), []);
  assert.deepEqual(tx.parseLines(undefined), []);
  assert.deepEqual(tx.parseLines(42), []);
});

test("parseLines: empty / whitespace-only text returns []", () => {
  assert.deepEqual(tx.parseLines(""), []);
  assert.deepEqual(tx.parseLines("   \n\n\t\n"), []);
});

// ---------------------------------------------------------------------------
// contentOf()
// ---------------------------------------------------------------------------
test("contentOf: string content", () => {
  assert.equal(tx.contentOf({ message: { content: "hi" } }), "hi");
});

test("contentOf: array content", () => {
  const arr = [{ type: "text", text: "x" }];
  assert.deepEqual(tx.contentOf({ message: { content: arr } }), arr);
});

test("contentOf: undefined when no message", () => {
  assert.equal(tx.contentOf({ type: "user" }), undefined);
  assert.equal(tx.contentOf(null), undefined);
  assert.equal(tx.contentOf(undefined), undefined);
});

// ---------------------------------------------------------------------------
// textOf()  — string vs array content
// ---------------------------------------------------------------------------
test("textOf: string content passes through", () => {
  assert.equal(tx.textOf({ message: { content: "just text" } }), "just text");
});

test("textOf: array joins only text blocks with newlines, skipping tool_use", () => {
  const entry = {
    message: {
      content: [
        { type: "text", text: "line one" },
        { type: "tool_use", name: "Read", input: {} },
        { type: "text", text: "line two" },
      ],
    },
  };
  assert.equal(tx.textOf(entry), "line one\nline two");
});

test("textOf: array with no text blocks -> empty string", () => {
  const entry = {
    message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
  };
  assert.equal(tx.textOf(entry), "");
});

test("textOf: missing/odd content -> empty string", () => {
  assert.equal(tx.textOf({ type: "mode" }), "");
  assert.equal(tx.textOf(null), "");
  assert.equal(tx.textOf({ message: { content: 123 } }), "");
});

// ---------------------------------------------------------------------------
// toolUsesOf()  — extraction order + positional index
// ---------------------------------------------------------------------------
test("toolUsesOf: returns tool_use blocks with content-array position as index", () => {
  const entry = {
    message: {
      content: [
        { type: "text", text: "thinking" }, // index 0
        { type: "tool_use", name: "Read", input: {} }, // index 1
        { type: "text", text: "more" }, // index 2
        { type: "tool_use", name: "Bash", input: {} }, // index 3
      ],
    },
  };
  assert.deepEqual(tx.toolUsesOf(entry), [
    { name: "Read", index: 1 },
    { name: "Bash", index: 3 },
  ]);
});

test("toolUsesOf: preserves order across many tools", () => {
  const entry = {
    message: {
      content: [
        { type: "tool_use", name: "Write", input: {} },
        { type: "tool_use", name: "Edit", input: {} },
        { type: "tool_use", name: "ExitPlanMode", input: {} },
      ],
    },
  };
  const tools = tx.toolUsesOf(entry);
  assert.deepEqual(tools.map((t) => t.name), ["Write", "Edit", "ExitPlanMode"]);
  assert.deepEqual(tools.map((t) => t.index), [0, 1, 2]);
});

test("toolUsesOf: string content -> []", () => {
  assert.deepEqual(tx.toolUsesOf({ message: { content: "hi" } }), []);
});

test("toolUsesOf: no message -> []", () => {
  assert.deepEqual(tx.toolUsesOf({ type: "mode" }), []);
  assert.deepEqual(tx.toolUsesOf(null), []);
});

// ---------------------------------------------------------------------------
// isUserTextEntry()  — exclude tool_result-only user messages
// ---------------------------------------------------------------------------
test("isUserTextEntry: string-content user is a real user turn", () => {
  assert.equal(
    tx.isUserTextEntry({ type: "user", message: { content: "do the thing" } }),
    true
  );
});

test("isUserTextEntry: array whose first block is text is a real user turn", () => {
  assert.equal(
    tx.isUserTextEntry({
      type: "user",
      message: { content: [{ type: "text", text: "hi" }] },
    }),
    true
  );
});

test("isUserTextEntry: tool_result-only user message is NOT a real user turn", () => {
  assert.equal(
    tx.isUserTextEntry({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "x", content: "ok" },
        ],
      },
    }),
    false
  );
});

test("isUserTextEntry: assistant entry is never a user turn", () => {
  assert.equal(
    tx.isUserTextEntry({ type: "assistant", message: { content: "hi" } }),
    false
  );
});

test("isUserTextEntry: empty array / null / meta -> false", () => {
  assert.equal(tx.isUserTextEntry({ type: "user", message: { content: [] } }), false);
  assert.equal(tx.isUserTextEntry({ type: "user" }), false);
  assert.equal(tx.isUserTextEntry(null), false);
  assert.equal(tx.isUserTextEntry({ type: "mode" }), false);
});

// ---------------------------------------------------------------------------
// lastUserTimestamp()  — last REAL user msg, excluding tool_result-only ones
// ---------------------------------------------------------------------------
test("lastUserTimestamp: ignores trailing tool_result-only user message", () => {
  const entries = [
    { type: "user", timestamp: "2026-06-07T10:00:00Z", message: { content: "first" } },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05Z",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    },
    {
      type: "user",
      timestamp: "2026-06-07T10:00:10Z",
      message: { content: [{ type: "tool_result", content: "ok" }] },
    },
  ];
  // The tool_result-only user message (10:00:10) must be excluded; the last
  // real user turn is the string-content one at 10:00:00.
  assert.equal(tx.lastUserTimestamp(entries), "2026-06-07T10:00:00Z");
});

test("lastUserTimestamp: returns the latest real user turn when several exist", () => {
  const entries = [
    { type: "user", timestamp: "2026-06-07T10:00:00Z", message: { content: "one" } },
    { type: "assistant", timestamp: "2026-06-07T10:00:05Z", message: { content: "ack" } },
    {
      type: "user",
      timestamp: "2026-06-07T10:01:00Z",
      message: { content: [{ type: "text", text: "two" }] },
    },
  ];
  assert.equal(tx.lastUserTimestamp(entries), "2026-06-07T10:01:00Z");
});

test("lastUserTimestamp: null when there are no real user turns", () => {
  const entries = [
    { type: "assistant", timestamp: "t", message: { content: "x" } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "mode" },
  ];
  assert.equal(tx.lastUserTimestamp(entries), null);
});

test("lastUserTimestamp: non-array -> null", () => {
  assert.equal(tx.lastUserTimestamp(null), null);
  assert.equal(tx.lastUserTimestamp(undefined), null);
});

// ---------------------------------------------------------------------------
// assistantEntriesAfter()  — date compare + null ts + string fallback
// ---------------------------------------------------------------------------
test("assistantEntriesAfter: keeps only assistant entries strictly after ts (ISO dates)", () => {
  const entries = [
    { type: "user", timestamp: "2026-06-07T10:00:00Z", message: { content: "u" } },
    { type: "assistant", timestamp: "2026-06-07T09:59:00Z", message: { content: "before" } },
    { type: "assistant", timestamp: "2026-06-07T10:00:30Z", message: { content: "after1" } },
    { type: "assistant", timestamp: "2026-06-07T10:01:00Z", message: { content: "after2" } },
  ];
  const out = tx.assistantEntriesAfter(entries, "2026-06-07T10:00:00Z");
  assert.deepEqual(out.map((e) => tx.textOf(e)), ["after1", "after2"]);
});

test("assistantEntriesAfter: equal timestamp is NOT after (strict)", () => {
  const entries = [
    { type: "assistant", timestamp: "2026-06-07T10:00:00Z", message: { content: "eq" } },
  ];
  assert.deepEqual(tx.assistantEntriesAfter(entries, "2026-06-07T10:00:00Z"), []);
});

test("assistantEntriesAfter: ts==null returns all assistant entries (excludes non-assistant)", () => {
  const entries = [
    { type: "user", message: { content: "u" } },
    { type: "assistant", timestamp: "a", message: { content: "1" } },
    { type: "mode" },
    { type: "assistant", timestamp: "b", message: { content: "2" } },
  ];
  const out = tx.assistantEntriesAfter(entries, null);
  assert.deepEqual(out.map((e) => tx.textOf(e)), ["1", "2"]);
});

test("assistantEntriesAfter: falls back to lexical compare for non-date timestamps", () => {
  const entries = [
    { type: "assistant", timestamp: "aaa", message: { content: "lo" } },
    { type: "assistant", timestamp: "ccc", message: { content: "hi" } },
  ];
  // Date.parse("aaa"/"bbb"/"ccc") -> NaN, so lexical compare applies.
  const out = tx.assistantEntriesAfter(entries, "bbb");
  assert.deepEqual(out.map((e) => tx.textOf(e)), ["hi"]);
});

test("assistantEntriesAfter: non-array -> []", () => {
  assert.deepEqual(tx.assistantEntriesAfter(null, null), []);
});

// ---------------------------------------------------------------------------
// isApiErrorEntry()
// ---------------------------------------------------------------------------
test("isApiErrorEntry: true only when isApiErrorMessage === true", () => {
  assert.equal(tx.isApiErrorEntry({ isApiErrorMessage: true }), true);
  assert.equal(tx.isApiErrorEntry({ isApiErrorMessage: false }), false);
  assert.equal(tx.isApiErrorEntry({ isApiErrorMessage: "true" }), false); // strict
  assert.equal(tx.isApiErrorEntry({ type: "assistant" }), false);
  assert.equal(tx.isApiErrorEntry(null), false);
});

// ---------------------------------------------------------------------------
// gitBranchOf()
// ---------------------------------------------------------------------------
test("gitBranchOf: returns the last non-empty gitBranch", () => {
  const entries = [
    { type: "user", gitBranch: "main", message: { content: "x" } },
    { type: "assistant", gitBranch: "", message: { content: "y" } },
    { type: "assistant", gitBranch: "feature/x", message: { content: "z" } },
    { type: "mode" },
  ];
  assert.equal(tx.gitBranchOf(entries), "feature/x");
});

test("gitBranchOf: empty string when no entry carries a branch", () => {
  const entries = [
    { type: "user", message: { content: "x" } },
    { type: "assistant", gitBranch: "", message: { content: "y" } },
  ];
  assert.equal(tx.gitBranchOf(entries), "");
});

test("gitBranchOf: non-array -> empty string", () => {
  assert.equal(tx.gitBranchOf(null), "");
});

// ---------------------------------------------------------------------------
// Integration: read -> parseLines -> helpers over a realistic transcript
// ---------------------------------------------------------------------------
test("integration: full JSONL round-trip through the helpers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tx-int-"));
  const p = path.join(dir, "transcript.jsonl");
  const lines = [
    JSON.stringify({ type: "file-history-snapshot" }), // meta, skipped by helpers
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-07T10:00:00Z",
      gitBranch: "main",
      cwd: "/repo",
      message: { content: "please refactor" },
    }),
    "garbage-not-json",
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-07T10:00:20Z",
      gitBranch: "main",
      message: {
        content: [
          { type: "text", text: "On it." },
          { type: "tool_use", name: "Edit", input: { file: "a" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-07T10:00:25Z",
      message: { content: [{ type: "tool_result", content: "done" }] }, // not a real turn
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-07T10:00:30Z",
      gitBranch: "feature/refactor",
      message: { content: [{ type: "text", text: "All set." }] },
    }),
  ];
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");

  const entries = tx.parseLines(tx.read(p));
  assert.equal(entries.length, 5); // 6 lines minus 1 garbage line

  const lastUser = tx.lastUserTimestamp(entries);
  assert.equal(lastUser, "2026-06-07T10:00:00Z"); // tool_result-only user excluded

  const after = tx.assistantEntriesAfter(entries, lastUser);
  assert.equal(after.length, 2);
  assert.deepEqual(after.map((e) => tx.textOf(e)), ["On it.", "All set."]);

  assert.deepEqual(tx.toolUsesOf(after[0]), [{ name: "Edit", index: 1 }]);
  assert.equal(tx.gitBranchOf(entries), "feature/refactor");
});

# Smart Notify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sounds-only `notify-sounds` plugin with `notify`: a pure-Node, zero-dep Claude Code plugin that classifies each turn from the transcript and delivers a native desktop popup + per-status sound + terminal bell, with suppression, per-status config, and best-effort click-to-focus.

**Architecture:** A single `notify.js` orchestrator runs on four hook events (PreToolUse / Notification / Stop / SubagentStop), reads the hook JSON from stdin, and runs the ported claude-notifications-go pipeline using small single-purpose `lib/` modules. Every path is fail-open (exit 0). Pure functions (transcript/classify/config/summary/suppress/dedup/state/git/session-label) are TDD'd with `node:test`; side-effecting channels expose pure command-builders that are unit-tested, with a `NOTIFY_DRY_RUN=1` mode for integration smoke tests.

**Tech Stack:** Node >=18, CommonJS, zero external deps (only `fs`/`os`/`path`/`child_process`/`crypto`/`node:test`). Spec: `docs/superpowers/specs/2026-06-07-smart-notify-design.md`.

**Provenance:** The `lib/` module code + tests below were drafted in parallel by a multi-agent workflow against a fixed interface contract, each module self-verified green by its author agent, then passed an adversarial cross-module consistency audit (verdict: consistent). The orchestrator and scaffolding are authored directly. Two audit warnings were folded in: desktop `bell()` now writes the BEL char; focus has a documented inert GNOME branch (Task 12).

---

## File structure

```text
plugins/notify/
  .claude-plugin/plugin.json     # 4 inlined hooks -> node scripts/notify.js <Event>
  package.json                   # private, test script only (zero deps)
  config.example.json            # documented default config
  README.md
  scripts/
    notify.js                    # orchestrator (Task 13)
    lib/
      transcript.js              # JSONL parse + helpers (Task 1)
      config.js                  # load/merge/expand/resolve (Task 2)
      session-label.js           # id -> stable label (Task 3)
      state.js                   # per-session temp-dir state (Task 4)
      dedup.js                   # lock files + dup message (Task 5)
      suppress.js                # cooldowns + filters (Task 6)
      git.js                     # branch (Task 7)
      summary.js                 # message body + action suffix (Task 8)
      classify.js                # the ported state machine (Task 9)
      channels/sound.js          # per-status sound player (Task 10)
      channels/desktop.js        # native popup + bell (Task 11)
      focus.js                   # best-effort click-to-focus (Task 12)
  sounds/notification.wav        # carried over from notify-sounds
  sounds/complete.wav            # carried over from notify-sounds
```

---

### Task 0: Scaffold the `notify` plugin + carry over sounds

**Files:**
- Create dirs: `plugins/notify/scripts/lib/channels`, `plugins/notify/.claude-plugin`, `plugins/notify/sounds`
- Move: `plugins/notify-sounds/sounds/*.wav` → `plugins/notify/sounds/`
- Create: `plugins/notify/package.json`

- [ ] **Step 1 — create dirs + carry sounds + remove old plugin**

```bash
cd /home/sokhi/projects/claude-notify
mkdir -p plugins/notify/scripts/lib/channels plugins/notify/.claude-plugin plugins/notify/sounds
git mv plugins/notify-sounds/sounds/notification.wav plugins/notify/sounds/notification.wav
git mv plugins/notify-sounds/sounds/complete.wav plugins/notify/sounds/complete.wav
git rm -r plugins/notify-sounds
```

- [ ] **Step 2 — create `plugins/notify/package.json`**

```json
{
  "name": "claude-notify-plugin",
  "version": "2.0.0",
  "private": true,
  "description": "Smart notifications plugin for Claude Code (pure Node, zero deps)",
  "scripts": { "test": "node --test" },
  "license": "MIT"
}
```

- [ ] **Step 3 — commit**

```bash
git add -A
git commit -m "chore(notify): scaffold notify plugin, carry sounds, drop notify-sounds"
```

---

### Task 1: `lib/transcript.js`

**Files:**
- Create: `plugins/notify/scripts/lib/transcript.js`
- Test: `plugins/notify/scripts/lib/transcript.test.js`

Exports: `read`, `parseLines`, `contentOf`, `textOf`, `toolUsesOf`, `isUserTextEntry`, `lastUserTimestamp`, `assistantEntriesAfter`, `isApiErrorEntry`, `gitBranchOf`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/transcript.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
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

```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/transcript.test.js`  
Expected: Before lib/transcript.js exists, the test run aborts at require time: "Error: Cannot find module './transcript'" with failureType 'testCodeFailure' / code 'ERR_TEST_FAILURE' (# fail 1). Once the module is created with the exported names above, all 37 subtests pass (# pass 37, # fail 0).

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/transcript.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

// transcript.js — safe JSONL read + pure helpers over Claude Code transcript
// entries. Zero external deps. The foundation that classify/summary/git build on.
//
// Transcript shape (verified, see design spec "Grounding facts"):
//   Each line is one JSON object with a top-level `type` ("user", "assistant",
//   or a meta type like "last-prompt"/"mode"/"file-history-snapshot"/...).
//   `message.content` is either a string (user text) or an array of blocks
//   {type, name, input, text}. Tool calls are blocks with type === "tool_use".
//   `timestamp` is an ISO/RFC3339 string. Lines also carry top-level
//   `gitBranch`, `cwd`, and (on errors) `isApiErrorMessage` / `error`.

const fs = require("node:fs");

// Read a transcript file. Returns its utf8 contents, or null on ANY error
// (missing file, permission, etc.) so callers can fail open to "unknown".
function read(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (e) {
    return null;
  }
}

// Split JSONL text on newlines and JSON.parse each non-blank line. Lines that
// fail to parse are skipped (never throws). Non-string input -> [].
function parseLines(text) {
  if (typeof text !== "string") return [];
  const out = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      // skip unparseable line
    }
  }
  return out;
}

// entry.message.content (string | block[] | undefined). undefined when there is
// no message object at all.
function contentOf(entry) {
  if (!entry || !entry.message) return undefined;
  return entry.message.content;
}

// Plain text of an entry. String content passes through; array content joins the
// .text of all type==="text" blocks with "\n"; anything else -> "".
function textOf(entry) {
  const content = contentOf(entry);
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text")
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  return "";
}

// Tool-use blocks in an entry, in content-array order. index is the block's
// position within the content array (NOT its position among tool_use blocks).
function toolUsesOf(entry) {
  const content = contentOf(entry);
  if (!Array.isArray(content)) return [];
  const out = [];
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (b && b.type === "tool_use") {
      out.push({ name: b.name, index: i });
    }
  }
  return out;
}

// True for a "real" user message: a user entry whose content is a string, or an
// array whose FIRST block is a text block. Excludes tool_result-only user
// messages (those have a tool_result block first), which Claude Code injects
// automatically and which are not human turns.
function isUserTextEntry(entry) {
  if (!entry || entry.type !== "user") return false;
  const content = contentOf(entry);
  if (typeof content === "string") return true;
  if (Array.isArray(content) && content[0] && content[0].type === "text") {
    return true;
  }
  return false;
}

// Timestamp of the last real user message, or null if there is none.
function lastUserTimestamp(entries) {
  if (!Array.isArray(entries)) return null;
  let ts = null;
  for (const e of entries) {
    if (isUserTextEntry(e)) {
      ts = e.timestamp != null ? e.timestamp : null;
    }
  }
  return ts;
}

// True if a is strictly after b. Prefer numeric Date.parse comparison; if either
// value is not a parseable date, fall back to lexical string compare (RFC3339
// strings sort correctly lexically — what the reference relies on).
function tsAfter(a, b) {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da > db;
  return String(a) > String(b);
}

// All assistant entries strictly after timestamp ts. ts == null/undefined -> all
// assistant entries.
function assistantEntriesAfter(entries, ts) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e) => e && e.type === "assistant" && (ts == null || tsAfter(e.timestamp, ts))
  );
}

// True for API-error entries (carry isApiErrorMessage === true).
function isApiErrorEntry(entry) {
  return !!(entry && entry.isApiErrorMessage === true);
}

// The last non-empty top-level gitBranch across entries, or "".
function gitBranchOf(entries) {
  if (!Array.isArray(entries)) return "";
  let branch = "";
  for (const e of entries) {
    if (e && typeof e.gitBranch === "string" && e.gitBranch !== "") {
      branch = e.gitBranch;
    }
  }
  return branch;
}

module.exports = {
  read,
  parseLines,
  contentOf,
  textOf,
  toolUsesOf,
  isUserTextEntry,
  lastUserTimestamp,
  assistantEntriesAfter,
  isApiErrorEntry,
  gitBranchOf,
};

```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/transcript.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/transcript.js plugins/notify/scripts/lib/transcript.test.js
git commit -m "feat(notify): lib/transcript.js"
```

> Author notes: Verified: 37/37 subtests pass on Node v20.20.2 (engine target >=18) via `node --test`; confirmed red state (Cannot find module './transcript') when the impl is absent. No time-dependent functions in this module, so no nowSec param is needed (none in the contract). Decisions/edge cases worth flagging for downstream module authors: - contentOf normalizes the "no message" case to `undefined` (not null) to match the contract type string|object[]|undefined, even though `entry.message && entry.message.content` would yield null for a null entry. - textOf only joins blocks with type==="text" and coerc

---

### Task 2: `lib/config.js`

**Files:**
- Create: `plugins/notify/scripts/lib/config.js`
- Test: `plugins/notify/scripts/lib/config.test.js`

Exports: `DEFAULTS`, `defaultConfig`, `expandEnv`, `load`, `statusEnabled`, `soundFor`, `titleFor`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/config.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("./config");

// --- helpers --------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-notify-cfg-"));
}

function writeConfig(obj) {
  const dir = tmpDir();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
}

// nonexistent path inside a fresh temp dir
function missingConfigPath() {
  return path.join(tmpDir(), "does-not-exist.json");
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = "";
  process.stderr.write = function (chunk) {
    out += String(chunk);
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: out };
  } finally {
    process.stderr.write = orig;
  }
}

// --- DEFAULTS shape -------------------------------------------------------

test("DEFAULTS has the exact top-level flags and cooldowns", () => {
  assert.equal(config.DEFAULTS.suppressQuestionAfterTaskCompleteSeconds, 12);
  assert.equal(config.DEFAULTS.suppressQuestionAfterAnyNotificationSeconds, 7);
  assert.equal(config.DEFAULTS.notifyOnSubagentStop, false);
  assert.equal(config.DEFAULTS.suppressForSubagents, true);
  assert.equal(config.DEFAULTS.notifyOnTextResponse, true);
  assert.equal(config.DEFAULTS.respectJudgeMode, true);
  assert.deepEqual(config.DEFAULTS.suppressFilters, []);
});

test("DEFAULTS.desktop matches spec", () => {
  assert.deepEqual(config.DEFAULTS.desktop, {
    enabled: true,
    sound: true,
    terminalBell: true,
    volume: 1.0,
    appIcon: "",
    clickToFocus: true,
  });
});

test("DEFAULTS.statuses has all 7 statuses with titles and placeholder sounds", () => {
  const keys = Object.keys(config.DEFAULTS.statuses).sort();
  assert.deepEqual(keys, [
    "api_error",
    "api_error_overloaded",
    "plan_ready",
    "question",
    "review_complete",
    "session_limit_reached",
    "task_complete",
  ]);
  assert.equal(config.DEFAULTS.statuses.task_complete.title, "✅ Completed");
  assert.equal(config.DEFAULTS.statuses.review_complete.title, "🔍 Review");
  assert.equal(config.DEFAULTS.statuses.question.title, "❓ Question");
  assert.equal(config.DEFAULTS.statuses.plan_ready.title, "📋 Plan");
  assert.equal(
    config.DEFAULTS.statuses.session_limit_reached.title,
    "⏱️ Session Limit Reached"
  );
  assert.equal(config.DEFAULTS.statuses.api_error.title, "🔴 API Error: 401");
  assert.equal(config.DEFAULTS.statuses.api_error_overloaded.title, "🔴 API Error");

  assert.equal(
    config.DEFAULTS.statuses.task_complete.sound,
    "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav"
  );
  assert.equal(
    config.DEFAULTS.statuses.review_complete.sound,
    "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav"
  );
  assert.equal(
    config.DEFAULTS.statuses.question.sound,
    "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav"
  );
  for (const k of Object.keys(config.DEFAULTS.statuses)) {
    assert.equal(config.DEFAULTS.statuses[k].enabled, true);
  }
});

// --- defaultConfig clone --------------------------------------------------

test("defaultConfig returns an independent deep clone", () => {
  const a = config.defaultConfig();
  a.desktop.volume = 0;
  a.statuses.task_complete.title = "MUTATED";
  a.suppressFilters.push({ status: "question" });

  const b = config.defaultConfig();
  assert.equal(b.desktop.volume, 1.0);
  assert.equal(b.statuses.task_complete.title, "✅ Completed");
  assert.deepEqual(b.suppressFilters, []);

  // DEFAULTS itself untouched
  assert.equal(config.DEFAULTS.desktop.volume, 1.0);
  assert.equal(config.DEFAULTS.statuses.task_complete.title, "✅ Completed");
});

// --- expandEnv ------------------------------------------------------------

test("expandEnv replaces ${NAME} from injected env", () => {
  assert.equal(config.expandEnv("a${X}b", { X: "Y" }), "aYb");
  assert.equal(config.expandEnv("${A}-${B}", { A: "1", B: "2" }), "1-2");
});

test("expandEnv tolerates inner whitespace ${ NAME }", () => {
  assert.equal(config.expandEnv("a${ X }b", { X: "Y" }), "aYb");
  assert.equal(config.expandEnv("${  CLAUDE_PLUGIN_ROOT  }/s", { CLAUDE_PLUGIN_ROOT: "/r" }), "/r/s");
});

test("expandEnv maps unknown vars to empty string", () => {
  assert.equal(config.expandEnv("${MISSING}", {}), "");
  assert.equal(config.expandEnv("x${MISSING}y", { OTHER: "z" }), "xy");
});

test("expandEnv passes through strings with no placeholders", () => {
  assert.equal(config.expandEnv("no vars here", { X: "Y" }), "no vars here");
});

test("expandEnv coerces non-string input to empty string", () => {
  assert.equal(config.expandEnv(123, {}), "");
  assert.equal(config.expandEnv(null, {}), "");
  assert.equal(config.expandEnv(undefined, {}), "");
});

// --- load: no file --------------------------------------------------------

test("load with missing file returns defaults (no warning)", () => {
  const { result, stderr } = captureStderr(() =>
    config.load({ configPath: missingConfigPath(), pluginRoot: "/plug", env: {} })
  );
  assert.equal(stderr, "");
  assert.equal(result.notifyOnTextResponse, true);
  assert.equal(result.desktop.enabled, true);
  assert.equal(result.suppressQuestionAfterAnyNotificationSeconds, 7);
});

test("load expands ${CLAUDE_PLUGIN_ROOT} in status sounds via pluginRoot", () => {
  const cfg = config.load({
    configPath: missingConfigPath(),
    pluginRoot: "/opt/plug",
    env: {},
  });
  assert.equal(config.soundFor(cfg, "task_complete"), "/opt/plug/sounds/complete.wav");
  assert.equal(config.soundFor(cfg, "question"), "/opt/plug/sounds/notification.wav");
  // DEFAULTS placeholder remains untouched after a load
  assert.equal(
    config.DEFAULTS.statuses.task_complete.sound,
    "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav"
  );
});

test("load falls back to env CLAUDE_PLUGIN_ROOT when no pluginRoot opt", () => {
  const cfg = config.load({
    configPath: missingConfigPath(),
    env: { CLAUDE_PLUGIN_ROOT: "/envroot" },
  });
  assert.equal(config.soundFor(cfg, "task_complete"), "/envroot/sounds/complete.wav");
});

test("pluginRoot opt overrides env CLAUDE_PLUGIN_ROOT", () => {
  const cfg = config.load({
    configPath: missingConfigPath(),
    pluginRoot: "/from-opt",
    env: { CLAUDE_PLUGIN_ROOT: "/from-env" },
  });
  assert.equal(config.soundFor(cfg, "task_complete"), "/from-opt/sounds/complete.wav");
});

test("load with unknown plugin root leaves sound path with empty prefix", () => {
  const cfg = config.load({ configPath: missingConfigPath(), env: {} });
  assert.equal(config.soundFor(cfg, "task_complete"), "/sounds/complete.wav");
});

// --- load: partial merge --------------------------------------------------

test("load deep-merges partial user config over defaults", () => {
  const p = writeConfig({
    desktop: { volume: 0.5, terminalBell: false },
    notifyOnTextResponse: false,
    statuses: { task_complete: { enabled: false } },
    suppressFilters: [{ status: "question" }],
  });
  const cfg = config.load({ configPath: p, pluginRoot: "/r", env: {} });

  // overridden
  assert.equal(cfg.desktop.volume, 0.5);
  assert.equal(cfg.desktop.terminalBell, false);
  assert.equal(cfg.notifyOnTextResponse, false);
  assert.equal(cfg.statuses.task_complete.enabled, false);
  assert.deepEqual(cfg.suppressFilters, [{ status: "question" }]);

  // preserved defaults
  assert.equal(cfg.desktop.enabled, true);
  assert.equal(cfg.desktop.clickToFocus, true);
  assert.equal(cfg.desktop.sound, true);
  assert.equal(cfg.suppressForSubagents, true);
  assert.equal(cfg.suppressQuestionAfterTaskCompleteSeconds, 12);

  // partial status merge keeps sibling fields + still env-expands the sound
  assert.equal(cfg.statuses.task_complete.title, "✅ Completed");
  assert.equal(config.soundFor(cfg, "task_complete"), "/r/sounds/complete.wav");
  // untouched statuses keep defaults
  assert.equal(cfg.statuses.question.enabled, true);
  assert.equal(cfg.statuses.question.title, "❓ Question");
});

test("load expands ${env} inside desktop.appIcon", () => {
  const p = writeConfig({ desktop: { appIcon: "${ICONDIR}/icon.png" } });
  const cfg = config.load({ configPath: p, env: { ICONDIR: "/imgs" } });
  assert.equal(cfg.desktop.appIcon, "/imgs/icon.png");
});

test("load ignores a non-object user config (array) and keeps defaults", () => {
  const p = writeConfig([1, 2, 3]);
  const cfg = config.load({ configPath: p, pluginRoot: "/r", env: {} });
  assert.equal(cfg.notifyOnTextResponse, true);
  assert.equal(config.soundFor(cfg, "question"), "/r/sounds/notification.wav");
});

// --- load: clamping -------------------------------------------------------

test("load clamps volume above 1 to 1", () => {
  const p = writeConfig({ desktop: { volume: 5 } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.desktop.volume, 1);
});

test("load clamps volume below 0 to 0", () => {
  const p = writeConfig({ desktop: { volume: -2 } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.desktop.volume, 0);
});

test("load resets non-numeric volume to default", () => {
  const p = writeConfig({ desktop: { volume: "loud" } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.desktop.volume, 1.0);
});

test("load clamps negative cooldowns to 0", () => {
  const p = writeConfig({
    suppressQuestionAfterAnyNotificationSeconds: -3,
    suppressQuestionAfterTaskCompleteSeconds: -1,
  });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.suppressQuestionAfterAnyNotificationSeconds, 0);
  assert.equal(cfg.suppressQuestionAfterTaskCompleteSeconds, 0);
});

test("load keeps valid in-range volume and cooldowns", () => {
  const p = writeConfig({
    desktop: { volume: 0.25 },
    suppressQuestionAfterAnyNotificationSeconds: 3,
  });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.desktop.volume, 0.25);
  assert.equal(cfg.suppressQuestionAfterAnyNotificationSeconds, 3);
});

// --- load: invalid JSON fallback -----------------------------------------

test("load on invalid JSON warns to stderr and falls back to defaults", () => {
  const p = writeConfig("{ this is not valid json ");
  const { result, stderr } = captureStderr(() =>
    config.load({ configPath: p, pluginRoot: "/r", env: {} })
  );
  assert.match(stderr, /config load failed/);
  // clean defaults restored
  assert.equal(result.notifyOnTextResponse, true);
  assert.equal(result.desktop.volume, 1.0);
  assert.deepEqual(result.suppressFilters, []);
  // still env-expanded
  assert.equal(config.soundFor(result, "task_complete"), "/r/sounds/complete.wav");
});

test("load never throws on a garbled file", () => {
  const p = writeConfig("  not json at all");
  assert.doesNotThrow(() =>
    config.load({ configPath: p, env: {} })
  );
});

// --- statusEnabled --------------------------------------------------------

test("statusEnabled true by default", () => {
  const cfg = config.load({ configPath: missingConfigPath(), env: {} });
  assert.equal(config.statusEnabled(cfg, "task_complete"), true);
  assert.equal(config.statusEnabled(cfg, "question"), true);
});

test("statusEnabled false when desktop disabled entirely", () => {
  const p = writeConfig({ desktop: { enabled: false } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(config.statusEnabled(cfg, "task_complete"), false);
  assert.equal(config.statusEnabled(cfg, "question"), false);
});

test("statusEnabled false when the status itself is disabled", () => {
  const p = writeConfig({ statuses: { task_complete: { enabled: false } } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(config.statusEnabled(cfg, "task_complete"), false);
  // sibling status unaffected
  assert.equal(config.statusEnabled(cfg, "question"), true);
});

test("statusEnabled false when per-status desktop.enabled is false", () => {
  const p = writeConfig({ statuses: { question: { desktop: { enabled: false } } } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(config.statusEnabled(cfg, "question"), false);
  assert.equal(config.statusEnabled(cfg, "task_complete"), true);
});

test("statusEnabled true when per-status desktop present with enabled true", () => {
  const p = writeConfig({ statuses: { question: { desktop: { enabled: true } } } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(config.statusEnabled(cfg, "question"), true);
});

test("statusEnabled tolerates an unknown status without throwing", () => {
  const cfg = config.load({ configPath: missingConfigPath(), env: {} });
  assert.doesNotThrow(() => config.statusEnabled(cfg, "nonexistent"));
});

// --- soundFor / titleFor --------------------------------------------------

test("soundFor and titleFor return resolved values", () => {
  const cfg = config.load({ configPath: missingConfigPath(), pluginRoot: "/r", env: {} });
  assert.equal(config.titleFor(cfg, "plan_ready"), "📋 Plan");
  assert.equal(config.soundFor(cfg, "plan_ready"), "/r/sounds/notification.wav");
});

test("soundFor and titleFor return empty string for unknown status", () => {
  const cfg = config.load({ configPath: missingConfigPath(), env: {} });
  assert.equal(config.soundFor(cfg, "nonexistent"), "");
  assert.equal(config.titleFor(cfg, "nonexistent"), "");
});

test("soundFor and titleFor tolerate empty/garbage config object", () => {
  assert.equal(config.soundFor({}, "task_complete"), "");
  assert.equal(config.titleFor({}, "task_complete"), "");
  assert.equal(config.soundFor(null, "task_complete"), "");
});
```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/config.test.js`  
Expected: Before lib/config.js exists, requiring "./config" throws MODULE_NOT_FOUND, so node:test fails to load the test file and reports: "# Error: Cannot find module './config'" with "# fail 1" (every assertion is unreached). Once the module is implemented, all 33 tests pass (verified: "# pass 33 / # fail 0").

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/config.js`

<details><summary>impl source (paste verbatim)</summary>

```js
// config.js — load + merge config, defaults, ${env} expansion, per-status resolution.
// Pure Node, zero external deps. Fail-open: never throw out of load().

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Full default config — see design spec "Config" section. Status sounds use the
// ${CLAUDE_PLUGIN_ROOT} placeholder, expanded by load() at runtime.
const DEFAULTS = {
  desktop: {
    enabled: true,
    sound: true,
    terminalBell: true,
    volume: 1.0, // 0.0–1.0, best-effort
    appIcon: "", // optional path, ${env} expanded
    clickToFocus: true,
  },
  suppressQuestionAfterTaskCompleteSeconds: 12,
  suppressQuestionAfterAnyNotificationSeconds: 7,
  notifyOnSubagentStop: false,
  suppressForSubagents: true,
  notifyOnTextResponse: true,
  respectJudgeMode: true,
  suppressFilters: [],
  statuses: {
    task_complete: {
      enabled: true,
      title: "✅ Completed",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav",
    },
    review_complete: {
      enabled: true,
      title: "🔍 Review",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav",
    },
    question: {
      enabled: true,
      title: "❓ Question",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
    plan_ready: {
      enabled: true,
      title: "📋 Plan",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
    session_limit_reached: {
      enabled: true,
      title: "⏱️ Session Limit Reached",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
    api_error: {
      enabled: true,
      title: "🔴 API Error: 401",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
    api_error_overloaded: {
      enabled: true,
      title: "🔴 API Error",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
  },
};

const COOLDOWN_KEYS = [
  "suppressQuestionAfterTaskCompleteSeconds",
  "suppressQuestionAfterAnyNotificationSeconds",
];

function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// JSON-based deep clone — DEFAULTS / user config are pure JSON values.
function cloneJSON(x) {
  if (x === undefined) return undefined;
  return JSON.parse(JSON.stringify(x));
}

function defaultConfig() {
  return cloneJSON(DEFAULTS);
}

function defaultConfigPath() {
  return path.join(os.homedir(), ".claude", "claude-notify", "config.json");
}

// Deep-merge `patch` over `base`. Plain objects merge recursively; arrays and
// primitives from patch replace base (cloned, so no reference sharing). A
// non-object patch is ignored (returns a clone of base) — fail-open.
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return cloneJSON(base);
  const out = isPlainObject(base) ? Object.assign({}, base) : {};
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = out[key];
    if (isPlainObject(pv) && isPlainObject(bv)) {
      out[key] = deepMerge(bv, pv);
    } else if (isPlainObject(pv)) {
      out[key] = deepMerge({}, pv);
    } else if (Array.isArray(pv)) {
      out[key] = cloneJSON(pv);
    } else {
      out[key] = pv;
    }
  }
  return out;
}

// Replace ${NAME} and ${ NAME } using `env` (default process.env). Unknown -> "".
function expandEnv(str, env) {
  if (typeof str !== "string") return "";
  const source = env || process.env;
  return str.replace(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (_m, name) => {
    const val = source[name];
    return val == null ? "" : String(val);
  });
}

function applyEnvExpansion(config, env) {
  if (config && config.desktop && typeof config.desktop.appIcon === "string") {
    config.desktop.appIcon = expandEnv(config.desktop.appIcon, env);
  }
  if (config && isPlainObject(config.statuses)) {
    for (const key of Object.keys(config.statuses)) {
      const s = config.statuses[key];
      if (s && typeof s.sound === "string") {
        s.sound = expandEnv(s.sound, env);
      }
    }
  }
}

function clampConfig(config) {
  const d = config.desktop || (config.desktop = {});
  let v = d.volume;
  if (typeof v !== "number" || !isFinite(v)) v = DEFAULTS.desktop.volume;
  else v = Math.max(0, Math.min(1, v));
  d.volume = v;

  for (const key of COOLDOWN_KEYS) {
    let c = config[key];
    if (typeof c !== "number" || !isFinite(c)) c = DEFAULTS[key];
    else if (c < 0) c = 0;
    config[key] = c;
  }
}

// load({configPath?, pluginRoot?, env?}) — read user config, deep-merge over
// defaults, expand env (CLAUDE_PLUGIN_ROOT injected from pluginRoot), clamp.
// Never throws: a bad/garbled file warns to stderr and falls back to defaults.
function load(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const configPath = opts.configPath || defaultConfigPath();

  const expandSource = Object.assign({}, env);
  if (opts.pluginRoot != null) {
    expandSource.CLAUDE_PLUGIN_ROOT = String(opts.pluginRoot);
  }

  let config;
  try {
    config = defaultConfig();
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const user = JSON.parse(raw);
      config = deepMerge(config, user);
    }
  } catch (err) {
    process.stderr.write(
      "[claude-notify] config load failed (" +
        configPath +
        "): " +
        (err && err.message) +
        "; using defaults\n"
    );
    config = defaultConfig();
  }

  try {
    applyEnvExpansion(config, expandSource);
    clampConfig(config);
  } catch (_err) {
    config = defaultConfig();
    applyEnvExpansion(config, expandSource);
    clampConfig(config);
  }

  return config;
}

function statusEnabled(config, status) {
  const c = config || {};
  const desktop = c.desktop || {};
  const statuses = c.statuses || {};
  const s = statuses[status] || {};
  const desktopOn = !!desktop.enabled;
  const statusOn = s.enabled !== false;
  const perStatusDesktopOn = s.desktop ? s.desktop.enabled !== false : true;
  return desktopOn && statusOn && perStatusDesktopOn;
}

function soundFor(config, status) {
  const statuses = (config && config.statuses) || {};
  const s = statuses[status];
  return (s && s.sound) || "";
}

function titleFor(config, status) {
  const statuses = (config && config.statuses) || {};
  const s = statuses[status];
  return (s && s.title) || "";
}

module.exports = {
  DEFAULTS,
  defaultConfig,
  expandEnv,
  load,
  statusEnabled,
  soundFor,
  titleFor,
};
```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/config.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/config.js plugins/notify/scripts/lib/config.test.js
git commit -m "feat(notify): lib/config.js"
```

> Author notes: Files written and verified at: - /home/sokhi/projects/claude-notify/plugins/notify/scripts/lib/config.js - /home/sokhi/projects/claude-notify/plugins/notify/scripts/lib/config.test.js 33 tests pass on Node v20.20.2. Zero deps; only node:fs/os/path + node:test/assert. Behavior decisions (all within the interface contract): - DEFAULTS is the single source of truth; defaultConfig() returns a JSON deep clone so callers (and load) cannot mutate DEFAULTS. Verified DEFAULTS placeholders survive a load(). - deepMerge: plain objects merge recursively; arrays (suppressFilters) and primitives REPLACE (no

---

### Task 3: `lib/session-label.js`

**Files:**
- Create: `plugins/notify/scripts/lib/session-label.js`
- Test: `plugins/notify/scripts/lib/session-label.test.js`

Exports: `label`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/session-label.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { label } = require("./session-label");

const LABEL_RE = /^[a-z]+-[a-z]+$/;

test("falsy ids collapse to the fixed sentinel 'session'", () => {
  assert.equal(label(""), "session");
  assert.equal(label(undefined), "session");
  assert.equal(label(null), "session");
  assert.equal(label(0), "session");
  assert.equal(label(false), "session");
  assert.equal(label(NaN), "session");
});

test("a normal id yields a two-word adjective-animal label", () => {
  const out = label("abc123");
  assert.match(out, LABEL_RE);
  const parts = out.split("-");
  assert.equal(parts.length, 2);
  assert.ok(parts[0].length > 0);
  assert.ok(parts[1].length > 0);
});

test("golden values lock determinism across runs (regression)", () => {
  // Pinned outputs of the documented sha256 + wordlist scheme. If the lists or
  // hashing change, these break on purpose (labels must stay stable per id).
  assert.equal(label("abc123"), "lucky-tiger");
  assert.equal(label("session-001"), "silver-koala");
  assert.equal(label("9f8e7d6c-1234-4abc-9def-0011223344556"), "shiny-hare");
  assert.equal(label("x"), "snappy-jackal");
  assert.equal(label("another-session-id"), "crisp-quokka");
});

test("same id always produces the same label (pure, no randomness)", () => {
  const id = "deadbeef-cafe-1234";
  const first = label(id);
  for (let i = 0; i < 50; i++) {
    assert.equal(label(id), first);
  }
});

test("non-string truthy ids are coerced deterministically", () => {
  assert.equal(label(12345), label("12345"));
  assert.equal(typeof label(12345), "string");
  assert.match(label(98765), LABEL_RE);
});

test("different ids almost always produce different labels", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(label("id-" + i));
  // High-entropy hash over a large product space -> mostly distinct.
  assert.ok(seen.size > 700, "expected many distinct labels, got " + seen.size);
});

test("two specific distinct ids differ", () => {
  assert.notEqual(label("alpha"), label("omega"));
});

test("hashing scheme is reproducible (sha256 is available & stable)", () => {
  // Independently confirm the underlying primitive the impl relies on, and that
  // the label re-derives identically for the same id.
  const id = "verify-the-scheme";
  const digest = crypto.createHash("sha256").update(id).digest();
  const out = label(id);
  const parts = out.split("-");
  const adjIdx = digest.readUInt32BE(0);
  const aniIdx = digest.readUInt32BE(4);
  assert.equal(label(id), out);
  assert.equal(parts.length, 2);
  assert.ok(Number.isInteger(adjIdx) && Number.isInteger(aniIdx));
});
```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/session-label.test.js`  
Expected: Before plugins/notify/scripts/lib/session-label.js exists, `require("./session-label")` throws and node:test reports it as a load-time failure: "# Error: Cannot find module './session-label'", failureType 'testCodeFailure', code 'ERR_TEST_FAILURE', "# fail 1". All assertions are blocked (red). Once the module is created, the suite goes green (8 passing tests). Verified both states against a prototype copy.

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/session-label.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

// session-label.js
// Deterministic session_id -> short, stable, human-friendly "adjective-animal"
// label, shown in the notification title bracket (e.g. "blue-otter").
//
// Pure & stable: no randomness, no I/O. Same id always yields the same label
// (across calls AND across process restarts, since sha256 is fixed). Falsy id
// collapses to the sentinel "session".
//
// Zero external deps; only the `crypto` node builtin.

const crypto = require("crypto");

// Fixed wordlists. Order is part of the contract: changing/reordering these
// changes everyone's label, so treat them as append-only if ever extended.
const ADJECTIVES = [
  "amber", "azure", "blue", "bold", "brave", "bright", "calm", "clever",
  "cosmic", "crimson", "crisp", "daring", "eager", "electric", "fancy",
  "gentle", "golden", "happy", "hidden", "jolly", "keen", "lively",
  "lucky", "mellow", "mighty", "nimble", "noble", "polar", "quiet",
  "rapid", "royal", "rustic", "shiny", "silent", "silver", "smooth",
  "snappy", "solar", "spry", "stellar", "sunny", "swift", "teal",
  "tidy", "vivid", "warm", "wild", "witty", "zany", "zesty"
];

const ANIMALS = [
  "otter", "falcon", "panda", "tiger", "lynx", "heron", "koala", "moose",
  "raven", "gecko", "ibex", "marten", "newt", "ocelot", "puffin", "quokka",
  "robin", "seal", "stork", "toad", "urchin", "viper", "walrus", "yak",
  "zebra", "badger", "beaver", "bison", "cobra", "crane", "dingo", "egret",
  "ferret", "fox", "hare", "hawk", "jackal", "jaguar", "kestrel", "lemur",
  "manta", "narwhal", "osprey", "possum", "rabbit", "shark", "swan", "wombat"
];

// label(sessionId) -> "adjective-animal", or "session" for any falsy id.
function label(sessionId) {
  if (!sessionId) return "session";
  const id = String(sessionId);
  const digest = crypto.createHash("sha256").update(id).digest();
  // Two independent big-endian uint32 slices of the digest index each list.
  const adj = ADJECTIVES[digest.readUInt32BE(0) % ADJECTIVES.length];
  const animal = ANIMALS[digest.readUInt32BE(4) % ANIMALS.length];
  return adj + "-" + animal;
}

module.exports = { label };
```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/session-label.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/session-label.js plugins/notify/scripts/lib/session-label.test.js
git commit -m "feat(notify): lib/session-label.js"
```

> Author notes: - Contract match: exports exactly { label }. label(sessionId): string. No extra exports (ADJECTIVES/ANIMALS kept module-private to match the contract's single-export surface). - Algorithm: sha256(String(id)) digest; adjective = list[readUInt32BE(0) % 50], animal = list[readUInt32BE(4) % 48]. Result is "adjective-animal". - Wordlists: 50 adjectives, 48 animals, all unique (verified). Product space = 2400 labels. - Falsy handling: `if (!sessionId) return "session"` covers "" / undefined / null / 0 / false / NaN. Truthy non-strings (e.g. numbers) are coerced via String(), so label(12345) === labe

---

### Task 4: `lib/state.js`

**Files:**
- Create: `plugins/notify/scripts/lib/state.js`
- Test: `plugins/notify/scripts/lib/state.test.js`

Exports: `statePath`, `read`, `write`, `gc`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/state.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = require("./state");

function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-state-test-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_e) {}
  });
  return dir;
}

// ---- statePath -----------------------------------------------------------

test("statePath builds <tmpDir>/claude-notify-state-<id>.json", () => {
  assert.equal(
    state.statePath("abc", "/tmp/x"),
    path.join("/tmp/x", "claude-notify-state-abc.json")
  );
});

test("statePath defaults to os.tmpdir()", () => {
  assert.equal(
    state.statePath("abc"),
    path.join(os.tmpdir(), "claude-notify-state-abc.json")
  );
});

// ---- read ----------------------------------------------------------------

test("read returns {} when the file is missing", (t) => {
  const dir = freshDir(t);
  assert.deepEqual(state.read("nope", { tmpDir: dir }), {});
});

test("read returns {} on malformed JSON", (t) => {
  const dir = freshDir(t);
  fs.writeFileSync(state.statePath("bad", dir), "{not json");
  assert.deepEqual(state.read("bad", { tmpDir: dir }), {});
});

test("read returns the parsed object for valid state", (t) => {
  const dir = freshDir(t);
  const obj = { session_id: "s1", last_ts: 5, focus_hint: { type: "tmux" } };
  fs.writeFileSync(state.statePath("s1", dir), JSON.stringify(obj));
  assert.deepEqual(state.read("s1", { tmpDir: dir }), obj);
});

test("read returns {} when JSON parses to a non-object", (t) => {
  const dir = freshDir(t);
  fs.writeFileSync(state.statePath("arr", dir), "[1,2,3]");
  assert.deepEqual(state.read("arr", { tmpDir: dir }), {});
  fs.writeFileSync(state.statePath("num", dir), "42");
  assert.deepEqual(state.read("num", { tmpDir: dir }), {});
  fs.writeFileSync(state.statePath("nul", dir), "null");
  assert.deepEqual(state.read("nul", { tmpDir: dir }), {});
});

test("read with default opts returns {} for an unknown session", () => {
  const id = "cn-state-unknown-" + Math.random().toString(36).slice(2);
  assert.deepEqual(state.read(id), {});
});

// ---- write ---------------------------------------------------------------

test("write creates a file that read can parse back", (t) => {
  const dir = freshDir(t);
  state.write("w1", { last_notification_status: "task_complete" }, { tmpDir: dir });
  assert.equal(fs.existsSync(state.statePath("w1", dir)), true);
  assert.deepEqual(state.read("w1", { tmpDir: dir }), {
    last_notification_status: "task_complete",
  });
});

test("write shallow-merges, preserving prior unrelated fields", (t) => {
  const dir = freshDir(t);
  state.write("m1", { session_id: "m1", last_ts: 100 }, { tmpDir: dir });
  state.write("m1", { last_notification_ts: 200 }, { tmpDir: dir });
  assert.deepEqual(state.read("m1", { tmpDir: dir }), {
    session_id: "m1",
    last_ts: 100,
    last_notification_ts: 200,
  });
});

test("write overwrites an existing key with the patch value", (t) => {
  const dir = freshDir(t);
  state.write("o1", { last_ts: 1 }, { tmpDir: dir });
  state.write("o1", { last_ts: 2 }, { tmpDir: dir });
  assert.equal(state.read("o1", { tmpDir: dir }).last_ts, 2);
});

test("write round-trips integer timestamps", (t) => {
  const dir = freshDir(t);
  state.write("t1", { last_task_complete_ts: 1717000000 }, { tmpDir: dir });
  const got = state.read("t1", { tmpDir: dir });
  assert.equal(got.last_task_complete_ts, 1717000000);
  assert.equal(Number.isInteger(got.last_task_complete_ts), true);
});

test("write preserves a nested focus_hint object across merges", (t) => {
  const dir = freshDir(t);
  state.write("f1", { focus_hint: { bundleId: "com.apple.Terminal" } }, { tmpDir: dir });
  state.write("f1", { last_ts: 9 }, { tmpDir: dir });
  const got = state.read("f1", { tmpDir: dir });
  assert.deepEqual(got.focus_hint, { bundleId: "com.apple.Terminal" });
  assert.equal(got.last_ts, 9);
});

test("write never throws when tmpDir does not exist", () => {
  const bogus = path.join(
    os.tmpdir(),
    "cn-state-nope-" + Math.random().toString(36).slice(2)
  );
  assert.doesNotThrow(() => state.write("x", { a: 1 }, { tmpDir: bogus }));
  assert.deepEqual(state.read("x", { tmpDir: bogus }), {});
});

test("write tolerates a null/undefined patch", (t) => {
  const dir = freshDir(t);
  state.write("p1", { a: 1 }, { tmpDir: dir });
  assert.doesNotThrow(() => state.write("p1", null, { tmpDir: dir }));
  assert.doesNotThrow(() => state.write("p1", undefined, { tmpDir: dir }));
  assert.deepEqual(state.read("p1", { tmpDir: dir }), { a: 1 });
});

test("write/read default to os.tmpdir() when no tmpDir given", (t) => {
  const id = "cn-state-default-" + Math.random().toString(36).slice(2);
  t.after(() => {
    try {
      fs.unlinkSync(state.statePath(id));
    } catch (_e) {}
  });
  state.write(id, { last_ts: 7 });
  assert.deepEqual(state.read(id), { last_ts: 7 });
});

// ---- gc ------------------------------------------------------------------

test("gc deletes state files older than maxAgeSec and keeps fresh ones", (t) => {
  const dir = freshDir(t);
  const now = 1000000;
  state.write("old", { a: 1 }, { tmpDir: dir });
  state.write("fresh", { a: 1 }, { tmpDir: dir });
  fs.utimesSync(state.statePath("old", dir), now - 120, now - 120);
  fs.utimesSync(state.statePath("fresh", dir), now - 5, now - 5);
  state.gc({ tmpDir: dir, nowSec: now });
  assert.equal(fs.existsSync(state.statePath("old", dir)), false);
  assert.equal(fs.existsSync(state.statePath("fresh", dir)), true);
});

test("gc keeps a file exactly maxAgeSec old, deletes one second older", (t) => {
  const dir = freshDir(t);
  const now = 2000000;
  state.write("edge", { a: 1 }, { tmpDir: dir });
  fs.utimesSync(state.statePath("edge", dir), now - 60, now - 60);
  state.gc({ tmpDir: dir, nowSec: now });
  assert.equal(fs.existsSync(state.statePath("edge", dir)), true);
  fs.utimesSync(state.statePath("edge", dir), now - 61, now - 61);
  state.gc({ tmpDir: dir, nowSec: now });
  assert.equal(fs.existsSync(state.statePath("edge", dir)), false);
});

test("gc honors a custom maxAgeSec", (t) => {
  const dir = freshDir(t);
  const now = 3000000;
  state.write("c", { a: 1 }, { tmpDir: dir });
  fs.utimesSync(state.statePath("c", dir), now - 15, now - 15);
  state.gc({ tmpDir: dir, nowSec: now, maxAgeSec: 30 });
  assert.equal(fs.existsSync(state.statePath("c", dir)), true);
  state.gc({ tmpDir: dir, nowSec: now, maxAgeSec: 10 });
  assert.equal(fs.existsSync(state.statePath("c", dir)), false);
});

test("gc ignores files that are not state files", (t) => {
  const dir = freshDir(t);
  const now = 4000000;
  const lock = path.join(dir, "claude-notify-sess-content.lock");
  const other = path.join(dir, "unrelated.txt");
  fs.writeFileSync(lock, "");
  fs.writeFileSync(other, "");
  fs.utimesSync(lock, now - 9999, now - 9999);
  fs.utimesSync(other, now - 9999, now - 9999);
  state.gc({ tmpDir: dir, nowSec: now });
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(other), true);
});

test("gc never throws on a missing tmpDir", () => {
  const bogus = path.join(
    os.tmpdir(),
    "cn-state-gc-nope-" + Math.random().toString(36).slice(2)
  );
  assert.doesNotThrow(() => state.gc({ tmpDir: bogus, nowSec: 1 }));
});

test("gc default nowSec uses the current clock", (t) => {
  const dir = freshDir(t);
  state.write("agedefault", { a: 1 }, { tmpDir: dir });
  const farPast = Math.floor(Date.now() / 1000) - 10000;
  fs.utimesSync(state.statePath("agedefault", dir), farPast, farPast);
  state.gc({ tmpDir: dir });
  assert.equal(fs.existsSync(state.statePath("agedefault", dir)), false);
});

```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/state.test.js`  
Expected: Before lib/state.js exists, requiring it fails: the run prints `# Error: Cannot find module './state'` and `error: 'test failed'`, so every subtest errors out (exit code 1). Once the module is implemented, all 21 subtests pass (# pass 21 / # fail 0).

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/state.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

// Per-session notification state, stored as a single JSON file in a temp dir.
// Pure Node, zero deps. Every call is fail-open: reads default to {} and writes
// swallow errors so the hook pipeline never breaks because of state I/O.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PREFIX = "claude-notify-state-";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// <tmpDir>/claude-notify-state-<sessionId>.json
function statePath(sessionId, tmpDir = os.tmpdir()) {
  return path.join(tmpDir, `${PREFIX}${sessionId}.json`);
}

// Parse the session's state file. Returns {} on any miss/parse error, and also
// when the parsed JSON is not a plain object (arrays/scalars are not valid state).
function read(sessionId, opts = {}) {
  const tmpDir = opts.tmpDir || os.tmpdir();
  try {
    const raw = fs.readFileSync(statePath(sessionId, tmpDir), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch (_err) {
    return {};
  }
}

// Read-merge-write: shallow-merge `patch` over the existing state and persist.
// Unrelated fields are preserved. Never throws.
function write(sessionId, patch, opts = {}) {
  const tmpDir = opts.tmpDir || os.tmpdir();
  try {
    const existing = read(sessionId, { tmpDir });
    const merged = Object.assign({}, existing, patch || {});
    fs.writeFileSync(statePath(sessionId, tmpDir), JSON.stringify(merged), "utf8");
  } catch (_err) {
    // fail-open: state is best-effort
  }
}

// Opportunistically delete state files strictly older than maxAgeSec. Never throws.
function gc(opts = {}) {
  const tmpDir = opts.tmpDir || os.tmpdir();
  const now = typeof opts.nowSec === "number" ? opts.nowSec : nowSeconds();
  const maxAgeSec = typeof opts.maxAgeSec === "number" ? opts.maxAgeSec : 60;
  let names;
  try {
    names = fs.readdirSync(tmpDir);
  } catch (_err) {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const full = path.join(tmpDir, name);
    try {
      const st = fs.statSync(full);
      const mtimeSec = Math.floor(st.mtimeMs / 1000);
      if (now - mtimeSec > maxAgeSec) {
        fs.unlinkSync(full);
      }
    } catch (_err) {
      // ignore individual file errors
    }
  }
}

module.exports = { statePath, read, write, gc };

```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/state.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/state.js plugins/notify/scripts/lib/state.test.js
git commit -m "feat(notify): lib/state.js"
```

> Author notes: Validated: 21/21 subtests pass under Node v20 with `node --test`; red state confirmed (Cannot find module './state'). Decisions / edge cases: - statePath uses positional `tmpDir=os.tmpdir()` default (matches contract). read/write/gc take `opts={tmpDir,...}` and resolve `opts.tmpDir || os.tmpdir()`. - read returns {} on missing file, parse error, AND when parsed JSON is not a plain object (arrays/scalars/null). This is a deliberate guard beyond the literal "JSON.parse or {}" so that a corrupt array/scalar file cannot poison a later shallow-merge write. If the plan author wants the literal behav

---

### Task 5: `lib/dedup.js`

**Files:**
- Create: `plugins/notify/scripts/lib/dedup.js`
- Test: `plugins/notify/scripts/lib/dedup.test.js`

Exports: `lockPath`, `isRecentDuplicate`, `acquire`, `acquireContentLock`, `release`, `isDuplicateMessage`, `gc`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/dedup.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dedup = require("./dedup");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
}

test("lockPath builds <tmpDir>/claude-notify-<session>-<key>.lock", () => {
  assert.equal(
    dedup.lockPath("abc", "Stop", "/tmp/x"),
    path.join("/tmp/x", "claude-notify-abc-Stop.lock")
  );
  // default tmpDir is os.tmpdir()
  assert.equal(
    dedup.lockPath("s", "content"),
    path.join(os.tmpdir(), "claude-notify-s-content.lock")
  );
});

test("isRecentDuplicate: missing -> false, fresh -> true, stale/boundary -> false", (t) => {
  const dir = tmpDir("dedup-recent-");
  t.after(() => rmrf(dir));

  // no lock file
  assert.equal(
    dedup.isRecentDuplicate("nope", "Stop", { tmpDir: dir, nowSec: 1000 }),
    false
  );

  // create a lock and pin its mtime to epoch second 1000
  const p = dedup.lockPath("s2", "Stop", dir);
  fs.writeFileSync(p, "");
  fs.utimesSync(p, 1000, 1000);

  // fresh: now 1001, diff 1 < 2 -> true
  assert.equal(
    dedup.isRecentDuplicate("s2", "Stop", { tmpDir: dir, nowSec: 1001, ttlSec: 2 }),
    true
  );
  // boundary: now 1002, diff 2 is NOT < 2 -> false
  assert.equal(
    dedup.isRecentDuplicate("s2", "Stop", { tmpDir: dir, nowSec: 1002, ttlSec: 2 }),
    false
  );
  // stale: now 1003, diff 3 -> false
  assert.equal(
    dedup.isRecentDuplicate("s2", "Stop", { tmpDir: dir, nowSec: 1003, ttlSec: 2 }),
    false
  );
});

test("acquire: fresh -> true, immediate -> false, stale -> true (recreate)", (t) => {
  const dir = tmpDir("dedup-acq-");
  t.after(() => rmrf(dir));

  const sid = "sess1";
  const key = "Stop";
  const p = dedup.lockPath(sid, key, dir);

  // fresh acquire creates the file
  assert.equal(
    dedup.acquire(sid, key, { tmpDir: dir, nowSec: 1000, ttlSec: 2 }),
    true
  );
  assert.ok(fs.existsSync(p));

  // pin mtime for deterministic freshness math
  fs.utimesSync(p, 1000, 1000);

  // immediate (still fresh): now 1001, diff 1 < 2 -> false
  assert.equal(
    dedup.acquire(sid, key, { tmpDir: dir, nowSec: 1001, ttlSec: 2 }),
    false
  );
  // file must still exist (never released)
  assert.ok(fs.existsSync(p));

  // boundary: now 1002, diff 2 >= 2 -> stale -> recreate -> true
  fs.utimesSync(p, 1000, 1000);
  assert.equal(
    dedup.acquire(sid, key, { tmpDir: dir, nowSec: 1002, ttlSec: 2 }),
    true
  );
  assert.ok(fs.existsSync(p));

  // clearly stale: now 1003 vs mtime 1000 -> true
  fs.utimesSync(p, 1000, 1000);
  assert.equal(
    dedup.acquire(sid, key, { tmpDir: dir, nowSec: 1003, ttlSec: 2 }),
    true
  );
});

test("acquireContentLock: 5s ttl, releasable, re-acquirable after release", (t) => {
  const dir = tmpDir("dedup-content-");
  t.after(() => rmrf(dir));

  const sid = "s3";
  const cp = dedup.lockPath(sid, "content", dir);

  // fresh acquire of the content lock
  assert.equal(dedup.acquireContentLock(sid, { tmpDir: dir, nowSec: 2000 }), true);
  assert.ok(fs.existsSync(cp));
  fs.utimesSync(cp, 2000, 2000);

  // within 5s -> false (now 2004, diff 4 < 5)
  assert.equal(dedup.acquireContentLock(sid, { tmpDir: dir, nowSec: 2004 }), false);

  // releasable: release removes the lock
  dedup.release(sid, "content", { tmpDir: dir });
  assert.ok(!fs.existsSync(cp));

  // after release we can acquire again even within the old window
  assert.equal(dedup.acquireContentLock(sid, { tmpDir: dir, nowSec: 2004 }), true);

  // boundary staleness: diff 5 >= 5 -> recreate -> true
  fs.utimesSync(cp, 2000, 2000);
  assert.equal(dedup.acquireContentLock(sid, { tmpDir: dir, nowSec: 2005 }), true);
});

test("release ignores missing locks (never throws)", (t) => {
  const dir = tmpDir("dedup-rel-");
  t.after(() => rmrf(dir));
  assert.doesNotThrow(() =>
    dedup.release("ghost", "Stop", { tmpDir: dir })
  );
});

test("isDuplicateMessage: normalization (dot/case/whitespace) inside vs outside window", () => {
  const state = {
    last_notification_ts: 5000,
    last_notification_message: "Task complete.",
  };

  // trailing dot + case + surrounding whitespace, inside window -> true
  assert.equal(
    dedup.isDuplicateMessage(state, "  task complete  ", {
      nowSec: 5100,
      windowSec: 180,
    }),
    true
  );

  // same message but outside the window -> false
  assert.equal(
    dedup.isDuplicateMessage(state, "task complete", {
      nowSec: 5300,
      windowSec: 180,
    }),
    false
  );

  // boundary: now - ts == windowSec is NOT < window -> false
  assert.equal(
    dedup.isDuplicateMessage(state, "task complete", {
      nowSec: 5180,
      windowSec: 180,
    }),
    false
  );

  // different message inside window -> false
  assert.equal(
    dedup.isDuplicateMessage(state, "something else", { nowSec: 5100 }),
    false
  );

  // case-only difference -> true
  assert.equal(
    dedup.isDuplicateMessage(
      { last_notification_ts: 5000, last_notification_message: "HELLO World" },
      "hello world",
      { nowSec: 5001 }
    ),
    true
  );

  // multiple trailing dots stripped -> true
  assert.equal(
    dedup.isDuplicateMessage(
      { last_notification_ts: 5000, last_notification_message: "done..." },
      "Done",
      { nowSec: 5001 }
    ),
    true
  );

  // no last_notification_ts -> false (even if messages match)
  assert.equal(
    dedup.isDuplicateMessage({ last_notification_message: "x" }, "x", {
      nowSec: 5100,
    }),
    false
  );

  // null/undefined state -> false
  assert.equal(dedup.isDuplicateMessage(null, "x", { nowSec: 5100 }), false);
  assert.equal(dedup.isDuplicateMessage(undefined, "x", { nowSec: 5100 }), false);

  // missing last_notification_message normalizes to "" -> not equal to "x"
  assert.equal(
    dedup.isDuplicateMessage({ last_notification_ts: 5000 }, "x", {
      nowSec: 5001,
    }),
    false
  );

  // both empty -> equal -> true (within window)
  assert.equal(
    dedup.isDuplicateMessage(
      { last_notification_ts: 5000, last_notification_message: "" },
      "",
      { nowSec: 5001 }
    ),
    true
  );

  // default window (180) is applied when not supplied: diff 200 -> false
  assert.equal(
    dedup.isDuplicateMessage(state, "task complete", { nowSec: 5200 }),
    false
  );
});

test("gc: removes lock files older than maxAgeSec, keeps fresh + non-lock files", (t) => {
  const dir = tmpDir("dedup-gc-");
  t.after(() => rmrf(dir));

  const oldLock = path.join(dir, "claude-notify-old-Stop.lock");
  const freshLock = path.join(dir, "claude-notify-fresh-content.lock");
  const stateFile = path.join(dir, "claude-notify-state-x.json"); // not a .lock

  fs.writeFileSync(oldLock, "");
  fs.writeFileSync(freshLock, "");
  fs.writeFileSync(stateFile, "{}");

  fs.utimesSync(oldLock, 1000, 1000); // now 1100 -> age 100 > 60 -> remove
  fs.utimesSync(freshLock, 1080, 1080); // age 20 -> keep
  fs.utimesSync(stateFile, 1000, 1000); // old but not a .lock -> keep

  dedup.gc({ tmpDir: dir, nowSec: 1100, maxAgeSec: 60 });

  assert.ok(!fs.existsSync(oldLock), "old lock should be gc'd");
  assert.ok(fs.existsSync(freshLock), "fresh lock should remain");
  assert.ok(fs.existsSync(stateFile), "non-lock files untouched");

  // boundary: exactly maxAgeSec old is NOT > maxAgeSec -> kept
  const edgeLock = path.join(dir, "claude-notify-edge-Stop.lock");
  fs.writeFileSync(edgeLock, "");
  fs.utimesSync(edgeLock, 1040, 1040); // age exactly 60
  dedup.gc({ tmpDir: dir, nowSec: 1100, maxAgeSec: 60 });
  assert.ok(fs.existsSync(edgeLock), "age == maxAgeSec is kept");

  // gc on a nonexistent dir does not throw
  assert.doesNotThrow(() =>
    dedup.gc({ tmpDir: path.join(dir, "nope"), nowSec: 1100 })
  );
});

test("default nowSec clock path does not crash and behaves sanely", (t) => {
  const dir = tmpDir("dedup-clock-");
  t.after(() => rmrf(dir));
  // missing lock -> false using the real clock default
  assert.equal(dedup.isRecentDuplicate("c", "Stop", { tmpDir: dir }), false);
  // acquire with real clock creates a lock and returns true
  assert.equal(dedup.acquire("c", "Stop", { tmpDir: dir }), true);
  assert.ok(fs.existsSync(dedup.lockPath("c", "Stop", dir)));
  // immediate re-acquire with real clock -> false (fresh)
  assert.equal(dedup.acquire("c", "Stop", { tmpDir: dir }), false);
});

```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/dedup.test.js`  
Expected: Before dedup.js exists, the test run aborts at require("./dedup") with: "# Error: Cannot find module './dedup'" and "error: 'test failed'" (exit code 1, 0 tests pass). After implementing dedup.js all 8 subtests pass (verified locally: "# pass 8 / # fail 0").

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/dedup.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

// dedup.js — lock files in the temp dir for noise control.
//
// Three mechanisms:
//   - 2s throttle locks per (session, event): created with acquire(), NEVER
//     auto-released; they age out so rapid repeats are throttled.
//   - 5s releasable content lock (acquireContentLock + release) to serialize the
//     Stop-vs-Notification race before the dup-content check.
//   - 180s duplicate-message check against state.last_notification_message.
//
// Pure node, zero deps. Every time-dependent function takes an optional nowSec
// (unix seconds) for deterministic/injectable tests.

const fs = require("fs");
const os = require("os");
const path = require("path");

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function mtimeSecOf(p) {
  const st = fs.statSync(p);
  return Math.floor(st.mtimeMs / 1000);
}

// <tmpDir>/claude-notify-<sessionId>-<key>.lock
function lockPath(sessionId, key, tmpDir) {
  const dir = tmpDir || os.tmpdir();
  return path.join(dir, "claude-notify-" + sessionId + "-" + key + ".lock");
}

// true if the lock exists and (now - mtimeSec) < ttlSec, OR the lock exists but
// its mtime is unreadable. Missing lock -> false.
function isRecentDuplicate(sessionId, key, opts) {
  opts = opts || {};
  const tmpDir = opts.tmpDir || os.tmpdir();
  const nowSec = opts.nowSec != null ? opts.nowSec : nowSeconds();
  const ttlSec = opts.ttlSec != null ? opts.ttlSec : 2;
  const p = lockPath(sessionId, key, tmpDir);
  if (!fs.existsSync(p)) return false;
  let mtimeSec;
  try {
    mtimeSec = mtimeSecOf(p);
  } catch (e) {
    // exists but mtime unreadable -> treat as a recent duplicate
    return true;
  }
  return nowSec - mtimeSec < ttlSec;
}

// Atomic create via flag "wx".
//   - created fresh        -> true
//   - exists & fresh(<ttl) -> false (not acquired)
//   - exists & stale(>=ttl)-> unlink + recreate -> true
// The lock is intentionally never auto-released (it ages out).
function acquire(sessionId, key, opts) {
  opts = opts || {};
  const tmpDir = opts.tmpDir || os.tmpdir();
  const nowSec = opts.nowSec != null ? opts.nowSec : nowSeconds();
  const ttlSec = opts.ttlSec != null ? opts.ttlSec : 2;
  const p = lockPath(sessionId, key, tmpDir);

  try {
    fs.closeSync(fs.openSync(p, "wx"));
    return true; // created fresh
  } catch (e) {
    // Most likely EEXIST. Decide based on freshness.
  }

  let mtimeSec;
  try {
    mtimeSec = mtimeSecOf(p);
  } catch (e) {
    // exists but mtime unreadable -> be conservative, do not acquire
    return false;
  }

  if (nowSec - mtimeSec < ttlSec) {
    return false; // still fresh -> not acquired
  }

  // stale -> remove and recreate
  try {
    fs.unlinkSync(p);
  } catch (e) {
    /* ignore */
  }
  try {
    fs.closeSync(fs.openSync(p, "wx"));
    return true;
  } catch (e) {
    return false;
  }
}

// 5s content lock; same acquire semantics but meant to be released on exit.
function acquireContentLock(sessionId, opts) {
  const o = Object.assign({}, opts || {});
  if (o.ttlSec == null) o.ttlSec = 5;
  return acquire(sessionId, "content", o);
}

// Unlink the lock; ignore all errors.
function release(sessionId, key, opts) {
  opts = opts || {};
  const tmpDir = opts.tmpDir || os.tmpdir();
  try {
    fs.unlinkSync(lockPath(sessionId, key, tmpDir));
  } catch (e) {
    /* ignore */
  }
}

// normalize(s) = trim -> strip trailing "." -> toLowerCase
function normalizeMessage(s) {
  return String(s == null ? "" : s)
    .trim()
    .replace(/\.+$/, "")
    .toLowerCase();
}

// true if state has a last_notification_ts within windowSec and the normalized
// new message equals the normalized last_notification_message.
function isDuplicateMessage(state, message, opts) {
  opts = opts || {};
  const nowSec = opts.nowSec != null ? opts.nowSec : nowSeconds();
  const windowSec = opts.windowSec != null ? opts.windowSec : 180;
  if (!state || !state.last_notification_ts) return false;
  if (nowSec - state.last_notification_ts >= windowSec) return false;
  return (
    normalizeMessage(message) ===
    normalizeMessage(state.last_notification_message || "")
  );
}

// Remove claude-notify-*.lock files older than maxAgeSec (default 60s).
function gc(opts) {
  opts = opts || {};
  const tmpDir = opts.tmpDir || os.tmpdir();
  const nowSec = opts.nowSec != null ? opts.nowSec : nowSeconds();
  const maxAgeSec = opts.maxAgeSec != null ? opts.maxAgeSec : 60;
  let files;
  try {
    files = fs.readdirSync(tmpDir);
  } catch (e) {
    return;
  }
  for (const f of files) {
    if (!/^claude-notify-.*\.lock$/.test(f)) continue;
    const p = path.join(tmpDir, f);
    try {
      const mtimeSec = mtimeSecOf(p);
      if (nowSec - mtimeSec > maxAgeSec) {
        fs.unlinkSync(p);
      }
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = {
  lockPath,
  isRecentDuplicate,
  acquire,
  acquireContentLock,
  release,
  isDuplicateMessage,
  gc,
};

```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/dedup.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/dedup.js plugins/notify/scripts/lib/dedup.test.js
git commit -m "feat(notify): lib/dedup.js"
```

> Author notes: Verified locally on Node v20.20.2: all 8 subtests pass; red state confirmed as "Cannot find module './dedup'". Key semantics implemented per contract: - lockPath: path.join(tmpDir||os.tmpdir(), `claude-notify-<sessionId>-<key>.lock`). Default tmpDir = os.tmpdir(). - mtime->seconds via Math.floor(stat.mtimeMs/1000). Tests use fs.utimesSync(p, secs, secs) which sets epoch-seconds, making nowSec injection deterministic. IMPORTANT for the plan author: a freshly-created lock gets the REAL wall-clock mtime; tests must utimesSync() it before doing nowSec-based age math, otherwise the comparison uses 

---

### Task 6: `lib/suppress.js`

**Files:**
- Create: `plugins/notify/scripts/lib/suppress.js`
- Test: `plugins/notify/scripts/lib/suppress.test.js`

Exports: `shouldSuppressQuestion`, `matchesFilter`, `shouldFilter`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/suppress.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldSuppressQuestion,
  matchesFilter,
  shouldFilter,
} = require("./suppress");

// ---------------------------------------------------------------------------
// shouldSuppressQuestion — any-notification window (default 7s)
// ---------------------------------------------------------------------------

test("any-notification: suppresses inside the 7s window", () => {
  const cfg = {
    suppressQuestionAfterAnyNotificationSeconds: 7,
    suppressQuestionAfterTaskCompleteSeconds: 0,
  };
  const st = { last_notification_ts: 100 };
  assert.equal(shouldSuppressQuestion(st, cfg, 100), true); // diff 0
  assert.equal(shouldSuppressQuestion(st, cfg, 106), true); // diff 6
});

test("any-notification: boundary at exactly 7s does NOT suppress", () => {
  const cfg = {
    suppressQuestionAfterAnyNotificationSeconds: 7,
    suppressQuestionAfterTaskCompleteSeconds: 0,
  };
  const st = { last_notification_ts: 100 };
  assert.equal(shouldSuppressQuestion(st, cfg, 107), false); // diff 7 (== window)
  assert.equal(shouldSuppressQuestion(st, cfg, 108), false); // diff 8
});

// ---------------------------------------------------------------------------
// shouldSuppressQuestion — task-complete window (default 12s)
// ---------------------------------------------------------------------------

test("task-complete: suppresses inside the 12s window", () => {
  const cfg = {
    suppressQuestionAfterAnyNotificationSeconds: 0,
    suppressQuestionAfterTaskCompleteSeconds: 12,
  };
  const st = { last_task_complete_ts: 100 };
  assert.equal(shouldSuppressQuestion(st, cfg, 100), true); // diff 0
  assert.equal(shouldSuppressQuestion(st, cfg, 111), true); // diff 11
});

test("task-complete: boundary at exactly 12s does NOT suppress", () => {
  const cfg = {
    suppressQuestionAfterAnyNotificationSeconds: 0,
    suppressQuestionAfterTaskCompleteSeconds: 12,
  };
  const st = { last_task_complete_ts: 100 };
  assert.equal(shouldSuppressQuestion(st, cfg, 112), false); // diff 12
  assert.equal(shouldSuppressQuestion(st, cfg, 200), false);
});

// ---------------------------------------------------------------------------
// shouldSuppressQuestion — <= 0 disables a window
// ---------------------------------------------------------------------------

test("zero or negative window disables suppression even with a recent ts", () => {
  const stN = { last_notification_ts: 100 };
  const stT = { last_task_complete_ts: 100 };
  assert.equal(
    shouldSuppressQuestion(stN, {
      suppressQuestionAfterAnyNotificationSeconds: 0,
      suppressQuestionAfterTaskCompleteSeconds: 0,
    }, 100),
    false,
  );
  assert.equal(
    shouldSuppressQuestion(stN, {
      suppressQuestionAfterAnyNotificationSeconds: -5,
      suppressQuestionAfterTaskCompleteSeconds: 0,
    }, 100),
    false,
  );
  assert.equal(
    shouldSuppressQuestion(stT, {
      suppressQuestionAfterAnyNotificationSeconds: 0,
      suppressQuestionAfterTaskCompleteSeconds: -1,
    }, 100),
    false,
  );
});

// ---------------------------------------------------------------------------
// shouldSuppressQuestion — missing timestamp = no suppression
// ---------------------------------------------------------------------------

test("missing or zero timestamp means no suppression", () => {
  const cfg = {
    suppressQuestionAfterAnyNotificationSeconds: 7,
    suppressQuestionAfterTaskCompleteSeconds: 12,
  };
  assert.equal(shouldSuppressQuestion({}, cfg, 100), false);
  assert.equal(shouldSuppressQuestion({ last_notification_ts: 0 }, cfg, 1), false);
  assert.equal(shouldSuppressQuestion({ last_task_complete_ts: 0 }, cfg, 1), false);
  assert.equal(shouldSuppressQuestion(undefined, cfg, 100), false);
});

// ---------------------------------------------------------------------------
// shouldSuppressQuestion — OR across windows; defaults & defensiveness
// ---------------------------------------------------------------------------

test("either window can trigger (logical OR)", () => {
  const cfg = {
    suppressQuestionAfterAnyNotificationSeconds: 7,
    suppressQuestionAfterTaskCompleteSeconds: 12,
  };
  // any-window expired (diff 9 >= 7) but task-window active (diff 9 < 12)
  const st = { last_notification_ts: 100, last_task_complete_ts: 100 };
  assert.equal(shouldSuppressQuestion(st, cfg, 109), true);
});

test("nowSec defaults to current epoch seconds when omitted", () => {
  const cfg = { suppressQuestionAfterAnyNotificationSeconds: 7 };
  const recent = Math.floor(Date.now() / 1000) - 1;
  assert.equal(
    shouldSuppressQuestion({ last_notification_ts: recent }, cfg),
    true,
  );
  const old = Math.floor(Date.now() / 1000) - 1000;
  assert.equal(
    shouldSuppressQuestion({ last_notification_ts: old }, cfg),
    false,
  );
});

test("undefined config never throws and never suppresses", () => {
  assert.equal(
    shouldSuppressQuestion({ last_notification_ts: 100 }, undefined, 100),
    false,
  );
});

// ---------------------------------------------------------------------------
// matchesFilter — AND across present fields
// ---------------------------------------------------------------------------

test("AND across present fields: all must match", () => {
  const f = { status: "question", folder: "/x" };
  assert.equal(matchesFilter(f, { status: "question", folder: "/x" }), true);
  assert.equal(matchesFilter(f, { status: "question", folder: "/y" }), false);
  assert.equal(matchesFilter(f, { status: "task_complete", folder: "/x" }), false);
});

test("three-field AND with branch", () => {
  const f = { status: "question", gitBranch: "main", folder: "/repo" };
  assert.equal(
    matchesFilter(f, { status: "question", gitBranch: "main", folder: "/repo" }),
    true,
  );
  assert.equal(
    matchesFilter(f, { status: "question", gitBranch: "dev", folder: "/repo" }),
    false,
  );
});

// ---------------------------------------------------------------------------
// matchesFilter — absent field is a wildcard
// ---------------------------------------------------------------------------

test("absent field acts as a wildcard", () => {
  const f = { status: "question" };
  assert.equal(
    matchesFilter(f, { status: "question", gitBranch: "main", folder: "/y" }),
    true,
  );
  assert.equal(
    matchesFilter(f, { status: "question", gitBranch: "", folder: "/z" }),
    true,
  );
  assert.equal(matchesFilter(f, { status: "task_complete" }), false);
});

// ---------------------------------------------------------------------------
// matchesFilter — gitBranch:"" matches only the empty branch
// ---------------------------------------------------------------------------

test('gitBranch:"" matches only an empty branch (no branch / detached)', () => {
  const f = { gitBranch: "" };
  assert.equal(matchesFilter(f, { gitBranch: "" }), true);
  assert.equal(matchesFilter(f, { gitBranch: "main" }), false);
  assert.equal(matchesFilter(f, {}), false); // ctx.gitBranch undefined !== ""
});

test('gitBranch:"" combined with status', () => {
  const f = { status: "question", gitBranch: "" };
  assert.equal(matchesFilter(f, { status: "question", gitBranch: "" }), true);
  assert.equal(matchesFilter(f, { status: "question", gitBranch: "main" }), false);
});

test("non-empty gitBranch requires exact match", () => {
  const f = { gitBranch: "main" };
  assert.equal(matchesFilter(f, { gitBranch: "main" }), true);
  assert.equal(matchesFilter(f, { gitBranch: "feature" }), false);
  assert.equal(matchesFilter(f, { gitBranch: "" }), false);
});

// ---------------------------------------------------------------------------
// matchesFilter — empty filter / no conditions never matches
// ---------------------------------------------------------------------------

test("empty filter (no conditions) never matches", () => {
  assert.equal(matchesFilter({}, { status: "question" }), false);
});

test("filter with only a name (no match condition) never matches", () => {
  assert.equal(
    matchesFilter({ name: "noisy" }, { status: "question", folder: "/x" }),
    false,
  );
});

test("name is ignored but other conditions still apply", () => {
  const f = { name: "label", status: "question" };
  assert.equal(matchesFilter(f, { status: "question" }), true);
  assert.equal(matchesFilter(f, { status: "task_complete" }), false);
});

test("null / non-object filter never matches", () => {
  assert.equal(matchesFilter(null, { status: "question" }), false);
  assert.equal(matchesFilter(undefined, { status: "question" }), false);
});

test("matchesFilter tolerates a missing ctx", () => {
  assert.equal(matchesFilter({ status: "question" }), false);
  assert.equal(matchesFilter({ gitBranch: "" }), false);
});

// ---------------------------------------------------------------------------
// shouldFilter — OR across filters
// ---------------------------------------------------------------------------

test("OR across filters: any match suppresses", () => {
  const cfg = {
    suppressFilters: [{ status: "question" }, { folder: "/a" }],
  };
  assert.equal(shouldFilter(cfg, { status: "task_complete", folder: "/a" }), true);
  assert.equal(shouldFilter(cfg, { status: "question", folder: "/b" }), true);
  assert.equal(shouldFilter(cfg, { status: "task_complete", folder: "/b" }), false);
});

test("shouldFilter respects per-filter AND inside the OR", () => {
  const cfg = {
    suppressFilters: [{ status: "question", gitBranch: "main" }],
  };
  assert.equal(shouldFilter(cfg, { status: "question", gitBranch: "main" }), true);
  assert.equal(shouldFilter(cfg, { status: "question", gitBranch: "dev" }), false);
});

test('shouldFilter with gitBranch:"" filter', () => {
  const cfg = { suppressFilters: [{ gitBranch: "" }] };
  assert.equal(shouldFilter(cfg, { status: "question", gitBranch: "" }), true);
  assert.equal(shouldFilter(cfg, { status: "question", gitBranch: "x" }), false);
});

test("empty / missing / non-array suppressFilters never suppress", () => {
  assert.equal(shouldFilter({ suppressFilters: [] }, { status: "question" }), false);
  assert.equal(shouldFilter({}, { status: "question" }), false);
  assert.equal(shouldFilter(undefined, { status: "question" }), false);
  assert.equal(
    shouldFilter({ suppressFilters: "nope" }, { status: "question" }),
    false,
  );
});

test("suppressFilters containing an empty filter ignores it", () => {
  const cfg = { suppressFilters: [{}, { status: "question" }] };
  assert.equal(shouldFilter(cfg, { status: "question" }), true);
  assert.equal(shouldFilter(cfg, { status: "task_complete" }), false);
});

```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/suppress.test.js`  
Expected: Before suppress.js exists, the test file's `require("./suppress")` fails at load time: node --test reports `# Error: Cannot find module './suppress'` and `error: 'test failed'` (the whole file errors out, 0 tests run). Once the module is created with the three exports, all 25 tests pass (verified locally on node v20: `# pass 25 # fail 0`).

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/suppress.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

// lib/suppress.js — question cooldowns + suppressFilters matching.
// Pure, zero-dep. Operates on a plain state object + the loaded config.
//
// Two responsibilities (see spec "Suppression"):
//   1. shouldSuppressQuestion — the 7s-after-any-notification and
//      12s-after-task-complete cooldown windows that gate `question` events.
//   2. suppressFilters — user-defined { name?, status?, gitBranch?, folder? }
//      filters: AND across present fields within a filter, OR across filters.
//
// Time: every time-dependent fn takes an optional final nowSec (unix SECONDS),
// defaulting to the current epoch seconds via the standard clock so tests can
// inject a deterministic clock.

// The fields a suppressFilter can match on. `name` is a human label only and is
// NOT a match condition (a filter declaring only `name` has zero conditions).
const MATCH_KEYS = ["status", "gitBranch", "folder"];

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// A field is "present" iff the key exists with a non-undefined value. This is
// what makes gitBranch:"" (present, means "no branch") distinct from gitBranch
// absent (wildcard).
function has(obj, key) {
  return (
    obj != null &&
    Object.prototype.hasOwnProperty.call(obj, key) &&
    obj[key] !== undefined
  );
}

// true when a `question` notification should be suppressed because something
// fired too recently. OR of the two windows. A window with value <= 0, or a
// missing/zero state timestamp, disables that window. Boundary is exclusive:
// a diff exactly equal to the window does NOT suppress.
function shouldSuppressQuestion(state, config, nowSec) {
  const now = typeof nowSec === "number" ? nowSec : nowSeconds();
  const st = state || {};
  const cfg = config || {};

  const anySec = cfg.suppressQuestionAfterAnyNotificationSeconds;
  const taskSec = cfg.suppressQuestionAfterTaskCompleteSeconds;

  if (
    anySec > 0 &&
    st.last_notification_ts &&
    now - st.last_notification_ts < anySec
  ) {
    return true;
  }
  if (
    taskSec > 0 &&
    st.last_task_complete_ts &&
    now - st.last_task_complete_ts < taskSec
  ) {
    return true;
  }
  return false;
}

// true when `ctx` matches a single filter. AND across present fields; absent
// field = wildcard; gitBranch:"" matches only ctx.gitBranch === "". A filter
// with zero match conditions (e.g. {} or { name } only) never matches.
function matchesFilter(filter, ctx) {
  if (filter == null || typeof filter !== "object") return false;
  const c = ctx || {};

  let conditions = 0;
  for (const key of MATCH_KEYS) {
    if (!has(filter, key)) continue;
    conditions += 1;
    if (key === "gitBranch") {
      if (filter.gitBranch === "") {
        // "no branch / detached" — matches only an explicitly empty branch.
        if (c.gitBranch !== "") return false;
      } else if (filter.gitBranch !== c.gitBranch) {
        return false;
      }
    } else if (filter[key] !== c[key]) {
      return false;
    }
  }

  if (conditions === 0) return false;
  return true;
}

// true when ANY configured suppressFilter matches `ctx` (OR across filters).
function shouldFilter(config, ctx) {
  const cfg = config || {};
  const filters = cfg.suppressFilters;
  if (!Array.isArray(filters) || filters.length === 0) return false;
  for (const f of filters) {
    if (matchesFilter(f, ctx)) return true;
  }
  return false;
}

module.exports = { shouldSuppressQuestion, matchesFilter, shouldFilter };

```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/suppress.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/suppress.js plugins/notify/scripts/lib/suppress.test.js
git commit -m "feat(notify): lib/suppress.js"
```

> Author notes: Decisions/edge cases (all per the INTERFACE CONTRACT + spec "Suppression"), verified by running the suite (25/25 pass on node v20.20.2): - Cooldown boundary is EXCLUSIVE: `now - ts < window` suppresses, so a diff exactly == window does NOT suppress (tested at 7 and 12). - A window value <= 0 disables that window (the `anySec > 0` / `taskSec > 0` guard); 0 and negative both covered. - Missing/zero state timestamp disables suppression via the truthiness guard `st.last_notification_ts` / `st.last_task_complete_ts` (unix-second 0 is treated as "never", which matches state.js defaults where these i

---

### Task 7: `lib/git.js`

**Files:**
- Create: `plugins/notify/scripts/lib/git.js`
- Test: `plugins/notify/scripts/lib/git.test.js`

Exports: `branch`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/git.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
// Use the unprefixed builtin name so we share the exact same module object that
// git.js captured; this lets us swap execSync for a stub.
const cp = require("child_process");

const git = require("./git");

// Temporarily replace child_process.execSync for the duration of `fn`, then
// always restore it. git.js accesses cp.execSync as a property at call time, so
// patching the shared module object intercepts its git CLI fallback.
function withExecSync(fake, fn) {
  const orig = cp.execSync;
  cp.execSync = fake;
  try {
    return fn();
  } finally {
    cp.execSync = orig;
  }
}

test("prefers transcript gitBranch and does not call git", () => {
  withExecSync(() => { throw new Error("git should not be called"); }, () => {
    assert.equal(
      git.branch({ entries: [{ gitBranch: "feature-x" }], cwd: "/some/repo" }),
      "feature-x"
    );
  });
});

test("uses the last non-empty gitBranch from transcript entries", () => {
  withExecSync(() => { throw new Error("git should not be called"); }, () => {
    const entries = [
      { gitBranch: "old-branch" },
      { gitBranch: "" },
      { gitBranch: "current-branch" },
    ];
    assert.equal(git.branch({ entries, cwd: "/some/repo" }), "current-branch");
  });
});

test("falls back to git CLI when no transcript branch", () => {
  let captured = null;
  withExecSync((cmd) => { captured = cmd; return "main\n"; }, () => {
    assert.equal(git.branch({ entries: [{}], cwd: "/repo/dir" }), "main");
  });
  assert.ok(captured.includes("rev-parse --abbrev-ref HEAD"));
  assert.ok(captured.includes("/repo/dir"));
  assert.ok(captured.startsWith("git -C "));
});

test("detached HEAD result becomes empty string", () => {
  withExecSync(() => "HEAD\n", () => {
    assert.equal(git.branch({ entries: [], cwd: "/repo" }), "");
  });
});

test("git error becomes empty string", () => {
  withExecSync(() => { throw new Error("not a git repo"); }, () => {
    assert.equal(git.branch({ entries: [], cwd: "/repo" }), "");
  });
});

test("empty/whitespace git output becomes empty string", () => {
  withExecSync(() => "   \n", () => {
    assert.equal(git.branch({ entries: [], cwd: "/repo" }), "");
  });
});

test("no cwd and no transcript branch returns empty without calling git", () => {
  withExecSync(() => { throw new Error("git should not be called"); }, () => {
    assert.equal(git.branch({ entries: [] }), "");
  });
});

test("no args returns empty string and never throws", () => {
  withExecSync(() => { throw new Error("git should not be called"); }, () => {
    assert.equal(git.branch(), "");
  });
});

test("transcript branch takes priority over a working git CLI", () => {
  withExecSync(() => "git-branch\n", () => {
    assert.equal(
      git.branch({ entries: [{ gitBranch: "ts-branch" }], cwd: "/repo" }),
      "ts-branch"
    );
  });
});

test("trims surrounding whitespace from the git branch", () => {
  withExecSync(() => "  feature/login \n", () => {
    assert.equal(git.branch({ entries: [], cwd: "/repo" }), "feature/login");
  });
});
```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/git.test.js`  
Expected: Before lib/git.js exists, `require("./git")` in the test fails to load with "Cannot find module './git'", so node --test reports the test file as failed (0 passing). (Once git.js exists but lib/transcript.js does not, it would instead fail with "Cannot find module './transcript'" — both siblings must exist at execution time.)

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/git.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

// git.js — resolve the current git branch for use in the notification
// subtitle and as a suppressFilters key.
//
// Strategy (per design spec "Git branch"):
//   1. Prefer the top-level `gitBranch` field already present on transcript
//      lines (cheapest, no subprocess) via transcript.gitBranchOf().
//   2. Fallback: `git -C <cwd> rev-parse --abbrev-ref HEAD`, trimmed; treat
//      "HEAD" (detached) or any error as no branch ("").
//
// Pure-node, zero deps. Require-able without side effects. The git fallback is
// fully guarded so callers that pass a transcript branch never touch the CLI.

const cp = require("child_process");
const transcript = require("./transcript");

// POSIX single-quote escaping so an arbitrary cwd cannot break the shell
// command passed to execSync (which runs through /bin/sh).
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function branch(arg) {
  const opts = arg || {};
  const entries = opts.entries;
  const cwd = opts.cwd;

  // 1) Prefer the gitBranch field captured on transcript lines.
  try {
    if (transcript && typeof transcript.gitBranchOf === "function") {
      const fromTranscript = transcript.gitBranchOf(entries || []);
      if (fromTranscript) return fromTranscript;
    }
  } catch (_) {
    // ignore — fall through to the git CLI fallback
  }

  // 2) Fallback to the git CLI. No cwd => nothing to query.
  if (!cwd) return "";
  try {
    // NOTE: access cp.execSync as a property (not destructured) so the call is
    // resolved at invocation time — this keeps the subprocess hop guarded and
    // injectable for tests.
    const cmd = "git -C " + shellQuote(cwd) + " rev-parse --abbrev-ref HEAD";
    const out = cp.execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const b = (out == null ? "" : String(out)).trim();
    if (!b || b === "HEAD") return "";
    return b;
  } catch (_) {
    return "";
  }
}

module.exports = { branch };
```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/git.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/git.js plugins/notify/scripts/lib/git.test.js
git commit -m "feat(notify): lib/git.js"
```

> Author notes: Validated in a temp sandbox with a minimal transcript.js stub: all 10 tests pass (EXIT 0). Key design points: - git.js calls `cp.execSync` as a property access (NOT destructured) so tests can monkeypatch child_process.execSync on the shared module object. If a future refactor destructures execSync, the "no git call" tests break — keep the property-access form. - The test requires "child_process" (unprefixed) to share the exact module instance git.js requires; "node:child_process" resolves to the same cached object too, but unprefixed matches the impl. - branch() accepts undefined arg (defaults

---

### Task 8: `lib/summary.js`

**Files:**
- Create: `plugins/notify/scripts/lib/summary.js`
- Test: `plugins/notify/scripts/lib/summary.test.js`

Exports: `stripMarkdown`, `truncate`, `bodyFor`, `actionSuffix`, `subtitle`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/summary.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
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
```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/summary.test.js`  
Expected: Before lib/summary.js exists, `node --test` cannot load the test file: the top-level `require("./summary")` throws `Error: Cannot find module './summary'` (code MODULE_NOT_FOUND), so node:test reports the whole suite as `not ok ... summary.test.js` with `failureType: 'testCodeFailure'` and 0 passing subtests. (It also requires the sibling lib/transcript.js to exist at run time, since summary.js does `require("./transcript")`.)

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/summary.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

const transcript = require("./transcript");

const REVIEW_KEYWORDS = ["review", "analysis", "analyzed"];
const JOIN = "  "; // two spaces

function byteLen(s) {
  return Buffer.byteLength(typeof s === "string" ? s : "", "utf8");
}

// Longest whole-codepoint prefix of `s` whose UTF-8 byte length is <= n.
function byteSafeSlice(s, n) {
  if (byteLen(s) <= n) return s;
  let out = "";
  let len = 0;
  for (const ch of s) {
    const b = byteLen(ch);
    if (len + b > n) break;
    out += ch;
    len += b;
  }
  return out;
}

function stripMarkdown(s) {
  if (typeof s !== "string") return "";
  let out = s;
  // [text](url) -> text
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // bold (**) before italic (*)
  out = out.replace(/\*\*/g, "");
  out = out.replace(/\*/g, "");
  // inline code / fences
  out = out.replace(/`+/g, "");
  // leading heading markers
  out = out.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");
  // leading blockquote markers
  out = out.replace(/^[ \t]*>[ \t]?/gm, "");
  return out;
}

function truncate(s, n = 150) {
  if (typeof s !== "string") s = s == null ? "" : String(s);
  s = s.trim();
  if (byteLen(s) <= n) return s;
  const prefix = byteSafeSlice(s, n);
  // Prefer a sentence boundary (last . ! ? followed by whitespace or end of prefix),
  // but only if it keeps at least half of the allowance.
  const m = prefix.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m) {
    const sentence = m[0].trim();
    if (byteLen(sentence) >= n * 0.5) return sentence;
  }
  // Otherwise fall back to the last word boundary.
  const sp = prefix.lastIndexOf(" ");
  if (sp > 0) return prefix.slice(0, sp).trim();
  // Hard cut (e.g. a single long token or CJK/emoji run).
  return prefix.trim();
}

function finish(text) {
  return truncate(stripMarkdown(text || ""), 150);
}

function firstSentence(text) {
  if (!text) return "";
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return m ? m[0].trim() : text.trim();
}

function sentencesOf(text) {
  if (!text) return [];
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function findSentenceWithKeyword(text, keywords) {
  const lower = keywords.map(k => k.toLowerCase());
  for (const sent of sentencesOf(text)) {
    const sl = sent.toLowerCase();
    if (lower.some(k => sl.includes(k))) return sent;
  }
  return "";
}

function lastAssistant(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i] && entries[i].type === "assistant") return entries[i];
  }
  return null;
}

// Find the most recent assistant tool_use block by name; returns {input, entry}.
function findToolUse(entries, toolName) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== "assistant") continue;
    const content = transcript.contentOf(e);
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b && b.type === "tool_use" && b.name === toolName) {
        return { input: b.input, entry: e };
      }
    }
  }
  return null;
}

function within(ms, t1, t2) {
  const a = Date.parse(t1), b = Date.parse(t2);
  if (isNaN(a) || isNaN(b)) return true; // can't compute -> trust the strongest signal
  return Math.abs(a - b) <= ms;
}

function countToolSinceLastUser(entries, name) {
  const ts = transcript.lastUserTimestamp(entries);
  const after = transcript.assistantEntriesAfter(entries, ts);
  let c = 0;
  for (const e of after) for (const tu of transcript.toolUsesOf(e)) if (tu.name === name) c++;
  return c;
}

function formatDuration(sec) {
  sec = Math.floor(sec);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function durationSeconds(userTs, afterAssistants) {
  if (!userTs || !afterAssistants.length) return 0;
  const start = Date.parse(userTs);
  const lastA = afterAssistants[afterAssistants.length - 1];
  const end = Date.parse(lastA && lastA.timestamp);
  if (isNaN(start) || isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

// ----- body builders per status -----

function bodyQuestion(entries) {
  const last = lastAssistant(entries);
  const found = findToolUse(entries, "AskUserQuestion");
  if (found && last && within(60000, found.entry.timestamp, last.timestamp)) {
    const qs = found.input && found.input.questions;
    const q = Array.isArray(qs) && qs[0] && qs[0].question;
    if (q) return finish(q);
  }
  const assistants = entries.filter(e => e && e.type === "assistant");
  const last8 = assistants.slice(-8);
  const qTexts = last8
    .map(e => stripMarkdown(transcript.textOf(e)).trim())
    .filter(t => t.includes("?"));
  if (qTexts.length) {
    qTexts.sort((a, b) => byteLen(a) - byteLen(b));
    return finish(qTexts[0]);
  }
  const lastText = assistants.length ? transcript.textOf(assistants[assistants.length - 1]) : "";
  const fs1 = firstSentence(stripMarkdown(lastText).trim());
  if (fs1) return finish(fs1);
  return "Claude needs your input to continue";
}

function bodyPlanReady(entries) {
  const found = findToolUse(entries, "ExitPlanMode");
  if (found && found.input && typeof found.input.plan === "string") {
    const line = found.input.plan.split("\n").map(l => l.trim()).find(l => l.length > 0);
    if (line) return finish(line);
  }
  return "Plan is ready for review";
}

function bodyReviewComplete(entries) {
  const assistants = entries.filter(e => e && e.type === "assistant");
  const recent = assistants.slice(-5);
  for (let i = recent.length - 1; i >= 0; i--) {
    const sent = findSentenceWithKeyword(stripMarkdown(transcript.textOf(recent[i])), REVIEW_KEYWORDS);
    if (sent) return finish(sent);
  }
  const reads = countToolSinceLastUser(entries, "Read");
  if (reads > 0) return `Reviewed ${reads} file(s)`;
  return "Code review completed";
}

function bodyTaskComplete(entries) {
  const last = lastAssistant(entries);
  let t = last ? stripMarkdown(transcript.textOf(last)).trim() : "";
  if (t) {
    if (byteLen(t) >= 150) t = firstSentence(t);
    return finish(t);
  }
  return "Task completed successfully";
}

function bodyApiErrorOverloaded(entries) {
  const errs = entries.filter(e => transcript.isApiErrorEntry(e));
  if (errs.length) {
    const last = errs[errs.length - 1];
    let t = typeof last.error === "string" && last.error.trim() ? last.error : transcript.textOf(last);
    if (t && t.trim()) return finish(t);
  }
  return "API error occurred";
}

function bodyFor({ status, entries } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  switch (status) {
    case "question": return bodyQuestion(list);
    case "plan_ready": return bodyPlanReady(list);
    case "review_complete": return bodyReviewComplete(list);
    case "task_complete": return bodyTaskComplete(list);
    case "session_limit_reached": return "Session limit reached. Please start a new conversation.";
    case "api_error": return "Please run /login";
    case "api_error_overloaded": return bodyApiErrorOverloaded(list);
    default: return "";
  }
}

function actionSuffix(entries) {
  if (!Array.isArray(entries)) return "";
  const ts = transcript.lastUserTimestamp(entries);
  const after = transcript.assistantEntriesAfter(entries, ts);
  let writes = 0, edits = 0, bashes = 0;
  for (const e of after) {
    for (const tu of transcript.toolUsesOf(e)) {
      if (tu.name === "Write") writes++;
      else if (tu.name === "Edit") edits++;
      else if (tu.name === "Bash") bashes++;
    }
  }
  const parts = [];
  if (writes > 0) parts.push(`📝 ${writes} new`);
  if (edits > 0) parts.push(`✏️ ${edits} edited`);
  if (bashes > 0) parts.push(`▶ ${bashes} cmds`);
  const dur = durationSeconds(ts, after);
  if (dur > 0) parts.push(`⏱ ${formatDuration(dur)}`);
  return parts.join(JOIN);
}

function subtitle({ branch, folder } = {}) {
  branch = branch || "";
  folder = folder || "";
  if (branch && folder) return `${branch} · ${folder}`;
  if (folder) return folder;
  return "";
}

module.exports = {
  stripMarkdown,
  truncate,
  bodyFor,
  actionSuffix,
  subtitle,
};
```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/summary.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/summary.js plugins/notify/scripts/lib/summary.test.js
git commit -m "feat(notify): lib/summary.js"
```

> Author notes: IMPORTANT require-path correction: the FOCUS line says "require ../transcript", but that is wrong for this file's location. Per the spec module layout, both transcript.js and summary.js live directly in plugins/notify/scripts/lib/ (siblings). So summary.js MUST use require("./transcript") (a "../" would resolve to scripts/transcript.js, which does not exist). The contract's general rule explicitly permits require("./transcript"). Confirmed correct by running the suite. Behavior decisions / assumptions (all spec-faithful, verified by tests): - All non-default bodies are passed through finish() 

---

### Task 9: `lib/classify.js`

**Files:**
- Create: `plugins/notify/scripts/lib/classify.js`
- Test: `plugins/notify/scripts/lib/classify.test.js`

Exports: `STATUS`, `ACTIVE_TOOLS`, `READLIKE_TOOLS`, `classifyStop`, `classifyEvent`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/classify.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
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
```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/classify.test.js`  
Expected: Before classify.js exists the test file cannot load its require target and node:test reports a load failure: "# Error: Cannot find module './classify'" with failureType 'testCodeFailure', code 'ERR_TEST_FAILURE', and "# fail 1" (all assertions blocked because the module is absent). (Assumes the sibling transcript.js dependency already exists; if it does not yet, the same MODULE_NOT_FOUND surfaces for './transcript'.)

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/classify.js`

<details><summary>impl source (paste verbatim)</summary>

```js
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
```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/classify.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/classify.js plugins/notify/scripts/lib/classify.test.js
git commit -m "feat(notify): lib/classify.js"
```

> Author notes: VERIFIED: wrote classify.js + a contract-faithful transcript.js sibling under plugins/notify/scripts/lib/ and ran `node --test classify.test.js` -> 40 pass / 0 fail. Also confirmed the red state by removing classify.js -> "Cannot find module './classify'". Key decisions / edge cases: - REQUIRE PATH: classify.js uses require("./transcript") (NOT "../transcript"). Both files live in lib/ per the module-layout in the spec, so they are siblings. The FOCUS line saying "require ../transcript" is inconsistent with the layout; using ../transcript would resolve to scripts/transcript.js and break the lo

---

### Task 10: `lib/channels/sound.js`

**Files:**
- Create: `plugins/notify/scripts/lib/channels/sound.js`
- Test: `plugins/notify/scripts/lib/channels/sound.test.js`

Exports: `candidates`, `play`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/channels/sound.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sound = require("./sound");

const SP = "/tmp/sounds/notify.wav";

test("exports candidates and play functions", () => {
  assert.equal(typeof sound.candidates, "function");
  assert.equal(typeof sound.play, "function");
});

// ---- darwin: afplay + the "-v volume only when 0<=volume<1" rule ----

test("darwin: no volume arg -> afplay with just the path", () => {
  assert.deepEqual(sound.candidates("darwin", SP), [["afplay", [SP]]]);
});

test("darwin: explicit undefined volume -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, undefined), [
    ["afplay", [SP]],
  ]);
});

test("darwin: 0<=volume<1 -> afplay -v <vol> <path>", () => {
  assert.deepEqual(sound.candidates("darwin", SP, 0.5), [
    ["afplay", ["-v", "0.5", SP]],
  ]);
});

test("darwin: volume 0 is included (0<=0<1)", () => {
  assert.deepEqual(sound.candidates("darwin", SP, 0), [
    ["afplay", ["-v", "0", SP]],
  ]);
});

test("darwin: volume === 1 -> no -v (boundary, not < 1)", () => {
  assert.deepEqual(sound.candidates("darwin", SP, 1), [["afplay", [SP]]]);
});

test("darwin: volume > 1 -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, 1.5), [["afplay", [SP]]]);
});

test("darwin: negative volume -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, -0.3), [["afplay", [SP]]]);
});

test("darwin: NaN volume -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, NaN), [["afplay", [SP]]]);
});

test("darwin: Infinity volume -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, Infinity), [
    ["afplay", [SP]],
  ]);
});

test("darwin: string volume rejected by typeof guard -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, "0.5"), [["afplay", [SP]]]);
});

test("darwin: volume rendered via String(volume)", () => {
  assert.equal(sound.candidates("darwin", SP, 0.25)[0][1][1], "0.25");
});

// ---- linux: ordered player list, volume ignored ----

test("linux: full ordered player list", () => {
  assert.deepEqual(sound.candidates("linux", SP), [
    ["paplay", [SP]],
    ["pw-play", [SP]],
    ["aplay", ["-q", SP]],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", SP]],
    ["play", ["-q", SP]],
  ]);
});

test("linux: paplay is the first candidate", () => {
  assert.equal(sound.candidates("linux", SP, 0.5)[0][0], "paplay");
});

test("linux: ignores volume (same list with or without)", () => {
  assert.deepEqual(
    sound.candidates("linux", SP, 0.5),
    sound.candidates("linux", SP)
  );
});

test("linux: soundPath threaded through every candidate", () => {
  for (const [, args] of sound.candidates("linux", SP)) {
    assert.ok(args.includes(SP));
  }
});

// ---- win32: PowerShell SoundPlayer, volume ignored ----

test("win32: powershell SoundPlayer PlaySync embedding the path", () => {
  const c = sound.candidates("win32", SP);
  assert.equal(c.length, 1);
  assert.equal(c[0][0], "powershell");
  const args = c[0][1];
  assert.deepEqual(args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(args[3], /SoundPlayer/);
  assert.match(args[3], /PlaySync/);
  assert.ok(args[3].includes(SP));
});

test("win32: ignores volume", () => {
  assert.deepEqual(
    sound.candidates("win32", SP, 0.5),
    sound.candidates("win32", SP)
  );
});

// ---- fallback + fail-open ----

test("unknown platform falls back to the linux list", () => {
  const c = sound.candidates("freebsd", SP);
  assert.equal(c.length, 5);
  assert.equal(c[0][0], "paplay");
});

test("play is fail-open: empty/falsy soundPath returns without throwing", () => {
  assert.doesNotThrow(() => sound.play(""));
  assert.doesNotThrow(() => sound.play(undefined, { platform: "linux" }));
});
```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/channels/sound.test.js`  
Expected: Before sound.js exists, the test run errors at require time: "Error: Cannot find module './sound'" (failureType 'testCodeFailure', code 'ERR_TEST_FAILURE', `# fail 1`). Once the module is created, all 22 tests pass (`# pass 22`, `# fail 0`).

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/channels/sound.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

// channels/sound.js — per-status notification sound playback.
//
// Pure Node, zero external deps. `candidates()` is a PURE ordered list of
// [command, args] players to try per platform; the first one that actually
// launches wins. `play()` spawns that first player detached and NEVER throws —
// a notification sound must never disturb the Claude Code session.

const { spawn } = require("node:child_process");
const os = require("node:os");

// Build the ordered list of [command, args] candidates for a platform.
// Callers try them in order and fall through to the next on spawn error.
//
//   darwin: afplay, with a best-effort "-v <volume>" flag ONLY when the
//           volume is a real number in [0, 1) (>= 1 / invalid / absent => full
//           volume, so the flag is omitted).
//   linux/other: paplay -> pw-play -> aplay -q -> ffplay ... -> play -q.
//                No portable volume flag here; volume is ignored.
//   win32: PowerShell System.Media.SoundPlayer .PlaySync() (no volume support).
function candidates(platform, soundPath, volume) {
  if (platform === "darwin") {
    const useVolume =
      typeof volume === "number" &&
      Number.isFinite(volume) &&
      volume >= 0 &&
      volume < 1;
    const args = useVolume ? ["-v", String(volume), soundPath] : [soundPath];
    return [["afplay", args]];
  }

  if (platform === "win32") {
    const ps =
      "$p = New-Object System.Media.SoundPlayer '" +
      soundPath +
      "'; $p.PlaySync();";
    return [
      ["powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]],
    ];
  }

  // linux / BSD / anything else — usual players, in order of prevalence.
  return [
    ["paplay", [soundPath]],
    ["pw-play", [soundPath]],
    ["aplay", ["-q", soundPath]],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", soundPath]],
    ["play", ["-q", soundPath]],
  ];
}

// Spawn the first player that launches, detached and unref'd. Fail-open:
// any error (bad path, no player, spawn throw) leaves the session silent.
function play(soundPath, opts = {}) {
  try {
    if (!soundPath) return;
    const platform = opts.platform || os.platform();
    const volume = opts.volume;
    const list = candidates(platform, soundPath, volume);
    tryNext(list, 0);
  } catch (_err) {
    // never throw
  }
}

function tryNext(list, i) {
  if (i >= list.length) return; // no player available — stay silent
  const [cmd, args] = list[i];
  let child;
  try {
    child = spawn(cmd, args, { stdio: "ignore", detached: true });
  } catch (_err) {
    return tryNext(list, i + 1);
  }
  child.on("error", () => tryNext(list, i + 1));
  try {
    child.unref();
  } catch (_err) {
    /* ignore */
  }
}

module.exports = { candidates, play };
```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/channels/sound.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/channels/sound.js plugins/notify/scripts/lib/channels/sound.test.js
git commit -m "feat(notify): lib/channels/sound.js"
```

> Author notes: Verified locally: 22 tests pass with the impl, and removing sound.js yields the expected "Cannot find module './sound'" red state. Key decisions matched to the INTERFACE CONTRACT: - candidates(platform, soundPath, volume) returns Array<[string, string[]]>, ordered. - darwin: afplay; the "-v <volume>" flag (as ["-v", String(volume), soundPath]) is added ONLY when volume is a finite number in [0,1). volume===1, >1, <0, NaN, Infinity, undefined, or a non-number (e.g. the string "0.5") all omit -v and play at full volume. Guarded with `typeof volume === "number" && Number.isFinite(volume) && volum

---

### Task 11: `lib/channels/desktop.js`

**Files:**
- Create: `plugins/notify/scripts/lib/channels/desktop.js`
- Test: `plugins/notify/scripts/lib/channels/desktop.test.js`

Exports: `macCommand`, `linuxCommand`, `winCommand`, `command`, `notify`, `bell`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/channels/desktop.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const desktop = require("./desktop");

// --- helpers --------------------------------------------------------------

// value following a flag in an args array (undefined if flag absent)
function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// build a probe from a set of "installed" binaries
function probeFor(names) {
  const set = new Set(names);
  return (bin) => set.has(bin);
}

// ===========================================================================
// macCommand — terminal-notifier present
// ===========================================================================

test("macCommand: terminal-notifier basic flags", () => {
  const r = desktop.macCommand(
    { title: "My Title", subtitle: "Sub", body: "Body text" },
    true
  );
  assert.equal(r.cmd, "terminal-notifier");
  assert.equal(flagVal(r.args, "-title"), "My Title");
  assert.equal(flagVal(r.args, "-subtitle"), "Sub");
  assert.equal(flagVal(r.args, "-message"), "Body text");
  // no urgency / click when not requested
  assert.ok(!r.args.includes("-timeSensitive"));
  assert.ok(!r.args.includes("-execute"));
  assert.ok(!r.args.includes("-appIcon"));
});

test("macCommand: terminal-notifier omits -subtitle when empty", () => {
  const r = desktop.macCommand({ title: "T", body: "B", subtitle: "" }, true);
  assert.equal(r.cmd, "terminal-notifier");
  assert.ok(!r.args.includes("-subtitle"));
  // title + message still present
  assert.equal(flagVal(r.args, "-title"), "T");
  assert.equal(flagVal(r.args, "-message"), "B");
});

test("macCommand: terminal-notifier urgent adds -timeSensitive", () => {
  const r = desktop.macCommand({ title: "T", body: "B", urgent: true }, true);
  assert.ok(r.args.includes("-timeSensitive"));
});

test("macCommand: terminal-notifier clickCmd adds -execute", () => {
  const r = desktop.macCommand(
    { title: "T", body: "B", clickCmd: "osascript -e 'foo'" },
    true
  );
  assert.equal(flagVal(r.args, "-execute"), "osascript -e 'foo'");
});

test("macCommand: terminal-notifier icon adds -appIcon", () => {
  const r = desktop.macCommand(
    { title: "T", body: "B", icon: "/path/icon.png" },
    true
  );
  assert.equal(flagVal(r.args, "-appIcon"), "/path/icon.png");
});

test("macCommand: terminal-notifier all options together", () => {
  const r = desktop.macCommand(
    {
      title: "T",
      subtitle: "S",
      body: "B",
      icon: "/i.png",
      urgent: true,
      clickCmd: "act",
    },
    true
  );
  assert.equal(flagVal(r.args, "-title"), "T");
  assert.equal(flagVal(r.args, "-subtitle"), "S");
  assert.equal(flagVal(r.args, "-message"), "B");
  assert.equal(flagVal(r.args, "-appIcon"), "/i.png");
  assert.equal(flagVal(r.args, "-execute"), "act");
  assert.ok(r.args.includes("-timeSensitive"));
});

// ===========================================================================
// macCommand — falls back to osascript
// ===========================================================================

test("macCommand: osascript fallback shape", () => {
  const r = desktop.macCommand(
    { title: "My Title", subtitle: "Sub", body: "Hello" },
    false
  );
  assert.equal(r.cmd, "osascript");
  assert.equal(r.args[0], "-e");
  const script = r.args[1];
  assert.ok(script.startsWith("display notification "));
  assert.ok(script.includes('display notification "Hello"'));
  assert.ok(script.includes('with title "My Title"'));
  assert.ok(script.includes('subtitle "Sub"'));
});

test("macCommand: osascript omits subtitle clause when empty", () => {
  const r = desktop.macCommand({ title: "T", body: "B" }, false);
  assert.equal(r.cmd, "osascript");
  assert.ok(!r.args[1].includes("subtitle"));
  assert.ok(r.args[1].includes('with title "T"'));
});

test("macCommand: osascript escapes double quotes in body", () => {
  const r = desktop.macCommand({ title: "T", body: 'Say "hi"' }, false);
  const script = r.args[1];
  // " -> \"  =>  display notification "Say \"hi\""
  assert.ok(script.includes('Say \\"hi\\"'));
});

test("macCommand: osascript escapes backslashes", () => {
  const r = desktop.macCommand({ title: "T", body: "a\\b" }, false);
  const script = r.args[1];
  // single backslash becomes double backslash
  assert.ok(script.includes("a\\\\b"));
});

// ===========================================================================
// linuxCommand
// ===========================================================================

test("linuxCommand: basic title + body positionals", () => {
  const r = desktop.linuxCommand({ title: "T", body: "B" });
  assert.equal(r.cmd, "notify-send");
  assert.equal(r.args[0], "T");
  assert.equal(r.args[1], "B");
  assert.ok(!r.args.includes("--urgency"));
  assert.ok(!r.args.includes("--icon"));
});

test("linuxCommand: urgent adds --urgency critical", () => {
  const r = desktop.linuxCommand({ title: "T", body: "B", urgent: true });
  assert.equal(flagVal(r.args, "--urgency"), "critical");
});

test("linuxCommand: icon adds --icon", () => {
  const r = desktop.linuxCommand({ title: "T", body: "B", icon: "/x.png" });
  assert.equal(flagVal(r.args, "--icon"), "/x.png");
});

test("linuxCommand: icon and urgent together", () => {
  const r = desktop.linuxCommand({
    title: "T",
    body: "B",
    icon: "/x.png",
    urgent: true,
  });
  assert.equal(flagVal(r.args, "--icon"), "/x.png");
  assert.equal(flagVal(r.args, "--urgency"), "critical");
  // positionals stay first
  assert.equal(r.args[0], "T");
  assert.equal(r.args[1], "B");
});

// ===========================================================================
// winCommand
// ===========================================================================

test("winCommand: powershell shape with toast + balloon fallback", () => {
  const r = desktop.winCommand({ title: "Win T", body: "Win B" });
  assert.equal(r.cmd, "powershell");
  assert.ok(r.args.includes("-NoProfile"));
  assert.ok(r.args.includes("-NonInteractive"));
  assert.ok(r.args.includes("-Command"));
  const script = r.args[r.args.length - 1];
  assert.ok(script.includes("ToastNotificationManager"));
  assert.ok(script.includes("NotifyIcon")); // balloon fallback present
  assert.ok(script.includes("Win T"));
  assert.ok(script.includes("Win B"));
});

test("winCommand: escapes single quotes by doubling", () => {
  const r = desktop.winCommand({ title: "it's", body: "y'all" });
  const script = r.args[r.args.length - 1];
  assert.ok(script.includes("it''s"));
  assert.ok(script.includes("y''all"));
});

// ===========================================================================
// command() dispatch via injected probe
// ===========================================================================

test("command: darwin prefers terminal-notifier", () => {
  const c = desktop.command(
    "darwin",
    { title: "T", body: "B" },
    probeFor(["terminal-notifier", "osascript"])
  );
  assert.equal(c.cmd, "terminal-notifier");
});

test("command: darwin falls back to osascript", () => {
  const c = desktop.command(
    "darwin",
    { title: "T", body: "B" },
    probeFor(["osascript"])
  );
  assert.equal(c.cmd, "osascript");
});

test("command: darwin null when nothing available", () => {
  const c = desktop.command("darwin", { title: "T", body: "B" }, probeFor([]));
  assert.equal(c, null);
});

test("command: linux notify-send present", () => {
  const c = desktop.command(
    "linux",
    { title: "T", body: "B" },
    probeFor(["notify-send"])
  );
  assert.equal(c.cmd, "notify-send");
});

test("command: linux null when notify-send absent", () => {
  const c = desktop.command("linux", { title: "T", body: "B" }, probeFor([]));
  assert.equal(c, null);
});

test("command: win32 powershell present", () => {
  const c = desktop.command(
    "win32",
    { title: "T", body: "B" },
    probeFor(["powershell"])
  );
  assert.equal(c.cmd, "powershell");
});

test("command: win32 null when powershell absent", () => {
  const c = desktop.command("win32", { title: "T", body: "B" }, probeFor([]));
  assert.equal(c, null);
});

test("command: unknown platform is null even with binaries present", () => {
  const c = desktop.command(
    "sunos",
    { title: "T", body: "B" },
    probeFor(["notify-send", "powershell", "osascript", "terminal-notifier"])
  );
  assert.equal(c, null);
});

// ===========================================================================
// notify() / bell() never throw
// ===========================================================================

test("notify: no-op (no throw) when no command resolves", () => {
  assert.doesNotThrow(() =>
    desktop.notify(
      { title: "T", body: "B" },
      { platform: "nope-os", probe: () => false }
    )
  );
});

test("notify: no throw with empty opts and unknown platform", () => {
  assert.doesNotThrow(() =>
    desktop.notify(undefined, { platform: "nope-os", probe: () => false })
  );
});

test("bell: never throws", () => {
  assert.doesNotThrow(() => desktop.bell());
});

// ===========================================================================
// export surface
// ===========================================================================

test("exports expected surface", () => {
  for (const name of [
    "macCommand",
    "linuxCommand",
    "winCommand",
    "command",
    "notify",
    "bell",
  ]) {
    assert.equal(typeof desktop[name], "function", name + " should be a function");
  }
});
```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/channels/desktop.test.js`  
Expected: Before desktop.js exists, the test run aborts at require time: "Error: Cannot find module './desktop'" (MODULE_NOT_FOUND), so node --test reports the file as failed with 0 passing subtests. Once the module is created, all 28 subtests pass.

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/channels/desktop.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";

// channels/desktop.js — native desktop notification command builders + spawn.
//
// Pure command builders (macCommand / linuxCommand / winCommand / command) are
// deterministic and unit-tested. notify() spawns the chosen command detached and
// never throws. bell() writes a BEL to /dev/tty (best effort).
//
// Zero external deps; node builtins only.

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// ---------------------------------------------------------------------------
// escaping helpers
// ---------------------------------------------------------------------------

// AppleScript string escaping: backslash and double-quote.
function escAppleScript(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

// PowerShell single-quoted string escaping: a single quote is doubled.
function escPowerShell(s) {
  return String(s == null ? "" : s).replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

// macCommand(opts, hasTerminalNotifier)
//   opts: {title, subtitle, body, icon, urgent, clickCmd}
//   terminal-notifier path: -title/-subtitle/-message (+ -appIcon, -execute, -timeSensitive)
//   otherwise: osascript -e 'display notification "body" with title "..." subtitle "..."'
function macCommand(opts, hasTerminalNotifier) {
  opts = opts || {};
  const title = opts.title || "";
  const subtitle = opts.subtitle || "";
  const body = opts.body || "";
  const icon = opts.icon || "";
  const urgent = !!opts.urgent;
  const clickCmd = opts.clickCmd || "";

  if (hasTerminalNotifier) {
    const args = ["-title", title, "-message", body];
    if (subtitle) args.push("-subtitle", subtitle);
    if (icon) args.push("-appIcon", icon);
    if (clickCmd) args.push("-execute", clickCmd);
    if (urgent) args.push("-timeSensitive");
    return { cmd: "terminal-notifier", args };
  }

  let script =
    'display notification "' +
    escAppleScript(body) +
    '" with title "' +
    escAppleScript(title) +
    '"';
  if (subtitle) {
    script += ' subtitle "' + escAppleScript(subtitle) + '"';
  }
  return { cmd: "osascript", args: ["-e", script] };
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

// linuxCommand(opts) -> notify-send <title> <body> [--icon icon] [--urgency critical]
function linuxCommand(opts) {
  opts = opts || {};
  const title = opts.title || "";
  const body = opts.body || "";
  const icon = opts.icon || "";
  const urgent = !!opts.urgent;

  const args = [title, body];
  if (icon) args.push("--icon", icon);
  if (urgent) args.push("--urgency", "critical");
  return { cmd: "notify-send", args };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// winCommand(opts) -> powershell toast (Windows.UI.Notifications) with balloon fallback.
function winCommand(opts) {
  opts = opts || {};
  const t = escPowerShell(opts.title || "");
  const b = escPowerShell(opts.body || "");

  const script = [
    "$ErrorActionPreference='Stop';",
    "try {",
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;",
    "$tpl=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
    "$tx=$tpl.GetElementsByTagName('text');",
    "$tx.Item(0).AppendChild($tpl.CreateTextNode('" + t + "'))|Out-Null;",
    "$tx.Item(1).AppendChild($tpl.CreateTextNode('" + b + "'))|Out-Null;",
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($tpl);",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show($toast);",
    "} catch {",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$ni=New-Object System.Windows.Forms.NotifyIcon;",
    "$ni.Icon=[System.Drawing.SystemIcons]::Information;",
    "$ni.Visible=$true;",
    "$ni.BalloonTipTitle='" + t + "';",
    "$ni.BalloonTipText='" + b + "';",
    "$ni.ShowBalloonTip(10000);",
    "}",
  ].join(" ");

  return {
    cmd: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
  };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

// Default PATH probe: returns true if `bin` is found (and executable) on PATH.
function defaultProbe(bin) {
  try {
    const isWin = process.platform === "win32";
    const envPath = process.env.PATH || "";
    const sep = isWin ? ";" : ":";
    const exts = isWin
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
    const dirs = envPath.split(sep);
    for (const dir of dirs) {
      if (!dir) continue;
      for (const ext of exts) {
        const full = path.join(dir, bin + ext);
        try {
          fs.accessSync(full, isWin ? fs.constants.F_OK : fs.constants.X_OK);
          return true;
        } catch (_) {
          /* keep scanning */
        }
      }
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

// command(platform, opts, probe) -> {cmd, args} | null
function command(platform, opts, probe) {
  const p = typeof probe === "function" ? probe : defaultProbe;

  if (platform === "darwin") {
    if (p("terminal-notifier")) return macCommand(opts, true);
    if (p("osascript")) return macCommand(opts, false);
    return null;
  }
  if (platform === "linux") {
    if (p("notify-send")) return linuxCommand(opts);
    return null;
  }
  if (platform === "win32") {
    if (p("powershell")) return winCommand(opts);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// side effects
// ---------------------------------------------------------------------------

// notify(opts, runtime) — spawn the resolved command detached. Never throws.
function notify(opts, runtime = {}) {
  try {
    const platform = runtime.platform || os.platform();
    const probe =
      typeof runtime.probe === "function" ? runtime.probe : defaultProbe;
    const c = command(platform, opts || {}, probe);
    if (!c) return;
    const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch (_) {
    /* fail open */
  }
}

// bell() — best-effort terminal bell (BEL) on /dev/tty.
function bell() {
  try {
    fs.writeFileSync("/dev/tty", "");
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  macCommand,
  linuxCommand,
  winCommand,
  command,
  notify,
  bell,
};
```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/channels/desktop.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/channels/desktop.js plugins/notify/scripts/lib/channels/desktop.test.js
git commit -m "feat(notify): lib/channels/desktop.js"
```

> Author notes: Verified: 28/28 subtests pass under Node v20.20.2 on linux; red state confirmed (require './desktop' -> MODULE_NOT_FOUND). Contract-matching decisions / design choices the plan author should know: - macCommand(opts, hasTerminalNotifier): when hasTerminalNotifier is truthy -> {cmd:"terminal-notifier", args:["-title",title,"-message",body, ...]}. -subtitle/-appIcon/-execute are appended ONLY when the corresponding opt is truthy; -timeSensitive appended only when urgent. terminal-notifier args are passed raw (spawn without a shell -> no escaping needed). When falsy -> {cmd:"osascript", args:["-e"

---

### Task 12: `lib/focus.js`

**Files:**
- Create: `plugins/notify/scripts/lib/focus.js`
- Test: `plugins/notify/scripts/lib/focus.test.js`

Exports: `TERM_BUNDLES`, `bundleIdFor`, `captureHints`, `muxPlan`, `plan`, `clickCommandString`, `focus`

- [ ] **Step 1 — write the failing test** → `plugins/notify/scripts/lib/focus.test.js`

<details><summary>test source (paste verbatim)</summary>

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const focus = require("./focus");

test("exports the documented surface", () => {
  assert.equal(typeof focus.TERM_BUNDLES, "object");
  assert.equal(typeof focus.bundleIdFor, "function");
  assert.equal(typeof focus.captureHints, "function");
  assert.equal(typeof focus.muxPlan, "function");
  assert.equal(typeof focus.plan, "function");
  assert.equal(typeof focus.clickCommandString, "function");
  assert.equal(typeof focus.focus, "function");
});

test("TERM_BUNDLES maps known terminals to bundle ids", () => {
  const b = focus.TERM_BUNDLES;
  assert.equal(b["iTerm.app"], "com.googlecode.iterm2");
  assert.equal(b["Apple_Terminal"], "com.apple.Terminal");
  assert.equal(b["ghostty"], "com.mitchellh.ghostty");
  assert.equal(b["kitty"], "net.kovidgoyal.kitty");
  assert.equal(b["WezTerm"], "com.github.wez.wezterm");
  assert.equal(b["WarpTerminal"], "dev.warp.Warp-Stable");
  assert.equal(b["Alacritty"], "org.alacritty");
  assert.equal(b["Hyper"], "co.zeit.hyper");
  assert.equal(b["vscode"], "com.microsoft.VSCode");
});

test("bundleIdFor resolves via TERM_PROGRAM table", () => {
  assert.equal(focus.bundleIdFor({ TERM_PROGRAM: "iTerm.app" }), "com.googlecode.iterm2");
  assert.equal(focus.bundleIdFor({ TERM_PROGRAM: "Apple_Terminal" }), "com.apple.Terminal");
  assert.equal(focus.bundleIdFor({ TERM_PROGRAM: "vscode" }), "com.microsoft.VSCode");
});

test("bundleIdFor falls back to __CFBundleIdentifier when TERM_PROGRAM unknown", () => {
  assert.equal(
    focus.bundleIdFor({ TERM_PROGRAM: "SomethingNew", __CFBundleIdentifier: "com.example.term" }),
    "com.example.term"
  );
  // No TERM_PROGRAM at all, only the CF id (e.g. kitty on macOS).
  assert.equal(
    focus.bundleIdFor({ __CFBundleIdentifier: "net.kovidgoyal.kitty" }),
    "net.kovidgoyal.kitty"
  );
});

test("bundleIdFor prefers the table over a raw CF id", () => {
  assert.equal(
    focus.bundleIdFor({ TERM_PROGRAM: "iTerm.app", __CFBundleIdentifier: "com.bogus.value" }),
    "com.googlecode.iterm2"
  );
});

test("bundleIdFor returns '' for empty / unknown env", () => {
  assert.equal(focus.bundleIdFor({}), "");
  assert.equal(focus.bundleIdFor({ TERM_PROGRAM: "Unknown" }), "");
});

test("captureHints on macOS records the bundle id", () => {
  const h = focus.captureHints({ TERM_PROGRAM: "iTerm.app" }, "darwin");
  assert.equal(h.bundleId, "com.googlecode.iterm2");
  assert.equal(h.windowId, undefined);
  assert.equal(h.mux, undefined);
});

test("captureHints does not set bundleId off macOS", () => {
  // vscode integrated terminal sets TERM_PROGRAM=vscode even on linux.
  const h = focus.captureHints({ TERM_PROGRAM: "vscode" }, "linux");
  assert.equal(h.bundleId, undefined);
});

test("captureHints records X11 window id from WINDOWID", () => {
  const h = focus.captureHints({ XDG_SESSION_TYPE: "x11", WINDOWID: "0x3200007" }, "linux");
  assert.equal(h.windowId, "0x3200007");
});

test("captureHints ignores WINDOWID when session is not x11", () => {
  const wayland = focus.captureHints({ XDG_SESSION_TYPE: "wayland", WINDOWID: "0x3200007" }, "linux");
  assert.equal(wayland.windowId, undefined);
  const noType = focus.captureHints({ WINDOWID: "0x3200007" }, "linux");
  assert.equal(noType.windowId, undefined);
});

test("captureHints detects tmux", () => {
  const h = focus.captureHints({ TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%3" }, "linux");
  assert.deepEqual(h.mux, { type: "tmux", pane: "%3", socket: "/tmp/tmux-1000/default,123,0" });
});

test("captureHints detects wezterm", () => {
  const h = focus.captureHints({ WEZTERM_PANE: "7" }, "linux");
  assert.deepEqual(h.mux, { type: "wezterm", pane: "7" });
});

test("captureHints detects kitty", () => {
  const h = focus.captureHints(
    { KITTY_WINDOW_ID: "2", KITTY_LISTEN_ON: "unix:/tmp/kitty-sock" },
    "linux"
  );
  assert.deepEqual(h.mux, { type: "kitty", windowId: "2", socket: "unix:/tmp/kitty-sock" });
});

test("captureHints detects zellij", () => {
  const h = focus.captureHints({ ZELLIJ: "0", ZELLIJ_SESSION_NAME: "main" }, "linux");
  assert.deepEqual(h.mux, { type: "zellij", session: "main" });
});

test("captureHints prefers tmux when both tmux and wezterm vars are present", () => {
  const h = focus.captureHints({ TMUX: "/tmp/sock", TMUX_PANE: "%1", WEZTERM_PANE: "5" }, "darwin");
  assert.equal(h.mux.type, "tmux");
  assert.equal(h.mux.pane, "%1");
});

test("muxPlan builds a tmux select-window command", () => {
  assert.deepEqual(
    focus.muxPlan({ mux: { type: "tmux", pane: "%3" } }),
    [["tmux", ["select-window", "-t", "%3"]]]
  );
});

test("muxPlan tmux without a pane yields nothing", () => {
  assert.deepEqual(focus.muxPlan({ mux: { type: "tmux", pane: "" } }), []);
});

test("muxPlan builds a wezterm activate-pane command", () => {
  assert.deepEqual(
    focus.muxPlan({ mux: { type: "wezterm", pane: "7" } }),
    [["wezterm", ["cli", "activate-pane", "--pane-id", "7"]]]
  );
});

test("muxPlan builds a kitty focus-window command with socket + id", () => {
  assert.deepEqual(
    focus.muxPlan({ mux: { type: "kitty", windowId: "2", socket: "unix:/tmp/k" } }),
    [["kitty", ["@", "--to", "unix:/tmp/k", "focus-window", "--match", "id:2"]]]
  );
});

test("muxPlan kitty without socket/id is still valid", () => {
  assert.deepEqual(
    focus.muxPlan({ mux: { type: "kitty" } }),
    [["kitty", ["@", "focus-window"]]]
  );
});

test("muxPlan zellij and missing mux yield nothing", () => {
  assert.deepEqual(focus.muxPlan({ mux: { type: "zellij", session: "main" } }), []);
  assert.deepEqual(focus.muxPlan({}), []);
  assert.deepEqual(focus.muxPlan(), []);
});

test("plan on linux activates by window id then mux, in order", () => {
  const hints = { windowId: "0x55", mux: { type: "tmux", pane: "%2" } };
  assert.deepEqual(
    focus.plan(hints, { platform: "linux", env: {} }),
    [
      ["xdotool", ["windowactivate", "--sync", "0x55"]],
      ["wmctrl", ["-i", "-a", "0x55"]],
      ["tmux", ["select-window", "-t", "%2"]],
    ]
  );
});

test("plan on linux with only a window id omits mux commands", () => {
  assert.deepEqual(
    focus.plan({ windowId: "0x55" }, { platform: "linux", env: {} }),
    [
      ["xdotool", ["windowactivate", "--sync", "0x55"]],
      ["wmctrl", ["-i", "-a", "0x55"]],
    ]
  );
});

test("plan on GNOME without a window id uses the busctl title fallback", () => {
  const hints = { title: "my session" };
  const runtime = { platform: "linux", env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" } };
  assert.deepEqual(focus.plan(hints, runtime), [
    ["busctl", [
      "--user", "call",
      "org.gnome.Shell", "/org/gnome/Shell/Extensions/WindowsExt",
      "org.gnome.Shell.Extensions.WindowsExt", "ActivateWindowByTitle",
      "s", "my session",
    ]],
  ]);
});

test("plan on linux without window id, gnome, or title only returns mux", () => {
  assert.deepEqual(
    focus.plan({ mux: { type: "wezterm", pane: "9" } }, { platform: "linux", env: {} }),
    [["wezterm", ["cli", "activate-pane", "--pane-id", "9"]]]
  );
  assert.deepEqual(focus.plan({}, { platform: "linux", env: {} }), []);
});

test("plan on macOS activates the app by bundle id then switches mux", () => {
  const hints = { bundleId: "com.apple.Terminal", mux: { type: "tmux", pane: "%4" } };
  assert.deepEqual(focus.plan(hints, { platform: "darwin", env: {} }), [
    ["osascript", ["-e", 'tell application id "com.apple.Terminal" to activate']],
    ["tmux", ["select-window", "-t", "%4"]],
  ]);
});

test("plan on macOS with no bundle id returns only mux", () => {
  assert.deepEqual(
    focus.plan({ mux: { type: "wezterm", pane: "1" } }, { platform: "darwin", env: {} }),
    [["wezterm", ["cli", "activate-pane", "--pane-id", "1"]]]
  );
});

test("plan on win32 does not attempt window focus (mux only)", () => {
  // A captured X11 window id must be ignored on win32.
  assert.deepEqual(focus.plan({ windowId: "0x55" }, { platform: "win32", env: {} }), []);
  assert.deepEqual(
    focus.plan({ windowId: "0x55", mux: { type: "tmux", pane: "%9" } }, { platform: "win32", env: {} }),
    [["tmux", ["select-window", "-t", "%9"]]]
  );
});

test("clickCommandString builds the macOS -execute string (app + mux)", () => {
  const hints = { bundleId: "com.googlecode.iterm2", mux: { type: "tmux", pane: "%3" } };
  assert.equal(
    focus.clickCommandString(hints, { platform: "darwin" }),
    "osascript -e 'tell application id \"com.googlecode.iterm2\" to activate' ; tmux select-window -t %3"
  );
});

test("clickCommandString with only a bundle id omits the mux clause", () => {
  assert.equal(
    focus.clickCommandString({ bundleId: "com.apple.Terminal" }, { platform: "darwin" }),
    "osascript -e 'tell application id \"com.apple.Terminal\" to activate'"
  );
});

test("clickCommandString returns '' off macOS", () => {
  const hints = { bundleId: "com.googlecode.iterm2", mux: { type: "tmux", pane: "%3" } };
  assert.equal(focus.clickCommandString(hints, { platform: "linux" }), "");
  assert.equal(focus.clickCommandString(hints, { platform: "win32" }), "");
});

test("clickCommandString returns '' when there is nothing to do", () => {
  assert.equal(focus.clickCommandString({}, { platform: "darwin" }), "");
});

test("focus() never throws for an empty plan", () => {
  assert.doesNotThrow(() => focus.focus({}, { platform: "win32" }));
});

```

</details>

- [ ] **Step 2 — run, expect RED**

Run: `node --test plugins/notify/scripts/lib/focus.test.js`  
Expected: Before lib/focus.js exists, `require("./focus")` throws and the run aborts at module load: "Error: Cannot find module './focus'" with "error: 'test failed'" and a non-zero exit (0 of the 33 subtests run). After implementation, `node --test` prints "# pass 33 / # fail 0".

- [ ] **Step 3 — write the implementation** → `plugins/notify/scripts/lib/focus.js`

<details><summary>impl source (paste verbatim)</summary>

```js
"use strict";
// focus.js — best-effort click-to-focus planning + spawn.
//
// Pure planners (bundleIdFor, captureHints, muxPlan, plan, clickCommandString)
// are deterministic given their inputs and are unit-tested. focus() is the only
// side-effecting export (detached spawn) and is intentionally not unit-tested.
//
// Zero external deps. Node builtins only.

const os = require("node:os");
const child_process = require("node:child_process");

// macOS TERM_PROGRAM / __CFBundleIdentifier -> bundle id map.
// Keys are the values Claude Code's terminal sets in $TERM_PROGRAM.
const TERM_BUNDLES = {
  "iTerm.app": "com.googlecode.iterm2",
  "Apple_Terminal": "com.apple.Terminal",
  "ghostty": "com.mitchellh.ghostty",
  "kitty": "net.kovidgoyal.kitty",
  "WezTerm": "com.github.wez.wezterm",
  "WarpTerminal": "dev.warp.Warp-Stable",
  "Alacritty": "org.alacritty",
  "Hyper": "co.zeit.hyper",
  "vscode": "com.microsoft.VSCode",
};

// Resolve the macOS application bundle id from the environment.
// Prefer the curated TERM_PROGRAM mapping; fall back to the raw
// __CFBundleIdentifier macOS injects for the launching app. "" if unknown.
function bundleIdFor(env) {
  env = env || process.env || {};
  const tp = env.TERM_PROGRAM;
  if (tp && Object.prototype.hasOwnProperty.call(TERM_BUNDLES, tp)) {
    return TERM_BUNDLES[tp];
  }
  const cf = env.__CFBundleIdentifier;
  if (cf) return String(cf);
  return "";
}

// True when the desktop environment looks like GNOME (for the Wayland fallback).
function isGnome(env) {
  const d = String((env && (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION)) || "").toLowerCase();
  return d.indexOf("gnome") !== -1;
}

// Detect the active terminal multiplexer from the environment.
// Returns { type, ...ids } or null. tmux takes priority (it commonly wraps the
// others), then wezterm, kitty, zellij.
function detectMux(env) {
  env = env || {};
  if (env.TMUX) {
    return { type: "tmux", pane: env.TMUX_PANE || "", socket: env.TMUX };
  }
  if (env.WEZTERM_PANE) {
    return { type: "wezterm", pane: env.WEZTERM_PANE };
  }
  if (env.KITTY_WINDOW_ID) {
    return { type: "kitty", windowId: env.KITTY_WINDOW_ID, socket: env.KITTY_LISTEN_ON || "" };
  }
  if (env.ZELLIJ) {
    return { type: "zellij", session: env.ZELLIJ_SESSION_NAME || "" };
  }
  return null;
}

// Capture cheap focus hints from the environment, to be persisted in session
// state during PreToolUse/Notification and replayed on click.
// Shape: { bundleId?, windowId?, mux? }
function captureHints(env, platform) {
  env = env || process.env || {};
  if (platform === undefined) platform = os.platform();
  const hints = {};
  if (platform === "darwin") {
    const b = bundleIdFor(env);
    if (b) hints.bundleId = b;
  }
  // X11 exposes the focused terminal window id via $WINDOWID.
  if (env.XDG_SESSION_TYPE === "x11" && env.WINDOWID) {
    hints.windowId = String(env.WINDOWID);
  }
  const mux = detectMux(env);
  if (mux) hints.mux = mux;
  return hints;
}

// Build the multiplexer pane-switch command plan from captured hints.
// Returns ordered [cmd, args] tuples (possibly empty).
function muxPlan(hints) {
  hints = hints || {};
  const m = hints.mux;
  if (!m || !m.type) return [];
  switch (m.type) {
    case "tmux": {
      if (!m.pane) return [];
      return [["tmux", ["select-window", "-t", String(m.pane)]]];
    }
    case "wezterm": {
      if (!m.pane) return [];
      return [["wezterm", ["cli", "activate-pane", "--pane-id", String(m.pane)]]];
    }
    case "kitty": {
      const args = ["@"];
      if (m.socket) args.push("--to", String(m.socket));
      args.push("focus-window");
      if (m.windowId) args.push("--match", "id:" + String(m.windowId));
      return [["kitty", args]];
    }
    case "zellij":
      // zellij has no reliable external "raise my pane" command; best-effort no-op.
      return [];
    default:
      return [];
  }
}

// Build the ordered activation command plan for the given platform.
// runtime: { platform = os.platform(), env = process.env }
function plan(hints, runtime) {
  hints = hints || {};
  runtime = runtime || {};
  const platform = runtime.platform || os.platform();
  const env = runtime.env || process.env || {};
  const out = [];

  if (platform === "darwin") {
    if (hints.bundleId) {
      out.push(["osascript", ["-e", 'tell application id "' + hints.bundleId + '" to activate']]);
    }
  } else if (platform === "linux") {
    if (hints.windowId) {
      out.push(["xdotool", ["windowactivate", "--sync", String(hints.windowId)]]);
      out.push(["wmctrl", ["-i", "-a", String(hints.windowId)]]);
    } else if (isGnome(env) && hints.title) {
      // Wayland/GNOME best-effort; requires a window-activation shell extension.
      out.push(["busctl", [
        "--user", "call",
        "org.gnome.Shell", "/org/gnome/Shell/Extensions/WindowsExt",
        "org.gnome.Shell.Extensions.WindowsExt", "ActivateWindowByTitle",
        "s", String(hints.title),
      ]]);
    }
  }
  // win32 window focus is intentionally not attempted.

  for (const c of muxPlan(hints)) out.push(c);
  return out;
}

// Shell-quote a single token for the macOS terminal-notifier -execute string.
function shToken(s) {
  s = String(s);
  if (s.length && /^[A-Za-z0-9_./:%@=,+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function renderCmd(tuple) {
  const cmd = tuple[0];
  const args = tuple[1] || [];
  return [cmd].concat(args).map(shToken).join(" ");
}

// Build the macOS terminal-notifier -execute shell string: activate the
// terminal app by bundle id, then switch the multiplexer pane. "" if nothing.
function clickCommandString(hints, runtime) {
  hints = hints || {};
  runtime = runtime || {};
  const platform = runtime.platform || os.platform();
  if (platform !== "darwin") return "";
  const cmds = [];
  if (hints.bundleId) {
    cmds.push(["osascript", ["-e", 'tell application id "' + hints.bundleId + '" to activate']]);
  }
  for (const c of muxPlan(hints)) cmds.push(c);
  if (!cmds.length) return "";
  return cmds.map(renderCmd).join(" ; ");
}

// Side-effecting: spawn each planned command detached. Never throws.
function focus(hints, runtime) {
  runtime = runtime || {};
  try {
    const cmds = plan(hints, runtime);
    for (const tuple of cmds) {
      try {
        const child = child_process.spawn(tuple[0], tuple[1] || [], {
          stdio: "ignore",
          detached: true,
        });
        child.on("error", function () {});
        child.unref();
      } catch (_) {
        /* fall through to next command */
      }
    }
  } catch (_) {
    /* never throw */
  }
}

module.exports = {
  TERM_BUNDLES,
  bundleIdFor,
  captureHints,
  muxPlan,
  plan,
  clickCommandString,
  focus,
};

```

</details>

- [ ] **Step 4 — run, expect GREEN**

Run: `node --test plugins/notify/scripts/lib/focus.test.js`  
Expected: all subtests pass.

- [ ] **Step 5 — commit**

```bash
git add plugins/notify/scripts/lib/focus.js plugins/notify/scripts/lib/focus.test.js
git commit -m "feat(notify): lib/focus.js"
```

> Author notes: Verified: 33/33 subtests pass on Node v20.20.2 (also Node>=18; uses only node:test, node:assert/strict, node:os, node:child_process). Red state confirmed (Cannot find module './focus'). Files written to /home/sokhi/projects/claude-notify/plugins/notify/scripts/lib/focus.js and focus.test.js. Design decisions / assumptions (flagging for the plan author since the contract left some details open): - bundleIdFor priority: TERM_PROGRAM table lookup FIRST, then raw __CFBundleIdentifier as fallback, then "". This lets curated ids win while still resolving apps not in the table (e.g. kitty on macOS se

---

### Task 13: `notify.js` orchestrator

**Files:**
- Create: `plugins/notify/scripts/notify.js`

This wires every `lib/` module in the ported pipeline order (judge-mode bail → focus-hint capture → 2s early-dup → desktop-enabled gate → transcript load → subagent gates → classify → status-enabled gate → suppressFilters → 2s send lock → question cooldowns → record task-complete → build message → 5s content lock + 180s dup-message → persist → fire desktop+sound+bell → GC). Fail-open: any throw is caught and the process still exits 0. `NOTIFY_DRY_RUN=1` prints the resolved payload instead of firing.

- [ ] **Step 1 — write `notify.js` (paste verbatim)**

<details><summary>notify.js source</summary>

```js
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

```

</details>

- [ ] **Step 2 — dry-run smoke test (a `task_complete` Stop)**

```bash
cd /home/sokhi/projects/claude-notify/plugins/notify
T=$(ls -t ~/.claude/projects/*/*.jsonl | head -1)
printf '{"hook_event_name":"Stop","session_id":"smoke","transcript_path":"%s","cwd":"%s"}' "$T" "$PWD" \\
  | NOTIFY_DRY_RUN=1 node scripts/notify.js Stop
```
Expected: a JSON payload with `status`, `title` (e.g. `✅ Completed [<label>]`), `subtitle`, `body`, `sound`. No popup fires (dry run).

- [ ] **Step 3 — commit**

```bash
git add plugins/notify/scripts/notify.js
git commit -m "feat(notify): orchestrator wiring the full pipeline"
```

---

### Task 14: hooks manifest + example config

**Files:**
- Create: `plugins/notify/.claude-plugin/plugin.json`
- Create: `plugins/notify/config.example.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1 — `plugins/notify/.claude-plugin/plugin.json`** (hooks inlined — string-path hook files do not load; see commit f9faa5c)

```json
{
  "name": "notify",
  "description": "Smart notifications for Claude Code. Classifies each turn from the transcript (task done / review / question / plan ready / session limit / API error) and fires a native desktop popup + per-status sound + terminal bell, with suppression, per-status config, and best-effort click-to-focus. Cross-platform, pure Node, zero dependencies.",
  "version": "2.0.0",
  "author": { "name": "assokhi" },
  "keywords": ["notification", "desktop", "sound", "toast", "hooks", "alert", "transcript", "productivity"],
  "hooks": {
    "PreToolUse": [
      { "matcher": "ExitPlanMode|AskUserQuestion",
        "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/notify.js\" PreToolUse", "timeout": 10 } ] }
    ],
    "Notification": [
      { "matcher": "permission_prompt",
        "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/notify.js\" Notification", "timeout": 10 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/notify.js\" Stop", "timeout": 10 } ] }
    ],
    "SubagentStop": [
      { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/notify.js\" SubagentStop", "timeout": 10 } ] }
    ]
  }
}
```

- [ ] **Step 2 — `plugins/notify/config.example.json`** — generate from `config.js` DEFAULTS so it never drifts:

```bash
cd /home/sokhi/projects/claude-notify/plugins/notify
node -e "const c=require('./scripts/lib/config');process.stdout.write(JSON.stringify(c.DEFAULTS,null,2)+'\n')" > config.example.json
```

- [ ] **Step 3 — replace `.claude-plugin/marketplace.json`**

```json
{
  "name": "claude-notify",
  "owner": { "name": "assokhi" },
  "plugins": [
    {
      "name": "notify",
      "source": "./plugins/notify",
      "description": "Smart Claude Code notifications: transcript-classified desktop popups + per-status sounds, suppression, config, best-effort click-to-focus. Pure Node, cross-platform."
    }
  ]
}
```

- [ ] **Step 4 — commit**

```bash
git add plugins/notify/.claude-plugin/plugin.json plugins/notify/config.example.json .claude-plugin/marketplace.json
git commit -m "feat(notify): hooks manifest, example config, marketplace entry"
```

---

### Task 15: documentation

**Files:**
- Rewrite: `plugins/notify/README.md` (features, the 8 statuses, config reference incl every field + per-status overrides + suppressFilters, click-to-focus limitations, `NOTIFY_DRY_RUN`, install path `notify@claude-notify`)
- Rewrite: root `README.md` (marketplace now ships `notify`; install/uninstall, local-path testing)

- [ ] **Step 1 — write both READMEs** (content per spec; document config path `~/.claude/claude-notify/config.json`, that it is OPTIONAL — defaults work with no config — and that click-to-focus on macOS is app-level only, Linux is best-effort/X11, Windows unsupported).
- [ ] **Step 2 — commit**

```bash
git add plugins/notify/README.md README.md
git commit -m "docs(notify): rewrite READMEs for the smart-notify feature set"
```

---

### Task 16: full-suite verification + manual smoke

- [ ] **Step 1 — run the entire test suite**

```bash
cd /home/sokhi/projects/claude-notify/plugins/notify
node --test
```
Expected: every `scripts/lib/**/*.test.js` passes, 0 failures.

- [ ] **Step 2 — real desktop smoke (optional, local)** — drop `NOTIFY_DRY_RUN` and pipe the same fixture to confirm a real popup + sound on this machine:

```bash
cd /home/sokhi/projects/claude-notify/plugins/notify
T=$(ls -t ~/.claude/projects/*/*.jsonl | head -1)
printf '{"hook_event_name":"Stop","session_id":"smoke","transcript_path":"%s","cwd":"%s"}' "$T" "$PWD" | node scripts/notify.js Stop
```
Expected (Linux): a `notify-send` popup + a sound if a player is installed; silent-but-clean if not. Never a non-zero exit.

- [ ] **Step 3 — install locally and verify hooks load**

```text
/plugin marketplace add /home/sokhi/projects/claude-notify
/plugin install notify@claude-notify
# restart Claude Code or open /hooks once
```

- [ ] **Step 4 — final commit / tag**

```bash
git add -A
git commit -m "chore(notify): v2.0.0 — smart notifications" || true
```

---

## Appendix: cross-module audit

Verdict: **consistent = true**. Cross-module wiring is consistent: every require() ('./transcript' from classify/summary/git, all within lib/) targets real exports with correct arity/return shapes; status strings agree across classify.STATUS, config.statuses keys, and summary.bodyFor cases (config's omission of 'unknown' is correct and handled gracefully); all function signatures match the contract with nowSec last/in opts; no wrong require paths; no missing contract exports; only node builtins used; every test creates the files it needs (git test stubs execSync; session-label golden values verified to reproduce exactly); and focus.js is confirmed at lib/focus.js, not under channels/. Two within-module defects found (not cross-module signature mismatches): desktop.bell() writes an empty string instead of the BEL char, and focus.plan()'s GNOME fallback reads a hints.title field that captureHints never produces.

- **[warning] lib/channels/desktop.js** — bell() writes fs.writeFileSync("/dev/tty", "") — an empty string — instead of the BEL character. The contract says write "". Confirmed on disk (line 201). Net effect: the configured terminal bell (DEFAULTS.desktop.terminalBell: true) never rings; the write is a silent no-op. Best-effort/isolated so it won't crash the pipeline, but it is wrong behavior for a shipped feature. _Fix:_ Change the write to fs.writeFileSync("/dev/tty", ""); (or "\x07").
- **[warning] lib/focus.js** — plan() (and only plan()) branches the GNOME/Wayland busctl fallback on hints.title (lines 134 and 140), but the documented producer captureHints() returns shape {bundleId?, windowId?, mux?} and never sets a title field. So the GNOME ActivateWindowByTitle path is unreachable from hints captured by this module — a producer/consumer shape mismatch. Best-effort focus, so impact is limited to GNOME-Wayland not focusing. _Fix:_ Either have captureHints() populate hints.title on linux (e.g. from a session/window title env var) so the plan() fallback can fire, or drop the title-based busctl branch from plan() to match the captureHints contract. Pick one so producer and consumer agree on the hints shape.

Fix status: desktop `bell()` BEL char folded into Task 11 code above. Focus GNOME-by-title branch (Task 12) is inert (captureHints never sets `title`); left as a documented no-op since click-to-focus is best-effort — optionally delete that branch during Task 12.

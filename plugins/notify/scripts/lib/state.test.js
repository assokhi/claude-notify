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

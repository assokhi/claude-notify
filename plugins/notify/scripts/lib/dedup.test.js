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

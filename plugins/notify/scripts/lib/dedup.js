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

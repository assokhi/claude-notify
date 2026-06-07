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

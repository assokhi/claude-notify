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
      // Bound the only blocking subprocess on the hook's critical path: a slow
      // NFS/huge/pathological repo must not hang the notification. On timeout
      // execSync throws -> the catch below returns "" (fail-open).
      timeout: 1000,
      maxBuffer: 1 << 16,
    });
    const b = (out == null ? "" : String(out)).trim();
    if (!b || b === "HEAD") return "";
    return b;
  } catch (_) {
    return "";
  }
}

module.exports = { branch };
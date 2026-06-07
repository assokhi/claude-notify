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

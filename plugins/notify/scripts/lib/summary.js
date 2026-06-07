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
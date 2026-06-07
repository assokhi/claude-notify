"use strict";

// Integration tests for the orchestrator. notify.js is driven as a child
// process with NOTIFY_DRY_RUN=1 (so it prints the resolved payload instead of
// firing anything). Each test gets an isolated TMPDIR (locks/state) and HOME
// (config path) so runs never interfere. These lock in the two contracts the
// orchestrator must never break: always exit 0, and correct cross-module wiring.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NOTIFY = path.join(__dirname, "notify.js");

function freshDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "notify-" + tag + "-"));
}

// Write a transcript whose last turn ran an active tool -> task_complete.
function writeTaskTranscript(dir, name) {
  const p = path.join(dir, name || "t.jsonl");
  const lines = [
    { type: "user", timestamp: "2026-06-07T10:00:00.000Z", gitBranch: "main", cwd: "/proj/app", message: { role: "user", content: "do the thing" } },
    { type: "assistant", timestamp: "2026-06-07T10:00:05.000Z", gitBranch: "main", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
    { type: "assistant", timestamp: "2026-06-07T10:00:06.000Z", gitBranch: "main", message: { role: "assistant", content: [{ type: "text", text: "All done." }] } },
  ];
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

// Run notify.js <event> feeding hook JSON on stdin. Returns {status, stdout, stderr}.
function run(event, hook, env) {
  const tmp = (env && env.TMPDIR) || freshDir("run");
  const home = (env && env.HOME) || freshDir("home");
  const r = spawnSync(process.execPath, [NOTIFY, event], {
    input: JSON.stringify(hook),
    encoding: "utf8",
    env: Object.assign({}, process.env, { NOTIFY_DRY_RUN: "1", TMPDIR: tmp, HOME: home }, env || {}),
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", tmp, home };
}

function parseOut(stdout) {
  const s = stdout.trim();
  return s ? JSON.parse(s) : null;
}

test("Stop on a task transcript: exit 0, dry-run JSON with task_complete", () => {
  const dir = freshDir("tx");
  const tpath = writeTaskTranscript(dir);
  const r = run("Stop", { hook_event_name: "Stop", session_id: "s1", transcript_path: tpath, cwd: "/proj/app" });
  assert.equal(r.status, 0);
  const out = parseOut(r.stdout);
  assert.ok(out, "should print a dry-run payload");
  assert.equal(out.status, "task_complete");
  assert.match(out.title, /Completed/);
  assert.ok(out.title.includes("["), "title carries a session label");
  assert.equal(out.subtitle, "main · app");
  assert.ok(out.body.length > 0);
  assert.ok(out.sound.endsWith("complete.wav"));
});

test("Notification: exit 0, classified as question", () => {
  const r = run("Notification", { hook_event_name: "Notification", session_id: "s2", message: "needs permission", cwd: "/proj/app" });
  assert.equal(r.status, 0);
  const out = parseOut(r.stdout);
  assert.ok(out);
  assert.equal(out.status, "question");
  assert.match(out.title, /Question/);
});

test("PreToolUse ExitPlanMode: exit 0, plan_ready", () => {
  const r = run("PreToolUse", { hook_event_name: "PreToolUse", session_id: "s3", tool_name: "ExitPlanMode", cwd: "/proj/app" });
  assert.equal(r.status, 0);
  const out = parseOut(r.stdout);
  assert.ok(out);
  assert.equal(out.status, "plan_ready");
});

test("malformed JSON on stdin: exit 0, no output, no crash", () => {
  const r = spawnSync(process.execPath, [NOTIFY, "Stop"], {
    input: "{not json",
    encoding: "utf8",
    env: Object.assign({}, process.env, { NOTIFY_DRY_RUN: "1", TMPDIR: freshDir("t"), HOME: freshDir("h") }),
  });
  assert.equal(r.status, 0);
  assert.equal((r.stdout || "").trim(), "");
});

test("empty stdin: exit 0, no output", () => {
  const r = spawnSync(process.execPath, [NOTIFY, "Stop"], {
    input: "",
    encoding: "utf8",
    env: Object.assign({}, process.env, { NOTIFY_DRY_RUN: "1", TMPDIR: freshDir("t"), HOME: freshDir("h") }),
  });
  assert.equal(r.status, 0);
  assert.equal((r.stdout || "").trim(), "");
});

test("judge mode suppresses everything", () => {
  const dir = freshDir("tx");
  const tpath = writeTaskTranscript(dir);
  const r = run("Stop", { hook_event_name: "Stop", session_id: "s4", transcript_path: tpath, cwd: "/proj/app" }, { CLAUDE_HOOK_JUDGE_MODE: "true" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("desktop.enabled=false (user config) suppresses output", () => {
  const home = freshDir("home");
  const cfgDir = path.join(home, ".claude", "claude-notify");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ desktop: { enabled: false } }));
  const dir = freshDir("tx");
  const tpath = writeTaskTranscript(dir);
  const r = run("Stop", { hook_event_name: "Stop", session_id: "s5", transcript_path: tpath, cwd: "/proj/app" }, { HOME: home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("2s throttle: a 2nd identical event is suppressed", () => {
  const tmp = freshDir("tmp");
  const home = freshDir("home");
  const dir = freshDir("tx");
  const tpath = writeTaskTranscript(dir);
  const hook = { hook_event_name: "Stop", session_id: "sThrottle", transcript_path: tpath, cwd: "/proj/app" };
  const first = run("Stop", hook, { TMPDIR: tmp, HOME: home });
  const second = run("Stop", hook, { TMPDIR: tmp, HOME: home });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.ok(parseOut(first.stdout), "first fires");
  assert.equal(second.stdout.trim(), "", "second within 2s is throttled");
});

test("subagent transcript path is suppressed on Stop by default", () => {
  const dir = freshDir("subagents"); // dir name contains 'subagents'
  const subDir = path.join(dir, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  const tpath = writeTaskTranscript(subDir);
  assert.ok(tpath.includes("/subagents/"));
  const r = run("Stop", { hook_event_name: "Stop", session_id: "s6", transcript_path: tpath, cwd: "/proj/app" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("SubagentStop suppressed unless notifyOnSubagentStop is set", () => {
  const dir = freshDir("tx");
  const tpath = writeTaskTranscript(dir);
  const r = run("SubagentStop", { hook_event_name: "SubagentStop", session_id: "s7", transcript_path: tpath, cwd: "/proj/app" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "SubagentStop off by default");
});

test("SubagentStop fires when notifyOnSubagentStop=true in config", () => {
  const home = freshDir("home");
  const cfgDir = path.join(home, ".claude", "claude-notify");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ notifyOnSubagentStop: true }));
  const dir = freshDir("tx");
  const tpath = writeTaskTranscript(dir);
  const r = run("SubagentStop", { hook_event_name: "SubagentStop", session_id: "s8", transcript_path: tpath, cwd: "/proj/app" }, { HOME: home });
  assert.equal(r.status, 0);
  const out = parseOut(r.stdout);
  assert.ok(out, "should fire when enabled");
  assert.equal(out.status, "task_complete");
});

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

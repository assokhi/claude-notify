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

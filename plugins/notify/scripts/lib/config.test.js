"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("./config");

// --- helpers --------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-notify-cfg-"));
}

function writeConfig(obj) {
  const dir = tmpDir();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
}

// nonexistent path inside a fresh temp dir
function missingConfigPath() {
  return path.join(tmpDir(), "does-not-exist.json");
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = "";
  process.stderr.write = function (chunk) {
    out += String(chunk);
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: out };
  } finally {
    process.stderr.write = orig;
  }
}

// --- DEFAULTS shape -------------------------------------------------------

test("DEFAULTS has the exact top-level flags and cooldowns", () => {
  assert.equal(config.DEFAULTS.suppressQuestionAfterTaskCompleteSeconds, 12);
  assert.equal(config.DEFAULTS.suppressQuestionAfterAnyNotificationSeconds, 7);
  assert.equal(config.DEFAULTS.notifyOnSubagentStop, false);
  assert.equal(config.DEFAULTS.suppressForSubagents, true);
  assert.equal(config.DEFAULTS.notifyOnTextResponse, true);
  assert.equal(config.DEFAULTS.respectJudgeMode, true);
  assert.deepEqual(config.DEFAULTS.suppressFilters, []);
});

test("DEFAULTS.desktop matches spec", () => {
  assert.deepEqual(config.DEFAULTS.desktop, {
    enabled: true,
    sound: true,
    terminalBell: true,
    volume: 1.0,
    appIcon: "",
    clickToFocus: true,
  });
});

test("DEFAULTS.statuses has all 7 statuses with titles and placeholder sounds", () => {
  const keys = Object.keys(config.DEFAULTS.statuses).sort();
  assert.deepEqual(keys, [
    "api_error",
    "api_error_overloaded",
    "plan_ready",
    "question",
    "review_complete",
    "session_limit_reached",
    "task_complete",
  ]);
  assert.equal(config.DEFAULTS.statuses.task_complete.title, "✅ Completed");
  assert.equal(config.DEFAULTS.statuses.review_complete.title, "🔍 Review");
  assert.equal(config.DEFAULTS.statuses.question.title, "❓ Question");
  assert.equal(config.DEFAULTS.statuses.plan_ready.title, "📋 Plan");
  assert.equal(
    config.DEFAULTS.statuses.session_limit_reached.title,
    "⏱️ Session Limit Reached"
  );
  assert.equal(config.DEFAULTS.statuses.api_error.title, "🔴 API Error: 401");
  assert.equal(config.DEFAULTS.statuses.api_error_overloaded.title, "🔴 API Error");

  assert.equal(
    config.DEFAULTS.statuses.task_complete.sound,
    "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav"
  );
  assert.equal(
    config.DEFAULTS.statuses.review_complete.sound,
    "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav"
  );
  assert.equal(
    config.DEFAULTS.statuses.question.sound,
    "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav"
  );
  for (const k of Object.keys(config.DEFAULTS.statuses)) {
    assert.equal(config.DEFAULTS.statuses[k].enabled, true);
  }
});

// --- defaultConfig clone --------------------------------------------------

test("defaultConfig returns an independent deep clone", () => {
  const a = config.defaultConfig();
  a.desktop.volume = 0;
  a.statuses.task_complete.title = "MUTATED";
  a.suppressFilters.push({ status: "question" });

  const b = config.defaultConfig();
  assert.equal(b.desktop.volume, 1.0);
  assert.equal(b.statuses.task_complete.title, "✅ Completed");
  assert.deepEqual(b.suppressFilters, []);

  // DEFAULTS itself untouched
  assert.equal(config.DEFAULTS.desktop.volume, 1.0);
  assert.equal(config.DEFAULTS.statuses.task_complete.title, "✅ Completed");
});

// --- expandEnv ------------------------------------------------------------

test("expandEnv replaces ${NAME} from injected env", () => {
  assert.equal(config.expandEnv("a${X}b", { X: "Y" }), "aYb");
  assert.equal(config.expandEnv("${A}-${B}", { A: "1", B: "2" }), "1-2");
});

test("expandEnv tolerates inner whitespace ${ NAME }", () => {
  assert.equal(config.expandEnv("a${ X }b", { X: "Y" }), "aYb");
  assert.equal(config.expandEnv("${  CLAUDE_PLUGIN_ROOT  }/s", { CLAUDE_PLUGIN_ROOT: "/r" }), "/r/s");
});

test("expandEnv maps unknown vars to empty string", () => {
  assert.equal(config.expandEnv("${MISSING}", {}), "");
  assert.equal(config.expandEnv("x${MISSING}y", { OTHER: "z" }), "xy");
});

test("expandEnv passes through strings with no placeholders", () => {
  assert.equal(config.expandEnv("no vars here", { X: "Y" }), "no vars here");
});

test("expandEnv coerces non-string input to empty string", () => {
  assert.equal(config.expandEnv(123, {}), "");
  assert.equal(config.expandEnv(null, {}), "");
  assert.equal(config.expandEnv(undefined, {}), "");
});

// --- load: no file --------------------------------------------------------

test("load with missing file returns defaults (no warning)", () => {
  const { result, stderr } = captureStderr(() =>
    config.load({ configPath: missingConfigPath(), pluginRoot: "/plug", env: {} })
  );
  assert.equal(stderr, "");
  assert.equal(result.notifyOnTextResponse, true);
  assert.equal(result.desktop.enabled, true);
  assert.equal(result.suppressQuestionAfterAnyNotificationSeconds, 7);
});

test("load expands ${CLAUDE_PLUGIN_ROOT} in status sounds via pluginRoot", () => {
  const cfg = config.load({
    configPath: missingConfigPath(),
    pluginRoot: "/opt/plug",
    env: {},
  });
  assert.equal(config.soundFor(cfg, "task_complete"), "/opt/plug/sounds/complete.wav");
  assert.equal(config.soundFor(cfg, "question"), "/opt/plug/sounds/notification.wav");
  // DEFAULTS placeholder remains untouched after a load
  assert.equal(
    config.DEFAULTS.statuses.task_complete.sound,
    "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav"
  );
});

test("load falls back to env CLAUDE_PLUGIN_ROOT when no pluginRoot opt", () => {
  const cfg = config.load({
    configPath: missingConfigPath(),
    env: { CLAUDE_PLUGIN_ROOT: "/envroot" },
  });
  assert.equal(config.soundFor(cfg, "task_complete"), "/envroot/sounds/complete.wav");
});

test("pluginRoot opt overrides env CLAUDE_PLUGIN_ROOT", () => {
  const cfg = config.load({
    configPath: missingConfigPath(),
    pluginRoot: "/from-opt",
    env: { CLAUDE_PLUGIN_ROOT: "/from-env" },
  });
  assert.equal(config.soundFor(cfg, "task_complete"), "/from-opt/sounds/complete.wav");
});

test("load with unknown plugin root leaves sound path with empty prefix", () => {
  const cfg = config.load({ configPath: missingConfigPath(), env: {} });
  assert.equal(config.soundFor(cfg, "task_complete"), "/sounds/complete.wav");
});

// --- load: partial merge --------------------------------------------------

test("load deep-merges partial user config over defaults", () => {
  const p = writeConfig({
    desktop: { volume: 0.5, terminalBell: false },
    notifyOnTextResponse: false,
    statuses: { task_complete: { enabled: false } },
    suppressFilters: [{ status: "question" }],
  });
  const cfg = config.load({ configPath: p, pluginRoot: "/r", env: {} });

  // overridden
  assert.equal(cfg.desktop.volume, 0.5);
  assert.equal(cfg.desktop.terminalBell, false);
  assert.equal(cfg.notifyOnTextResponse, false);
  assert.equal(cfg.statuses.task_complete.enabled, false);
  assert.deepEqual(cfg.suppressFilters, [{ status: "question" }]);

  // preserved defaults
  assert.equal(cfg.desktop.enabled, true);
  assert.equal(cfg.desktop.clickToFocus, true);
  assert.equal(cfg.desktop.sound, true);
  assert.equal(cfg.suppressForSubagents, true);
  assert.equal(cfg.suppressQuestionAfterTaskCompleteSeconds, 12);

  // partial status merge keeps sibling fields + still env-expands the sound
  assert.equal(cfg.statuses.task_complete.title, "✅ Completed");
  assert.equal(config.soundFor(cfg, "task_complete"), "/r/sounds/complete.wav");
  // untouched statuses keep defaults
  assert.equal(cfg.statuses.question.enabled, true);
  assert.equal(cfg.statuses.question.title, "❓ Question");
});

test("load expands ${env} inside desktop.appIcon", () => {
  const p = writeConfig({ desktop: { appIcon: "${ICONDIR}/icon.png" } });
  const cfg = config.load({ configPath: p, env: { ICONDIR: "/imgs" } });
  assert.equal(cfg.desktop.appIcon, "/imgs/icon.png");
});

test("load ignores a non-object user config (array) and keeps defaults", () => {
  const p = writeConfig([1, 2, 3]);
  const cfg = config.load({ configPath: p, pluginRoot: "/r", env: {} });
  assert.equal(cfg.notifyOnTextResponse, true);
  assert.equal(config.soundFor(cfg, "question"), "/r/sounds/notification.wav");
});

// --- load: clamping -------------------------------------------------------

test("load clamps volume above 1 to 1", () => {
  const p = writeConfig({ desktop: { volume: 5 } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.desktop.volume, 1);
});

test("load clamps volume below 0 to 0", () => {
  const p = writeConfig({ desktop: { volume: -2 } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.desktop.volume, 0);
});

test("load resets non-numeric volume to default", () => {
  const p = writeConfig({ desktop: { volume: "loud" } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.desktop.volume, 1.0);
});

test("load clamps negative cooldowns to 0", () => {
  const p = writeConfig({
    suppressQuestionAfterAnyNotificationSeconds: -3,
    suppressQuestionAfterTaskCompleteSeconds: -1,
  });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.suppressQuestionAfterAnyNotificationSeconds, 0);
  assert.equal(cfg.suppressQuestionAfterTaskCompleteSeconds, 0);
});

test("load keeps valid in-range volume and cooldowns", () => {
  const p = writeConfig({
    desktop: { volume: 0.25 },
    suppressQuestionAfterAnyNotificationSeconds: 3,
  });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(cfg.desktop.volume, 0.25);
  assert.equal(cfg.suppressQuestionAfterAnyNotificationSeconds, 3);
});

// --- load: invalid JSON fallback -----------------------------------------

test("load on invalid JSON warns to stderr and falls back to defaults", () => {
  const p = writeConfig("{ this is not valid json ");
  const { result, stderr } = captureStderr(() =>
    config.load({ configPath: p, pluginRoot: "/r", env: {} })
  );
  assert.match(stderr, /config load failed/);
  // clean defaults restored
  assert.equal(result.notifyOnTextResponse, true);
  assert.equal(result.desktop.volume, 1.0);
  assert.deepEqual(result.suppressFilters, []);
  // still env-expanded
  assert.equal(config.soundFor(result, "task_complete"), "/r/sounds/complete.wav");
});

test("load never throws on a garbled file", () => {
  const p = writeConfig("  not json at all");
  assert.doesNotThrow(() =>
    config.load({ configPath: p, env: {} })
  );
});

// --- statusEnabled --------------------------------------------------------

test("statusEnabled true by default", () => {
  const cfg = config.load({ configPath: missingConfigPath(), env: {} });
  assert.equal(config.statusEnabled(cfg, "task_complete"), true);
  assert.equal(config.statusEnabled(cfg, "question"), true);
});

test("statusEnabled false when desktop disabled entirely", () => {
  const p = writeConfig({ desktop: { enabled: false } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(config.statusEnabled(cfg, "task_complete"), false);
  assert.equal(config.statusEnabled(cfg, "question"), false);
});

test("statusEnabled false when the status itself is disabled", () => {
  const p = writeConfig({ statuses: { task_complete: { enabled: false } } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(config.statusEnabled(cfg, "task_complete"), false);
  // sibling status unaffected
  assert.equal(config.statusEnabled(cfg, "question"), true);
});

test("statusEnabled false when per-status desktop.enabled is false", () => {
  const p = writeConfig({ statuses: { question: { desktop: { enabled: false } } } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(config.statusEnabled(cfg, "question"), false);
  assert.equal(config.statusEnabled(cfg, "task_complete"), true);
});

test("statusEnabled true when per-status desktop present with enabled true", () => {
  const p = writeConfig({ statuses: { question: { desktop: { enabled: true } } } });
  const cfg = config.load({ configPath: p, env: {} });
  assert.equal(config.statusEnabled(cfg, "question"), true);
});

test("statusEnabled tolerates an unknown status without throwing", () => {
  const cfg = config.load({ configPath: missingConfigPath(), env: {} });
  assert.doesNotThrow(() => config.statusEnabled(cfg, "nonexistent"));
});

// --- soundFor / titleFor --------------------------------------------------

test("soundFor and titleFor return resolved values", () => {
  const cfg = config.load({ configPath: missingConfigPath(), pluginRoot: "/r", env: {} });
  assert.equal(config.titleFor(cfg, "plan_ready"), "📋 Plan");
  assert.equal(config.soundFor(cfg, "plan_ready"), "/r/sounds/notification.wav");
});

test("soundFor and titleFor return empty string for unknown status", () => {
  const cfg = config.load({ configPath: missingConfigPath(), env: {} });
  assert.equal(config.soundFor(cfg, "nonexistent"), "");
  assert.equal(config.titleFor(cfg, "nonexistent"), "");
});

test("soundFor and titleFor tolerate empty/garbage config object", () => {
  assert.equal(config.soundFor({}, "task_complete"), "");
  assert.equal(config.titleFor({}, "task_complete"), "");
  assert.equal(config.soundFor(null, "task_complete"), "");
});
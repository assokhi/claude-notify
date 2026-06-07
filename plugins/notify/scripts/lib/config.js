// config.js — load + merge config, defaults, ${env} expansion, per-status resolution.
// Pure Node, zero external deps. Fail-open: never throw out of load().

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Full default config — see design spec "Config" section. Status sounds use the
// ${CLAUDE_PLUGIN_ROOT} placeholder, expanded by load() at runtime.
const DEFAULTS = {
  desktop: {
    enabled: true,
    sound: true,
    terminalBell: true,
    volume: 1.0, // 0.0–1.0, best-effort
    appIcon: "", // optional path, ${env} expanded
    clickToFocus: true,
  },
  suppressQuestionAfterTaskCompleteSeconds: 12,
  suppressQuestionAfterAnyNotificationSeconds: 7,
  notifyOnSubagentStop: false,
  suppressForSubagents: true,
  notifyOnTextResponse: true,
  respectJudgeMode: true,
  suppressFilters: [],
  statuses: {
    task_complete: {
      enabled: true,
      title: "✅ Completed",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav",
    },
    review_complete: {
      enabled: true,
      title: "🔍 Review",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/complete.wav",
    },
    question: {
      enabled: true,
      title: "❓ Question",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
    plan_ready: {
      enabled: true,
      title: "📋 Plan",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
    session_limit_reached: {
      enabled: true,
      title: "⏱️ Session Limit Reached",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
    api_error: {
      enabled: true,
      title: "🔴 API Error: 401",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
    api_error_overloaded: {
      enabled: true,
      title: "🔴 API Error",
      sound: "${CLAUDE_PLUGIN_ROOT}/sounds/notification.wav",
    },
  },
};

const COOLDOWN_KEYS = [
  "suppressQuestionAfterTaskCompleteSeconds",
  "suppressQuestionAfterAnyNotificationSeconds",
];

function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// JSON-based deep clone — DEFAULTS / user config are pure JSON values.
function cloneJSON(x) {
  if (x === undefined) return undefined;
  return JSON.parse(JSON.stringify(x));
}

function defaultConfig() {
  return cloneJSON(DEFAULTS);
}

function defaultConfigPath() {
  return path.join(os.homedir(), ".claude", "claude-notify", "config.json");
}

// Deep-merge `patch` over `base`. Plain objects merge recursively; arrays and
// primitives from patch replace base (cloned, so no reference sharing). A
// non-object patch is ignored (returns a clone of base) — fail-open.
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return cloneJSON(base);
  const out = isPlainObject(base) ? Object.assign({}, base) : {};
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = out[key];
    if (isPlainObject(pv) && isPlainObject(bv)) {
      out[key] = deepMerge(bv, pv);
    } else if (isPlainObject(pv)) {
      out[key] = deepMerge({}, pv);
    } else if (Array.isArray(pv)) {
      out[key] = cloneJSON(pv);
    } else {
      out[key] = pv;
    }
  }
  return out;
}

// Replace ${NAME} and ${ NAME } using `env` (default process.env). Unknown -> "".
function expandEnv(str, env) {
  if (typeof str !== "string") return "";
  const source = env || process.env;
  return str.replace(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (_m, name) => {
    const val = source[name];
    return val == null ? "" : String(val);
  });
}

function applyEnvExpansion(config, env) {
  if (config && config.desktop && typeof config.desktop.appIcon === "string") {
    config.desktop.appIcon = expandEnv(config.desktop.appIcon, env);
  }
  if (config && isPlainObject(config.statuses)) {
    for (const key of Object.keys(config.statuses)) {
      const s = config.statuses[key];
      if (s && typeof s.sound === "string") {
        s.sound = expandEnv(s.sound, env);
      }
    }
  }
}

function clampConfig(config) {
  const d = config.desktop || (config.desktop = {});
  let v = d.volume;
  if (typeof v !== "number" || !isFinite(v)) v = DEFAULTS.desktop.volume;
  else v = Math.max(0, Math.min(1, v));
  d.volume = v;

  for (const key of COOLDOWN_KEYS) {
    let c = config[key];
    if (typeof c !== "number" || !isFinite(c)) c = DEFAULTS[key];
    else if (c < 0) c = 0;
    config[key] = c;
  }
}

// load({configPath?, pluginRoot?, env?}) — read user config, deep-merge over
// defaults, expand env (CLAUDE_PLUGIN_ROOT injected from pluginRoot), clamp.
// Never throws: a bad/garbled file warns to stderr and falls back to defaults.
function load(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const configPath = opts.configPath || defaultConfigPath();

  const expandSource = Object.assign({}, env);
  if (opts.pluginRoot != null) {
    expandSource.CLAUDE_PLUGIN_ROOT = String(opts.pluginRoot);
  }

  let config;
  try {
    config = defaultConfig();
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const user = JSON.parse(raw);
      config = deepMerge(config, user);
    }
  } catch (err) {
    process.stderr.write(
      "[claude-notify] config load failed (" +
        configPath +
        "): " +
        (err && err.message) +
        "; using defaults\n"
    );
    config = defaultConfig();
  }

  try {
    applyEnvExpansion(config, expandSource);
    clampConfig(config);
  } catch (_err) {
    config = defaultConfig();
    applyEnvExpansion(config, expandSource);
    clampConfig(config);
  }

  return config;
}

function statusEnabled(config, status) {
  const c = config || {};
  const desktop = c.desktop || {};
  const statuses = c.statuses || {};
  const s = statuses[status] || {};
  const desktopOn = !!desktop.enabled;
  const statusOn = s.enabled !== false;
  const perStatusDesktopOn = s.desktop ? s.desktop.enabled !== false : true;
  return desktopOn && statusOn && perStatusDesktopOn;
}

function soundFor(config, status) {
  const statuses = (config && config.statuses) || {};
  const s = statuses[status];
  return (s && s.sound) || "";
}

function titleFor(config, status) {
  const statuses = (config && config.statuses) || {};
  const s = statuses[status];
  return (s && s.title) || "";
}

module.exports = {
  DEFAULTS,
  defaultConfig,
  expandEnv,
  load,
  statusEnabled,
  soundFor,
  titleFor,
};
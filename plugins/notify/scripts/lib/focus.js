"use strict";
// focus.js — best-effort click-to-focus planning + spawn.
//
// Pure planners (bundleIdFor, captureHints, muxPlan, plan, clickCommandString)
// are deterministic given their inputs and are unit-tested. focus() is the only
// side-effecting export (detached spawn) and is intentionally not unit-tested.
//
// Zero external deps. Node builtins only.

const os = require("node:os");
const child_process = require("node:child_process");

// macOS TERM_PROGRAM / __CFBundleIdentifier -> bundle id map.
// Keys are the values Claude Code's terminal sets in $TERM_PROGRAM.
const TERM_BUNDLES = {
  "iTerm.app": "com.googlecode.iterm2",
  "Apple_Terminal": "com.apple.Terminal",
  "ghostty": "com.mitchellh.ghostty",
  "kitty": "net.kovidgoyal.kitty",
  "WezTerm": "com.github.wez.wezterm",
  "WarpTerminal": "dev.warp.Warp-Stable",
  "Alacritty": "org.alacritty",
  "Hyper": "co.zeit.hyper",
  "vscode": "com.microsoft.VSCode",
};

// Resolve the macOS application bundle id from the environment.
// Prefer the curated TERM_PROGRAM mapping; fall back to the raw
// __CFBundleIdentifier macOS injects for the launching app. "" if unknown.
function bundleIdFor(env) {
  env = env || process.env || {};
  const tp = env.TERM_PROGRAM;
  if (tp && Object.prototype.hasOwnProperty.call(TERM_BUNDLES, tp)) {
    return TERM_BUNDLES[tp];
  }
  const cf = env.__CFBundleIdentifier;
  if (cf) return String(cf);
  return "";
}

// True when the desktop environment looks like GNOME (for the Wayland fallback).
function isGnome(env) {
  const d = String((env && (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION)) || "").toLowerCase();
  return d.indexOf("gnome") !== -1;
}

// Detect the active terminal multiplexer from the environment.
// Returns { type, ...ids } or null. tmux takes priority (it commonly wraps the
// others), then wezterm, kitty, zellij.
function detectMux(env) {
  env = env || {};
  if (env.TMUX) {
    return { type: "tmux", pane: env.TMUX_PANE || "", socket: env.TMUX };
  }
  if (env.WEZTERM_PANE) {
    return { type: "wezterm", pane: env.WEZTERM_PANE };
  }
  if (env.KITTY_WINDOW_ID) {
    return { type: "kitty", windowId: env.KITTY_WINDOW_ID, socket: env.KITTY_LISTEN_ON || "" };
  }
  if (env.ZELLIJ) {
    return { type: "zellij", session: env.ZELLIJ_SESSION_NAME || "" };
  }
  return null;
}

// Capture cheap focus hints from the environment, to be persisted in session
// state during PreToolUse/Notification and replayed on click.
// Shape: { bundleId?, windowId?, mux? }
function captureHints(env, platform) {
  env = env || process.env || {};
  if (platform === undefined) platform = os.platform();
  const hints = {};
  if (platform === "darwin") {
    const b = bundleIdFor(env);
    if (b) hints.bundleId = b;
  }
  // X11 exposes the focused terminal window id via $WINDOWID.
  if (env.XDG_SESSION_TYPE === "x11" && env.WINDOWID) {
    hints.windowId = String(env.WINDOWID);
  }
  const mux = detectMux(env);
  if (mux) hints.mux = mux;
  return hints;
}

// Build the multiplexer pane-switch command plan from captured hints.
// Returns ordered [cmd, args] tuples (possibly empty).
function muxPlan(hints) {
  hints = hints || {};
  const m = hints.mux;
  if (!m || !m.type) return [];
  switch (m.type) {
    case "tmux": {
      if (!m.pane) return [];
      return [["tmux", ["select-window", "-t", String(m.pane)]]];
    }
    case "wezterm": {
      if (!m.pane) return [];
      return [["wezterm", ["cli", "activate-pane", "--pane-id", String(m.pane)]]];
    }
    case "kitty": {
      const args = ["@"];
      if (m.socket) args.push("--to", String(m.socket));
      args.push("focus-window");
      if (m.windowId) args.push("--match", "id:" + String(m.windowId));
      return [["kitty", args]];
    }
    case "zellij":
      // zellij has no reliable external "raise my pane" command; best-effort no-op.
      return [];
    default:
      return [];
  }
}

// Build the ordered activation command plan for the given platform.
// runtime: { platform = os.platform(), env = process.env }
function plan(hints, runtime) {
  hints = hints || {};
  runtime = runtime || {};
  const platform = runtime.platform || os.platform();
  const env = runtime.env || process.env || {};
  const out = [];

  if (platform === "darwin") {
    if (hints.bundleId) {
      out.push(["osascript", ["-e", 'tell application id "' + hints.bundleId + '" to activate']]);
    }
  } else if (platform === "linux") {
    if (hints.windowId) {
      out.push(["xdotool", ["windowactivate", "--sync", String(hints.windowId)]]);
      out.push(["wmctrl", ["-i", "-a", String(hints.windowId)]]);
    } else if (isGnome(env) && hints.title) {
      // Wayland/GNOME best-effort; requires a window-activation shell extension.
      out.push(["busctl", [
        "--user", "call",
        "org.gnome.Shell", "/org/gnome/Shell/Extensions/WindowsExt",
        "org.gnome.Shell.Extensions.WindowsExt", "ActivateWindowByTitle",
        "s", String(hints.title),
      ]]);
    }
  }
  // win32 window focus is intentionally not attempted.

  for (const c of muxPlan(hints)) out.push(c);
  return out;
}

// Shell-quote a single token for the macOS terminal-notifier -execute string.
function shToken(s) {
  s = String(s);
  if (s.length && /^[A-Za-z0-9_./:%@=,+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function renderCmd(tuple) {
  const cmd = tuple[0];
  const args = tuple[1] || [];
  return [cmd].concat(args).map(shToken).join(" ");
}

// Build the macOS terminal-notifier -execute shell string: activate the
// terminal app by bundle id, then switch the multiplexer pane. "" if nothing.
function clickCommandString(hints, runtime) {
  hints = hints || {};
  runtime = runtime || {};
  const platform = runtime.platform || os.platform();
  if (platform !== "darwin") return "";
  const cmds = [];
  if (hints.bundleId) {
    cmds.push(["osascript", ["-e", 'tell application id "' + hints.bundleId + '" to activate']]);
  }
  for (const c of muxPlan(hints)) cmds.push(c);
  if (!cmds.length) return "";
  return cmds.map(renderCmd).join(" ; ");
}

// Side-effecting: spawn each planned command detached. Never throws.
function focus(hints, runtime) {
  runtime = runtime || {};
  try {
    const cmds = plan(hints, runtime);
    for (const tuple of cmds) {
      try {
        const child = child_process.spawn(tuple[0], tuple[1] || [], {
          stdio: "ignore",
          detached: true,
        });
        child.on("error", function () {});
        child.unref();
      } catch (_) {
        /* fall through to next command */
      }
    }
  } catch (_) {
    /* never throw */
  }
}

module.exports = {
  TERM_BUNDLES,
  bundleIdFor,
  captureHints,
  muxPlan,
  plan,
  clickCommandString,
  focus,
};

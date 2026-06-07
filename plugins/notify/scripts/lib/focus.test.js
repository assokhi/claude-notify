"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const focus = require("./focus");

test("exports the documented surface", () => {
  assert.equal(typeof focus.TERM_BUNDLES, "object");
  assert.equal(typeof focus.bundleIdFor, "function");
  assert.equal(typeof focus.captureHints, "function");
  assert.equal(typeof focus.muxPlan, "function");
  assert.equal(typeof focus.plan, "function");
  assert.equal(typeof focus.clickCommandString, "function");
  assert.equal(typeof focus.focus, "function");
});

test("TERM_BUNDLES maps known terminals to bundle ids", () => {
  const b = focus.TERM_BUNDLES;
  assert.equal(b["iTerm.app"], "com.googlecode.iterm2");
  assert.equal(b["Apple_Terminal"], "com.apple.Terminal");
  assert.equal(b["ghostty"], "com.mitchellh.ghostty");
  assert.equal(b["kitty"], "net.kovidgoyal.kitty");
  assert.equal(b["WezTerm"], "com.github.wez.wezterm");
  assert.equal(b["WarpTerminal"], "dev.warp.Warp-Stable");
  assert.equal(b["Alacritty"], "org.alacritty");
  assert.equal(b["Hyper"], "co.zeit.hyper");
  assert.equal(b["vscode"], "com.microsoft.VSCode");
});

test("bundleIdFor resolves via TERM_PROGRAM table", () => {
  assert.equal(focus.bundleIdFor({ TERM_PROGRAM: "iTerm.app" }), "com.googlecode.iterm2");
  assert.equal(focus.bundleIdFor({ TERM_PROGRAM: "Apple_Terminal" }), "com.apple.Terminal");
  assert.equal(focus.bundleIdFor({ TERM_PROGRAM: "vscode" }), "com.microsoft.VSCode");
});

test("bundleIdFor falls back to __CFBundleIdentifier when TERM_PROGRAM unknown", () => {
  assert.equal(
    focus.bundleIdFor({ TERM_PROGRAM: "SomethingNew", __CFBundleIdentifier: "com.example.term" }),
    "com.example.term"
  );
  // No TERM_PROGRAM at all, only the CF id (e.g. kitty on macOS).
  assert.equal(
    focus.bundleIdFor({ __CFBundleIdentifier: "net.kovidgoyal.kitty" }),
    "net.kovidgoyal.kitty"
  );
});

test("bundleIdFor prefers the table over a raw CF id", () => {
  assert.equal(
    focus.bundleIdFor({ TERM_PROGRAM: "iTerm.app", __CFBundleIdentifier: "com.bogus.value" }),
    "com.googlecode.iterm2"
  );
});

test("bundleIdFor returns '' for empty / unknown env", () => {
  assert.equal(focus.bundleIdFor({}), "");
  assert.equal(focus.bundleIdFor({ TERM_PROGRAM: "Unknown" }), "");
});

test("captureHints on macOS records the bundle id", () => {
  const h = focus.captureHints({ TERM_PROGRAM: "iTerm.app" }, "darwin");
  assert.equal(h.bundleId, "com.googlecode.iterm2");
  assert.equal(h.windowId, undefined);
  assert.equal(h.mux, undefined);
});

test("captureHints does not set bundleId off macOS", () => {
  // vscode integrated terminal sets TERM_PROGRAM=vscode even on linux.
  const h = focus.captureHints({ TERM_PROGRAM: "vscode" }, "linux");
  assert.equal(h.bundleId, undefined);
});

test("captureHints records X11 window id from WINDOWID", () => {
  const h = focus.captureHints({ XDG_SESSION_TYPE: "x11", WINDOWID: "0x3200007" }, "linux");
  assert.equal(h.windowId, "0x3200007");
});

test("captureHints ignores WINDOWID when session is not x11", () => {
  const wayland = focus.captureHints({ XDG_SESSION_TYPE: "wayland", WINDOWID: "0x3200007" }, "linux");
  assert.equal(wayland.windowId, undefined);
  const noType = focus.captureHints({ WINDOWID: "0x3200007" }, "linux");
  assert.equal(noType.windowId, undefined);
});

test("captureHints detects tmux", () => {
  const h = focus.captureHints({ TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%3" }, "linux");
  assert.deepEqual(h.mux, { type: "tmux", pane: "%3", socket: "/tmp/tmux-1000/default,123,0" });
});

test("captureHints detects wezterm", () => {
  const h = focus.captureHints({ WEZTERM_PANE: "7" }, "linux");
  assert.deepEqual(h.mux, { type: "wezterm", pane: "7" });
});

test("captureHints detects kitty", () => {
  const h = focus.captureHints(
    { KITTY_WINDOW_ID: "2", KITTY_LISTEN_ON: "unix:/tmp/kitty-sock" },
    "linux"
  );
  assert.deepEqual(h.mux, { type: "kitty", windowId: "2", socket: "unix:/tmp/kitty-sock" });
});

test("captureHints detects zellij", () => {
  const h = focus.captureHints({ ZELLIJ: "0", ZELLIJ_SESSION_NAME: "main" }, "linux");
  assert.deepEqual(h.mux, { type: "zellij", session: "main" });
});

test("captureHints prefers tmux when both tmux and wezterm vars are present", () => {
  const h = focus.captureHints({ TMUX: "/tmp/sock", TMUX_PANE: "%1", WEZTERM_PANE: "5" }, "darwin");
  assert.equal(h.mux.type, "tmux");
  assert.equal(h.mux.pane, "%1");
});

test("muxPlan builds a tmux select-window command", () => {
  assert.deepEqual(
    focus.muxPlan({ mux: { type: "tmux", pane: "%3" } }),
    [["tmux", ["select-window", "-t", "%3"]]]
  );
});

test("muxPlan tmux without a pane yields nothing", () => {
  assert.deepEqual(focus.muxPlan({ mux: { type: "tmux", pane: "" } }), []);
});

test("muxPlan builds a wezterm activate-pane command", () => {
  assert.deepEqual(
    focus.muxPlan({ mux: { type: "wezterm", pane: "7" } }),
    [["wezterm", ["cli", "activate-pane", "--pane-id", "7"]]]
  );
});

test("muxPlan builds a kitty focus-window command with socket + id", () => {
  assert.deepEqual(
    focus.muxPlan({ mux: { type: "kitty", windowId: "2", socket: "unix:/tmp/k" } }),
    [["kitty", ["@", "--to", "unix:/tmp/k", "focus-window", "--match", "id:2"]]]
  );
});

test("muxPlan kitty without socket/id is still valid", () => {
  assert.deepEqual(
    focus.muxPlan({ mux: { type: "kitty" } }),
    [["kitty", ["@", "focus-window"]]]
  );
});

test("muxPlan zellij and missing mux yield nothing", () => {
  assert.deepEqual(focus.muxPlan({ mux: { type: "zellij", session: "main" } }), []);
  assert.deepEqual(focus.muxPlan({}), []);
  assert.deepEqual(focus.muxPlan(), []);
});

test("plan on linux activates by window id then mux, in order", () => {
  const hints = { windowId: "0x55", mux: { type: "tmux", pane: "%2" } };
  assert.deepEqual(
    focus.plan(hints, { platform: "linux", env: {} }),
    [
      ["xdotool", ["windowactivate", "--sync", "0x55"]],
      ["wmctrl", ["-i", "-a", "0x55"]],
      ["tmux", ["select-window", "-t", "%2"]],
    ]
  );
});

test("plan on linux with only a window id omits mux commands", () => {
  assert.deepEqual(
    focus.plan({ windowId: "0x55" }, { platform: "linux", env: {} }),
    [
      ["xdotool", ["windowactivate", "--sync", "0x55"]],
      ["wmctrl", ["-i", "-a", "0x55"]],
    ]
  );
});

test("plan on GNOME without a window id does NOT attempt a title-based focus (no producer sets title)", () => {
  // captureHints never emits a `title`, so any title-based Wayland branch would
  // be dead code. A linux hint with no windowId and no mux yields nothing.
  const hints = { title: "my session" };
  const runtime = { platform: "linux", env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" } };
  assert.deepEqual(focus.plan(hints, runtime), []);
});

test("plan on linux without window id, gnome, or title only returns mux", () => {
  assert.deepEqual(
    focus.plan({ mux: { type: "wezterm", pane: "9" } }, { platform: "linux", env: {} }),
    [["wezterm", ["cli", "activate-pane", "--pane-id", "9"]]]
  );
  assert.deepEqual(focus.plan({}, { platform: "linux", env: {} }), []);
});

test("plan on macOS activates the app by bundle id then switches mux", () => {
  const hints = { bundleId: "com.apple.Terminal", mux: { type: "tmux", pane: "%4" } };
  assert.deepEqual(focus.plan(hints, { platform: "darwin", env: {} }), [
    ["osascript", ["-e", 'tell application id "com.apple.Terminal" to activate']],
    ["tmux", ["select-window", "-t", "%4"]],
  ]);
});

test("plan on macOS escapes a bundle id with quotes/backslashes (AppleScript injection guard)", () => {
  const evil = 'x" to activate\ntell application "Finder';
  const out = focus.plan({ bundleId: evil }, { platform: "darwin", env: {} });
  const script = out[0][1][1];
  // backslashes doubled, double-quotes escaped — no unescaped " can close the literal
  assert.ok(!/[^\\]"/.test(script.slice('tell application id '.length)) || script.includes('\\"'));
  assert.ok(script.includes('\\"'), "embedded quote is escaped");
  assert.ok(script.startsWith('tell application id "'));
});

test("plan on macOS with no bundle id returns only mux", () => {
  assert.deepEqual(
    focus.plan({ mux: { type: "wezterm", pane: "1" } }, { platform: "darwin", env: {} }),
    [["wezterm", ["cli", "activate-pane", "--pane-id", "1"]]]
  );
});

test("plan on win32 does not attempt window focus (mux only)", () => {
  // A captured X11 window id must be ignored on win32.
  assert.deepEqual(focus.plan({ windowId: "0x55" }, { platform: "win32", env: {} }), []);
  assert.deepEqual(
    focus.plan({ windowId: "0x55", mux: { type: "tmux", pane: "%9" } }, { platform: "win32", env: {} }),
    [["tmux", ["select-window", "-t", "%9"]]]
  );
});

test("clickCommandString builds the macOS -execute string (app + mux)", () => {
  const hints = { bundleId: "com.googlecode.iterm2", mux: { type: "tmux", pane: "%3" } };
  assert.equal(
    focus.clickCommandString(hints, { platform: "darwin" }),
    "osascript -e 'tell application id \"com.googlecode.iterm2\" to activate' ; tmux select-window -t %3"
  );
});

test("clickCommandString with only a bundle id omits the mux clause", () => {
  assert.equal(
    focus.clickCommandString({ bundleId: "com.apple.Terminal" }, { platform: "darwin" }),
    "osascript -e 'tell application id \"com.apple.Terminal\" to activate'"
  );
});

test("clickCommandString returns '' off macOS", () => {
  const hints = { bundleId: "com.googlecode.iterm2", mux: { type: "tmux", pane: "%3" } };
  assert.equal(focus.clickCommandString(hints, { platform: "linux" }), "");
  assert.equal(focus.clickCommandString(hints, { platform: "win32" }), "");
});

test("clickCommandString returns '' when there is nothing to do", () => {
  assert.equal(focus.clickCommandString({}, { platform: "darwin" }), "");
});

test("focus() never throws for an empty plan", () => {
  assert.doesNotThrow(() => focus.focus({}, { platform: "win32" }));
});

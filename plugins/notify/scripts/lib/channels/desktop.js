"use strict";

// channels/desktop.js — native desktop notification command builders + spawn.
//
// Pure command builders (macCommand / linuxCommand / winCommand / command) are
// deterministic and unit-tested. notify() spawns the chosen command detached and
// never throws. bell() writes a BEL to /dev/tty (best effort).
//
// Zero external deps; node builtins only.

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// ---------------------------------------------------------------------------
// escaping helpers
// ---------------------------------------------------------------------------

// AppleScript string escaping: backslash and double-quote.
function escAppleScript(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

// PowerShell single-quoted string escaping: a single quote is doubled.
function escPowerShell(s) {
  return String(s == null ? "" : s).replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

// macCommand(opts, hasTerminalNotifier)
//   opts: {title, subtitle, body, icon, urgent, clickCmd}
//   terminal-notifier path: -title/-subtitle/-message (+ -appIcon, -execute, -timeSensitive)
//   otherwise: osascript -e 'display notification "body" with title "..." subtitle "..."'
function macCommand(opts, hasTerminalNotifier) {
  opts = opts || {};
  const title = opts.title || "";
  const subtitle = opts.subtitle || "";
  const body = opts.body || "";
  const icon = opts.icon || "";
  const urgent = !!opts.urgent;
  const clickCmd = opts.clickCmd || "";

  if (hasTerminalNotifier) {
    const args = ["-title", title, "-message", body];
    if (subtitle) args.push("-subtitle", subtitle);
    if (icon) args.push("-appIcon", icon);
    if (clickCmd) args.push("-execute", clickCmd);
    if (urgent) args.push("-timeSensitive");
    return { cmd: "terminal-notifier", args };
  }

  let script =
    'display notification "' +
    escAppleScript(body) +
    '" with title "' +
    escAppleScript(title) +
    '"';
  if (subtitle) {
    script += ' subtitle "' + escAppleScript(subtitle) + '"';
  }
  return { cmd: "osascript", args: ["-e", script] };
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

// linuxCommand(opts) -> notify-send <title> <body> [--icon icon] [--urgency critical]
function linuxCommand(opts) {
  opts = opts || {};
  const title = opts.title || "";
  const body = opts.body || "";
  const icon = opts.icon || "";
  const urgent = !!opts.urgent;

  const args = [title, body];
  if (icon) args.push("--icon", icon);
  if (urgent) args.push("--urgency", "critical");
  return { cmd: "notify-send", args };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// winCommand(opts) -> powershell toast (Windows.UI.Notifications) with balloon fallback.
function winCommand(opts) {
  opts = opts || {};
  const t = escPowerShell(opts.title || "");
  const b = escPowerShell(opts.body || "");

  const script = [
    "$ErrorActionPreference='Stop';",
    "try {",
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;",
    "$tpl=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
    "$tx=$tpl.GetElementsByTagName('text');",
    "$tx.Item(0).AppendChild($tpl.CreateTextNode('" + t + "'))|Out-Null;",
    "$tx.Item(1).AppendChild($tpl.CreateTextNode('" + b + "'))|Out-Null;",
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($tpl);",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show($toast);",
    "} catch {",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$ni=New-Object System.Windows.Forms.NotifyIcon;",
    "$ni.Icon=[System.Drawing.SystemIcons]::Information;",
    "$ni.Visible=$true;",
    "$ni.BalloonTipTitle='" + t + "';",
    "$ni.BalloonTipText='" + b + "';",
    "$ni.ShowBalloonTip(10000);",
    "}",
  ].join(" ");

  return {
    cmd: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
  };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

// Default PATH probe: returns true if `bin` is found (and executable) on PATH.
function defaultProbe(bin) {
  try {
    const isWin = process.platform === "win32";
    const envPath = process.env.PATH || "";
    const sep = isWin ? ";" : ":";
    const exts = isWin
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
    const dirs = envPath.split(sep);
    for (const dir of dirs) {
      if (!dir) continue;
      for (const ext of exts) {
        const full = path.join(dir, bin + ext);
        try {
          fs.accessSync(full, isWin ? fs.constants.F_OK : fs.constants.X_OK);
          return true;
        } catch (_) {
          /* keep scanning */
        }
      }
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

// command(platform, opts, probe) -> {cmd, args} | null
function command(platform, opts, probe) {
  const p = typeof probe === "function" ? probe : defaultProbe;

  if (platform === "darwin") {
    if (p("terminal-notifier")) return macCommand(opts, true);
    if (p("osascript")) return macCommand(opts, false);
    return null;
  }
  if (platform === "linux") {
    if (p("notify-send")) return linuxCommand(opts);
    return null;
  }
  if (platform === "win32") {
    if (p("powershell")) return winCommand(opts);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// side effects
// ---------------------------------------------------------------------------

// notify(opts, runtime) — spawn the resolved command detached. Never throws.
function notify(opts, runtime = {}) {
  try {
    const platform = runtime.platform || os.platform();
    const probe =
      typeof runtime.probe === "function" ? runtime.probe : defaultProbe;
    const c = command(platform, opts || {}, probe);
    if (!c) return;
    const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch (_) {
    /* fail open */
  }
}

// bell() — best-effort terminal bell (BEL) on /dev/tty.
function bell() {
  try {
    fs.writeFileSync("/dev/tty", "");
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  macCommand,
  linuxCommand,
  winCommand,
  command,
  notify,
  bell,
};
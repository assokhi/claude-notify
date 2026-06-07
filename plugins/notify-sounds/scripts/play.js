#!/usr/bin/env node
// Cross-platform notification-sound player for Claude Code hooks.
// Usage: node play.js <notification|complete>
// Runs on Node (always present with Claude Code), so it works the same on
// macOS, Windows, and Linux without depending on a POSIX shell.

const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

const kind = process.argv[2] === "complete" ? "complete" : "notification";
const sound = path.join(__dirname, "..", "sounds", `${kind}.wav`);
const plat = os.platform();

// Ordered list of [command, args] candidates per platform. The first one that
// launches wins; if it fails to spawn we fall through to the next.
let candidates;
if (plat === "darwin") {
  candidates = [["afplay", [sound]]];
} else if (plat === "win32") {
  const ps = `$p = New-Object System.Media.SoundPlayer '${sound}'; $p.PlaySync();`;
  candidates = [["powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]]];
} else {
  // Linux / BSD — try the usual players in order of prevalence.
  candidates = [
    ["paplay", [sound]],
    ["pw-play", [sound]],
    ["aplay", ["-q", sound]],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", sound]],
    ["play", ["-q", sound]],
  ];
}

(function tryNext(i) {
  if (i >= candidates.length) return; // no player available — stay silent, never error
  const [cmd, args] = candidates[i];
  const child = spawn(cmd, args, { stdio: "ignore" });
  child.on("error", () => tryNext(i + 1));
})(0);

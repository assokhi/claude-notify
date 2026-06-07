"use strict";

// channels/sound.js — per-status notification sound playback.
//
// Pure Node, zero external deps. `candidates()` is a PURE ordered list of
// [command, args] players to try per platform; the first one that actually
// launches wins. `play()` spawns that first player detached and NEVER throws —
// a notification sound must never disturb the Claude Code session.

const { spawn } = require("node:child_process");
const os = require("node:os");

// Build the ordered list of [command, args] candidates for a platform.
// Callers try them in order and fall through to the next on spawn error.
//
//   darwin: afplay, with a best-effort "-v <volume>" flag ONLY when the
//           volume is a real number in [0, 1) (>= 1 / invalid / absent => full
//           volume, so the flag is omitted).
//   linux/other: paplay -> pw-play -> aplay -q -> ffplay ... -> play -q.
//                No portable volume flag here; volume is ignored.
//   win32: PowerShell System.Media.SoundPlayer .PlaySync() (no volume support).
function candidates(platform, soundPath, volume) {
  if (platform === "darwin") {
    const useVolume =
      typeof volume === "number" &&
      Number.isFinite(volume) &&
      volume >= 0 &&
      volume < 1;
    const args = useVolume ? ["-v", String(volume), soundPath] : [soundPath];
    return [["afplay", args]];
  }

  if (platform === "win32") {
    const ps =
      "$p = New-Object System.Media.SoundPlayer '" +
      soundPath +
      "'; $p.PlaySync();";
    return [
      ["powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]],
    ];
  }

  // linux / BSD / anything else — usual players, in order of prevalence.
  return [
    ["paplay", [soundPath]],
    ["pw-play", [soundPath]],
    ["aplay", ["-q", soundPath]],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", soundPath]],
    ["play", ["-q", soundPath]],
  ];
}

// Spawn the first player that launches, detached and unref'd. Fail-open:
// any error (bad path, no player, spawn throw) leaves the session silent.
function play(soundPath, opts = {}) {
  try {
    if (!soundPath) return;
    const platform = opts.platform || os.platform();
    const volume = opts.volume;
    const list = candidates(platform, soundPath, volume);
    tryNext(list, 0);
  } catch (_err) {
    // never throw
  }
}

function tryNext(list, i) {
  if (i >= list.length) return; // no player available — stay silent
  const [cmd, args] = list[i];
  let child;
  try {
    child = spawn(cmd, args, { stdio: "ignore", detached: true });
  } catch (_err) {
    return tryNext(list, i + 1);
  }
  child.on("error", () => tryNext(list, i + 1));
  try {
    child.unref();
  } catch (_err) {
    /* ignore */
  }
}

module.exports = { candidates, play };
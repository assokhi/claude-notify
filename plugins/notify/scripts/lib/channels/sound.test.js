"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sound = require("./sound");

const SP = "/tmp/sounds/notify.wav";

test("exports candidates and play functions", () => {
  assert.equal(typeof sound.candidates, "function");
  assert.equal(typeof sound.play, "function");
});

// ---- darwin: afplay + the "-v volume only when 0<=volume<1" rule ----

test("darwin: no volume arg -> afplay with just the path", () => {
  assert.deepEqual(sound.candidates("darwin", SP), [["afplay", [SP]]]);
});

test("darwin: explicit undefined volume -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, undefined), [
    ["afplay", [SP]],
  ]);
});

test("darwin: 0<=volume<1 -> afplay -v <vol> <path>", () => {
  assert.deepEqual(sound.candidates("darwin", SP, 0.5), [
    ["afplay", ["-v", "0.5", SP]],
  ]);
});

test("darwin: volume 0 is included (0<=0<1)", () => {
  assert.deepEqual(sound.candidates("darwin", SP, 0), [
    ["afplay", ["-v", "0", SP]],
  ]);
});

test("darwin: volume === 1 -> no -v (boundary, not < 1)", () => {
  assert.deepEqual(sound.candidates("darwin", SP, 1), [["afplay", [SP]]]);
});

test("darwin: volume > 1 -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, 1.5), [["afplay", [SP]]]);
});

test("darwin: negative volume -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, -0.3), [["afplay", [SP]]]);
});

test("darwin: NaN volume -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, NaN), [["afplay", [SP]]]);
});

test("darwin: Infinity volume -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, Infinity), [
    ["afplay", [SP]],
  ]);
});

test("darwin: string volume rejected by typeof guard -> no -v", () => {
  assert.deepEqual(sound.candidates("darwin", SP, "0.5"), [["afplay", [SP]]]);
});

test("darwin: volume rendered via String(volume)", () => {
  assert.equal(sound.candidates("darwin", SP, 0.25)[0][1][1], "0.25");
});

// ---- linux: ordered player list, volume ignored ----

test("linux: full ordered player list", () => {
  assert.deepEqual(sound.candidates("linux", SP), [
    ["paplay", [SP]],
    ["pw-play", [SP]],
    ["aplay", ["-q", SP]],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", SP]],
    ["play", ["-q", SP]],
  ]);
});

test("linux: paplay is the first candidate", () => {
  assert.equal(sound.candidates("linux", SP, 0.5)[0][0], "paplay");
});

test("linux: ignores volume (same list with or without)", () => {
  assert.deepEqual(
    sound.candidates("linux", SP, 0.5),
    sound.candidates("linux", SP)
  );
});

test("linux: soundPath threaded through every candidate", () => {
  for (const [, args] of sound.candidates("linux", SP)) {
    assert.ok(args.includes(SP));
  }
});

// ---- win32: PowerShell SoundPlayer, volume ignored ----

test("win32: powershell SoundPlayer PlaySync embedding the path", () => {
  const c = sound.candidates("win32", SP);
  assert.equal(c.length, 1);
  assert.equal(c[0][0], "powershell");
  const args = c[0][1];
  assert.deepEqual(args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(args[3], /SoundPlayer/);
  assert.match(args[3], /PlaySync/);
  assert.ok(args[3].includes(SP));
});

test("win32: ignores volume", () => {
  assert.deepEqual(
    sound.candidates("win32", SP, 0.5),
    sound.candidates("win32", SP)
  );
});

// ---- fallback + fail-open ----

test("unknown platform falls back to the linux list", () => {
  const c = sound.candidates("freebsd", SP);
  assert.equal(c.length, 5);
  assert.equal(c[0][0], "paplay");
});

test("play is fail-open: empty/falsy soundPath returns without throwing", () => {
  assert.doesNotThrow(() => sound.play(""));
  assert.doesNotThrow(() => sound.play(undefined, { platform: "linux" }));
});

// ---- win32: single-quote escaping (apostrophe paths + injection guard) ----

test("win32: a single quote in the path is doubled (PowerShell literal escape)", () => {
  const c = sound.candidates("win32", "C:\\Users\\O'Brien\\s.wav");
  // O'Brien -> O''Brien inside the single-quoted PS literal
  assert.ok(c[0][1][3].includes("O''Brien"));
  assert.ok(!c[0][1][3].includes("O'Brien'"));
});

test("win32: injection attempt is neutralized by quote doubling", () => {
  const evil = "x'; Remove-Item C:\\ -Recurse; '";
  const ps = sound.candidates("win32", evil)[0][1][3];
  // every original single quote becomes a doubled quote; no lone quote closes the literal early
  assert.ok(ps.includes("x''; Remove-Item C:\\ -Recurse; ''"));
});

// ---- play(): tryNext fallback chain via injected spawn ----

function fakeChild() {
  return {
    handlers: {},
    on(ev, fn) { this.handlers[ev] = fn; return this; },
    unref() { this.unrefed = true; },
  };
}

test("play: spawns the first candidate and unrefs it", () => {
  const spawned = [];
  const child = fakeChild();
  const spawn = (cmd, args) => { spawned.push([cmd, args]); return child; };
  sound.play(SP, { platform: "linux", spawn });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][0], "paplay");
  assert.equal(child.unrefed, true);
});

test("play: a child 'error' advances to the next candidate", () => {
  const spawned = [];
  const children = [];
  const spawn = (cmd, args) => { spawned.push(cmd); const c = fakeChild(); children.push(c); return c; };
  sound.play(SP, { platform: "linux", spawn });
  // simulate the first player failing to launch
  children[0].handlers.error(new Error("ENOENT"));
  assert.deepEqual(spawned, ["paplay", "pw-play"]);
});

test("play: exhausting all candidates stays silent without throwing", () => {
  const spawned = [];
  const children = [];
  const spawn = (cmd) => { spawned.push(cmd); const c = fakeChild(); children.push(c); return c; };
  assert.doesNotThrow(() => {
    sound.play(SP, { platform: "linux", spawn });
    // fail each in turn
    for (let i = 0; i < children.length; i++) {
      if (children[i].handlers.error) children[i].handlers.error(new Error("nope"));
    }
  });
  assert.deepEqual(spawned, ["paplay", "pw-play", "aplay", "ffplay", "play"]);
});

test("play: a synchronous spawn throw advances to the next candidate", () => {
  const spawned = [];
  let first = true;
  const spawn = (cmd) => {
    spawned.push(cmd);
    if (first) { first = false; throw new Error("spawn EACCES"); }
    return fakeChild();
  };
  assert.doesNotThrow(() => sound.play(SP, { platform: "linux", spawn }));
  assert.deepEqual(spawned.slice(0, 2), ["paplay", "pw-play"]);
});
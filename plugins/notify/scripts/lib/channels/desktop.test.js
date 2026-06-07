"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const desktop = require("./desktop");

// --- helpers --------------------------------------------------------------

// value following a flag in an args array (undefined if flag absent)
function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// build a probe from a set of "installed" binaries
function probeFor(names) {
  const set = new Set(names);
  return (bin) => set.has(bin);
}

// ===========================================================================
// macCommand — terminal-notifier present
// ===========================================================================

test("macCommand: terminal-notifier basic flags", () => {
  const r = desktop.macCommand(
    { title: "My Title", subtitle: "Sub", body: "Body text" },
    true
  );
  assert.equal(r.cmd, "terminal-notifier");
  assert.equal(flagVal(r.args, "-title"), "My Title");
  assert.equal(flagVal(r.args, "-subtitle"), "Sub");
  assert.equal(flagVal(r.args, "-message"), "Body text");
  // no urgency / click when not requested
  assert.ok(!r.args.includes("-timeSensitive"));
  assert.ok(!r.args.includes("-execute"));
  assert.ok(!r.args.includes("-appIcon"));
});

test("macCommand: terminal-notifier omits -subtitle when empty", () => {
  const r = desktop.macCommand({ title: "T", body: "B", subtitle: "" }, true);
  assert.equal(r.cmd, "terminal-notifier");
  assert.ok(!r.args.includes("-subtitle"));
  // title + message still present
  assert.equal(flagVal(r.args, "-title"), "T");
  assert.equal(flagVal(r.args, "-message"), "B");
});

test("macCommand: terminal-notifier urgent adds -timeSensitive", () => {
  const r = desktop.macCommand({ title: "T", body: "B", urgent: true }, true);
  assert.ok(r.args.includes("-timeSensitive"));
});

test("macCommand: terminal-notifier clickCmd adds -execute", () => {
  const r = desktop.macCommand(
    { title: "T", body: "B", clickCmd: "osascript -e 'foo'" },
    true
  );
  assert.equal(flagVal(r.args, "-execute"), "osascript -e 'foo'");
});

test("macCommand: terminal-notifier icon adds -appIcon", () => {
  const r = desktop.macCommand(
    { title: "T", body: "B", icon: "/path/icon.png" },
    true
  );
  assert.equal(flagVal(r.args, "-appIcon"), "/path/icon.png");
});

test("macCommand: terminal-notifier all options together", () => {
  const r = desktop.macCommand(
    {
      title: "T",
      subtitle: "S",
      body: "B",
      icon: "/i.png",
      urgent: true,
      clickCmd: "act",
    },
    true
  );
  assert.equal(flagVal(r.args, "-title"), "T");
  assert.equal(flagVal(r.args, "-subtitle"), "S");
  assert.equal(flagVal(r.args, "-message"), "B");
  assert.equal(flagVal(r.args, "-appIcon"), "/i.png");
  assert.equal(flagVal(r.args, "-execute"), "act");
  assert.ok(r.args.includes("-timeSensitive"));
});

// ===========================================================================
// macCommand — falls back to osascript
// ===========================================================================

test("macCommand: osascript fallback shape", () => {
  const r = desktop.macCommand(
    { title: "My Title", subtitle: "Sub", body: "Hello" },
    false
  );
  assert.equal(r.cmd, "osascript");
  assert.equal(r.args[0], "-e");
  const script = r.args[1];
  assert.ok(script.startsWith("display notification "));
  assert.ok(script.includes('display notification "Hello"'));
  assert.ok(script.includes('with title "My Title"'));
  assert.ok(script.includes('subtitle "Sub"'));
});

test("macCommand: osascript omits subtitle clause when empty", () => {
  const r = desktop.macCommand({ title: "T", body: "B" }, false);
  assert.equal(r.cmd, "osascript");
  assert.ok(!r.args[1].includes("subtitle"));
  assert.ok(r.args[1].includes('with title "T"'));
});

test("macCommand: osascript escapes double quotes in body", () => {
  const r = desktop.macCommand({ title: "T", body: 'Say "hi"' }, false);
  const script = r.args[1];
  // " -> \"  =>  display notification "Say \"hi\""
  assert.ok(script.includes('Say \\"hi\\"'));
});

test("macCommand: osascript escapes backslashes", () => {
  const r = desktop.macCommand({ title: "T", body: "a\\b" }, false);
  const script = r.args[1];
  // single backslash becomes double backslash
  assert.ok(script.includes("a\\\\b"));
});

// ===========================================================================
// linuxCommand
// ===========================================================================

test("linuxCommand: basic title + body positionals", () => {
  const r = desktop.linuxCommand({ title: "T", body: "B" });
  assert.equal(r.cmd, "notify-send");
  assert.equal(r.args[0], "T");
  assert.equal(r.args[1], "B");
  assert.ok(!r.args.includes("--urgency"));
  assert.ok(!r.args.includes("--icon"));
});

test("linuxCommand: urgent adds --urgency critical", () => {
  const r = desktop.linuxCommand({ title: "T", body: "B", urgent: true });
  assert.equal(flagVal(r.args, "--urgency"), "critical");
});

test("linuxCommand: icon adds --icon", () => {
  const r = desktop.linuxCommand({ title: "T", body: "B", icon: "/x.png" });
  assert.equal(flagVal(r.args, "--icon"), "/x.png");
});

test("linuxCommand: icon and urgent together", () => {
  const r = desktop.linuxCommand({
    title: "T",
    body: "B",
    icon: "/x.png",
    urgent: true,
  });
  assert.equal(flagVal(r.args, "--icon"), "/x.png");
  assert.equal(flagVal(r.args, "--urgency"), "critical");
  // positionals stay first
  assert.equal(r.args[0], "T");
  assert.equal(r.args[1], "B");
});

// ===========================================================================
// winCommand
// ===========================================================================

test("winCommand: powershell shape with toast + balloon fallback", () => {
  const r = desktop.winCommand({ title: "Win T", body: "Win B" });
  assert.equal(r.cmd, "powershell");
  assert.ok(r.args.includes("-NoProfile"));
  assert.ok(r.args.includes("-NonInteractive"));
  assert.ok(r.args.includes("-Command"));
  const script = r.args[r.args.length - 1];
  assert.ok(script.includes("ToastNotificationManager"));
  assert.ok(script.includes("NotifyIcon")); // balloon fallback present
  assert.ok(script.includes("Win T"));
  assert.ok(script.includes("Win B"));
});

test("winCommand: escapes single quotes by doubling", () => {
  const r = desktop.winCommand({ title: "it's", body: "y'all" });
  const script = r.args[r.args.length - 1];
  assert.ok(script.includes("it''s"));
  assert.ok(script.includes("y''all"));
});

// ===========================================================================
// command() dispatch via injected probe
// ===========================================================================

test("command: darwin prefers terminal-notifier", () => {
  const c = desktop.command(
    "darwin",
    { title: "T", body: "B" },
    probeFor(["terminal-notifier", "osascript"])
  );
  assert.equal(c.cmd, "terminal-notifier");
});

test("command: darwin falls back to osascript", () => {
  const c = desktop.command(
    "darwin",
    { title: "T", body: "B" },
    probeFor(["osascript"])
  );
  assert.equal(c.cmd, "osascript");
});

test("command: darwin null when nothing available", () => {
  const c = desktop.command("darwin", { title: "T", body: "B" }, probeFor([]));
  assert.equal(c, null);
});

test("command: linux notify-send present", () => {
  const c = desktop.command(
    "linux",
    { title: "T", body: "B" },
    probeFor(["notify-send"])
  );
  assert.equal(c.cmd, "notify-send");
});

test("command: linux null when notify-send absent", () => {
  const c = desktop.command("linux", { title: "T", body: "B" }, probeFor([]));
  assert.equal(c, null);
});

test("command: win32 powershell present", () => {
  const c = desktop.command(
    "win32",
    { title: "T", body: "B" },
    probeFor(["powershell"])
  );
  assert.equal(c.cmd, "powershell");
});

test("command: win32 null when powershell absent", () => {
  const c = desktop.command("win32", { title: "T", body: "B" }, probeFor([]));
  assert.equal(c, null);
});

test("command: unknown platform is null even with binaries present", () => {
  const c = desktop.command(
    "sunos",
    { title: "T", body: "B" },
    probeFor(["notify-send", "powershell", "osascript", "terminal-notifier"])
  );
  assert.equal(c, null);
});

// ===========================================================================
// notify() / bell() never throw
// ===========================================================================

test("notify: no-op (no throw) when no command resolves", () => {
  assert.doesNotThrow(() =>
    desktop.notify(
      { title: "T", body: "B" },
      { platform: "nope-os", probe: () => false }
    )
  );
});

test("notify: no throw with empty opts and unknown platform", () => {
  assert.doesNotThrow(() =>
    desktop.notify(undefined, { platform: "nope-os", probe: () => false })
  );
});

test("bell: never throws", () => {
  assert.doesNotThrow(() => desktop.bell());
});

// ===========================================================================
// export surface
// ===========================================================================

test("exports expected surface", () => {
  for (const name of [
    "macCommand",
    "linuxCommand",
    "winCommand",
    "command",
    "notify",
    "bell",
  ]) {
    assert.equal(typeof desktop[name], "function", name + " should be a function");
  }
});

// --- osascript newline escaping (multi-line body must not break osascript) ---

test("macCommand osascript: a multi-line body has no raw newline (escaped to \\n)", () => {
  const { cmd, args } = desktop.macCommand(
    { title: "T", body: "Line one.\nLine two.\r\nLine three." },
    false // force the osascript branch
  );
  assert.equal(cmd, "osascript");
  const script = args[1];
  assert.ok(!/[\r\n]/.test(script), "script must contain no raw CR/LF");
  assert.ok(script.includes("Line one.\\nLine two.\\nLine three."), "newlines become the literal \\n escape");
});

test("macCommand osascript: backslash doubling runs before newline escape", () => {
  const { args } = desktop.macCommand({ title: "T", body: "a\\b\nc" }, false);
  const script = args[1];
  // backslash doubled, then newline -> \n ; no raw newline survives
  assert.ok(!/[\r\n]/.test(script));
  assert.ok(script.includes("a\\\\b\\nc"));
});
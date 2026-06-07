"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
// Use the unprefixed builtin name so we share the exact same module object that
// git.js captured; this lets us swap execSync for a stub.
const cp = require("child_process");

const git = require("./git");

// Temporarily replace child_process.execSync for the duration of `fn`, then
// always restore it. git.js accesses cp.execSync as a property at call time, so
// patching the shared module object intercepts its git CLI fallback.
function withExecSync(fake, fn) {
  const orig = cp.execSync;
  cp.execSync = fake;
  try {
    return fn();
  } finally {
    cp.execSync = orig;
  }
}

test("prefers transcript gitBranch and does not call git", () => {
  withExecSync(() => { throw new Error("git should not be called"); }, () => {
    assert.equal(
      git.branch({ entries: [{ gitBranch: "feature-x" }], cwd: "/some/repo" }),
      "feature-x"
    );
  });
});

test("uses the last non-empty gitBranch from transcript entries", () => {
  withExecSync(() => { throw new Error("git should not be called"); }, () => {
    const entries = [
      { gitBranch: "old-branch" },
      { gitBranch: "" },
      { gitBranch: "current-branch" },
    ];
    assert.equal(git.branch({ entries, cwd: "/some/repo" }), "current-branch");
  });
});

test("falls back to git CLI when no transcript branch", () => {
  let captured = null;
  withExecSync((cmd) => { captured = cmd; return "main\n"; }, () => {
    assert.equal(git.branch({ entries: [{}], cwd: "/repo/dir" }), "main");
  });
  assert.ok(captured.includes("rev-parse --abbrev-ref HEAD"));
  assert.ok(captured.includes("/repo/dir"));
  assert.ok(captured.startsWith("git -C "));
});

test("detached HEAD result becomes empty string", () => {
  withExecSync(() => "HEAD\n", () => {
    assert.equal(git.branch({ entries: [], cwd: "/repo" }), "");
  });
});

test("git error becomes empty string", () => {
  withExecSync(() => { throw new Error("not a git repo"); }, () => {
    assert.equal(git.branch({ entries: [], cwd: "/repo" }), "");
  });
});

test("empty/whitespace git output becomes empty string", () => {
  withExecSync(() => "   \n", () => {
    assert.equal(git.branch({ entries: [], cwd: "/repo" }), "");
  });
});

test("no cwd and no transcript branch returns empty without calling git", () => {
  withExecSync(() => { throw new Error("git should not be called"); }, () => {
    assert.equal(git.branch({ entries: [] }), "");
  });
});

test("no args returns empty string and never throws", () => {
  withExecSync(() => { throw new Error("git should not be called"); }, () => {
    assert.equal(git.branch(), "");
  });
});

test("transcript branch takes priority over a working git CLI", () => {
  withExecSync(() => "git-branch\n", () => {
    assert.equal(
      git.branch({ entries: [{ gitBranch: "ts-branch" }], cwd: "/repo" }),
      "ts-branch"
    );
  });
});

test("trims surrounding whitespace from the git branch", () => {
  withExecSync(() => "  feature/login \n", () => {
    assert.equal(git.branch({ entries: [], cwd: "/repo" }), "feature/login");
  });
});
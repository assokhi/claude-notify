"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { label } = require("./session-label");

const LABEL_RE = /^[a-z]+-[a-z]+$/;

test("falsy ids collapse to the fixed sentinel 'session'", () => {
  assert.equal(label(""), "session");
  assert.equal(label(undefined), "session");
  assert.equal(label(null), "session");
  assert.equal(label(0), "session");
  assert.equal(label(false), "session");
  assert.equal(label(NaN), "session");
});

test("a normal id yields a two-word adjective-animal label", () => {
  const out = label("abc123");
  assert.match(out, LABEL_RE);
  const parts = out.split("-");
  assert.equal(parts.length, 2);
  assert.ok(parts[0].length > 0);
  assert.ok(parts[1].length > 0);
});

test("golden values lock determinism across runs (regression)", () => {
  // Pinned outputs of the documented sha256 + wordlist scheme. If the lists or
  // hashing change, these break on purpose (labels must stay stable per id).
  assert.equal(label("abc123"), "lucky-tiger");
  assert.equal(label("session-001"), "silver-koala");
  assert.equal(label("9f8e7d6c-1234-4abc-9def-0011223344556"), "shiny-hare");
  assert.equal(label("x"), "snappy-jackal");
  assert.equal(label("another-session-id"), "crisp-quokka");
});

test("same id always produces the same label (pure, no randomness)", () => {
  const id = "deadbeef-cafe-1234";
  const first = label(id);
  for (let i = 0; i < 50; i++) {
    assert.equal(label(id), first);
  }
});

test("non-string truthy ids are coerced deterministically", () => {
  assert.equal(label(12345), label("12345"));
  assert.equal(typeof label(12345), "string");
  assert.match(label(98765), LABEL_RE);
});

test("different ids almost always produce different labels", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(label("id-" + i));
  // High-entropy hash over a large product space -> mostly distinct.
  assert.ok(seen.size > 700, "expected many distinct labels, got " + seen.size);
});

test("two specific distinct ids differ", () => {
  assert.notEqual(label("alpha"), label("omega"));
});

test("hashing scheme is reproducible (sha256 is available & stable)", () => {
  // Independently confirm the underlying primitive the impl relies on, and that
  // the label re-derives identically for the same id.
  const id = "verify-the-scheme";
  const digest = crypto.createHash("sha256").update(id).digest();
  const out = label(id);
  const parts = out.split("-");
  const adjIdx = digest.readUInt32BE(0);
  const aniIdx = digest.readUInt32BE(4);
  assert.equal(label(id), out);
  assert.equal(parts.length, 2);
  assert.ok(Number.isInteger(adjIdx) && Number.isInteger(aniIdx));
});
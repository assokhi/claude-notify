"use strict";

// session-label.js
// Deterministic session_id -> short, stable, human-friendly "adjective-animal"
// label, shown in the notification title bracket (e.g. "blue-otter").
//
// Pure & stable: no randomness, no I/O. Same id always yields the same label
// (across calls AND across process restarts, since sha256 is fixed). Falsy id
// collapses to the sentinel "session".
//
// Zero external deps; only the `crypto` node builtin.

const crypto = require("crypto");

// Fixed wordlists. Order is part of the contract: changing/reordering these
// changes everyone's label, so treat them as append-only if ever extended.
const ADJECTIVES = [
  "amber", "azure", "blue", "bold", "brave", "bright", "calm", "clever",
  "cosmic", "crimson", "crisp", "daring", "eager", "electric", "fancy",
  "gentle", "golden", "happy", "hidden", "jolly", "keen", "lively",
  "lucky", "mellow", "mighty", "nimble", "noble", "polar", "quiet",
  "rapid", "royal", "rustic", "shiny", "silent", "silver", "smooth",
  "snappy", "solar", "spry", "stellar", "sunny", "swift", "teal",
  "tidy", "vivid", "warm", "wild", "witty", "zany", "zesty"
];

const ANIMALS = [
  "otter", "falcon", "panda", "tiger", "lynx", "heron", "koala", "moose",
  "raven", "gecko", "ibex", "marten", "newt", "ocelot", "puffin", "quokka",
  "robin", "seal", "stork", "toad", "urchin", "viper", "walrus", "yak",
  "zebra", "badger", "beaver", "bison", "cobra", "crane", "dingo", "egret",
  "ferret", "fox", "hare", "hawk", "jackal", "jaguar", "kestrel", "lemur",
  "manta", "narwhal", "osprey", "possum", "rabbit", "shark", "swan", "wombat"
];

// label(sessionId) -> "adjective-animal", or "session" for any falsy id.
function label(sessionId) {
  if (!sessionId) return "session";
  const id = String(sessionId);
  const digest = crypto.createHash("sha256").update(id).digest();
  // Two independent big-endian uint32 slices of the digest index each list.
  const adj = ADJECTIVES[digest.readUInt32BE(0) % ADJECTIVES.length];
  const animal = ANIMALS[digest.readUInt32BE(4) % ANIMALS.length];
  return adj + "-" + animal;
}

module.exports = { label };
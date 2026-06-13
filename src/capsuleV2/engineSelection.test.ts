import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  parseRequestedCapsuleEngine,
  requestWantsCapsuleV2,
  v1EngineSelection,
  v2EngineSelection,
} from "./engineSelection";

test("parseRequestedCapsuleEngine normalizes the known engines case-insensitively", () => {
  assert.equal(parseRequestedCapsuleEngine("v2"), "v2");
  assert.equal(parseRequestedCapsuleEngine("V2"), "v2");
  assert.equal(parseRequestedCapsuleEngine("  v2 "), "v2");
  assert.equal(parseRequestedCapsuleEngine("v1"), "v1");
  assert.equal(parseRequestedCapsuleEngine("legacy"), "legacy");
  assert.equal(parseRequestedCapsuleEngine("LEGACY"), "legacy");
  assert.equal(parseRequestedCapsuleEngine("default"), "default");
});

test("unrecognized, empty, or absent values normalize to default (old metadata stays readable)", () => {
  // Old run metadata that predates the engine-selection feature carries no
  // requested-engine string; it must read back as `default`, not error.
  assert.equal(parseRequestedCapsuleEngine(undefined), "default");
  assert.equal(parseRequestedCapsuleEngine(null), "default");
  assert.equal(parseRequestedCapsuleEngine(""), "default");
  assert.equal(parseRequestedCapsuleEngine("   "), "default");
  assert.equal(parseRequestedCapsuleEngine("v3"), "default");
  assert.equal(parseRequestedCapsuleEngine("garbage"), "default");
});

test("only v2 engages Capsule v2", () => {
  assert.equal(requestWantsCapsuleV2("v2"), true);
  assert.equal(requestWantsCapsuleV2("v1"), false);
  assert.equal(requestWantsCapsuleV2("legacy"), false);
  assert.equal(requestWantsCapsuleV2("default"), false);
});

test("v1EngineSelection records the request and optional fallback reason", () => {
  assert.deepEqual(v1EngineSelection("default"), {
    requested: "default",
    effective: "v1",
    fallbackReason: null,
    compactInspectFirst: false,
  });
  assert.deepEqual(v1EngineSelection("v2", "v2_build_failed: boom"), {
    requested: "v2",
    effective: "v1",
    fallbackReason: "v2_build_failed: boom",
    compactInspectFirst: false,
  });
});

test("v2EngineSelection never carries a fallback reason and tracks inspect-first", () => {
  assert.deepEqual(v2EngineSelection("v2", true), {
    requested: "v2",
    effective: "v2",
    fallbackReason: null,
    compactInspectFirst: true,
  });
  assert.deepEqual(v2EngineSelection("v2", false), {
    requested: "v2",
    effective: "v2",
    fallbackReason: null,
    compactInspectFirst: false,
  });
});

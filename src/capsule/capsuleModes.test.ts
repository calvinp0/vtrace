import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CAPSULE_MODE_LIMITS,
  CapsuleMode,
  DEFAULT_CAPSULE_MODE,
  isCapsuleMode,
  parseCapsuleMode,
  resolveCapsuleModeLimits,
} from "./capsuleModes";

test("mode limits follow the micro/standard/full sizing brief", () => {
  assert.deepEqual(CAPSULE_MODE_LIMITS[CapsuleMode.Micro], { maxItems: 2, maxChars: 1_500 });
  assert.deepEqual(CAPSULE_MODE_LIMITS[CapsuleMode.Standard], { maxItems: 5, maxChars: 6_000 });
  assert.deepEqual(CAPSULE_MODE_LIMITS[CapsuleMode.Full], { maxItems: 8, maxChars: 12_000 });
});

test("micro is strictly smaller than standard which is strictly smaller than full", () => {
  const micro = CAPSULE_MODE_LIMITS[CapsuleMode.Micro];
  const standard = CAPSULE_MODE_LIMITS[CapsuleMode.Standard];
  const full = CAPSULE_MODE_LIMITS[CapsuleMode.Full];

  assert.ok(micro.maxItems < standard.maxItems && standard.maxItems < full.maxItems);
  assert.ok(micro.maxChars < standard.maxChars && standard.maxChars < full.maxChars);
});

test("parseCapsuleMode accepts known modes case-insensitively and rejects others", () => {
  assert.equal(parseCapsuleMode("micro"), CapsuleMode.Micro);
  assert.equal(parseCapsuleMode("  FULL "), CapsuleMode.Full);
  assert.equal(parseCapsuleMode("Standard"), CapsuleMode.Standard);
  assert.equal(parseCapsuleMode("huge"), undefined);
  assert.equal(parseCapsuleMode(""), undefined);
});

test("isCapsuleMode narrows only valid values", () => {
  assert.equal(isCapsuleMode("micro"), true);
  assert.equal(isCapsuleMode("skip"), false);
});

test("resolveCapsuleModeLimits defaults to standard", () => {
  assert.deepEqual(resolveCapsuleModeLimits(), CAPSULE_MODE_LIMITS[DEFAULT_CAPSULE_MODE]);
});

test("resolveCapsuleModeLimits applies overrides including zero", () => {
  assert.deepEqual(
    resolveCapsuleModeLimits(CapsuleMode.Full, { maxItems: 2, maxChars: 1_500 }),
    { maxItems: 2, maxChars: 1_500 },
  );
  assert.deepEqual(
    resolveCapsuleModeLimits(CapsuleMode.Micro, { maxItems: 0 }),
    { maxItems: 0, maxChars: 1_500 },
  );
});

test("resolveCapsuleModeLimits rejects malformed overrides", () => {
  assert.throws(() => resolveCapsuleModeLimits(CapsuleMode.Micro, { maxChars: -1 }), /non-negative/);
  assert.throws(() => resolveCapsuleModeLimits(CapsuleMode.Micro, { maxItems: 1.5 }), /integer/);
});

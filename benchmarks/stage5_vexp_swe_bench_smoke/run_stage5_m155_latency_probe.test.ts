import assert from "node:assert/strict";
import { test } from "bun:test";

import { mean, median, percentile } from "./run_stage5_m155_latency_probe";

// --- 1. empty input is unavailable, never zero ------------------------------
// A latency of 0 ms and "we measured nothing" are different claims, and M155 §49
// requires the second to be reported as unavailable rather than folded in as a
// fast case.

test("percentile/median/mean report null for no samples", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(median([]), null);
  assert.equal(mean([]), null);
});

// --- 2. nearest-rank percentile matches the M122 convention -----------------

test("percentile uses nearest-rank and is order-independent", () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(values, 0.5), 50);
  assert.equal(percentile(values, 0.9), 90);
  assert.equal(percentile([...values].reverse(), 0.9), 90);
});

test("percentile clamps to the available range", () => {
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 2], 0), 1);
  assert.equal(percentile([1, 2], 1), 2);
});

// --- 3. a single outlier moves p90 but not the median -----------------------
// This is the property that makes the pair worth reporting together: M155 §69
// asks for both because they answer different questions about the tail.

test("median resists an outlier that p90 exposes", () => {
  const steady = [10, 10, 10, 10, 10, 10, 10, 10, 10, 5000];
  assert.equal(median(steady), 10);
  assert.equal(percentile(steady, 0.9), 10);
  assert.equal(percentile(steady, 0.95), 5000);
});

test("mean is dragged by the same outlier the median ignores", () => {
  const steady = [10, 10, 10, 10, 10, 10, 10, 10, 10, 5000];
  assert.equal(median(steady), 10);
  assert.ok(mean(steady)! > 500);
});

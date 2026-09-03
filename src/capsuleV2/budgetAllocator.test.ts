import assert from "node:assert/strict";
import { test } from "bun:test";

import { CANDIDATE_POOL_FLOOR, SUPPORT_ORDERING_WINDOW, allocateBudget, candidatePoolFor } from "./budgetAllocator";
import { CapsuleV2Mode } from "./types";

test("the pivot cap is tiered, the support ordering window is one constant (M208)", () => {
  const micro = allocateBudget(1000); const standard = allocateBudget(8000); const full = allocateBudget(16000);
  assert.deepEqual([micro.tier, standard.tier, full.tier], [CapsuleV2Mode.Micro, CapsuleV2Mode.Standard, CapsuleV2Mode.Full]);
  assert.deepEqual([micro.maxPivots, standard.maxPivots, full.maxPivots], [1, 2, 5]);
  for (const budget of [750, 1000, 1499, 1500, 4000, 8000, 11999, 12000, 16000, 20000]) {
    assert.equal(allocateBudget(budget).supportWindow, SUPPORT_ORDERING_WINDOW, `window at ${budget}`);
  }
});

test("the candidate allowance is monotone in the budget and floored at the historical pool (M207)", () => {
  let previous = 0;
  for (const budget of [500, 1000, 3000, 4000, 8000, 16000, 100000]) {
    const pool = candidatePoolFor(budget);
    assert.ok(pool >= CANDIDATE_POOL_FLOOR && pool >= previous);
    previous = pool;
  }
});

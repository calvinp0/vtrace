import assert from "node:assert/strict";
import { test } from "bun:test";

import { armOrder, coverage, orderCases, type SelectionCase } from "./stage5_m155_paired_selection";

// Instance ids must be globally unique, exactly as real SWE-bench ids are. An
// earlier version of this helper restarted numbering per (repo, difficulty) group,
// so a repository spanning two difficulty tiers produced colliding ids — and the
// collision surfaced as a bogus proportionality failure rather than as an identity
// problem. A shared counter makes that impossible to reintroduce.
let nextId = 0;
function corpus(spec: Array<[string, string, number]>): SelectionCase[] {
  const out: SelectionCase[] = [];
  for (const [repo, difficulty, n] of spec) {
    for (let i = 0; i < n; i += 1) {
      nextId += 1;
      out.push({ instance_id: `${repo.replace("/", "__")}-${String(nextId).padStart(4, "0")}`, repo, difficulty });
    }
  }
  return out;
}

test("instance ids in the test corpus are unique across difficulty tiers", () => {
  const cases = corpus([["a/a", "<15 min fix", 3], ["a/a", "1-4 hours", 3]]);
  assert.equal(new Set(cases.map((c) => c.instance_id)).size, 6);
});

test("a repository spanning two difficulty tiers keeps each case's own difficulty", () => {
  const cases = corpus([["django/django", "<15 min fix", 14], ["django/django", "15 min - 1 hour", 27]]);
  const ordered = orderCases(cases);
  const byDifficulty = new Map<string, number>();
  for (const c of ordered) byDifficulty.set(c.difficulty, (byDifficulty.get(c.difficulty) ?? 0) + 1);
  assert.equal(byDifficulty.get("<15 min fix"), 14);
  assert.equal(byDifficulty.get("15 min - 1 hour"), 27);
});

// --- determinism ------------------------------------------------------------
// No seed is recorded anywhere, so the ordering has to be a pure function of the
// input. If it were not, the frozen manifest could not be re-derived.

test("the ordering is deterministic and independent of input order", () => {
  const cases = corpus([["a/a", "<15 min fix", 5], ["b/b", "1-4 hours", 3], ["c/c", "15 min - 1 hour", 7]]);
  const forward = orderCases(cases).map((c) => c.instance_id);
  const reversed = orderCases([...cases].reverse()).map((c) => c.instance_id);
  const shuffled = orderCases([cases[4]!, cases[0]!, ...cases.slice(1, 4), ...cases.slice(5)]).map((c) => c.instance_id);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(shuffled, forward);
});

test("every corpus case appears exactly once", () => {
  const cases = corpus([["a/a", "<15 min fix", 14], ["b/b", "15 min - 1 hour", 27], ["c/c", "1-4 hours", 3]]);
  const ordered = orderCases(cases);
  assert.equal(ordered.length, cases.length);
  assert.equal(new Set(ordered.map((c) => c.instance_id)).size, cases.length);
  assert.deepEqual(ordered.map((c) => c.order), cases.map((_, i) => i + 1));
});

// --- prefix proportionality (§32/§34) ---------------------------------------
// The paired-30 set is a PREFIX. That only works if a prefix is representative.

test("a prefix is approximately proportional by difficulty", () => {
  // The real corpus shape: 38 / 53 / 8 / 1.
  const cases = corpus([
    ["django/django", "<15 min fix", 14], ["sympy/sympy", "<15 min fix", 8],
    ["sphinx-doc/sphinx", "<15 min fix", 6], ["psf/requests", "<15 min fix", 4],
    ["pytest-dev/pytest", "<15 min fix", 2], ["matplotlib/matplotlib", "<15 min fix", 2],
    ["pallets/flask", "<15 min fix", 1], ["astropy/astropy", "<15 min fix", 1],
    ["django/django", "15 min - 1 hour", 27], ["sympy/sympy", "15 min - 1 hour", 8],
    ["matplotlib/matplotlib", "15 min - 1 hour", 5], ["pydata/xarray", "15 min - 1 hour", 5],
    ["astropy/astropy", "15 min - 1 hour", 3], ["scikit-learn/scikit-learn", "15 min - 1 hour", 2],
    ["mwaskom/seaborn", "15 min - 1 hour", 1], ["sphinx-doc/sphinx", "15 min - 1 hour", 1],
    ["pytest-dev/pytest", "15 min - 1 hour", 1],
    ["django/django", "1-4 hours", 3], ["pylint-dev/pylint", "1-4 hours", 2],
    ["astropy/astropy", "1-4 hours", 1], ["sympy/sympy", "1-4 hours", 1],
    ["pytest-dev/pytest", "1-4 hours", 1],
    ["pydata/xarray", ">4 hours", 1],
  ]);
  assert.equal(cases.length, 100);
  const ordered = orderCases(cases);
  for (const row of coverage(ordered, 30, (c) => c.difficulty)) {
    // Within 10 percentage points of the corpus share at n=30.
    assert.ok(
      Math.abs(row.selectedShare - row.corpusShare) <= 0.10,
      `${row.stratum}: selected ${row.selectedShare} vs corpus ${row.corpusShare}`,
    );
  }
});

test("a prefix does not concentrate on one repository", () => {
  const cases = corpus([
    ["django/django", "15 min - 1 hour", 44], ["sympy/sympy", "15 min - 1 hour", 17],
    ["sphinx-doc/sphinx", "<15 min fix", 7], ["matplotlib/matplotlib", "<15 min fix", 7],
    ["pydata/xarray", "1-4 hours", 6], ["astropy/astropy", "1-4 hours", 5],
    ["psf/requests", "<15 min fix", 4], ["pytest-dev/pytest", "<15 min fix", 4],
    ["pylint-dev/pylint", "1-4 hours", 2], ["scikit-learn/scikit-learn", "1-4 hours", 2],
    ["pallets/flask", "<15 min fix", 1], ["mwaskom/seaborn", "<15 min fix", 1],
  ]);
  const ordered = orderCases(cases);
  const first30 = ordered.slice(0, 30);
  const django = first30.filter((c) => c.repo === "django/django").length;
  // django is 44% of the corpus; a proportional prefix must not be ~all django.
  assert.ok(django <= 16, `django took ${django} of 30`);
  assert.ok(new Set(first30.map((c) => c.repo)).size >= 6, "prefix should span several repositories");
});

test("extending the prefix never reorders what was already frozen", () => {
  // This is what makes 30 -> 100 an extension rather than a new selection.
  const cases = corpus([["a/a", "<15 min fix", 20], ["b/b", "15 min - 1 hour", 20], ["c/c", "1-4 hours", 10]]);
  const ordered = orderCases(cases).map((c) => c.instance_id);
  assert.deepEqual(ordered.slice(0, 30), orderCases(cases).slice(0, 30).map((c) => c.instance_id));
  assert.deepEqual(ordered.slice(0, 10), ordered.slice(0, 30).slice(0, 10));
});

// --- selection independence (§33) -------------------------------------------

test("selection consumes only instance id, repository and difficulty", () => {
  // A case carrying retrieval outcomes must order identically to one without them:
  // conditioning on gold state would bias the utility estimate.
  const plain = corpus([["a/a", "<15 min fix", 4], ["b/b", "1-4 hours", 4]]);
  const contaminated = plain.map((c) => ({
    ...c, goldDelivered: true, top1: true, vtraceScore: 0.99,
  })) as unknown as SelectionCase[];
  assert.deepEqual(orderCases(contaminated).map((c) => c.instance_id), orderCases(plain).map((c) => c.instance_id));
});

test("an unknown difficulty label is ordered deterministically, not dropped", () => {
  const cases = corpus([["a/a", "<15 min fix", 2], ["b/b", "brand new label", 2]]);
  const ordered = orderCases(cases);
  assert.equal(ordered.length, 4);
});

// --- arm order (§49) --------------------------------------------------------

test("arm order alternates so neither condition is systematically first", () => {
  assert.deepEqual(armOrder(1), ["baseline", "vtrace"]);
  assert.deepEqual(armOrder(2), ["vtrace", "baseline"]);
  assert.deepEqual(armOrder(29), ["baseline", "vtrace"]);
  const firsts = Array.from({ length: 30 }, (_, i) => armOrder(i + 1)[0]);
  assert.equal(firsts.filter((a) => a === "baseline").length, 15);
  assert.equal(firsts.filter((a) => a === "vtrace").length, 15);
});

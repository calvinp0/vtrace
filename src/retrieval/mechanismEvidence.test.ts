import { expect, test } from "bun:test";

import { extractMechanismFacts } from "../indexer/extractMechanismFacts";
import { deriveQueryIntent } from "./querySemantics";
import {
  deriveBehavioralObjective,
  hasBehavioralOperation,
  type BehavioralObjective,
} from "./behavioralObjective";
import {
  evaluateMechanismEvidence,
  DIRECT_MECHANISM_EVIDENCE,
  PARTIAL_MECHANISM_EVIDENCE,
  MECHANISM_SUBJECT_FLOOR,
} from "./mechanismEvidence";

function objective(task: string): BehavioralObjective {
  const derived = deriveBehavioralObjective(deriveQueryIntent(task));
  if (!hasBehavioralOperation(derived)) throw new Error(`no operation derived for: ${task}`);
  return derived;
}

/** Score one body against one request, with subject relevance assumed strong. */
function score(task: string, body: string, subjectRelevance = 0.8): number {
  return evaluateMechanismEvidence({
    objective: objective(task),
    facts: extractMechanismFacts(body),
    localName: "candidate",
    fqName: "mod.py::candidate",
    filePath: "mod.py",
    subjectRelevance,
  }).score;
}

const CACHE_WRAPPER = "def load(key):\n    if key in CACHE:\n        return CACHE[key]\n    value = process(key)\n    CACHE[key] = value\n    return value\n";
const SELECTOR = "def process(data):\n    options = collect(data)\n    return options[0]\n";
const ACCESSOR = "def family(self):\n    return self._family\n";

// --- §12 / §39 the relationship REVERSES, it is not a penalty -----------------
//
// This pair is the whole argument that mechanism evidence is relevance rather
// than a heuristic bonus. The same definition is strong evidence for one request
// and no evidence for another, and nothing anywhere subtracts from it.

test("a cache wrapper earns nothing on a selection question", () => {
  expect(score("How does the system choose which option wins?", CACHE_WRAPPER)).toBe(0);
});

test("the SAME cache wrapper is direct evidence on a cache question", () => {
  expect(score("How is the result cached?", CACHE_WRAPPER)).toBe(DIRECT_MECHANISM_EVIDENCE);
});

test("a selector earns nothing on a cache question", () => {
  expect(score("How is the result cached?", SELECTOR)).toBe(0);
});

test("withholding names the reason rather than reporting a silent zero", () => {
  const evidence = evaluateMechanismEvidence({
    objective: objective("How does the system choose which option wins?"),
    facts: extractMechanismFacts(CACHE_WRAPPER),
    localName: "load",
    fqName: "mod.py::load",
    filePath: "mod.py",
    subjectRelevance: 0.8,
  });
  expect(evidence.withheldReason).toContain("selection");
});

// --- §40 accessor controls ----------------------------------------------------

test("an accessor earns nothing on a selection question", () => {
  expect(score("How is the winning family chosen?", ACCESSOR)).toBe(0);
});

test("the same accessor is direct evidence on a storage question", () => {
  expect(score("Where is the selected family stored on the reaction?", ACCESSOR))
    .toBe(DIRECT_MECHANISM_EVIDENCE);
});

// --- §38 / §45 ordering is not selection --------------------------------------

test("sorting for display never reaches the direct tier on a selection question", () => {
  // §38. Sorting IS half of "which one wins" — a first element means nothing
  // without an order — so an ordering helper is truthfully partial evidence
  // rather than none. What it must never be is the DIRECT tier: sorting alone
  // does not select. In practice the subject-relevance floor also excludes a
  // display helper from a backend question; this asserts the tier, which holds
  // regardless of subject.
  const sorting = score("How is the preferred backend selected?", "def render(names):\n    return ', '.join(sorted(names))\n");
  expect(sorting).toBeLessThan(DIRECT_MECHANISM_EVIDENCE);
  expect(sorting).toBe(PARTIAL_MECHANISM_EVIDENCE);
});

test("an ordering helper is direct evidence on a precedence question", () => {
  const body = "def all_families(rmg, arc):\n    rmg = list(dict.fromkeys(rmg))\n    return rmg + arc\n";
  expect(score("What determines the precedence when multiple families match?", body))
    .toBe(DIRECT_MECHANISM_EVIDENCE);
});

// --- §13 / §30 performing beats delegating ------------------------------------

test("the definition that performs the operation outscores one that delegates", () => {
  const delegator = "def get_family(label):\n    if label in CACHE:\n        return CACHE[label]\n    CACHE[label] = build(label)\n    return CACHE[label]\n";
  const decider = "def determine_family(self):\n    dicts = self.product_dicts\n    family = dicts[0]['family']\n    return family\n";
  const question = "How does it decide which family wins?";
  expect(score(question, decider)).toBeGreaterThan(score(question, delegator));
});

// --- §37 / §77 mechanism cannot rescue an irrelevant candidate ----------------

test("mechanism evidence is withheld below the subject-relevance floor", () => {
  // The scheduler question has nothing to do with this code. A loop is not a
  // reason to deliver it, which is the mistake centrality used to make.
  expect(score("How does the scheduler choose which worker wins?", SELECTOR, MECHANISM_SUBJECT_FLOOR - 0.01))
    .toBe(0);
});

test("the floor withholds the score but still reports what matched", () => {
  const evidence = evaluateMechanismEvidence({
    objective: objective("How does the scheduler choose which worker wins?"),
    facts: extractMechanismFacts(SELECTOR),
    localName: "process",
    fqName: "mod.py::process",
    filePath: "mod.py",
    subjectRelevance: 0,
  });
  expect(evidence.score).toBe(0);
  expect(evidence.matched.length).toBeGreaterThan(0);
  expect(evidence.withheldReason).toContain("floor");
});

// --- §64 bounded, and not a sum over facts ------------------------------------

test("stacking compatible mechanisms cannot exceed one direct fact", () => {
  // Measured on ARC: a function with four weakly-compatible mechanisms
  // out-earned the one that actually decides. Containing more control flow is
  // not being more decisive, so the contribution is the strongest single fact.
  const busy = "def busy(rows, backends):\n    rows = sorted(rows)\n    for backend in backends:\n        if backend.ok():\n            return backend\n    return rows[0]\n";
  expect(score("How does it choose which row wins?", busy)).toBeLessThanOrEqual(DIRECT_MECHANISM_EVIDENCE);
});

test("a definition with no facts earns nothing", () => {
  expect(score("How does it choose which option wins?", "def noop(x):\n    return x\n")).toBe(0);
});

// --- determinism ---------------------------------------------------------------

test("evaluation is pool-independent and repeatable", () => {
  const first = score("How does the system choose which option wins?", SELECTOR);
  const second = score("How does the system choose which option wins?", SELECTOR);
  expect(first).toBe(second);
});

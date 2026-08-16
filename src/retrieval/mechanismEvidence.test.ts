import { expect, test } from "bun:test";

import { extractMechanismFacts } from "../indexer/extractMechanismFacts";
import { deriveQueryIntent } from "./querySemantics";
import {
  deriveBehavioralObjective,
  hasBehavioralOperation,
  type BehavioralObjective,
} from "./behavioralObjective";
import {
  alignmentOf,
  evaluateMechanismEvidence,
  subjectMatchClass,
  DIRECT_MECHANISM_EVIDENCE,
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
  // Since subject alignment landed this is now zero, not merely sub-direct:
  // `names` is neither the backend nor produced by anything that names one.
  const sorting = score("How is the preferred backend selected?", "def render(names):\n    return ', '.join(sorted(names))\n");
  expect(sorting).toBeLessThan(DIRECT_MECHANISM_EVIDENCE);
  expect(sorting).toBe(0);
});

test("an ordering helper is direct evidence on a precedence question", () => {
  // Realistic operand names: ARC's own helper works on `rmg_families` /
  // `arc_families`, and the abbreviation `rmg` hid the subject the request names.
  const body = "def all_families(rmg_families, arc_families):\n    rmg_families = list(dict.fromkeys(rmg_families))\n    return rmg_families + arc_families\n";
  expect(score("What determines the precedence when multiple families match?", body))
    .toBe(DIRECT_MECHANISM_EVIDENCE);
});

// --- §13 / §30 performing beats delegating ------------------------------------

test("the definition that performs the operation outscores one that delegates", () => {
  const delegator = "def get_family(label):\n    if label in CACHE:\n        return CACHE[label]\n    CACHE[label] = build(label)\n    return CACHE[label]\n";
  // Shaped like ARC's real determine_family: the operand name says nothing about
  // the subject, and the call that produced it says everything.
  const decider = "def determine_family(self):\n    product_dicts = get_reaction_family_products(rxn=self)\n    family = product_dicts[0]['family']\n    return family\n";
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

// --- subject alignment (§7, §10, §11, §19-§29) --------------------------------

test("the same operation on a different subject earns nothing", () => {
  // Both take element zero of a collection they just built. Only one of them is
  // choosing a backend. This is the Gaussian regression in miniature.
  const chooser = "def choose_backend(config):\n    candidates = matching_backends(config)\n    return candidates[0]\n";
  const parser = "def parse_frequency(output):\n    frequencies = extract_frequencies(output)\n    return frequencies[0]\n";
  const question = "How does the system decide which backend wins?";
  expect(score(question, chooser)).toBe(DIRECT_MECHANISM_EVIDENCE);
  expect(score(question, parser)).toBe(0);
});

test("the alignment reverses with the subject, like compatibility does", () => {
  const chooser = "def choose_backend(config):\n    candidates = matching_backends(config)\n    return candidates[0]\n";
  const parser = "def parse_frequency(output):\n    frequencies = extract_frequencies(output)\n    return frequencies[0]\n";
  const question = "How is the reported frequency selected?";
  expect(score(question, parser)).toBe(DIRECT_MECHANISM_EVIDENCE);
  expect(score(question, chooser)).toBe(0);
});

test("an uninformative operand aligns through its one-hop producer", () => {
  // §11/§22: `xs` names nothing. Only the call that produced it connects the
  // mechanism to the subject, which is exactly ARC's product_dicts shape.
  const body = "def resolve(config):\n    xs = matching_backends_for(config)\n    return xs[0]\n";
  expect(score("How does the system choose which backend wins?", body))
    .toBe(DIRECT_MECHANISM_EVIDENCE);
});

test("a wrong producer in a topically plausible definition earns nothing", () => {
  // §25: path, class and file all look right; the operand's producer does not.
  const body = "def route(self, level):\n    values = parse_frequencies(self.output)\n    return values[0]\n";
  expect(score("How does the adapter decide which route keywords to emit?", body)).toBe(0);
});

test("alignment is decided locally, never from the candidate's path or name", () => {
  // The definition is NAMED for the subject and still earns nothing, because the
  // statement it runs is about something else. §8 forbids the alternative.
  const body = "def backend_selector(output):\n    frequencies = extract_frequencies(output)\n    return frequencies[0]\n";
  expect(score("How does the system decide which backend wins?", body)).toBe(0);
});

test("a request naming no subject cannot refuse alignment", () => {
  const body = "def process(data):\n    options = collect(data)\n    return options[0]\n";
  const evidence = evaluateMechanismEvidence({
    objective: { ...objective("How does it decide which one wins?"), subjectTerms: [] },
    facts: extractMechanismFacts(body),
    localName: "process",
    fqName: "mod.py::process",
    filePath: "mod.py",
    subjectRelevance: 0.8,
  });
  expect(evidence.matched[0]?.alignment).toBe("undecidable");
  expect(evidence.score).toBe(DIRECT_MECHANISM_EVIDENCE);
});

test("a cache question is not refused because the operand names the cache", () => {
  // The operand of a cache consult is the STORE. Testing it against the
  // request's subject would refuse the only fact that answers the question.
  expect(score("How is the result cached?", CACHE_WRAPPER)).toBe(DIRECT_MECHANISM_EVIDENCE);
});

test("withholding on alignment names the value the mechanism actually acts on", () => {
  const evidence = evaluateMechanismEvidence({
    objective: objective("How does the system decide which backend wins?"),
    facts: extractMechanismFacts("def parse_frequency(output):\n    frequencies = extract_frequencies(output)\n    return frequencies[0]\n"),
    localName: "parse_frequency",
    fqName: "mod.py::parse_frequency",
    filePath: "mod.py",
    subjectRelevance: 0.8,
  });
  expect(evidence.score).toBe(0);
  expect(evidence.withheldReason).toContain("frequencies");
  expect(evidence.withheldReason).toContain("does not ask about");
});

// --- M153: subject match CLASS, not just yes/no --------------------------------
//
// `namesSubject` answers a boolean, which leaves every aligned fact
// indistinguishable and forces candidate admission to break ties on `symbol_id` —
// a content hash. Exact token identity is strictly stronger evidence than a stem
// approximation, and saying so costs no score and no threshold.

test("M153 an exact subject-term token is an exact match", () => {
  expect(subjectMatchClass("source_suffix", new Set(["source", "file"]))).toBe("exact");
});

test("M153 a stem-only overlap is weaker than exact", () => {
  // `files` reaches `file` only through the stem rule.
  expect(subjectMatchClass("mtimes_of_files", new Set(["file"]))).toBe("stem");
});

test("M153 no shared token at all is no match", () => {
  expect(subjectMatchClass("unrelated_thing", new Set(["backend", "parser"]))).toBe("none");
});

test("M153 an exact match anywhere in the name wins over a stem match", () => {
  // Both apply; the class must report the stronger one.
  expect(subjectMatchClass("files_and_source", new Set(["source", "file"]))).toBe("exact");
});

test("M153 an empty name matches nothing", () => {
  expect(subjectMatchClass("", new Set(["backend"]))).toBe("none");
});

test("M153 the class agrees with the alignment predicate it backs", () => {
  // Whatever counts as a match for alignment must be a non-"none" class, or the
  // two would disagree about the same fact.
  const terms = new Set(["adapter"]);
  expect(subjectMatchClass("adapters", terms)).not.toBe("none");
  expect(alignmentOf("adapters", "", terms)).toBe("direct_operand");
});

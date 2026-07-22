// M57 — Digest decision contract: target selection, render, parse, and the post-hoc
// per-target decision classifier. Pure unit tests (no DB, no IO, no live agents).

import assert from "node:assert/strict";
import { test } from "bun:test";

import type {
  CapsuleV2ProductResponse,
  CapsuleV2ProductItem,
  CapsuleV2DigestImpactSeam,
} from "./productAdapter";
import {
  DIGEST_DECISION_CONTRACT_START,
  DIGEST_DECISION_CONTRACT_END,
  MAX_DIGEST_DECISION_TARGETS,
  selectDigestDecisionTargets,
  selectBoundedDigestDecisionTargets,
  renderDigestDecisionContractText,
  renderBoundedDigestDecisionContractText,
  buildDigestDecisionContract,
  parseDigestDecisionContract,
  parseStructuredAgentDecisions,
  classifyDigestDecisionContract,
  classifyDigestPivotConfidence,
  NO_HIGH_CONFIDENCE_REQUIRED_MARKER,
  selectDigestActionFiles,
  MAX_DIGEST_ACTION_FILES,
  type DigestDecisionTarget,
  type DigestDecisionToolCall,
} from "./digestDecisionContract";

function pivot(
  path: string,
  symbol: string,
  roleReason: string,
  evidence: string[] = [],
): CapsuleV2ProductItem {
  return {
    role: "pivot",
    path,
    symbol,
    fqName: "", // empty → identity falls back to path::symbol (the common capsule case)
    kind: "function",
    roleReason,
    contentMode: "full",
    source: null,
    signature: null,
    evidence,
    estimatedTokens: 10,
    isNonSourceExample: false,
  };
}

function response(pivots: CapsuleV2ProductItem[]): CapsuleV2ProductResponse {
  return { pivots } as unknown as CapsuleV2ProductResponse;
}

const ANCHOR = "source line anchor in the issue points here"; // → source-anchored (not hidden)
const HIDDEN = "actionable function — exercised by a failing test"; // → hidden / non-traceback

function impactSeam(reps: Array<{ path: string; symbol?: string; role?: "dependent" | "caller" }>): CapsuleV2DigestImpactSeam {
  return {
    dependentCount: reps.length,
    crossFileDependentCount: reps.length,
    available: true,
    representative: reps.map((r) => ({ role: r.role ?? "dependent", path: r.path, symbol: r.symbol })),
  };
}

test("M57: lead pivot is always a required target", () => {
  const targets = selectDigestDecisionTargets(response([pivot("src/foo.py", "bar", ANCHOR)]));
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.kind, "PIVOT");
  assert.equal(targets[0]!.target, "src/foo.py::bar");
  assert.equal(targets[0]!.path, "src/foo.py");
});

test("M57: hidden/non-traceback co-pivot is included as a required target", () => {
  const targets = selectDigestDecisionTargets(
    response([
      pivot("src/symptom.py", "trigger", ANCHOR), // lead, source-anchored
      pivot("src/cause.py", "root", HIDDEN), // hidden co-pivot
    ]),
  );
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((t) => t.target),
    ["src/symptom.py::trigger", "src/cause.py::root"],
  );
  assert.equal(targets[1]!.hidden, true);
});

test("M57: an impact representative is included when impact enrichment exists", () => {
  const targets = selectDigestDecisionTargets(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "uses_bar", role: "dependent" }]),
  );
  assert.equal(targets.length, 2);
  assert.equal(targets[1]!.kind, "IMPACT");
  assert.equal(targets[1]!.target, "src/dep.py::uses_bar");
});

test("M57: required target cap (<=4) is enforced", () => {
  const targets = selectDigestDecisionTargets(
    response([
      pivot("src/a.py", "lead", ANCHOR),
      pivot("src/b.py", "hid", HIDDEN),
      pivot("src/c.py", "more", HIDDEN),
    ]),
    impactSeam([
      { path: "src/d.py", symbol: "d" },
      { path: "src/e.py", symbol: "e" },
      { path: "src/f.py", symbol: "f" },
    ]),
  );
  assert.ok(targets.length <= MAX_DIGEST_DECISION_TARGETS);
  assert.equal(targets.length, 4);
  // At most one hidden co-pivot is taken (lead + 1 hidden), then <=2 impact reps.
  assert.equal(targets.filter((t) => t.kind === "PIVOT").length, 2);
  assert.equal(targets.filter((t) => t.kind === "IMPACT").length, 2);
});

test("M57: a duplicate lead-pivot / impact target is not repeated", () => {
  // impact representative points at the SAME file as the lead pivot → must be skipped
  // (cross-file requirement + dedup), so only the lead pivot remains.
  const targets = selectDigestDecisionTargets(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([
      { path: "src/foo.py", symbol: "bar" }, // duplicate identity → dropped
      { path: "src/foo.py", symbol: "other" }, // same file → dropped (not cross-file)
    ]),
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.target, "src/foo.py::bar");
});

test("M57: no pivots → no targets and an empty contract", () => {
  const targets = selectDigestDecisionTargets(response([]));
  assert.deepEqual(targets, []);
  assert.equal(renderDigestDecisionContractText(targets), "");
  assert.equal(buildDigestDecisionContract(response([])).text, "");
});

test("M57: rendered contract carries both sentinels exactly once and the rules", () => {
  const { text } = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "qux" }]),
  );
  assert.equal((text.match(new RegExp(DIGEST_DECISION_CONTRACT_START, "g")) ?? []).length, 1);
  assert.equal((text.match(new RegExp(DIGEST_DECISION_CONTRACT_END, "g")) ?? []).length, 1);
  assert.match(text, /1\. PIVOT src\/foo\.py::bar/);
  assert.match(text, /2\. IMPACT src\/dep\.py::qux/);
  assert.match(text, /decision: EDIT \| RULE_OUT/);
  assert.match(text, /Do not ignore required targets\./);
});

test("M57: parse detects the contract and its targets; generic glyphs do NOT count", () => {
  const { text } = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "qux" }]),
  );
  const parsed = parseDigestDecisionContract(text);
  assert.equal(parsed.present, true);
  assert.deepEqual(
    parsed.targets.map((t) => `${t.kind} ${t.target}`),
    ["PIVOT src/foo.py::bar", "IMPACT src/dep.py::qux"],
  );
  assert.equal(parsed.targets[0]!.path, "src/foo.py");

  // A plain enriched digest (glyphs ●/○/→ and a budget line) is NOT a decision contract.
  const fakeDigest = "● pivot src/foo.py::bar\n○ skel src/x.py::y\n→ impact 3 dependents, 2 cross-file\nbudget: 100/8000t";
  assert.equal(parseDigestDecisionContract(fakeDigest).present, false);
});

// --- post-hoc classifier ----------------------------------------------------

const T_LEAD: DigestDecisionTarget = { kind: "PIVOT", target: "src/foo.py::bar", path: "src/foo.py", reason: "lead" };
const T_HID: DigestDecisionTarget = { kind: "PIVOT", target: "src/cause.py::root", path: "src/cause.py", reason: "hidden" };
const T_IMP: DigestDecisionTarget = { kind: "IMPACT", target: "src/dep.py::qux", path: "src/dep.py", reason: "dependent" };

function tc(category: string, p?: string): DigestDecisionToolCall {
  return { category, path: p };
}

test("M57 classifier: EDITED (read then patched) vs EDITED_WITHOUT_INSPECTION", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_LEAD, T_HID],
    toolCalls: [tc("read", "/repo/.bench-repos/proj/src/foo.py"), tc("edit", "/repo/.bench-repos/proj/src/foo.py")],
    editedFiles: ["src/foo.py", "src/cause.py"], // cause.py edited but never read
  });
  const byPath = Object.fromEntries(c.requiredTargets.map((r) => [r.target.path, r.decision]));
  assert.equal(byPath["src/foo.py"], "EDITED");
  assert.equal(byPath["src/cause.py"], "EDITED_WITHOUT_INSPECTION");
  assert.equal(c.requiredTargetEditedCount, 2);
  assert.equal(c.requiredTargetEditedWithoutInspectionCount, 1);
});

test("M57 classifier: INSPECTED_ONLY vs IGNORED", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_LEAD, T_IMP],
    toolCalls: [tc("read", "/x/.bench-repos/p/src/foo.py"), tc("search", null)],
    editedFiles: [],
  });
  const byPath = Object.fromEntries(c.requiredTargets.map((r) => [r.target.path, r.decision]));
  assert.equal(byPath["src/foo.py"], "INSPECTED_ONLY"); // read, not edited/ruled out
  assert.equal(byPath["src/dep.py"], "IGNORED"); // never read/edited/ruled out
  assert.equal(c.requiredTargetInspectedCount, 1);
  assert.equal(c.requiredTargetIgnoredCount, 1);
});

test("M57 classifier: a search/grep hit alone is NOT inspection (still IGNORED)", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_IMP],
    toolCalls: [tc("search", "/x/.bench-repos/p/src/dep.py")],
    editedFiles: [],
  });
  assert.equal(c.requiredTargets[0]!.decision, "IGNORED");
});

test("M57 classifier: RULED_OUT (valid) vs INVALID_RULE_OUT (no behavioral reason)", () => {
  const valid = classifyDigestDecisionContract({
    requiredTargets: [T_IMP],
    toolCalls: [],
    editedFiles: [],
    agentText: "I ruled out src/dep.py because it is a read-only caller and not affected by this change.",
  });
  assert.equal(valid.requiredTargets[0]!.decision, "RULED_OUT");
  assert.equal(valid.requiredTargetRuledOutCount, 1);

  const invalid = classifyDigestDecisionContract({
    requiredTargets: [T_IMP],
    toolCalls: [],
    editedFiles: [],
    agentText: "I ruled out src/dep.py.", // no behavioral reason
  });
  assert.equal(invalid.requiredTargets[0]!.decision, "INVALID_RULE_OUT");
  assert.equal(invalid.requiredTargetInvalidDecisionCount, 1);
});

test("M57 classifier: counts partition the required targets", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_LEAD, T_HID, T_IMP],
    toolCalls: [tc("read", "src/foo.py"), tc("edit", "src/foo.py"), tc("read", "src/cause.py")],
    editedFiles: ["src/foo.py"],
    agentText: "src/dep.py was ruled out because it is unrelated to the failing behavior.",
  });
  const sum =
    c.requiredTargetEditedCount +
    c.requiredTargetRuledOutCount +
    c.requiredTargetInspectOnlyNoEditCount +
    c.requiredTargetInspectedCount +
    c.requiredTargetIgnoredCount +
    c.requiredTargetInvalidDecisionCount;
  assert.equal(sum, c.requiredTargetCount);
  assert.equal(c.requiredTargetCount, 3);
  assert.equal(c.decisionContractPresent, true);
});

// --- M58: bounded contract (target selection, render, three-way decisions) --------

const CALLER = "caller" as const;
const DEPENDENT = "dependent" as const;

test("M58: default buildDigestDecisionContract is the M57 two-way contract (unchanged)", () => {
  const m57 = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "qux" }]),
  );
  // M57 render: two-way decision line, no INSPECT_ONLY_NO_EDIT, no optional section.
  assert.match(m57.text, /decision: EDIT \| RULE_OUT(?!\s*\|)/);
  assert.equal(m57.text.includes("INSPECT_ONLY_NO_EDIT"), false);
  assert.deepEqual(m57.optionalTargets, []);
});

test("M58: bounded contract is opt-in and renders the three-way decision", () => {
  const b = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "qux", role: DEPENDENT }]),
    { bounded: true },
  );
  assert.equal((b.text.match(new RegExp(DIGEST_DECISION_CONTRACT_START, "g")) ?? []).length, 1);
  assert.equal((b.text.match(new RegExp(DIGEST_DECISION_CONTRACT_END, "g")) ?? []).length, 1);
  assert.match(b.text, /decision: EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/);
});

test("M58: bounded contract spells out all three decision meanings", () => {
  const b = buildDigestDecisionContract(response([pivot("src/foo.py", "bar", ANCHOR)]), null, { bounded: true });
  assert.match(b.text, /EDIT: I changed this target/);
  assert.match(b.text, /RULE_OUT: I inspected or reasoned about this target/);
  assert.match(b.text, /INSPECT_ONLY_NO_EDIT: I inspected this target, confirmed it is relevant context/);
  assert.match(b.text, /required because: lead pivot/);
  assert.match(b.text, /files_touched:/);
});

test("M58: bounded contract carries the anti-over-edit guidance", () => {
  const b = buildDigestDecisionContract(response([pivot("src/foo.py", "bar", ANCHOR)]), null, { bounded: true });
  assert.match(b.text, /Required target does not mean required edit\./);
  assert.match(b.text, /Do not expand from an impact representative into unrelated callers\./);
  assert.match(b.text, /Avoid repeated reads of the same file/);
  assert.match(b.text, /Stop after each required target has EDIT \/ RULE_OUT \/ INSPECT_ONLY_NO_EDIT\./);
});

test("M58: bounded required target cap stays <= 4", () => {
  const { required } = selectBoundedDigestDecisionTargets(
    response([
      pivot("src/a.py", "lead", ANCHOR),
      pivot("src/b.py", "hid", HIDDEN),
      pivot("src/c.py", "more", HIDDEN),
    ]),
    impactSeam([
      { path: "src/d.py", symbol: "d", role: DEPENDENT },
      { path: "src/e.py", symbol: "e", role: DEPENDENT },
      { path: "src/f.py", symbol: "f", role: DEPENDENT },
    ]),
  );
  assert.ok(required.length <= MAX_DIGEST_DECISION_TARGETS);
});

// M65 — impact representatives are NO LONGER required. Both callers and dependents are
// demoted to optional/FYI context; only pivots are required decision targets.
test("M65: no impact rep is required — callers are demoted to optional context", () => {
  const { required, optional } = selectBoundedDigestDecisionTargets(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([
      { path: "src/c1.py", symbol: "a", role: CALLER },
      { path: "src/c2.py", symbol: "b", role: CALLER },
    ]),
  );
  // lead pivot is the only required target; BOTH impact reps are optional context.
  assert.equal(required.length, 1);
  assert.equal(required.filter((t) => t.kind === "IMPACT").length, 0);
  assert.equal(optional.length, 2);
  assert.deepEqual(optional.map((t) => t.path), ["src/c1.py", "src/c2.py"]);
  assert.ok(optional.every((t) => t.requiredReason === "optional context only"));
});

test("M65: dependent impact reps are ALSO optional (no required IMPACT, even for dependents)", () => {
  const { required, optional } = selectBoundedDigestDecisionTargets(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([
      { path: "src/d1.py", symbol: "a", role: DEPENDENT },
      { path: "src/d2.py", symbol: "b", role: DEPENDENT },
    ]),
  );
  assert.equal(required.length, 1);
  assert.equal(required.filter((t) => t.kind === "IMPACT").length, 0);
  assert.equal(optional.length, 2);
});

test("M65: lead + hidden pivots remain required while impact reps are optional", () => {
  const { required, optional } = selectBoundedDigestDecisionTargets(
    response([
      pivot("src/symptom.py", "trigger", ANCHOR), // lead, source-anchored
      pivot("src/cause.py", "root", HIDDEN), // hidden co-pivot
    ]),
    impactSeam([{ path: "src/dep.py", symbol: "qux", role: DEPENDENT }]),
  );
  assert.deepEqual(
    required.map((t) => t.target),
    ["src/symptom.py::trigger", "src/cause.py::root"],
  );
  assert.ok(required.every((t) => t.kind === "PIVOT"));
  assert.equal(required[1]!.hidden, true);
  assert.equal(optional.length, 1);
  assert.equal(optional[0]!.kind, "IMPACT");
});

test("M65: optional impact reps are NOT parsed as required targets, and render in the FYI section", () => {
  const b = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([
      { path: "src/c1.py", symbol: "a", role: CALLER },
      { path: "src/c2.py", symbol: "b", role: CALLER },
    ]),
    { bounded: true },
  );
  const parsed = parseDigestDecisionContract(b.text);
  // Only the lead pivot is a numbered required target — neither impact rep is.
  assert.equal(parsed.targets.length, 1);
  assert.equal(parsed.targets[0]!.kind, "PIVOT");
  assert.equal(parsed.targets.some((t) => t.path === "src/c1.py"), false);
  assert.equal(parsed.targets.some((t) => t.path === "src/c2.py"), false);
  // FYI section header + the explicit not-closure-scored statement are present.
  assert.match(b.text, /Optional context \/ FYI impact references/);
  assert.match(b.text, /These are not required decision targets and are not closure-scored\./);
  assert.match(b.text, /optional context only: additional dependent\/caller/);
  assert.equal(b.optionalTargets.length, 2);
});

test("M65: optional IDs are O-namespaced and never collide with required T-ids", () => {
  const b = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([
      { path: "src/c1.py", symbol: "a", role: CALLER },
      { path: "src/c2.py", symbol: "b", role: CALLER },
    ]),
    { bounded: true },
  );
  const requiredIds = [...b.text.matchAll(/target_id: (\S+)/g)].map((m) => m[1]!);
  const optionalIds = [...b.text.matchAll(/^- (O\d+):/gm)].map((m) => m[1]!);
  assert.deepEqual(requiredIds, ["T1"]); // only the lead pivot
  assert.deepEqual(optionalIds, ["O1", "O2"]);
  // Disjoint namespaces — no optional id is ever a required id.
  assert.equal(requiredIds.some((id) => optionalIds.includes(id)), false);
  assert.ok(optionalIds.every((id) => id.startsWith("O")));
});

test("M65: the classifier never closure-scores optional/FYI impact rows", () => {
  // Build the bounded contract; the required targets handed to the classifier exclude
  // every impact rep, so an impact row can never count toward closed/open/ignored.
  const b = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "qux", role: DEPENDENT }]),
    { bounded: true },
  );
  assert.equal(b.targets.every((t) => t.kind === "PIVOT"), true);
  const c = classifyDigestDecisionContract({
    requiredTargets: b.targets,
    // The agent never touched the impact rep at all — it must not surface as IGNORED.
    toolCalls: [tc("read", "src/foo.py"), tc("edit", "src/foo.py")],
    editedFiles: ["src/foo.py"],
  });
  assert.equal(c.requiredTargetCount, 1);
  assert.equal(c.requiredTargets.some((r) => r.target.kind === "IMPACT"), false);
  assert.equal(c.requiredTargetIgnoredCount, 0);
  assert.equal(c.requiredTargetClosedCount, 1);
  assert.equal(c.requiredTargetOpenCount, 0);
});

test("M65: M62C-style ignored impact rep no longer counts against coverage/ignored", () => {
  // Mirrors sympy-12481 / django-11740 layer: lead pivot EDITED, an impact rep the agent
  // never touched. Pre-M65 the impact rep was a required IGNORED target (open); post-M65
  // it is optional, so coverage is 1/1 and the ignored rate contribution is 0.
  const sel = selectBoundedDigestDecisionTargets(
    response([pivot("combinatorics/permutations.py", "_af_rmul", ANCHOR)]),
    impactSeam([{ path: "combinatorics/generators.py", symbol: "alternating", role: DEPENDENT }]),
  );
  const c = classifyDigestDecisionContract({
    requiredTargets: sel.required,
    toolCalls: [tc("read", "combinatorics/permutations.py"), tc("edit", "combinatorics/permutations.py")],
    editedFiles: ["combinatorics/permutations.py"],
  });
  assert.equal(c.requiredTargetCount, 1); // only the pivot is required
  assert.equal(c.requiredTargetClosedCount, 1); // coverage 1/1
  assert.equal(c.requiredTargetOpenCount, 0);
  assert.equal(c.requiredTargetIgnoredCount, 0); // the un-touched impact rep is optional, not ignored
});

test("M58: empty render when there are no required targets", () => {
  assert.equal(renderBoundedDigestDecisionContractText([], []), "");
  assert.equal(buildDigestDecisionContract(response([]), null, { bounded: true }).text, "");
});

test("M58 classifier: detects INSPECT_ONLY_NO_EDIT and separates it from RULED_OUT", () => {
  const io = classifyDigestDecisionContract({
    requiredTargets: [T_IMP],
    toolCalls: [tc("read", "/x/.bench-repos/p/src/dep.py")],
    editedFiles: [],
    agentText:
      "I inspected src/dep.py and confirmed it is relevant context, but the correct patch belongs elsewhere in src/foo.py.",
  });
  assert.equal(io.requiredTargets[0]!.decision, "INSPECT_ONLY_NO_EDIT");
  assert.equal(io.requiredTargetInspectOnlyNoEditCount, 1);

  const ro = classifyDigestDecisionContract({
    requiredTargets: [T_IMP],
    toolCalls: [],
    editedFiles: [],
    agentText: "I ruled out src/dep.py because it is a read-only caller and not affected by this change.",
  });
  assert.equal(ro.requiredTargets[0]!.decision, "RULED_OUT");
  assert.notEqual(io.requiredTargets[0]!.decision, ro.requiredTargets[0]!.decision);
});

test("M58 classifier: closed/open counts partition the required targets", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_LEAD, T_HID, T_IMP],
    toolCalls: [tc("read", "src/foo.py"), tc("edit", "src/foo.py"), tc("read", "src/cause.py")],
    editedFiles: ["src/foo.py"], // foo EDITED; cause read-only (INSPECTED_ONLY)
    agentText: "src/dep.py was inspected; it is relevant context but the fix belongs elsewhere.",
  });
  // foo.py EDITED + dep.py INSPECT_ONLY_NO_EDIT = closed(2); cause.py INSPECTED_ONLY = open(1).
  assert.equal(c.requiredTargetClosedCount, 2);
  assert.equal(c.requiredTargetOpenCount, 1);
  assert.equal(c.requiredTargetInspectOnlyNoEditCount, 1);
  assert.equal(c.requiredTargetClosedCount + c.requiredTargetOpenCount, c.requiredTargetCount);
});

// --- M59: structured decision grammar (render, parse, classifier recalibration) ----

test("M59: bounded mode renders the structured target_id grammar", () => {
  // M65 — required target_ids are PIVOTs only (lead + hidden co-pivot); the impact rep
  // renders as O-namespaced optional context, not a required target.
  const b = buildDigestDecisionContract(
    response([
      pivot("src/foo.py", "bar", ANCHOR), // lead → T1
      pivot("src/cause.py", "root", HIDDEN), // hidden co-pivot → T2
    ]),
    impactSeam([{ path: "src/dep.py", symbol: "qux", role: DEPENDENT }]),
    { bounded: true },
  );
  assert.match(b.text, /target_id: T1/);
  assert.match(b.text, /target: PIVOT src\/foo\.py::bar/);
  assert.match(b.text, /target_id: T2/);
  assert.match(b.text, /target: PIVOT src\/cause\.py::root/);
  // The impact rep is NOT a required target — it lives in the optional/FYI section.
  assert.equal(b.text.includes("target: IMPACT src/dep.py::qux"), false);
  assert.match(b.text, /- O1: IMPACT src\/dep\.py::qux/);
  assert.match(b.text, /decision: EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/);
  assert.match(b.text, /files_touched: <paths or none>/);
  // M59 reason-rules guidance is present.
  assert.match(b.text, /"not needed", "irrelevant", or "false positive" ALONE is not enough\./);
  assert.match(b.text, /handles enum choices, not combinator SQL/);
});

test("M59: target_id values are stable (T1..Tn) and unique", () => {
  const text = renderBoundedDigestDecisionContractText([
    { kind: "PIVOT", target: "src/a.py::a", path: "src/a.py", reason: "lead", requiredReason: "lead pivot" },
    { kind: "PIVOT", target: "src/b.py::b", path: "src/b.py", reason: "hid", requiredReason: "hidden pivot" },
    { kind: "IMPACT", target: "src/c.py::c", path: "src/c.py", reason: "dep", requiredReason: "cross-file co-edit candidate" },
  ]);
  const ids = [...text.matchAll(/target_id: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["T1", "T2", "T3"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("M59 parse: EDIT/RULE_OUT/INSPECT_ONLY decisions are parsed from a Markdown table", () => {
  const agentText = [
    "## Decision Contract",
    "| Target | Decision | Reason |",
    "|--------|----------|--------|",
    "| `src/foo.py::bar` | **EDIT** | Direct edit site - added the guard |",
    "| `src/dep.py::qux` | **RULE_OUT** | dependent caller, fix belongs in core method |",
    "| `src/ctx.py::ctx` | INSPECT_ONLY_NO_EDIT | relevant context but the patch belongs elsewhere |",
  ].join("\n");
  const decisions = parseStructuredAgentDecisions(agentText);
  assert.equal(decisions.length, 3);
  assert.equal(decisions[0]!.decision, "EDIT");
  assert.match(decisions[0]!.targetRef, /src\/foo\.py::bar/);
  assert.equal(decisions[1]!.decision, "RULE_OUT");
  assert.equal(decisions[2]!.decision, "INSPECT_ONLY_NO_EDIT");
});

test("M59 parse: the field grammar is parsed and the unfilled placeholder is ignored", () => {
  const filled = [
    "- target_id: T2",
    "  target: IMPACT django/db/models/enums.py::ChoicesMeta",
    "  decision: RULE_OUT",
    "  reason: false positive — handles enum choices, not base field conversion",
    "  files_touched: none",
  ].join("\n");
  const d = parseStructuredAgentDecisions(filled);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.targetId, "T2");
  assert.equal(d[0]!.decision, "RULE_OUT");

  // The unfilled contract template (decision is a `A | B | C` placeholder) yields nothing.
  const placeholder = [
    "- target_id: T1",
    "  target: PIVOT src/foo.py::bar",
    "  decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT",
    "  reason: <one sentence with a behavioral reason>",
  ].join("\n");
  assert.equal(parseStructuredAgentDecisions(placeholder).length, 0);
});

const T_RO: DigestDecisionTarget = {
  kind: "IMPACT",
  target: "django/db/models/enums.py::ChoicesMeta",
  path: "django/db/models/enums.py",
  reason: "dep",
};

function ruleOutTable(reason: string): string {
  return `| \`django/db/models/enums.py::ChoicesMeta\` | **RULE_OUT** | ${reason} |`;
}

test("M59 classifier: RULE_OUT with a behavioral reason is credited", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_RO],
    toolCalls: [],
    editedFiles: [],
    agentText: ruleOutTable("not affected because it only handles enum choices, not ordering"),
  });
  assert.equal(c.requiredTargets[0]!.decision, "RULED_OUT");
});

test('M59 classifier: RULE_OUT with only "not needed" is rejected', () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_RO],
    toolCalls: [],
    editedFiles: [],
    agentText: ruleOutTable("not needed"),
  });
  assert.equal(c.requiredTargets[0]!.decision, "INVALID_RULE_OUT");
});

test('M59 classifier: RULE_OUT with only "false positive" is rejected', () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_RO],
    toolCalls: [],
    editedFiles: [],
    agentText: ruleOutTable("false positive"),
  });
  assert.equal(c.requiredTargets[0]!.decision, "INVALID_RULE_OUT");
});

test('M59 classifier: "false positive — handles enum choices, not base field conversion" is credited', () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_RO],
    toolCalls: [],
    editedFiles: [],
    agentText: ruleOutTable("False positive — handles enum choices, not base field conversion"),
  });
  assert.equal(c.requiredTargets[0]!.decision, "RULED_OUT");
});

test('M59 classifier: "dependent caller, fix belongs in core method" is credited', () => {
  const T_CHECKS: DigestDecisionTarget = {
    kind: "IMPACT",
    target: "django/contrib/admin/checks.py::_check_inlines_item",
    path: "django/contrib/admin/checks.py",
    reason: "dep",
  };
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_CHECKS],
    toolCalls: [],
    editedFiles: [],
    agentText:
      "| `django/contrib/admin/checks.py::_check_inlines_item` | **RULE_OUT** | Just a dependent caller, fix belongs in core method |",
  });
  assert.equal(c.requiredTargets[0]!.decision, "RULED_OUT");
});

test("M59 classifier: INSPECT_ONLY_NO_EDIT is parsed and credited from a structured table", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_RO],
    toolCalls: [tc("read", "django/db/models/enums.py")],
    editedFiles: [],
    agentText: ruleOutTable("inspected — relevant context but the patch belongs elsewhere").replace(
      "RULE_OUT",
      "INSPECT_ONLY_NO_EDIT",
    ),
  });
  assert.equal(c.requiredTargets[0]!.decision, "INSPECT_ONLY_NO_EDIT");
  assert.equal(c.requiredTargetInspectOnlyNoEditCount, 1);
});

test("M59 classifier: INSPECT_ONLY_NO_EDIT without a reason is rejected", () => {
  const agentText = [
    "- target_id: T1",
    "  target: IMPACT django/db/models/enums.py::ChoicesMeta",
    "  decision: INSPECT_ONLY_NO_EDIT",
    "  reason:",
  ].join("\n");
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_RO],
    toolCalls: [],
    editedFiles: [],
    agentText,
  });
  assert.notEqual(c.requiredTargets[0]!.decision, "INSPECT_ONLY_NO_EDIT");
  assert.equal(c.requiredTargets[0]!.decision, "INVALID_RULE_OUT");
});

test("M59 classifier: a decision referring to a different target does not credit this one", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_RO],
    toolCalls: [],
    editedFiles: [],
    agentText:
      "| `src/unrelated/other.py::thing` | **RULE_OUT** | unrelated; handled in a different module, not this one |",
  });
  // The structured rule-out is about another file, so the required target stays open.
  assert.notEqual(c.requiredTargets[0]!.decision, "RULED_OUT");
  assert.equal(c.requiredTargets[0]!.decision, "IGNORED");
});

test("M59 classifier: free-form (non-structured) M57/M58 prose rule-outs still credit", () => {
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_RO],
    toolCalls: [],
    editedFiles: [],
    agentText:
      "I ruled out django/db/models/enums.py because it is a read-only caller and not affected by this change.",
  });
  assert.equal(c.requiredTargets[0]!.decision, "RULED_OUT");
});

test("M59 classifier: closed/open counts update with the structured grammar", () => {
  // Mirrors the django-11820 M58B case: one EDIT + two terse table rule-outs.
  const T_LEAD2: DigestDecisionTarget = {
    kind: "PIVOT",
    target: "django/db/models/base.py::_check_ordering",
    path: "django/db/models/base.py",
    reason: "lead",
  };
  const T_CHECKS: DigestDecisionTarget = {
    kind: "IMPACT",
    target: "django/contrib/admin/checks.py::_check_inlines_item",
    path: "django/contrib/admin/checks.py",
    reason: "dep",
  };
  const agentText = [
    "| Target | Decision | Reason |",
    "|--------|----------|--------|",
    "| `django/db/models/base.py::_check_ordering` | **EDIT** | Direct edit site - added pk exception |",
    "| `django/db/models/enums.py::ChoicesMeta` | **RULE_OUT** | False positive - handles enum choices, not model ordering |",
    "| `django/contrib/admin/checks.py::_check_inlines_item` | **RULE_OUT** | Just a dependent caller, fix belongs in core method |",
  ].join("\n");
  const c = classifyDigestDecisionContract({
    requiredTargets: [T_LEAD2, T_RO, T_CHECKS],
    toolCalls: [tc("read", "django/db/models/base.py"), tc("edit", "django/db/models/base.py")],
    editedFiles: ["django/db/models/base.py"],
    agentText,
  });
  // All three close: 1 EDITED + 2 RULED_OUT (was 1 EDITED + 2 INVALID_RULE_OUT pre-M59).
  assert.equal(c.requiredTargetEditedCount, 1);
  assert.equal(c.requiredTargetRuledOutCount, 2);
  assert.equal(c.requiredTargetClosedCount, 3);
  assert.equal(c.requiredTargetOpenCount, 0);
});

test("M59: default (non-bounded) contract behavior is unchanged", () => {
  const def = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "qux" }]),
  );
  // No structured field grammar / no INSPECT_ONLY / numbered M57 render preserved.
  assert.equal(def.text.includes("target_id:"), false);
  assert.equal(def.text.includes("INSPECT_ONLY_NO_EDIT"), false);
  assert.match(def.text, /1\. PIVOT src\/foo\.py::bar/);
  assert.match(def.text, /decision: EDIT \| RULE_OUT(?!\s*\|)/);
  assert.deepEqual(def.optionalTargets, []);
});

// ---------------------------------------------------------------------------
// M68 — required-pivot confidence gate
// ---------------------------------------------------------------------------

// Canonical evidence clauses (from assignCandidateRoles.describeSignals + the
// capsuleV2 edit-site/anchor enrichment), used to build realistic pivots.
const LEXICAL_ONLY = "actionable class — symbol-name match; strong lexical match";
const FAILING_TEST = "actionable function — exercised by a failing test; symbol-name match; lexical match";
const EDIT_SITE = "task diagnostic literal appears in this symbol's body — explicit edit site";
const GRAPH_EDGE = "actionable method — symbol-name match; lexical match; issue-domain relevance; graph/import neighbour";
const ISSUE_DOMAIN = "actionable class — symbol-name match; lexical match; issue-domain relevance; 94 dependents";
const FACADE = "actionable function — symbol-name match; lexical match; 857 dependents";

test("M68: unit — strong signals keep a pivot required; weak signals demote it", () => {
  assert.equal(classifyDigestPivotConfidence(ANCHOR).confidence, "required");
  assert.equal(classifyDigestPivotConfidence(ANCHOR).reason, "traceback_anchor");
  assert.equal(classifyDigestPivotConfidence(FAILING_TEST).reason, "failing_test_exercised");
  assert.equal(classifyDigestPivotConfidence(EDIT_SITE).reason, "edit_site_evidence");
  assert.equal(classifyDigestPivotConfidence(GRAPH_EDGE).reason, "direct_graph_edge");
  assert.equal(classifyDigestPivotConfidence(ISSUE_DOMAIN).reason, "issue_specific_overlap");
  // weak
  assert.equal(classifyDigestPivotConfidence(LEXICAL_ONLY).confidence, "optional_low_confidence");
  assert.equal(classifyDigestPivotConfidence(LEXICAL_ONLY).reason, "lexical_only");
  assert.equal(classifyDigestPivotConfidence(FACADE).reason, "facade_or_wrapper");
});

test("M68 (1): lead pivot with traceback/failing-test evidence remains required", () => {
  const sel = selectBoundedDigestDecisionTargets(
    response([pivot("src/core.py", "evalf", FAILING_TEST)]),
    null,
    { confidenceGate: true },
  );
  assert.equal(sel.required.length, 1);
  assert.equal(sel.required[0]!.target, "src/core.py::evalf");
  assert.deepEqual(sel.demotedPivots, []);
  assert.equal(sel.noHighConfidenceRequired, false);
});

test("M68 (2): hidden/non-traceback co-pivot WITH strong evidence remains required", () => {
  const sel = selectBoundedDigestDecisionTargets(
    response([
      pivot("src/symptom.py", "trigger", ANCHOR), // lead, anchored
      pivot("src/cause.py", "root", FAILING_TEST), // hidden co-pivot, failing-test → strong
    ]),
    null,
    { confidenceGate: true },
  );
  assert.equal(sel.required.length, 2);
  assert.equal(sel.required[1]!.target, "src/cause.py::root");
  assert.deepEqual(sel.demotedPivots, []);
});

test("M68 (3): lexical-only unrelated-subsystem pivot is demoted to optional/FYI", () => {
  // lead is a strong anchor; the second (hidden) pivot is lexical-only → demoted.
  const sel = selectBoundedDigestDecisionTargets(
    response([
      pivot("src/real.py", "fix", ANCHOR),
      pivot("src/contrib/gis/gdal/feature.py", "Feature", LEXICAL_ONLY),
    ]),
    null,
    { confidenceGate: true },
  );
  assert.equal(sel.required.length, 1);
  assert.equal(sel.required[0]!.path, "src/real.py");
  assert.equal(sel.demotedPivots!.length, 1);
  assert.equal(sel.demotedPivots![0]!.confidenceReason, "lexical_only");
  assert.equal(sel.demotedPivots![0]!.requiredReason, "low-confidence pivot (demoted)");
});

test("M68 (4): facade/wrapper pivot with no direct evidence is demoted", () => {
  const sel = selectBoundedDigestDecisionTargets(
    response([
      pivot("src/real.py", "fix", ANCHOR),
      pivot("lib/pyplot.py", "subplots", FACADE), // hub/facade, lexical-only
    ]),
    null,
    { confidenceGate: true },
  );
  assert.equal(sel.required.length, 1);
  assert.equal(sel.demotedPivots![0]!.confidenceReason, "facade_or_wrapper");
});

test("M68 (5): a test-file pivot is demoted unless the issue is test behavior", () => {
  const pivots = [pivot("tests/test_foo.py", "test_bar", FAILING_TEST)];
  // default: test file on a non-test issue → demoted even though it has failing-test text
  const demoted = selectBoundedDigestDecisionTargets(response(pivots), null, { confidenceGate: true });
  assert.equal(demoted.required.length, 0);
  assert.equal(demoted.demotedPivots![0]!.confidenceReason, "test_file_without_test_issue");
  assert.equal(demoted.noHighConfidenceRequired, true);
  // when the issue IS about test behavior, the test-file pivot may remain required
  const kept = selectBoundedDigestDecisionTargets(response(pivots), null, {
    confidenceGate: true,
    issueIsTestBehavior: true,
  });
  assert.equal(kept.required.length, 1);
});

test("M68 (6): demoted pivots render as optional/FYI and are explicitly not closure-scored", () => {
  const b = buildDigestDecisionContract(
    response([
      pivot("src/real.py", "fix", ANCHOR),
      pivot("src/weak.py", "Thing", LEXICAL_ONLY),
    ]),
    null,
    { bounded: true, confidenceGate: true },
  );
  assert.equal(b.targets.length, 1);
  assert.equal(b.demotedTargets.length, 1);
  assert.match(b.text, /Optional context \/ FYI/);
  assert.match(b.text, /low-confidence pivot \(weak localization evidence\)/);
  assert.match(b.text, /are not closure-scored/);
  // the demoted pivot is NOT parsed as a required target.
  const parsed = parseDigestDecisionContract(b.text);
  assert.equal(parsed.targets.length, 1);
  assert.equal(parsed.targets[0]!.path, "src/real.py");
});

test("M68 (7): optional IDs (O*) do not collide with required T IDs", () => {
  const b = buildDigestDecisionContract(
    response([
      pivot("src/real.py", "fix", ANCHOR),
      pivot("src/weak.py", "Thing", LEXICAL_ONLY),
    ]),
    impactSeam([{ path: "src/dep.py", symbol: "uses" }]),
    { bounded: true, confidenceGate: true },
  );
  assert.match(b.text, /target_id: T1/);
  assert.equal(b.text.includes("target_id: O"), false);
  // both the demoted pivot and the impact rep appear under the O namespace.
  assert.match(b.text, /- O1: PIVOT src\/weak\.py::Thing/);
  assert.match(b.text, /- O2: IMPACT src\/dep\.py::uses/);
});

test("M68 (8): post-hoc classifier scores only the kept required set (ignores demoted)", () => {
  const b = buildDigestDecisionContract(
    response([
      pivot("src/real.py", "fix", ANCHOR),
      pivot("src/weak.py", "Thing", LEXICAL_ONLY),
    ]),
    null,
    { bounded: true, confidenceGate: true },
  );
  const cls = classifyDigestDecisionContract({
    requiredTargets: b.targets,
    toolCalls: [],
    editedFiles: ["src/real.py"],
    agentText: "",
  });
  // only the kept required target is scored; the demoted weak pivot never counts.
  assert.equal(cls.requiredTargetCount, 1);
  assert.equal(cls.requiredTargetEditedCount, 1);
  assert.equal(cls.requiredTargetOpenCount, 0);
});

test("M68 (9): zero-required contract is VALID only with the explicit marker", () => {
  // all candidates demoted → zero required, marker present, contract still rendered.
  const b = buildDigestDecisionContract(
    response([
      pivot("src/gdal/feature.py", "Feature", LEXICAL_ONLY),
      pivot("src/gdal/feature.py", "fid", LEXICAL_ONLY),
    ]),
    null,
    { bounded: true, confidenceGate: true },
  );
  assert.equal(b.targets.length, 0);
  assert.equal(b.noHighConfidenceRequired, true);
  assert.notEqual(b.text, "");
  assert.ok(b.text.includes(NO_HIGH_CONFIDENCE_REQUIRED_MARKER));
  assert.match(b.text, /No high-confidence required decision target was selected/);
  const parsed = parseDigestDecisionContract(b.text);
  assert.equal(parsed.present, true);
  assert.equal(parsed.targets.length, 0);
  assert.equal(parsed.noHighConfidenceRequired, true);
});

test("M68 (10): an accidental zero-required contract (no marker) stays absent/invalid", () => {
  // no pivots at all → no intentional marker → empty contract (NOT a misleading one).
  const b = buildDigestDecisionContract(response([]), null, { bounded: true, confidenceGate: true });
  assert.equal(b.text, "");
  assert.equal(b.noHighConfidenceRequired, false);
  // render with required=[] and NO marker also yields "".
  assert.equal(
    renderBoundedDigestDecisionContractText([], [], { demotedPivots: [], noHighConfidenceRequired: false }),
    "",
  );
  const parsed = parseDigestDecisionContract(b.text);
  assert.equal(parsed.present, false);
});

test("M68 (11): M65 optional-impact behavior still holds under the gate", () => {
  const b = buildDigestDecisionContract(
    response([pivot("src/real.py", "fix", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "uses" }]),
    { bounded: true, confidenceGate: true },
  );
  // impact rep stays OPTIONAL/FYI, never a required target, never closure-scored.
  assert.equal(b.targets.length, 1);
  assert.equal(b.targets.some((t) => t.kind === "IMPACT"), false);
  assert.equal(b.optionalTargets.length, 1);
  assert.equal(b.optionalTargets[0]!.kind, "IMPACT");
  assert.match(b.text, /- O1: IMPACT src\/dep\.py::uses/);
});

test("M68 (12): gate ON keeps both sentinels (strict validity intact)", () => {
  const b = buildDigestDecisionContract(
    response([
      pivot("src/real.py", "fix", ANCHOR),
      pivot("src/weak.py", "Thing", LEXICAL_ONLY),
    ]),
    null,
    { bounded: true, confidenceGate: true },
  );
  assert.ok(b.text.includes(DIGEST_DECISION_CONTRACT_START));
  assert.ok(b.text.includes(DIGEST_DECISION_CONTRACT_END));
  assert.equal(b.text.split(DIGEST_DECISION_CONTRACT_START).length - 1, 1);
  assert.equal(b.text.split(DIGEST_DECISION_CONTRACT_END).length - 1, 1);
});

test("M68 (13): gate OFF is byte-identical to the pre-M68 bounded contract", () => {
  const pivots = response([
    pivot("src/real.py", "fix", ANCHOR),
    pivot("src/weak.py", "Thing", LEXICAL_ONLY),
  ]);
  const seam = impactSeam([{ path: "src/dep.py", symbol: "uses" }]);
  const gateOff = buildDigestDecisionContract(pivots, seam, { bounded: true }).text;
  const explicitOff = buildDigestDecisionContract(pivots, seam, {
    bounded: true,
    confidenceGate: false,
  }).text;
  assert.equal(gateOff, explicitOff);
  // gate off → the weak pivot is STILL a required target (old behavior), impact still FYI.
  assert.match(gateOff, /target_id: T2/);
  assert.match(gateOff, /Optional context \/ FYI impact references/);
  assert.equal(gateOff.includes("low-confidence pivot"), false);
});

test("M68 (14): non-bounded/default contract is unchanged by the gate option", () => {
  const pivots = response([pivot("src/foo.py", "bar", ANCHOR)]);
  // confidenceGate is inert without bounded:true.
  const def = buildDigestDecisionContract(pivots, null);
  const withGateButNotBounded = buildDigestDecisionContract(pivots, null, { confidenceGate: true });
  assert.equal(def.text, withGateButNotBounded.text);
  assert.match(def.text, /1\. PIVOT src\/foo\.py::bar/);
  assert.deepEqual(def.demotedTargets, []);
});

// ---------------------------------------------------------------------------
// M112 — per-file EDIT/RULE_OUT action contract
// ---------------------------------------------------------------------------

function supportItem(
  path: string,
  symbol: string,
  roleReason: string,
  evidence: string[] = [],
): CapsuleV2ProductItem {
  return { ...pivot(path, symbol, roleReason, evidence), role: "support", contentMode: "signature" };
}

function responseWith(
  pivots: CapsuleV2ProductItem[],
  support: CapsuleV2ProductItem[],
): CapsuleV2ProductResponse {
  return { pivots, support } as unknown as CapsuleV2ProductResponse;
}

const EVICTED = "strong target beyond the pivot budget — actionable method — strong lexical match; 5 dependents";

test("M112 (1): every pivot file gets an action entry with its role label", () => {
  const { files } = selectDigestActionFiles(
    responseWith(
      [
        pivot("src/lead.py", "run", ANCHOR),
        pivot("src/hidden.py", "root", HIDDEN),
        pivot("src/other.py", "aux", ANCHOR),
      ],
      [],
    ),
  );
  assert.deepEqual(files, [
    { path: "src/lead.py", reason: "lead pivot" },
    { path: "src/hidden.py", reason: "hidden pivot" },
    { path: "src/other.py", reason: "required target" },
  ]);
});

test("M112 (2): pivot files dedup by path (two pivots in one file → one entry)", () => {
  const { files } = selectDigestActionFiles(
    responseWith([pivot("src/lead.py", "a", ANCHOR), pivot("src/lead.py", "b", HIDDEN)], []),
  );
  assert.deepEqual(files, [{ path: "src/lead.py", reason: "lead pivot" }]);
});

test("M112 (3): co-edit / import-reexport / file-evidence lane support files get labeled action entries", () => {
  const { files } = selectDigestActionFiles(
    responseWith(
      [pivot("src/lead.py", "run", ANCHOR)],
      [
        supportItem("src/sibling.py", "helper", "likely co-edit sibling of a high-confidence anchor", [
          "co-edit sibling of anchor src/lead.py (3 cross-file edge(s), co-edit lane)",
        ]),
        supportItem("src/facade_user.py", "consume", "support", [
          "imports co-edit anchor src/lead.py via package __init__ re-export (helper) (import-relation lane)",
        ]),
        supportItem("src/evidence.py", "hit", "support", [
          "task literal `frobnicate` appears in this file's source (file-evidence rescue)",
        ]),
      ],
    ),
  );
  assert.deepEqual(files, [
    { path: "src/lead.py", reason: "lead pivot" },
    { path: "src/sibling.py", reason: "co-edit candidate" },
    { path: "src/facade_user.py", reason: "import/re-export rescue" },
    { path: "src/evidence.py", reason: "file evidence" },
  ]);
});

test("M112 (4): pivot-cap-evicted strong targets are included, capped, in support order", () => {
  const { files } = selectDigestActionFiles(
    responseWith(
      [pivot("src/lead.py", "run", ANCHOR)],
      [
        supportItem("src/evicted1.py", "a", EVICTED),
        supportItem("src/evicted2.py", "b", "strong target beyond the pivot budget — helper — likely edit site"),
        supportItem("src/evicted3.py", "c", EVICTED), // beyond MAX_DIGEST_ACTION_EVICTED_FILES
      ],
    ),
  );
  assert.deepEqual(files, [
    { path: "src/lead.py", reason: "lead pivot" },
    { path: "src/evicted1.py", reason: "required target" },
    { path: "src/evicted2.py", reason: "required target" },
  ]);
});

test("M112 (5): plain support files (no lane marker, no eviction marker) get NO action entry", () => {
  const { files } = selectDigestActionFiles(
    responseWith(
      [pivot("src/lead.py", "run", ANCHOR)],
      [
        supportItem("src/neighbour.py", "x", "graph/import neighbour (not a pivot: no direct evidence)"),
        supportItem("src/lexical.py", "y", "actionable method — symbol-name match"),
      ],
    ),
  );
  assert.deepEqual(files, [{ path: "src/lead.py", reason: "lead pivot" }]);
});

test("M112 (6): no pivots (no_context) → no action files and no contract", () => {
  const selection = selectDigestActionFiles(responseWith([], [supportItem("src/a.py", "a", EVICTED)]));
  assert.deepEqual(selection, { files: [], droppedCount: 0 });
  const built = buildDigestDecisionContract(responseWith([], []), null, { bounded: true });
  assert.equal(built.text, "");
  assert.deepEqual(built.actionFiles, []);
});

test("M112 (7): total cap binds with an explicit honesty line, never silent truncation", () => {
  const pivots = [
    pivot("src/p1.py", "a", ANCHOR),
    pivot("src/p2.py", "b", HIDDEN),
    pivot("src/p3.py", "c", ANCHOR),
    pivot("src/p4.py", "d", ANCHOR),
  ];
  const support = [
    supportItem("src/s1.py", "e", "support", ["x (co-edit lane)"]),
    supportItem("src/s2.py", "f", "support", ["x (file-evidence rescue)"]),
    supportItem("src/s3.py", "g", EVICTED),
  ];
  const selection = selectDigestActionFiles(responseWith(pivots, support));
  assert.equal(selection.files.length, MAX_DIGEST_ACTION_FILES);
  assert.equal(selection.droppedCount, 1);
  const text = buildDigestDecisionContract(responseWith(pivots, support), null, { bounded: true }).text;
  assert.match(text, /\(\+1 more action-eligible file\(s\) not listed\)/);
});

test("M112 (8): bounded render with the action contract keeps the T/O grammar parseable and adds A lines", () => {
  const resp = responseWith(
    [pivot("src/lead.py", "run", ANCHOR), pivot("src/hidden.py", "root", HIDDEN)],
    [supportItem("src/sibling.py", "helper", "support", ["x (co-edit lane)"])],
  );
  const built = buildDigestDecisionContract(resp, null, { bounded: true });
  assert.match(built.text, /Per-file action contract \(Required \/ Pivot \/ Co-edit files\):/);
  assert.match(built.text, /- A1: src\/lead\.py — lead pivot/);
  assert.match(built.text, /- A2: src\/hidden\.py — hidden pivot/);
  assert.match(built.text, /- A3: src\/sibling\.py — co-edit candidate/);
  assert.match(built.text, /Do not silently ignore any file listed here\./);
  assert.match(built.text, /decision for EACH before finalizing the patch/);
  assert.match(built.text, /Support-only files are context: consult if needed/);
  assert.match(built.text, /Verification:/);
  assert.match(built.text, /issue's exact inputs or changed behavior/);
  assert.match(built.text, /state the uncertainty before finalizing/);
  // The required-target parser must see EXACTLY the T targets — A lines never parse.
  const parsed = parseDigestDecisionContract(built.text);
  assert.equal(parsed.present, true);
  assert.deepEqual(
    parsed.targets.map((t) => t.path),
    built.targets.map((t) => t.path),
  );
});

test("M112 (9): perFileActionContract:false reproduces the pre-M112 bounded render byte-for-byte", () => {
  const resp = responseWith(
    [pivot("src/lead.py", "run", ANCHOR), pivot("src/hidden.py", "root", HIDDEN)],
    [supportItem("src/sibling.py", "helper", "support", ["x (co-edit lane)"])],
  );
  const off = buildDigestDecisionContract(resp, null, { bounded: true, perFileActionContract: false });
  const { required, optional } = selectBoundedDigestDecisionTargets(resp, null, {});
  const preM112 = renderBoundedDigestDecisionContractText(required, optional, {});
  assert.equal(off.text, preM112);
  assert.deepEqual(off.actionFiles, []);
  assert.equal(off.text.includes("Per-file action contract"), false);
});

test("M113: verification guidance is default-on and false reproduces M112 wording", () => {
  const resp = responseWith([pivot("src/lead.py", "run", ANCHOR)], []);
  const current = buildDigestDecisionContract(resp, null, { bounded: true }).text;
  const m112 = buildDigestDecisionContract(resp, null, {
    bounded: true,
    verificationOraclePolicy: false,
  }).text;
  assert.match(current, /Verification:\n- If normal tests cannot run/);
  assert.match(current, /issue's exact inputs or changed behavior/);
  assert.match(current, /state the uncertainty before finalizing/);
  assert.doesNotMatch(current, /existing code paths, docstrings, issue reproduction/);
  assert.match(m112, /If tests cannot run, that is not evidence of correctness/);
  assert.doesNotMatch(m112, /Verification:\n/);
  assert.equal(
    current.replace(
      /\nVerification:\n- If normal tests cannot run, do not treat that as proof of correctness\.\n- Build a small repository-grounded oracle from the issue's exact inputs or changed behavior when possible\.\n- If only static reasoning is possible, state the uncertainty before finalizing\./,
      "If tests cannot run, that is not evidence of correctness: verify against a repository-grounded oracle (existing code paths, docstrings, issue reproduction) or state the uncertainty explicitly.",
    ),
    m112,
  );
});

test("M112 (10): gate demoting EVERY pivot yields the zero-required contract with NO action list", () => {
  const weak = pivot("src/vague.py", "thing", "actionable function — symbol-name match", [
    "symbol-name match only",
  ]);
  const built = buildDigestDecisionContract(response([weak]), null, {
    bounded: true,
    confidenceGate: true,
  });
  assert.match(built.text, new RegExp(NO_HIGH_CONFIDENCE_REQUIRED_MARKER));
  assert.equal(built.text.includes("Per-file action contract"), false);
  assert.deepEqual(built.actionFiles, []);
});

test("M112 (11): xarray-6938 shape — gate-demoted lead + budget-evicted co-edit file all get action entries", () => {
  // Lead pivot's evidence phrase is NOT in the M68 strong-clause vocabulary (the
  // real xarray-6938 render), the hidden co-pivot passes, and gold variable.py is a
  // pivot-cap-evicted support item. The T set has ONE target; the action list must
  // still name all three FILES.
  const lead = pivot("xarray/core/dataset.py", "Dataset.swap_dims", "actionable method — strong lexical match", [
    "task names this symbol directly — edit target despite delegating to local helpers",
  ]);
  const hidden = pivot(
    "xarray/core/dataarray.py",
    "DataArray.swap_dims",
    "local implementation helper invoked by the entry point — likely edit site",
  );
  const evicted = supportItem(
    "xarray/core/variable.py",
    "Variable.transpose",
    "strong target beyond the pivot budget — actionable method — strong lexical match; 5 dependents",
  );
  const plain = supportItem(
    "xarray/core/alignment.py",
    "reindex_like",
    "graph/import neighbour (not a pivot: no direct evidence (graph/domain reach only))",
  );
  const built = buildDigestDecisionContract(responseWith([lead, hidden], [evicted, plain]), null, {
    bounded: true,
    confidenceGate: true,
  });
  // Gate: lead demoted (weak vocabulary), hidden kept → exactly one T target.
  assert.equal(built.targets.length, 1);
  assert.equal(built.targets[0]!.path, "xarray/core/dataarray.py");
  // Action list: all three high-importance FILES, alignment.py excluded.
  assert.deepEqual(built.actionFiles, [
    { path: "xarray/core/dataset.py", reason: "lead pivot" },
    { path: "xarray/core/dataarray.py", reason: "hidden pivot" },
    { path: "xarray/core/variable.py", reason: "required target" },
  ]);
  assert.equal(built.text.includes("xarray/core/alignment.py"), false);
});

test("M112 (12): action-contract render is deterministic and carries no benchmark markers", () => {
  const resp = responseWith(
    [pivot("src/lead.py", "run", ANCHOR)],
    [supportItem("src/sibling.py", "helper", "support", ["x (co-edit lane)"])],
  );
  const a = buildDigestDecisionContract(resp, null, { bounded: true }).text;
  const b = buildDigestDecisionContract(resp, null, { bounded: true }).text;
  assert.equal(a, b);
  for (const marker of ["FAIL_TO_PASS", "PASS_TO_PASS", "gold_patch", "gold patch", "hints:"]) {
    assert.equal(a.includes(marker), false, `render must not contain ${marker}`);
  }
});

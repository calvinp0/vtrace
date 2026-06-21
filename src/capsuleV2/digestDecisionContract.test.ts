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

test("M58: only ONE impact rep is required when the second is a mere caller", () => {
  const { required, optional } = selectBoundedDigestDecisionTargets(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([
      { path: "src/c1.py", symbol: "a", role: CALLER },
      { path: "src/c2.py", symbol: "b", role: CALLER },
    ]),
  );
  // lead + 1 impact rep required; the 2nd caller is demoted to optional context.
  assert.equal(required.length, 2);
  assert.equal(required.filter((t) => t.kind === "IMPACT").length, 1);
  assert.equal(optional.length, 1);
  assert.equal(optional[0]!.path, "src/c2.py");
  assert.equal(optional[0]!.requiredReason, "optional context only");
});

test("M58: a second impact rep IS required when it is a distinct dependent co-edit candidate", () => {
  const { required, optional } = selectBoundedDigestDecisionTargets(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([
      { path: "src/d1.py", symbol: "a", role: DEPENDENT },
      { path: "src/d2.py", symbol: "b", role: DEPENDENT },
    ]),
  );
  assert.equal(required.length, 3);
  assert.equal(required.filter((t) => t.kind === "IMPACT").length, 2);
  assert.equal(optional.length, 0);
});

test("M58: optional impact reps are NOT parsed as required targets", () => {
  const b = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([
      { path: "src/c1.py", symbol: "a", role: CALLER },
      { path: "src/c2.py", symbol: "b", role: CALLER },
    ]),
    { bounded: true },
  );
  const parsed = parseDigestDecisionContract(b.text);
  // Only the lead pivot + the single required impact rep are numbered required targets.
  assert.equal(parsed.targets.length, 2);
  assert.equal(parsed.targets.some((t) => t.path === "src/c2.py"), false);
  assert.match(b.text, /Optional context \(NOT required to decide/);
  assert.match(b.text, /optional context only: additional dependent\/caller/);
  assert.equal(b.optionalTargets.length, 1);
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
  const b = buildDigestDecisionContract(
    response([pivot("src/foo.py", "bar", ANCHOR)]),
    impactSeam([{ path: "src/dep.py", symbol: "qux", role: DEPENDENT }]),
    { bounded: true },
  );
  assert.match(b.text, /target_id: T1/);
  assert.match(b.text, /target: PIVOT src\/foo\.py::bar/);
  assert.match(b.text, /target_id: T2/);
  assert.match(b.text, /target: IMPACT src\/dep\.py::qux/);
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

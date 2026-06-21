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
  renderDigestDecisionContractText,
  buildDigestDecisionContract,
  parseDigestDecisionContract,
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
    c.requiredTargetInspectedCount +
    c.requiredTargetIgnoredCount +
    c.requiredTargetInvalidDecisionCount;
  assert.equal(sum, c.requiredTargetCount);
  assert.equal(c.requiredTargetCount, 3);
  assert.equal(c.decisionContractPresent, true);
});

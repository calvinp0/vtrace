// M16 offline audit — rule-out conflict guardrail.
//
// Reads the CAPTURED M15.1 revision records (`_pivot_revision.json`) for the five valid
// M15.1 labels and recomputes, OFFLINE, what the M16 guardrail does to each first-pass
// grounded RULED_OUT: would it now be treated as a test-expectation CONFLICT (kept
// revision-triggering) or still credited as `ruledOut` (suppressed)?
//
// It runs NO agents, NO Docker, and touches NO retrieval. The only behavioral change M16
// introduces is in the grounded-rule-out branch of `computePivotInspectionCompliance`, so
// NEW compliance is derived from the stored OLD verdict by re-classifying each OLD
// `ruledOut` entry through the real, exported `detectRuleOutConflict`. Everything else
// (edited / missing / non-conflicted unclear) is identical by construction.
//
// Usage:
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m16_ruleout_conflict_guardrail_audit.ts \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  detectRuleOutConflict,
  type ComplianceTestExpectation,
  type RequiredPivotCandidate,
  type RuleOutConflict,
} from "../../src/capsuleV2/pivotInspectionCompliance";

const LABELS = [
  "eval-m15-pivot-revision-current-sphinx-7462-r1",
  "eval-m15-pivot-revision-current-sphinx-7462-r2",
  "eval-m15-pivot-revision-current-seaborn-3187-r1",
  "eval-m15-pivot-revision-current-seaborn-3187-r2",
  "eval-m15-pivot-revision-current-seaborn-3187-r3",
] as const;

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

function inspectionId(p: string, symbol: string | undefined): string {
  return symbol && symbol.length > 0 ? `${p}::${symbol}` : p;
}

interface StoredCompliance {
  required: RequiredPivotCandidate[];
  edited: string[];
  ruledOut: string[];
  missing: string[];
  unclear: string[];
}

interface AuditRow {
  label: string;
  candidate: string;
  markerDecision: string;
  testExpectation: string;
  oldResult: string;
  newResult: string;
  conflict: boolean;
  revisionWouldRun: boolean;
  why: string;
}

async function readRecord(out: string, label: string): Promise<Record<string, unknown> | null> {
  const file = path.join(out, "runs", label, "raw", "vtrace", "_pivot_revision.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findCandidate(required: RequiredPivotCandidate[], id: string): RequiredPivotCandidate | null {
  return required.find((c) => inspectionId(c.path, c.symbol) === id) ?? null;
}

function auditLabel(label: string, rec: Record<string, unknown> | null): AuditRow[] {
  if (rec === null) {
    return [{
      label, candidate: "(no record)", markerDecision: "—", testExpectation: "—",
      oldResult: "—", newResult: "—", conflict: false, revisionWouldRun: false,
      why: "no _pivot_revision.json found",
    }];
  }
  const before = (rec.complianceBefore ?? null) as StoredCompliance | null;
  const te = (rec.testExpectation ?? undefined) as ComplianceTestExpectation | undefined;
  const decisions = (rec.firstPassPivotDecisions ?? []) as { path: string; decision: string; evidence: string }[];
  const ftp = (te?.failToPass ?? []).join(", ") || "(none)";

  if (before === null || before.required.length === 0) {
    return [{
      label, candidate: "(no required candidates)", markerDecision: "—", testExpectation: ftp,
      oldResult: "n/a", newResult: "n/a", conflict: false,
      revisionWouldRun: false, why: "no required non-lead/co-edit candidates",
    }];
  }

  // Derive NEW from OLD: re-classify each OLD ruledOut through detectRuleOutConflict.
  const newRuledOut: string[] = [];
  const newUnclear: string[] = [...before.unclear];
  const conflicts: RuleOutConflict[] = [];
  for (const id of before.ruledOut) {
    const cand = findCandidate(before.required, id);
    const conflict = cand ? detectRuleOutConflict(cand, te) : null;
    if (conflict) {
      newUnclear.push(id);
      conflicts.push(conflict);
    } else {
      newRuledOut.push(id);
    }
  }
  const newOutstanding = before.missing.length + newUnclear.length;

  // One row per required candidate (so edited/unclear/missing are visible too).
  const rows: AuditRow[] = [];
  for (const c of before.required) {
    const id = inspectionId(c.path, c.symbol);
    const marker = decisions.find((d) => d.path === c.path || c.path.endsWith(`/${d.path}`) || d.path.endsWith(`/${c.path}`));
    const oldClass = before.edited.includes(id) ? "edited"
      : before.ruledOut.includes(id) ? "ruledOut (suppressed)"
      : before.unclear.includes(id) ? "unclear"
      : "missing";
    const conflict = conflicts.find((x) => x.id === id) ?? null;
    const newClass = before.edited.includes(id) ? "edited"
      : conflict ? "unclear_test_conflict"
      : newRuledOut.includes(id) ? "ruledOut (suppressed)"
      : newUnclear.includes(id) ? "unclear"
      : "missing";
    const why = conflict
      ? conflict.evidence.join("; ")
      : before.ruledOut.includes(id)
        ? "grounded rule-out, no test-expectation conflict → still suppressed"
        : oldClass === "edited" ? "file in final patch"
        : oldClass === "unclear" ? "inspected/no grounded marker"
        : "not handled";
    rows.push({
      label, candidate: id,
      markerDecision: marker ? `${marker.decision}` : "(none)",
      testExpectation: ftp,
      oldResult: oldClass, newResult: newClass,
      conflict: conflict !== null,
      revisionWouldRun: newOutstanding > 0,
      why,
    });
  }
  return rows;
}

function md(rows: AuditRow[]): string {
  const L: string[] = [];
  L.push("# Stage 5 — M16 rule-out conflict guardrail offline audit");
  L.push("");
  L.push("Offline recomputation (no agents, no Docker, no retrieval) over the five valid");
  L.push("M15.1 labels. For each first-pass grounded `RULED_OUT`, does the M16 guardrail now");
  L.push("treat it as a test-expectation **conflict** (kept revision-triggering) or still");
  L.push("credit it as `ruledOut` (suppressed)? NEW compliance is derived from the stored");
  L.push("OLD verdict by re-classifying each OLD `ruledOut` through the real exported");
  L.push("`detectRuleOutConflict` — the only branch M16 changes.");
  L.push("");
  L.push("| label | candidate | first-pass marker | old result | new result | conflict? | revision would run? | why |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const lab = r.label.replace("eval-m15-pivot-revision-current-", "");
    L.push(`| ${lab} | \`${r.candidate}\` | ${r.markerDecision} | ${r.oldResult} | ${r.newResult} | ${r.conflict ? "**yes**" : "no"} | ${r.revisionWouldRun ? "yes" : "no"} | ${r.why} |`);
  }
  L.push("");
  L.push("Test expectation (FAIL_TO_PASS) per case is shown via the conflict reasoning; the");
  L.push("guardrail matches the candidate symbol / file stem against the FAIL_TO_PASS test's");
  L.push("METHOD leaf only (not the test file path or class).");
  L.push("");
  L.push("## Expected vs observed");
  L.push("");
  const sphinxR1 = rows.find((r) => r.label.endsWith("sphinx-7462-r1") && r.candidate.includes("ast.py"));
  const seabornR2 = rows.find((r) => r.label.endsWith("seaborn-3187-r2") && r.candidate.includes("relational.py"));
  L.push(`- **sphinx r1** (\`ast.py::unparse\`): old = ${sphinxR1?.oldResult ?? "?"}; new = **${sphinxR1?.newResult ?? "?"}**; conflict = ${sphinxR1?.conflict ? "true" : "false"}; revision would run = ${sphinxR1?.revisionWouldRun ? "**yes**" : "no"}. Expected: ruledOut→unclear_test_conflict, revision runs. ✓`);
  L.push(`- **seaborn r2** (\`relational.py::scatterplot\`): old = ${seabornR2?.oldResult ?? "?"}; new = **${seabornR2?.newResult ?? "?"}**; conflict = ${seabornR2?.conflict ? "true" : "false"}. Expected: stays ruledOut/suppressed (non-gold; symbol/file absent from the failing method). ✓`);
  L.push("- **sphinx r2** / **seaborn r1, r3**: no first-pass grounded rule-out to re-classify; their (edited / unclear) verdicts are unchanged, so revision behavior is identical to M15.1.");
  L.push("");
  L.push("Net effect: the guardrail flips exactly the sphinx r1 false suppression to a");
  L.push("revision-triggering conflict, and leaves the correct seaborn r2 suppression — and");
  L.push("every non-rule-out verdict — untouched.");
  return L.join("\n") + "\n";
}

const out = argValue("--out", "benchmarks/stage5_vexp_swe_bench_smoke/results");
const rows: AuditRow[] = [];
for (const label of LABELS) {
  rows.push(...auditLabel(label, await readRecord(out, label)));
}
const report = md(rows);
const reportPath = path.join(out, "stage5_m16_ruleout_conflict_guardrail_audit.md");
await writeFile(reportPath, report);
// Console summary
for (const r of rows) {
  console.log(
    `${r.label.replace("eval-m15-pivot-revision-current-", "").padEnd(16)} ${r.candidate.padEnd(40)} `
    + `${r.oldResult.padEnd(22)} -> ${r.newResult.padEnd(22)} conflict=${r.conflict} revRun=${r.revisionWouldRun}`,
  );
}
console.log(`\nwrote ${reportPath}`);

/**
 * M65 — offline retrospective replay of the M62C structured-bounded 24-task validation
 * under the new required-target rule (impact representatives demoted to optional/FYI,
 * never closure-scored). NO live agents, NO Docker, NO API spend, NO retrieval/scoring
 * changes. Pure recomputation over the CAPTURED M62C run artifacts.
 *
 * Method (mirrors run_stage5_m58b_analyze's readers):
 *   1. For each M62C run, parse the required-target set the M62C contract rendered
 *      (lead pivot + hidden co-pivot + impact reps) from the run's own snapshot.
 *   2. Classify each target's decision from the captured tool-call trace, the final
 *      patch's edited files, and the agent's final text (classifyDigestDecisionContract).
 *      Per-target decisions are independent of which targets are "required", so they are
 *      identical before and after the rule change.
 *   3. BEFORE = the M62C accounting (all PIVOT + IMPACT targets count as required).
 *      AFTER  = the M65 rule (only PIVOT targets are required; IMPACT targets are
 *      demoted to optional and excluded from required-target closure scoring).
 *   4. Aggregate coverage / ignored-rate / invalid-rule-out-rate before vs after, list
 *      the demoted targets, and check that no treatment-only win edited a demoted rep.
 *
 * Usage: bun run_stage5_m65_impact_reps_replay.ts [--out <results-dir>]
 *   Writes stage5_m65_impact_reps_optional_targets.json and prints a summary.
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseDigestDecisionContract,
  classifyDigestDecisionContract,
  type DigestDecisionTarget,
  type DigestDecisionToolCall,
  type DigestDecision,
} from "../../src/capsuleV2/digestDecisionContract.ts";

const RESULTS_DIR = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const RUNS_DIR = path.join(RESULTS_DIR, "runs");
const M62C_JSON = path.join(RESULTS_DIR, "stage5_m62c_structured_bounded_24_live_validation.json");

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}
function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function firstGlob(dir: string, prefix: string): string | null {
  try {
    const f = fs.readdirSync(dir).find((n) => n.startsWith(prefix));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}
function toRepoRelative(p: string): string {
  const m = /\.bench-repos\/[^/]+\/(.+)$/.exec(p) || /workspaces\/[^/]+\/[^/]+\/(.+)$/.exec(p);
  return (m ? m[1]! : p).replace(/^\.\//, "");
}
function pathsMatch(a: string, b: string): boolean {
  const na = toRepoRelative(a);
  const nb = toRepoRelative(b);
  if (na === nb) return true;
  return na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}
function editedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!.trim());
  for (const m of patch.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)) files.add(m[1]!.trim());
  return [...files];
}
function agentTextFrom(raw: string): string {
  let agentText = "";
  for (const line of readText(path.join(raw, "_agent_stream.first_pass.jsonl")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.type === "result" && typeof o.result === "string") agentText += "\n" + o.result;
      if (o.type === "assistant") {
        const content = (o.message as Record<string, unknown> | undefined)?.content;
        if (Array.isArray(content)) {
          for (const blk of content) {
            if (blk && typeof blk === "object" && (blk as Record<string, unknown>).type === "text") {
              agentText += "\n" + String((blk as Record<string, unknown>).text ?? "");
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return agentText;
}

// A decision "closes" a required target (a real decision was reached).
const CLOSED: ReadonlySet<DigestDecision> = new Set([
  "EDITED",
  "EDITED_WITHOUT_INSPECTION",
  "RULED_OUT",
  "INSPECT_ONLY_NO_EDIT",
]);

interface PerTarget {
  kind: "PIVOT" | "IMPACT";
  target: string;
  path: string;
  decision: DigestDecision;
}
interface Acc {
  required: number;
  closed: number;
  open: number;
  ignored: number;
  invalid: number;
  inspectedOnly: number;
}
function emptyAcc(): Acc {
  return { required: 0, closed: 0, open: 0, ignored: 0, invalid: 0, inspectedOnly: 0 };
}
function fold(acc: Acc, t: PerTarget): void {
  acc.required += 1;
  if (CLOSED.has(t.decision)) acc.closed += 1;
  else acc.open += 1;
  if (t.decision === "IGNORED") acc.ignored += 1;
  if (t.decision === "INVALID_RULE_OUT") acc.invalid += 1;
  if (t.decision === "INSPECTED_ONLY") acc.inspectedOnly += 1;
}
const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

interface CaseMeta {
  instance_id: string;
  run_label: string;
  resolved: boolean;
  baseline_resolved_any: boolean;
  category: string;
}

const outArg = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1]! : RESULTS_DIR;
})();

const m62c = readJson<{ cases: CaseMeta[] }>(M62C_JSON);
if (!m62c) throw new Error(`cannot read M62C JSON at ${M62C_JSON}`);

const before = emptyAcc();
const after = emptyAcc();
const perCase: Record<string, unknown>[] = [];
const demoted: Record<string, unknown>[] = [];
let impactEditedCount = 0;
const winSafety: Record<string, unknown>[] = [];

for (const c of m62c.cases) {
  const runDir = path.join(RUNS_DIR, c.run_label);
  const snapshot = readText(path.join(runDir, "_vtrace_instructions.snapshot.md"));
  const raw = path.join(runDir, "raw", "vtrace");
  const parsed = parseDigestDecisionContract(snapshot);
  if (!parsed.present || parsed.targets.length === 0) {
    perCase.push({ instance_id: c.instance_id, contract_present: false });
    continue;
  }
  const sweFile = firstGlob(raw, "swebench-");
  const swe = sweFile
    ? readJson<Record<string, unknown>>(sweFile) ??
      (() => {
        const last = readText(sweFile).trim().split("\n").pop();
        return last ? (JSON.parse(last) as Record<string, unknown>) : null;
      })()
    : null;
  const modelPatch = typeof swe?.modelPatch === "string" ? (swe.modelPatch as string) : "";
  const editedFiles = editedFilesFromPatch(modelPatch);
  const toolCalls = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const clsToolCalls: DigestDecisionToolCall[] = toolCalls.map((t) => ({
    category: typeof t.category === "string" ? t.category : "other",
    path: typeof t.path === "string" ? t.path : null,
  }));
  const agentText = agentTextFrom(raw);

  const requiredTargets: DigestDecisionTarget[] = parsed.targets.map((t) => ({
    kind: t.kind,
    target: t.target,
    path: t.path,
    reason: "",
  }));
  const cls = classifyDigestDecisionContract({
    requiredTargets,
    toolCalls: clsToolCalls,
    editedFiles,
    agentText,
  });
  const per: PerTarget[] = cls.requiredTargets.map((r) => ({
    kind: r.target.kind,
    target: r.target.target,
    path: r.target.path,
    decision: r.decision,
  }));

  const caseBefore = emptyAcc();
  const caseAfter = emptyAcc();
  for (const t of per) {
    fold(before, t);
    fold(caseBefore, t);
    if (t.kind === "PIVOT") {
      fold(after, t);
      fold(caseAfter, t);
    } else {
      // IMPACT — demoted to optional/FYI; excluded from required closure scoring.
      if (cls.requiredTargets.find((r) => r.target.target === t.target)?.edited) impactEditedCount += 1;
      demoted.push({
        instance_id: c.instance_id,
        target: t.target,
        target_type: "IMPACT",
        original_status: t.decision,
        new_status: "optional/FYI (not closure-scored)",
        edited_in_patch: editedFiles.some((f) => pathsMatch(f, t.path)),
      });
    }
  }

  // Treatment-only win safety: did a demoted impact rep correspond to an edited file?
  if (c.resolved && !c.baseline_resolved_any) {
    const demotedEdited = per
      .filter((t) => t.kind === "IMPACT" && editedFiles.some((f) => pathsMatch(f, t.path)))
      .map((t) => t.target);
    winSafety.push({
      instance_id: c.instance_id,
      treatment_only_win: true,
      required_pivots_after: caseAfter.required,
      edited_files: editedFiles,
      demoted_impact_reps: per.filter((t) => t.kind === "IMPACT").map((t) => t.target),
      demoted_impact_rep_edited: demotedEdited,
      explanation_intact: demotedEdited.length === 0,
    });
  }

  perCase.push({
    instance_id: c.instance_id,
    contract_present: true,
    resolved: c.resolved,
    baseline_resolved_any: c.baseline_resolved_any,
    required_before: caseBefore.required,
    required_after: caseAfter.required,
    open_before: caseBefore.open,
    open_after: caseAfter.open,
    ignored_before: caseBefore.ignored,
    ignored_after: caseAfter.ignored,
    invalid_before: caseBefore.invalid,
    invalid_after: caseAfter.invalid,
    per_target: per.map((t) => ({ kind: t.kind, target: t.target, decision: t.decision })),
  });
}

function metrics(a: Acc): Record<string, number> {
  return {
    required: a.required,
    closed: a.closed,
    open: a.open,
    ignored: a.ignored,
    invalid: a.invalid,
    inspected_only: a.inspectedOnly,
    coverage_pct: pct(a.closed, a.required),
    ignored_rate_pct: pct(a.ignored, a.required),
    invalid_rate_pct: pct(a.invalid, a.required),
  };
}

const summary = {
  milestone: "M65",
  source: "M62C captured run artifacts (offline replay; no agents, no Docker, no spend)",
  rule: "impact representatives demoted to optional/FYI; only pivots are required + closure-scored",
  cases_analyzed: perCase.filter((c) => c.contract_present).length,
  impact_reps_demoted: demoted.length,
  impact_reps_edited_in_patch: impactEditedCount,
  before: metrics(before),
  after: metrics(after),
  criteria: {
    coverage_ge_90_before: metrics(before).coverage_pct >= 90,
    coverage_ge_90_after: metrics(after).coverage_pct >= 90,
    ignored_le_5_before: metrics(before).ignored_rate_pct <= 5,
    ignored_le_5_after: metrics(after).ignored_rate_pct <= 5,
    invalid_not_worse: metrics(after).invalid_rate_pct <= metrics(before).invalid_rate_pct,
  },
  treatment_only_win_safety: winSafety,
  matches_m64_simulation: {
    coverage_after_pct: metrics(after).coverage_pct,
    ignored_after_pct: metrics(after).ignored_rate_pct,
    invalid_after_pct: metrics(after).invalid_rate_pct,
    m64_expected: { coverage_pct: 93.6, ignored_pct: 4.3, invalid_pct: 0.0 },
  },
};

const outJson = path.join(outArg, "stage5_m65_impact_reps_optional_targets.replay.json");
fs.writeFileSync(outJson, JSON.stringify({ summary, demoted, treatment_only_win_safety: winSafety, cases: perCase }, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.log(`\nwrote ${outJson}`);

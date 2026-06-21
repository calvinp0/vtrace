/**
 * M59 — retrospective recalibration of the M58B decision-contract outputs.
 *
 * Report-only. Reads the CAPTURED M58B run artifacts (no agent, no Docker, no spend),
 * re-parses each run's required-target contract + the agent's final text + tool calls +
 * patch, and re-scores every required target with the UPDATED classifier
 * (`classifyDigestDecisionContract`, now structured-grammar aware). It then compares the
 * new per-target decision against the OLD M58B decision (taken from the frozen M58B
 * ledger JSON) so we can answer: were the M58B "invalid" rule-outs actually valid
 * structured rule-outs under the improved grammar?
 *
 * Usage:  bun run_stage5_m59_recalibration.ts            (prints JSON + a Markdown table)
 *         bun run_stage5_m59_recalibration.ts --json out.json
 *
 * Does NOT mutate any raw M58B artifact.
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseDigestDecisionContract,
  classifyDigestDecisionContract,
  type DigestDecision,
  type DigestDecisionTarget,
  type DigestDecisionToolCall,
} from "../../src/capsuleV2/digestDecisionContract.ts";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const RUNS = path.join(RESULTS, "runs");

// (instance, run-label, ordered OLD M58B per-target decisions) — old decisions are read
// from the frozen M58B ledger so this script measures *only* the classifier delta.
interface Case {
  instance: string;
  runLabel: string;
}
const CASES: Case[] = [
  { instance: "sphinx-doc__sphinx-7462", runLabel: "m58b_vtrace_bounded_contract_sphinx_7462" },
  { instance: "django__django-11820", runLabel: "m58b_vtrace_bounded_contract_django_11820" },
  { instance: "django__django-13195", runLabel: "m58b_vtrace_bounded_contract_django_13195" },
];

function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
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
function editedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!.trim());
  for (const m of patch.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)) files.add(m[1]!.trim());
  return [...files];
}
function agentTextFromStream(streamPath: string): string {
  let text = "";
  for (const line of readText(streamPath).split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type === "result" && typeof o.result === "string") text += "\n" + o.result;
    if (o.type === "assistant") {
      const content = (o.message as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) {
        for (const blk of content) {
          if (blk && typeof blk === "object" && (blk as Record<string, unknown>).type === "text") {
            text += "\n" + String((blk as Record<string, unknown>).text ?? "");
          }
        }
      }
    }
  }
  return text;
}

// OLD M58B per-target decisions, keyed by instance, in contract order (frozen ledger).
function loadOldDecisions(): Record<string, string[]> {
  const ledger = readJson<Record<string, unknown>>(
    path.join(RESULTS, "stage5_m58b_bounded_digest_decision_live_validation.json"),
  );
  const compliance = ledger?.compliance as Record<string, unknown> | undefined;
  const per = (compliance?.per_target_m58 as Array<Record<string, unknown>> | undefined) ?? [];
  const out: Record<string, string[]> = {};
  for (const row of per) {
    const inst = String(row.instance);
    const decisions = (row.decisions as Array<Record<string, unknown>> | undefined) ?? [];
    out[inst] = decisions.map((d) => String(d.decision));
  }
  return out;
}

const CLOSED: DigestDecision[] = ["EDITED", "EDITED_WITHOUT_INSPECTION", "RULED_OUT", "INSPECT_ONLY_NO_EDIT"];
const isClosed = (d: string): boolean => (CLOSED as string[]).includes(d);
// A reason credit = a decision that requires a behavioral justification and got it.
const isReasonCredited = (d: string): boolean => d === "RULED_OUT" || d === "INSPECT_ONLY_NO_EDIT";

const oldDecisions = loadOldDecisions();

interface RecalRow {
  instance_id: string;
  target: string;
  old_status: string;
  new_status: string;
  old_reason_credit: boolean;
  new_reason_credit: boolean;
  reason_text: string;
}

const rows: RecalRow[] = [];
const perInstance: Record<string, { old_closed: number; new_closed: number; total: number }> = {};

for (const c of CASES) {
  const raw = path.join(RUNS, c.runLabel, "raw", "vtrace");
  const snapshot = readText(path.join(RUNS, c.runLabel, "_vtrace_instructions.snapshot.md"));
  const parsed = parseDigestDecisionContract(snapshot);
  const requiredTargets: DigestDecisionTarget[] = parsed.targets.map((t) => ({
    kind: t.kind,
    target: t.target,
    path: t.path,
    reason: "",
  }));
  const toolCallsRaw = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const toolCalls: DigestDecisionToolCall[] = toolCallsRaw.map((t) => ({
    category: typeof t.category === "string" ? t.category : "other",
    path: typeof t.path === "string" ? t.path : null,
  }));
  const sweFile = firstGlob(raw, "swebench-");
  const swe = sweFile ? JSON.parse(readText(sweFile).trim().split("\n").pop()!) : null;
  const modelPatch = typeof swe?.modelPatch === "string" ? (swe.modelPatch as string) : "";
  const editedFiles = editedFilesFromPatch(modelPatch);
  const agentText = agentTextFromStream(path.join(raw, "_agent_stream.first_pass.jsonl"));

  const cls = classifyDigestDecisionContract({ requiredTargets, toolCalls, editedFiles, agentText });
  const old = oldDecisions[c.instance] ?? [];

  // Per-target reason text: pull the matching structured/table row reason from agent text
  // for the report (best-effort; the classifier itself does not need it surfaced).
  perInstance[c.instance] = { old_closed: 0, new_closed: 0, total: cls.requiredTargets.length };
  cls.requiredTargets.forEach((r, i) => {
    const oldStatus = old[i] ?? "(unknown)";
    const reasonText = reasonForTarget(agentText, r.target);
    rows.push({
      instance_id: c.instance,
      target: r.target.target,
      old_status: oldStatus,
      new_status: r.decision,
      old_reason_credit: isReasonCredited(oldStatus),
      new_reason_credit: isReasonCredited(r.decision),
      reason_text: reasonText,
    });
    if (isClosed(oldStatus)) perInstance[c.instance]!.old_closed += 1;
    if (isClosed(r.decision)) perInstance[c.instance]!.new_closed += 1;
  });
}

// Best-effort: find the reason cell/line the agent wrote for a target, for display.
function reasonForTarget(agentText: string, target: DigestDecisionTarget): string {
  const base = target.path.split("/").pop() ?? target.path;
  const sym = target.target.includes("::") ? target.target.split("::").pop()! : "";
  for (const line of agentText.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("|")) continue;
    if (!(l.includes(target.path) || (base && l.includes(base)) || (sym.length > 2 && l.includes(sym)))) continue;
    const cells = l
      .split("|")
      .map((x) => x.replace(/^[*`\s]+|[*`\s]+$/g, "").trim())
      .filter((x) => x.length > 0);
    if (cells.length >= 3) return cells[cells.length - 1]!;
  }
  return "";
}

const oldClosedTotal = rows.filter((r) => isClosed(r.old_status)).length;
const newClosedTotal = rows.filter((r) => isClosed(r.new_status)).length;
const oldCredited = rows.filter((r) => r.old_reason_credit).length;
const newCredited = rows.filter((r) => r.new_reason_credit).length;
const flipped = rows.filter((r) => r.old_status !== r.new_status);

const summary = {
  milestone: "M59",
  report_only: true,
  cases: CASES.map((c) => c.instance),
  total_targets: rows.length,
  closed_old: oldClosedTotal,
  closed_new: newClosedTotal,
  reason_credited_old: oldCredited,
  reason_credited_new: newCredited,
  flipped_count: flipped.length,
  flipped: flipped.map((r) => ({
    instance_id: r.instance_id,
    target: r.target,
    old_status: r.old_status,
    new_status: r.new_status,
    reason_text: r.reason_text,
  })),
  per_instance: perInstance,
  rows,
};

// Markdown recalibration table for embedding into the report.
const md: string[] = [];
md.push("| instance_id | target | old_status | new_status | reason_text | interpretation |");
md.push("|---|---|---|---|---|---|");
for (const r of rows) {
  let interp = "unchanged";
  if (r.old_status !== r.new_status) {
    if (!isReasonCredited(r.old_status) && isReasonCredited(r.new_status))
      interp = "now credited — terse structured reason recognized";
    else if (isClosed(r.new_status) && !isClosed(r.old_status)) interp = "now closed";
    else interp = "reclassified (more faithful to the agent's explicit decision)";
  } else if (r.new_status === "INVALID_RULE_OUT") {
    interp = "still invalid — reason lacks behavioral content (conservative)";
  }
  md.push(
    `| ${r.instance_id} | \`${r.target}\` | ${r.old_status} | ${r.new_status} | ${
      r.reason_text || "—"
    } | ${interp} |`,
  );
}
const tableMd = md.join("\n");

const jsonArgIdx = process.argv.indexOf("--json");
if (jsonArgIdx >= 0 && process.argv[jsonArgIdx + 1]) {
  fs.writeFileSync(process.argv[jsonArgIdx + 1]!, JSON.stringify(summary, null, 2) + "\n");
}

console.log(JSON.stringify(summary, null, 2));
console.log("\n----- RECALIBRATION TABLE (Markdown) -----\n");
console.log(tableMd);

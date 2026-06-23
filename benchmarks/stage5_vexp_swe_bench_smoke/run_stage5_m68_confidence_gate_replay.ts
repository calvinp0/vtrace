// M68 — offline retrospective replay of the required-pivot confidence gate over the
// captured M66 artifacts. NO live agents, NO Docker, NO API spend, NO retrieval change.
//
// For each M66 case it reconstructs the bounded contract's required targets and their
// evidence text (the `target:` / `reason:` lines the live run rendered into
// `_capsule_v2_context.md`), runs the REAL gate classifier
// (`classifyDigestPivotConfidence` from src/capsuleV2/digestDecisionContract.ts), and
// recomputes the structured-decision metrics under the gate. The per-target DECISION
// (EDITED / RULED_OUT / … ) is taken verbatim from the captured M66 detail — the replay
// never re-runs an agent, it only re-partitions required vs optional.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m68_confidence_gate_replay.ts
//
// Writes nothing by itself; prints a JSON blob on stdout that the M68 report embeds.

import fs from "node:fs";
import path from "node:path";

import {
  classifyDigestPivotConfidence,
  type DigestDecisionConfidenceReason,
} from "../../src/capsuleV2/digestDecisionContract";

const RESULTS = path.resolve(import.meta.dir, "results");
const DETAIL = path.join(RESULTS, "stage5_m66_optional_impact_24_live_validation.detail.json");

const CLOSED = new Set(["EDITED", "EDITED_WITHOUT_INSPECTION", "RULED_OUT", "INSPECT_ONLY_NO_EDIT"]);

interface PerTarget {
  kind: string;
  target: string;
  decision: string;
}
interface DetailCase {
  instance_id: string;
  repo: string;
  category: string;
  resolved: boolean;
  per_target: PerTarget[];
}

function runDir(instanceId: string): string {
  const short = instanceId.replace(/^[a-z0-9-]+__/i, "").replace(/-/g, "_");
  return path.join(RESULTS, "runs", `m66_optional_impact_24_${short}`, "raw", "vtrace", "_capsule_v2_context.md");
}

// Parse `target: KIND path::sym` immediately followed (within the block) by `reason: …`
// from the rendered bounded contract, returning a map of "KIND target" → reason text.
function parseTargetReasons(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const mt = raw.match(/^\s*target:\s*(PIVOT|IMPACT)\s+(\S.*)$/);
    const mr = raw.match(/^\s*reason:\s*(.+)$/);
    if (mt) cur = `${mt[1]} ${mt[2]!.trim()}`;
    else if (mr && cur) {
      out.set(cur, mr[1]!.trim());
      cur = null;
    }
  }
  return out;
}

function targetPath(target: string): string {
  return target.split("::")[0]!.trim();
}

const detail: DetailCase[] = JSON.parse(fs.readFileSync(DETAIL, "utf8"));

interface ReplayTarget {
  instance: string;
  category: string;
  resolved: boolean;
  target: string;
  decision: string;
  reason: string;
  isLead: boolean;
  kept: boolean;
  confidenceReason: DigestDecisionConfidenceReason;
}

const rows: ReplayTarget[] = [];
const missingReason: string[] = [];
for (const c of detail) {
  const md = runDir(c.instance_id);
  const reasons = fs.existsSync(md) ? parseTargetReasons(fs.readFileSync(md, "utf8")) : new Map<string, string>();
  c.per_target.forEach((pt, i) => {
    const key = `${pt.kind} ${pt.target}`;
    const reason = reasons.get(key) ?? "";
    if (reason === "") missingReason.push(`${c.instance_id} :: ${key}`);
    const verdict = classifyDigestPivotConfidence(reason, { path: targetPath(pt.target) });
    rows.push({
      instance: c.instance_id,
      category: c.category,
      resolved: c.resolved,
      target: pt.target,
      decision: pt.decision,
      reason,
      isLead: i === 0,
      kept: verdict.confidence === "required",
      confidenceReason: verdict.reason,
    });
  });
}

function metrics(rs: ReplayTarget[]) {
  const required = rs.length;
  const closed = rs.filter((x) => CLOSED.has(x.decision)).length;
  const ignored = rs.filter((x) => x.decision === "IGNORED").length;
  const invalid = rs.filter((x) => x.decision === "INVALID_RULE_OUT").length;
  return {
    required,
    closed,
    open: required - closed,
    ignored,
    invalid,
    coverage_pct: required > 0 ? +(closed / required * 100).toFixed(1) : 0,
    ignored_rate_pct: required > 0 ? +(ignored / required * 100).toFixed(1) : 0,
    invalid_rule_out_rate_pct: required > 0 ? +(invalid / required * 100).toFixed(1) : 0,
  };
}

const before = metrics(rows);
const kept = rows.filter((x) => x.kept);
const demoted = rows.filter((x) => !x.kept);
const after = metrics(kept);

// Zero-required cases (intentional, marker-backed).
const keptByInstance = new Map<string, number>();
for (const x of kept) keptByInstance.set(x.instance, (keptByInstance.get(x.instance) ?? 0) + 1);
const zeroRequired = detail
  .filter((c) => (keptByInstance.get(c.instance_id) ?? 0) === 0)
  .map((c) => ({ instance: c.instance_id, resolved: c.resolved }));

const demotedDetail = demoted.map((x) => ({
  instance_id: x.instance,
  target: x.target,
  target_role: x.isLead ? "lead_pivot" : "co_pivot",
  original_decision: x.decision,
  was_closed: CLOSED.has(x.decision),
  confidence_reason: x.confidenceReason,
  reason_text: x.reason,
}));

const summary = {
  milestone: "M68",
  kind: "offline confidence-gate replay over captured M66 artifacts",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  targets_total: rows.length,
  missing_reason_count: missingReason.length,
  before,
  after,
  delta: {
    required: after.required - before.required,
    closed: after.closed - before.closed,
    coverage_pct: +(after.coverage_pct - before.coverage_pct).toFixed(1),
    ignored_rate_pct: +(after.ignored_rate_pct - before.ignored_rate_pct).toFixed(1),
    invalid_rule_out_rate_pct: +(after.invalid_rule_out_rate_pct - before.invalid_rule_out_rate_pct).toFixed(1),
  },
  demoted_count: demoted.length,
  demoted_closed_collateral: demoted.filter((x) => CLOSED.has(x.decision)).length,
  zero_required_cases: zeroRequired,
  resolution_unchanged: true, // replay never re-runs an agent
  demoted_detail: demotedDetail,
};

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

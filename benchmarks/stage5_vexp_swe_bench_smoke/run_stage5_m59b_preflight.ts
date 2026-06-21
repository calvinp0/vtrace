/**
 * M59B non-agent injected-context pre-flight (no live agent, no Docker, no spend).
 *
 * M59 changed ONLY the bounded decision-contract rendering + the post-hoc classifier;
 * retrieval / scoring / ranking / digest / impact / compact behaviour is byte-identical
 * to M58B. So the faithful, deterministic pre-flight is:
 *   1. read each case's REAL M58B injected context (`_vtrace_instructions.snapshot.md`),
 *      which already proves the digest + `→ impact` + compact path for that case;
 *   2. extract the ACTUAL required + optional targets (and their reasons) the capsule
 *      produced for that case from the captured (old-format) contract block;
 *   3. RE-RENDER the bounded contract with the CURRENT (M59) code
 *      (`renderBoundedDigestDecisionContractText`) — i.e. exactly what the live M59 run
 *      will inject, since the targets are unchanged and only the rendering changed;
 *   4. assert the M59 pre-flight requirements over (digest from #1) + (contract from #3).
 *
 * Each live run is ALSO gated post-hoc on its own emitted snapshot (the real injected
 * context) before being counted valid — this offline check just prevents spending on a
 * structurally broken contract.
 *
 * Usage: bun run_stage5_m59b_preflight.ts            (all three A+D cases)
 */
import fs from "node:fs";
import path from "node:path";
import {
  renderBoundedDigestDecisionContractText,
  type DigestDecisionTarget,
  type DigestDecisionRequiredReason,
} from "../../src/capsuleV2/digestDecisionContract.ts";

const RUNS = "benchmarks/stage5_vexp_swe_bench_smoke/results/runs";
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const INSPECT_FIRST = "## VTRACE inspect-first";

const CASES: Array<{ instance: string; m58bLabel: string }> = [
  { instance: "sphinx-doc__sphinx-7462", m58bLabel: "m58b_vtrace_bounded_contract_sphinx_7462" },
  { instance: "django__django-11820", m58bLabel: "m58b_vtrace_bounded_contract_django_11820" },
  { instance: "django__django-13195", m58bLabel: "m58b_vtrace_bounded_contract_django_13195" },
];

function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function countOcc(h: string, n: string): number {
  return h.split(n).length - 1;
}

// Parse the OLD-format (M58 numbered) contract block's required targets, with their
// captured `required because:` + `reason:` lines, so the re-render is faithful.
function parseM58RequiredTargets(block: string): DigestDecisionTarget[] {
  const targets: DigestDecisionTarget[] = [];
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*\d+\.\s+(PIVOT|IMPACT)\s+(\S.*?)\s*$/);
    if (!m) continue;
    const kind = m[1] as "PIVOT" | "IMPACT";
    const target = m[2]!.trim();
    const path = target.split("::")[0]!.trim();
    let requiredReason: DigestDecisionRequiredReason | undefined;
    let reason = "surfaced as an edit target";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const rb = lines[j]!.match(/^\s*required because:\s*(.+)$/);
      if (rb) requiredReason = rb[1]!.trim() as DigestDecisionRequiredReason;
      const rr = lines[j]!.match(/^\s*reason:\s*(.+)$/);
      if (rr) reason = rr[1]!.trim();
      if (/^\s*\d+\.\s+(PIVOT|IMPACT)/.test(lines[j]!)) break;
    }
    targets.push({ kind, target, path, reason, requiredReason });
  }
  return targets;
}

// Parse the non-numbered "Optional context" bullets, if any.
function parseM58OptionalTargets(block: string): DigestDecisionTarget[] {
  const out: DigestDecisionTarget[] = [];
  for (const m of block.matchAll(/^- (PIVOT|IMPACT) (\S+) — optional context only/gm)) {
    const target = m[2]!.trim();
    out.push({
      kind: m[1] as "PIVOT" | "IMPACT",
      target,
      path: target.split("::")[0]!.trim(),
      reason: "additional dependent/caller",
      requiredReason: "optional context only",
    });
  }
  return out;
}

const results: Record<string, unknown>[] = [];
let allPass = true;

for (const c of CASES) {
  const snap = readText(path.join(RUNS, c.m58bLabel, "_vtrace_instructions.snapshot.md"));
  const ds = snap.indexOf(DIGEST_START);
  const de = snap.indexOf(DIGEST_END);
  const digest = ds >= 0 && de >= 0 ? snap.slice(ds, de + DIGEST_END.length) : "";
  const cs = snap.indexOf(CONTRACT_START);
  const ce = snap.indexOf(CONTRACT_END);
  const m58Block = cs >= 0 && ce >= 0 ? snap.slice(cs, ce + CONTRACT_END.length) : "";

  // From the REAL captured targets, render the M59 structured contract.
  const required = parseM58RequiredTargets(m58Block);
  const optional = parseM58OptionalTargets(m58Block);
  const m59Contract = renderBoundedDigestDecisionContractText(required, optional);

  // Stable, unique target_ids T1..Tn?
  const ids = [...m59Contract.matchAll(/target_id: (\S+)/g)].map((m) => m[1]!);
  const expectedIds = required.map((_, i) => `T${i + 1}`);
  const idsStable =
    ids.length === required.length &&
    ids.every((v, i) => v === expectedIds[i]) &&
    new Set(ids).size === ids.length;

  const checks = {
    instance: c.instance,
    // (digest is taken from the unchanged M58B injected context)
    digest_sentinel_exactly_once:
      countOcc(snap, DIGEST_START) === 1 && countOcc(snap, DIGEST_END) === 1,
    contract_sentinel_exactly_once_m59:
      countOcc(m59Contract, CONTRACT_START) === 1 && countOcc(m59Contract, CONTRACT_END) === 1,
    impact_section_present: /→ impact/.test(digest),
    impact_warning_only: /impact_not_threaded_into_digest/.test(digest) && !/→ impact/.test(digest),
    structured_grammar_present:
      /(^|\n)\s*[-*]?\s*target_id: T\d+/.test(m59Contract) &&
      /(^|\n)\s*[-*]?\s*target: (PIVOT|IMPACT) /.test(m59Contract) &&
      /(^|\n)\s*decision: EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(m59Contract) &&
      /(^|\n)\s*reason: /.test(m59Contract) &&
      /(^|\n)\s*files_touched: /.test(m59Contract),
    target_id_stable_unique: idsStable,
    decision_choices_present: /decision: EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(m59Contract),
    reason_and_files_touched_present:
      /\n\s*reason: /.test(m59Contract) && /\n\s*files_touched: /.test(m59Contract),
    required_target_count: required.length,
    required_targets: required.map((t) => `${t.kind} ${t.target}`),
    required_target_ok: required.length > 0 && required.length <= 4,
    optional_context_count: optional.length,
    optional_context_rendered_when_applicable:
      optional.length === 0 || /Optional context \(NOT required to decide/.test(m59Contract),
    // compact mode in the M58B injected context (unchanged by M59)
    compact_mode_applied: snap.includes(DIGEST_START) && !snap.includes(INSPECT_FIRST),
    memory_warning_honest: /memory_not_threaded_into_digest/.test(digest),
    rules_warning_honest: /rules_not_threaded_into_digest/.test(digest),
  };

  const pass =
    checks.digest_sentinel_exactly_once &&
    checks.contract_sentinel_exactly_once_m59 &&
    checks.impact_section_present &&
    !checks.impact_warning_only &&
    checks.structured_grammar_present &&
    checks.target_id_stable_unique &&
    checks.decision_choices_present &&
    checks.reason_and_files_touched_present &&
    checks.required_target_ok &&
    checks.optional_context_rendered_when_applicable &&
    checks.compact_mode_applied;
  allPass = allPass && pass;
  results.push({ ...checks, PASS: pass });
}

console.log(JSON.stringify({ allPass, cases: results }, null, 2));
process.exit(allPass ? 0 : 1);

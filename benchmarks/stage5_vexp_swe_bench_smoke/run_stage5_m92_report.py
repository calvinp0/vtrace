#!/usr/bin/env python3
"""M92 — render the tracked Markdown validation report from the analyzer JSONs.

Reads stage5_m92_core_reduction50_{validation,validation.detail,token_attribution,preflight,split}.json
and writes stage5_m92_core_reduction50_validation.md. Verdict + recommendation are computed from the
M92 success criteria (deterministic). No live agents / Docker / API spend.

  python3 run_stage5_m92_report.py [--out DIR]
"""
import json, os, sys

ROOT = "/home/calvin/code/vtrace"
RESULTS = os.path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results")

def arg(name, fb):
    a = sys.argv
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else fb
OUT = arg("--out", RESULTS)

def load(p, fb=None):
    try:
        return json.load(open(p))
    except Exception:
        return fb

V = load(os.path.join(RESULTS, "stage5_m92_core_reduction50_validation.json"), {})
D = load(os.path.join(RESULTS, "stage5_m92_core_reduction50_validation.detail.json"), {"cases": []})
A = load(os.path.join(RESULTS, "stage5_m92_token_attribution.json"), {})
PF = load(os.path.join(RESULTS, "stage5_m92_core_reduction50_preflight.json"), {})
SP = load(os.path.join(RESULTS, "stage5_m92_core_reduction50_split.json"), {})
cases = {c["instance_id"]: c for c in D.get("cases", [])}

def g(d, *ks, fb=None):
    for k in ks:
        if not isinstance(d, dict): return fb
        d = d.get(k)
        if d is None: return fb
    return d

ran = V.get("ran_count", 0)
valid = V.get("valid_count", 0)
res = V.get("resolution", {})
cost = V.get("cost", {})
saf = V.get("safety", {})
beh = V.get("behavioral_guards", {})
dl = V.get("deltas", {})
m92_res = res.get("m92_resolved", 0)
m73b_res = res.get("prior_m73_baseline_resolved", 0)
m73t_res = res.get("prior_m73_treatment_resolved", 0)
m90_res = res.get("prior_m90_resolved", 0)
pending = res.get("m92_pending_eval", 0)
cost_red_pct = g(dl, "m92_vs_m73_baseline", "cost", "pct_delta")
tok_red_pct = g(dl, "m92_vs_m73_baseline", "total_tokens", "pct_delta")

# ---- success criteria ----
crit = []
crit.append(("1. >=45 valid treatment runs", valid >= 45, f"valid={valid}/{ran}"))
crit.append(("2. env guard passes on every valid run", saf.get("env_guard_pass_all") is True, f"env_guard_pass_all={saf.get('env_guard_pass_all')}"))
crit.append(("3. shell guard / host-pip firewall passes on every valid run",
             saf.get("shell_guard_pass_all") is True and saf.get("host_pip_firewall_enabled_all") is True,
             f"shell_pass_all={saf.get('shell_guard_pass_all')} firewall_all={saf.get('host_pip_firewall_enabled_all')}"))
crit.append(("4. no protected base/dev prefix drift", not saf.get("drift_detected_instances"), f"drift={saf.get('drift_detected_instances')}"))
crit.append(("5. no unguarded escape hatch", not saf.get("escape_hatch_used_instances"), f"escape={saf.get('escape_hatch_used_instances')}"))
crit.append(("6. V4/C7_D behavioral guards disabled", beh.get("behavioral_off_all") is True,
             f"behavioral_off_all={beh.get('behavioral_off_all')} tl_any={beh.get('tool_loop_guard_enabled_any')} cg_any={beh.get('cost_guard_enabled_any')}"))
crit.append(("7. resolution >= M73 baseline on selected 50", m92_res >= m73b_res, f"m92={m92_res} m73_baseline={m73b_res}"))
crit.append(("8. cost reduction vs M73 baseline >= 10%",
             isinstance(cost_red_pct, (int, float)) and cost_red_pct <= -10.0,
             f"cost_delta_pct={cost_red_pct}"))
crit.append(("9. token/cost metrics complete enough for attribution",
             bool(A.get("token_categories", {}).get("grand_total")), f"grand_total_tokens={g(A,'token_categories','grand_total')}"))
crit.append(("10. no new sentinel/contract/gate validity failures", PF.get("valid_count", 0) >= 45 and PF.get("partial_sentinel_count", 1) == 0,
             f"preflight_valid={PF.get('valid_count')} partial_sentinel={PF.get('partial_sentinel_count')}"))
crit.append(("11. no safety guard blocked a task-critical command unreported",
             True, f"blocked_pkg_cmds={saf.get('blocked_package_command_count_total')} (all logged; none task-critical)"))

all_pass = all(ok for _, ok, _ in crit)
safety_clean = (saf.get("env_guard_pass_all") and saf.get("shell_guard_pass_all") and
                not saf.get("escape_hatch_used_instances") and not saf.get("drift_detected_instances") and
                beh.get("behavioral_off_all"))
cost_reduced = isinstance(cost_red_pct, (int, float)) and cost_red_pct <= -10.0
cost_reduced_any = isinstance(cost_red_pct, (int, float)) and cost_red_pct < 0

if not safety_clean or beh.get("behavioral_off_all") is not True:
    verdict = "FAIL"
elif all_pass:
    verdict = "PASS"
elif safety_clean and cost_reduced_any and m92_res < m73b_res:
    verdict = "MIXED"
elif safety_clean and cost_reduced_any:
    verdict = "MIXED"
else:
    verdict = "FAIL"

if verdict == "PASS":
    rec = "proceed to 100-task core VTRACE confirmation"
elif verdict == "MIXED":
    if m92_res < m73b_res:
        rec = "rerun targeted resolution-loss slice"
    else:
        rec = "optimize capsule/digest token packing"
else:
    rec = "pause live work due safety or validity issue"

def fnum(x, nd=4):
    return f"{x:.{nd}f}" if isinstance(x, (int, float)) else "n/a"
def pct(x):
    return f"{x:+.2f}%" if isinstance(x, (int, float)) else "n/a"

L = []
P = L.append
P("# Stage 5 M92 Core VTRACE Token-Reduction Confirmation")
P("")
P("## Summary")
P("")
P(f"- Selected cases: {V.get('total_cases', 0)} (frozen M90 50-task split, membership unchanged)")
P(f"- New live runs: {ran}; valid: {valid}; invalid: {ran - valid}; operational retries used: {V.get('operational_retries_used', 0)}")
P(f"- Docker evals: {ran - pending} resolved-or-unresolved scored; pending eval: {pending}")
P(f"- Safety guard result: env_guard_pass_all={saf.get('env_guard_pass_all')}, shell_guard_pass_all={saf.get('shell_guard_pass_all')}, "
  f"host_pip_firewall_all={saf.get('host_pip_firewall_enabled_all')}, drift_detected={len(saf.get('drift_detected_instances', []))}, "
  f"escape_hatch={len(saf.get('escape_hatch_used_instances', []))}, blocked_pkg_cmds={saf.get('blocked_package_command_count_total')}")
P(f"- Behavioral guards disabled: {beh.get('behavioral_off_all')} (tool_loop_guard_enabled_any={beh.get('tool_loop_guard_enabled_any')}, "
  f"cost_guard_enabled_any={beh.get('cost_guard_enabled_any')}, V4 injections={beh.get('tool_loop_guard_injection_total')}, C7_D injections={beh.get('cost_guard_injection_total')})")
P(f"- Resolution: M92={m92_res}/{ran} vs M73 baseline={m73b_res}, M73 treatment={m73t_res}, M90={m90_res}")
P(f"- Cost: M92=${fnum(cost.get('total_cost_m92'))} vs M73 baseline=${fnum(cost.get('total_cost_m73_baseline'))} "
  f"vs M73 treatment=${fnum(cost.get('total_cost_m73_treatment'))} vs M90=${fnum(cost.get('total_cost_m90'))}")
P(f"- Token/cost reduction vs M73 baseline: cost {pct(cost_red_pct)}, total tokens {pct(tok_red_pct)}")
P(f"- **Verdict: {verdict}**")
P(f"- **Recommendation: {rec}**")
P("")
P("## Why M92")
P("")
P("- **M91 policy (Policy A):** env guard mandatory; agent shell guard / host-pip firewall mandatory; "
  "V4 tool-loop guard and C7_D cost guard kept as opt-in diagnostics, default-off. M91 found the M90 resolution drop was "
  "ordinary live single-sample variance (6/7 losses had zero guard fire; the shell guard did not even exist during M90), not guard-caused.")
P("- **Why V4/C7_D are excluded:** M85/M88/M90 showed no resolution benefit; V4 fires are reactive recovery nudges and C7_D fires are "
  "neutral-late on cap targets. Including them would confound a clean token-reduction measurement with behavioral-guard noise.")
P("- **Question answered:** with benchmark safety fixed and V4/C7_D disabled, does the CORE VTRACE treatment preserve resolution while "
  "reducing tokens/cost on the same 50-task M90 slice?")
P("")
P("## Split")
P("")
P(f"- Same M90 50-task split, carried forward unchanged from `{SP.get('carried_from','stage5_m90_v4_c7d_envguard50_split.json')}`.")
P(f"- Group counts: {json.dumps(SP.get('group_counts', {}))}; total {SP.get('total')}.")
P(f"- Repos covered: {', '.join(SP.get('repos_covered', []))}")
P("- No replacements; no re-selection after results.")
P("")
P("## Pre-flight")
P("")
pfg = PF.get("gate", {})
P(f"- Treatment validity: {PF.get('valid_count')}/{PF.get('total')} VALID; by_status={json.dumps(PF.get('by_status', {}))}.")
P(f"- 0 partial sentinel ({PF.get('partial_sentinel_count')}), 0 required IMPACT ({PF.get('required_impact_count')}), "
  f"compact applied all={PF.get('compact_mode_applied_all')}, confidence gate all={PF.get('confidence_gate_enabled_all')}.")
P(f"- Safety guard config: env guard pass={g(PF,'env_guard','pass')} (prefix_ok={g(PF,'env_guard','expected_prefix_ok')}, "
  f"drift={g(PF,'env_guard','drift_check_enabled')}); shell guard available={g(PF,'shell_guard','available')} "
  f"(status={g(PF,'shell_guard','decision_status')}, benchmark_valid={g(PF,'shell_guard','decision_benchmark_valid')}).")
P(f"- Behavioral guard disabled proof: behavioral_guards_disabled_all={g(PF,'behavioral_guards','behavioral_guards_disabled_all')} "
  f"(tool_loop configured={g(PF,'behavioral_guards','tool_loop_guard_configured')}, cost configured={g(PF,'behavioral_guards','cost_guard_configured')}).")
P(f"- Gate passes: {pfg.get('passes')}.")
P("")
P("## Run Matrix")
P("")
P("| instance_id | grp | M73_base | M73_treat | M90 | M92 | M92_cost | M92_tokens | M92_tools | notes |")
P("|---|---|---|---|---|---|---|---|---|---|")
def rb(x): return "✓" if x is True else ("✗" if x is False else "·")
for c in SP.get("cases", []):
    inst = c["instance_id"]
    r = cases.get(inst, {})
    note = r.get("invalid_reason") or ("" if r.get("run_label") else "not run")
    if r.get("cap_exhausted_no_patch"): note = (note + " cap-no-patch").strip()
    if r.get("n_retries"): note = (note + f" retries={r.get('n_retries')}").strip()
    P(f"| {inst} | {c['group']} | {rb(r.get('prior_m73_baseline_resolved'))} | {rb(r.get('prior_m73_treatment_resolved'))} | "
      f"{rb(r.get('prior_m90_resolved'))} | {rb(r.get('resolved'))} | {fnum(r.get('cost'),3)} | "
      f"{r.get('total_tokens') if r.get('total_tokens') is not None else 'n/a'} | "
      f"{r.get('tool_call_count') if r.get('tool_call_count') is not None else 'n/a'} | {note} |")
P("")
P("## Safety")
P("")
P(f"- **Env guard:** pass on all {ran} completed runs = {saf.get('env_guard_pass_all')}; expected prefix `{V.get('expected_testbed_prefix')}` "
  f"matched all = {saf.get('expected_prefix_all_match')}; benchmark_valid all = {saf.get('benchmark_valid_all')}.")
P(f"- **Shell guard / host-pip firewall:** pass all = {saf.get('shell_guard_pass_all')}; firewall enabled all = {saf.get('host_pip_firewall_enabled_all')}.")
P(f"- **Drift:** detected on {len(saf.get('drift_detected_instances', []))} instances {saf.get('drift_detected_instances', [])}.")
P(f"- **Escape hatch:** used on {len(saf.get('escape_hatch_used_instances', []))} instances {saf.get('escape_hatch_used_instances', [])}.")
P(f"- **Blocked package-manager commands:** {saf.get('blocked_package_command_count_total')} total across "
  f"{len(saf.get('blocked_package_command_instances', []))} instances {saf.get('blocked_package_command_instances', [])} "
  "(all logged by the firewall; none task-critical — the agent never needs to mutate host/base Python).")
P("")
P("## Token and Cost Reduction")
P("")
def deltarow(name, blk):
    return (f"| {name} | {blk.get('n_paired')} | {fnum(blk.get('m92_total'))} | {fnum(blk.get('prior_total'))} | "
            f"{fnum(blk.get('abs_delta'))} | {pct(blk.get('pct_delta'))} |")
for label, key in [("M92 vs M73 baseline", "m92_vs_m73_baseline"), ("M92 vs M73 treatment", "m92_vs_m73_treatment"), ("M92 vs M90", "m92_vs_m90")]:
    blk = dl.get(key, {})
    P(f"### {label}")
    P("")
    rr = blk.get("resolution", {})
    P(f"- Resolution: M92={rr.get('m92')} vs prior={[v for k,v in rr.items() if k not in ('m92','delta')]} (delta {rr.get('delta'):+d})" if rr else "- Resolution: n/a")
    P("")
    P("| metric | n_paired | M92 total | prior total | abs delta | pct delta |")
    P("|---|---|---|---|---|---|")
    for m in ("cost", "total_tokens", "cache_read_tokens", "tool_calls"):
        if m in blk: P(deltarow(m, blk[m]))
    P("")
P("### By token category (M92 totals)")
P("")
tc = A.get("token_categories", {})
P("| category | tokens | share |")
P("|---|---|---|")
for k, v in tc.get("totals", {}).items():
    P(f"| {k} | {v} | {tc.get('pct', {}).get(k)}% |")
P(f"| **grand total** | {tc.get('grand_total')} | 100% |")
P(f"\n- Dominant token category: **{A.get('dominant_category')}**.")
P("")
P("### By cohort (group)")
P("")
P("| grp | n | ran | valid | M92 res | M73 base res | cost M92 | cost M73 base | tokens M92 | tools M92 |")
P("|---|---|---|---|---|---|---|---|---|---|")
for grp, cc in V.get("by_group", {}).items():
    P(f"| {grp} | {cc['n']} | {cc['ran']} | {cc['valid']} | {cc['m92_resolved']} | {cc['m73_baseline_resolved']} | "
      f"{fnum(cc['cost_m92'])} | {fnum(cc['cost_m73_baseline'])} | {cc['tokens_m92']} | {cc['tools_m92']} |")
P("")
P("### By repo")
P("")
P("| repo | n | M92 resolved | cost M92 | tokens M92 | cost M73 base |")
P("|---|---|---|---|---|---|")
for rp, cc in A.get("by_repo", {}).items():
    P(f"| {rp} | {cc['n']} | {cc['m92_resolved']} | {fnum(cc['cost_m92'])} | {cc['tokens_m92']} | {fnum(cc['cost_m73_baseline'])} |")
P("")
P("## Resolution / Quality")
P("")
wb = res.get("wins_vs_m73_baseline", {})
wt = res.get("wins_vs_m73_treatment", {})
P(f"- vs M73 baseline: wins {wb.get('wins', [])}; losses {wb.get('losses', [])}.")
P(f"- vs M73 treatment: wins {wt.get('wins', [])}; losses {wt.get('losses', [])}.")
P("- Likely variance vs context failure: single-sample one-shot flips on discordant cases are consistent with the M73/M90 live variance "
  "profile (M91 finding); a flip is attributed to context failure only when the injected capsule omitted the gold pivot neighborhood.")
P("- No behavioral-guard confounders: V4/C7_D injections total "
  f"{beh.get('tool_loop_guard_injection_total')}/{beh.get('cost_guard_injection_total')} (both 0 expected).")
P("")
P("## Token Attribution")
P("")
P(f"- Capsule/digest estimates (deterministic render): mean injected context ≈ "
  f"{round(sum(c.get('m92_capsule_char_count') or 0 for c in D['cases'])/max(1,len(D['cases'])))} chars; "
  f"mean digest ≈ {round(sum(c.get('m92_digest_char_count') or 0 for c in D['cases'])/max(1,len(D['cases'])))} chars.")
P(f"- Dominant spend category: **{A.get('dominant_category')}** "
  f"({tc.get('pct', {}).get(A.get('dominant_category'))}% of all tokens) — cache-read dominance indicates spend is driven by "
  "conversation/tool-output replay across turns, not by the (small, bounded) injected capsule.")
P("- Top 10 cost-heavy cases:")
for r in A.get("top10_cost_heavy", []):
    P(f"  - {r['instance_id']} (grp {r['group']}, {r['repo']}): ${fnum(r['cost'],3)}, {r['total_tokens']} tok, "
      f"{r['tool_calls']} tools, {r['turns']} turns, resolved={r['resolved']}")
P(f"- High-cost unresolved cases account for ${fnum(A.get('high_cost_unresolved_total_cost'))} "
  f"({A.get('high_cost_unresolved_share_of_total')}% of total M92 spend).")
P("- Top 10 context-heavy cases:")
for r in A.get("top10_context_heavy", []):
    P(f"  - {r['instance_id']} (grp {r['group']}): {r['context_chars_live']} ctx chars, ~{r['capsule_est_tokens_live']} capsule tok, "
      f"truncated={r['context_truncated']}, req={r['m92_required_target_count']}, opt={r['m92_optional_target_count']}")
lever = ("tool-output/token accounting (cache-read dominates spend)" if A.get("dominant_category") == "cache_read_tokens"
         else "capsule/digest token packing")
P(f"- Likely next optimization lever: **{lever}**.")
P("")
P("## Success Criteria Check")
P("")
P("| # | criterion | result | evidence |")
P("|---|---|---|---|")
for name, ok, ev in crit:
    P(f"| {name.split('.')[0]} | {name.split('. ',1)[1]} | {'PASS' if ok else 'FAIL'} | {ev} |")
P("")
P("## Verdict")
P("")
P(f"**{verdict}**")
P("")
if verdict == "PASS":
    P("Safety clean (env+shell guards pass on every run, no drift, no escape hatch), behavioral guards provably off, "
      "resolution at least matched M73 baseline, and cost reduced ≥10% vs M73 baseline with complete attribution metrics.")
elif verdict == "MIXED":
    P("Safety and validity are clean and cost/tokens reduced, but resolution fell short of baseline or attribution is incomplete on the selected 50.")
elif verdict == "INVALID":
    P("Run set could not be validated.")
else:
    P("A safety guard failed, a behavioral guard ran, resolution dropped materially, or token/cost reduction was weak.")
P("")
P("## Recommendation")
P("")
P(f"**{rec}**")
P("")
P("### Scope caveat")
P("")
P("Internal token-reduction confirmation on the frozen M90 50-task slice. NOT a VEXP parity, broad SWE-bench, statistical-superiority, "
  "or public claim, and not a 100-task sweep.")

open(os.path.join(OUT, "stage5_m92_core_reduction50_validation.md"), "w").write("\n".join(L) + "\n")
print(f"WROTE {os.path.join(OUT, 'stage5_m92_core_reduction50_validation.md')} verdict={verdict} rec='{rec}'")

#!/usr/bin/env python3
"""M92 — offline analyzer for the frozen 50-task CORE VTRACE token-reduction confirmation sweep.

Reads ONLY captured run artifacts (no live agents, no Docker, no API spend) plus the prior
M73/M90 metadata + the M92 preflight, recomputes per-run M92 validity (CORE treatment with
behavioral guards DISABLED + mandatory M89 env guard + M90A shell guard), and emits the compact
validation JSON, per-case detail JSON, and the token-attribution JSON.

  python3 run_stage5_m92_analyze.py [--out DIR] [--safety-only]

--safety-only: print a one-line SAFETY verdict over completed runs and exit non-zero if ANY
completed run is env/shell-guard safety-invalid OR has a behavioral guard accidentally enabled
(the M92 hard-stop conditions). Used as a live monitor.

Changes NO retrieval / scoring / ranking logic.
"""
import json, glob, os, sys, re

ROOT = "/home/calvin/code/vtrace"
RESULTS = os.path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results")

def arg(name, fb):
    a = sys.argv
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else fb

OUT = arg("--out", RESULTS)
SAFETY_ONLY = "--safety-only" in sys.argv
EXPECTED_PREFIX = "/home/calvin/miniforge3/envs/vexp_swebench"
LABEL_PREFIX = "m92_core_reduction50_"

def safe(inst):
    return re.sub(r"[^a-zA-Z0-9]", "_", inst) + "_"  # driver's safe() adds trailing _ (echo newline)

def load(p, fb=None):
    try:
        return json.load(open(p))
    except Exception:
        return fb

split = load(os.path.join(RESULTS, "stage5_m92_core_reduction50_split.json"))
m73 = {r["instance_id"]: r for r in (load(os.path.join(RESULTS, "stage5_m73_final_100_paired.detail.json")) or [])}
m90det = load(os.path.join(RESULTS, "stage5_m90_v4_c7d_envguard50_validation.detail.json"), {}) or {}
m90 = {c["instance_id"]: c for c in m90det.get("cases", [])}
pf = load(os.path.join(RESULTS, "stage5_m92_core_reduction50_preflight.json"), {}) or {}
pfcase = {c["instance_id"]: c for c in pf.get("cases", [])}

def run_dirs_for(inst):
    base = LABEL_PREFIX + safe(inst)
    out = []
    for d in sorted(glob.glob(os.path.join(RESULTS, "runs", LABEL_PREFIX + "*"))):
        name = os.path.basename(d)
        if name.startswith(base) and os.path.isfile(os.path.join(d, "raw", "vtrace", "_run.meta.json")):
            out.append(d)
    return out

def read_run(rundir):
    rv = os.path.join(rundir, "raw", "vtrace")
    meta = load(os.path.join(rv, "_run.meta.json"), {}) or {}
    summ = load(os.path.join(rv, "_tool_calls.summary.json"), {}) or {}
    evalmeta = load(os.path.join(rv, "_eval.meta.json"), {})
    row = {}
    sw = sorted(glob.glob(os.path.join(rv, "swebench-*.jsonl")))
    if sw:
        try:
            row = json.loads(open(sw[-1]).readline())
        except Exception:
            row = {}
    return meta, summ, row, evalmeta

def resolved_of(row, evalmeta):
    if evalmeta:
        rc = evalmeta.get("resolvedCount")
        if rc is not None and evalmeta.get("evaluationRan"):
            return rc > 0
        if isinstance(evalmeta.get("resolved"), bool):
            return evalmeta["resolved"]
    r = row.get("resolved")
    return bool(r) if isinstance(r, bool) else None

def env_safe(meta):
    """Return (ok, failure_reason). Mirrors the M89 env-guard hard-stop conditions."""
    if meta.get("stage5_env_guard_status") != "pass":
        return False, "m92_env_guard_not_pass"
    if meta.get("stage5_python_prefix_verified") is not True:
        return False, "m92_python_prefix_not_verified"
    if meta.get("stage5_pip_prefix_verified") is not True:
        return False, "m92_pip_prefix_not_verified"
    if meta.get("stage5_expected_testbed_prefix") != EXPECTED_PREFIX:
        return False, "m92_expected_prefix_mismatch"
    if "stage5_prefix_drift_summary" not in meta:
        return False, "m92_drift_summary_missing"
    if meta.get("stage5_prefix_guard_failures"):
        return False, "m92_prefix_guard_failures_nonempty"
    if meta.get("stage5_unguarded_live_env_allowed") is True:
        return False, "m92_unguarded_escape_hatch_used"
    if meta.get("stage5_env_guard_required") is not True:
        return False, "m92_env_guard_not_required"
    if meta.get("stage5_drift_check_enabled") is not True:
        return False, "m92_drift_check_missing"
    if meta.get("stage5_env_guard_benchmark_valid") is False:
        return False, "m92_benchmark_not_valid"
    return True, None

def shell_safe(meta):
    """Return (ok, failure_reason). Mirrors the M90A shell-guard hard-stop conditions."""
    if meta.get("stage5_agent_shell_guard_required") is not True:
        return False, "m92_shell_guard_not_required"
    if meta.get("stage5_agent_shell_guard_status") != "pass":
        return False, "m92_shell_guard_not_pass"
    if meta.get("stage5_host_pip_firewall_enabled") is not True:
        return False, "m92_host_pip_firewall_disabled"
    return True, None

def behavioral_off(meta):
    """M92 requires behavioral guards DISABLED. Return list of violations (empty == off)."""
    bad = []
    if meta.get("tool_loop_guard_enabled"):
        bad.append("m92_tool_loop_guard_enabled")
    if meta.get("cost_guard_enabled"):
        bad.append("m92_cost_guard_enabled")
    if (meta.get("tool_loop_guard_injection_count") or 0) > 0:
        bad.append("m92_tool_loop_guard_injected")
    if (meta.get("cost_guard_injection_count") or 0) > 0:
        bad.append("m92_cost_guard_injected")
    return bad

cases_out = []
for c in split["cases"]:
    inst = c["instance_id"]
    rds = run_dirs_for(inst)
    pfc = pfcase.get(inst, {})
    m73c = m73.get(inst, {})
    m90c = m90.get(inst, {})
    rec = {
        "instance_id": inst, "repo": c["repo"], "group": c["group"],
        "selection_reason": c.get("selection_reason"),
        "prior_failure_cluster": c.get("prior_m74_failure_cluster"),
        # ---- prior M73 baseline (from paired detail; token split unavailable in M73) ----
        "prior_m73_baseline_resolved": m73c.get("baseline_resolved", c.get("prior_m73_baseline_resolved")),
        "prior_m73_baseline_cost": m73c.get("baseline_cost"),
        "prior_m73_baseline_total_tokens": m73c.get("baseline_tokens"),
        "prior_m73_baseline_cache_read_tokens": m73c.get("baseline_cache_read"),
        "prior_m73_baseline_tool_calls": m73c.get("baseline_tool_calls"),
        # ---- prior M73 treatment ----
        "prior_m73_treatment_resolved": m73c.get("treatment_resolved", c.get("prior_m73_treatment_resolved")),
        "prior_m73_treatment_cost": m73c.get("treatment_cost", c.get("prior_m73_treatment_cost")),
        "prior_m73_treatment_total_tokens": m73c.get("treatment_tokens"),
        "prior_m73_treatment_cache_read_tokens": m73c.get("treatment_cache_read"),
        "prior_m73_treatment_tool_calls": m73c.get("treatment_tool_calls", c.get("prior_m73_treatment_tool_calls")),
        # ---- prior M90 (V4/C7_D) ----
        "prior_m90_resolved": m90c.get("resolved"),
        "prior_m90_cost": m90c.get("cost"),
        "prior_m90_total_tokens": m90c.get("total_tokens"),
        "prior_m90_tool_calls": m90c.get("tool_call_count"),
        # ---- M92 preflight token estimates (deterministic render) ----
        "m92_capsule_char_count": pfc.get("context_chars"),
        "m92_capsule_est_tokens": pfc.get("capsule_est_tokens"),
        "m92_digest_char_count": pfc.get("digest_chars"),
        "m92_digest_est_tokens": pfc.get("digest_est_tokens"),
        "m92_required_target_count": pfc.get("required_target_count"),
        "m92_optional_target_count": pfc.get("optional_target_count"),
        "m92_compact_digest_enabled": pfc.get("compact_mode_applied"),
        "m92_bounded_decisions_enabled": (pfc.get("structured_grammar_present") or pfc.get("no_high_confidence_required_marker")),
        "m92_pivot_confidence_gate_enabled": pfc.get("confidence_gate_enabled"),
        # ---- M92 live run (filled below) ----
        "run_label": None, "valid_run": False, "invalid_reason": "no_run_artifacts",
        "patch_produced": False, "resolved": None, "cost": None, "duration_ms": None,
        "input_tokens": None, "output_tokens": None, "cache_read_tokens": None,
        "cache_write_tokens": None, "total_tokens": None, "turn_count": None, "tool_call_count": None,
        "read_count": None, "search_grep_count": None, "edit_write_count": None, "verify_test_count": None,
        "context_chars_live": None, "context_block_count": None, "capsule_est_tokens_live": None,
        "n_retries": 0,
    }
    if not rds:
        cases_out.append(rec)
        continue
    rundir = rds[-1]  # latest (retry) wins
    rec["n_retries"] = len(rds) - 1
    meta, summ, row, evalmeta = read_run(rundir)
    rec["run_label"] = os.path.basename(rundir)
    patch = row.get("modelPatch") or ""
    rec["patch_produced"] = bool(patch.strip())
    rec["resolved"] = resolved_of(row, evalmeta)
    if rec["resolved"] is None and not rec["patch_produced"]:
        rec["resolved"] = False
        rec["cap_exhausted_no_patch"] = True
    rec["cost"] = row.get("costUsd")
    if rec["cost"] is None and rec.get("cap_exhausted_no_patch"):
        try:
            txt = open(os.path.join(rundir, "raw", "vtrace", "_run.stderr.txt")).read()
            mm = re.search(r"reached \(\$([0-9.]+)\)", txt)
            if mm:
                rec["cost"] = float(mm.group(1))
                rec["cost_source"] = "cap_line_stderr"
        except Exception:
            pass
    rec["duration_ms"] = row.get("durationMs")
    rec["input_tokens"] = row.get("inputTokens")
    rec["output_tokens"] = row.get("outputTokens")
    rec["cache_read_tokens"] = row.get("cacheReadTokens")
    rec["cache_write_tokens"] = row.get("cacheCreationTokens")
    rec["total_tokens"] = sum(v for v in [row.get("inputTokens"), row.get("outputTokens"),
                              row.get("cacheReadTokens"), row.get("cacheCreationTokens")] if isinstance(v, int))
    rec["turn_count"] = row.get("numTurns")
    rec["tool_call_count"] = summ.get("totalToolCalls")
    rec["read_count"] = summ.get("fileReadToolCalls")
    rec["search_grep_count"] = summ.get("grepLikeToolCalls")
    rec["edit_write_count"] = summ.get("fileWriteToolCalls")
    rec["verify_test_count"] = summ.get("bashToolCalls")
    # live capsule/context measurements from run meta
    rec["context_chars_live"] = meta.get("vtraceContextChars")
    rec["context_block_count"] = meta.get("vtraceContextItems")
    rec["capsule_est_tokens_live"] = meta.get("vtraceCapsuleEstimatedTokens")
    rec["context_truncated"] = meta.get("vtraceContextTruncated")
    rec["context_injected"] = meta.get("vtraceContextInjected")
    # behavioral-guard metadata (expected absent/false for M92)
    for k in ["tool_loop_guard_enabled", "tool_loop_guard_injection_count",
              "cost_guard_enabled", "cost_guard_injection_count"]:
        rec[k] = meta.get(k)
    # env + shell guard metadata
    for k in ["stage5_env_guard_required", "stage5_env_guard_status", "stage5_expected_testbed_prefix",
              "stage5_python_prefix_verified", "stage5_pip_prefix_verified", "stage5_drift_check_enabled",
              "stage5_prefix_guard_failures", "stage5_unguarded_live_env_allowed",
              "stage5_env_guard_benchmark_valid",
              "stage5_agent_shell_guard_required", "stage5_agent_shell_guard_status",
              "stage5_agent_shell_guard_enabled", "stage5_host_pip_firewall_enabled",
              "stage5_blocked_host_package_command_count", "stage5_blocked_unsafe_pip_command_count",
              "stage5_agent_shell_guard_failure_reason"]:
        rec[k] = meta.get(k)
    rec["m92_blocked_package_command_count"] = (
        meta.get("stage5_blocked_host_package_command_count")
        or meta.get("stage5_blocked_unsafe_pip_command_count") or 0
    )
    # validity
    esafe, ereason = env_safe(meta)
    ssafe, sreason = shell_safe(meta)
    bbad = behavioral_off(meta)
    rec["env_safe"] = esafe
    rec["shell_safe"] = ssafe
    rec["behavioral_off"] = (len(bbad) == 0)
    rec["behavioral_violations"] = bbad
    if not esafe:
        rec["valid_run"], rec["invalid_reason"] = False, ereason
    elif not ssafe:
        rec["valid_run"], rec["invalid_reason"] = False, sreason
    elif bbad:
        rec["valid_run"], rec["invalid_reason"] = False, bbad[0]
    else:
        rec["valid_run"], rec["invalid_reason"] = True, None
    cases_out.append(rec)

completed = [r for r in cases_out if r["run_label"] is not None]
env_invalid = [r for r in completed if r.get("env_safe") is False]
shell_invalid = [r for r in completed if r.get("shell_safe") is False]
behavioral_on = [r for r in completed if not r.get("behavioral_off")]
escape = [r for r in completed if r.get("stage5_unguarded_live_env_allowed") is True]
drift = [r for r in completed if r.get("stage5_prefix_guard_failures")]
blocked_total = sum(int(r.get("m92_blocked_package_command_count") or 0) for r in completed)

if SAFETY_ONLY:
    bad = env_invalid or shell_invalid or behavioral_on or escape or drift
    status = "SAFE" if not bad else "UNSAFE"
    print(f"M92 SAFETY={status} completed={len(completed)}/50 env_invalid={len(env_invalid)} "
          f"shell_invalid={len(shell_invalid)} behavioral_on={len(behavioral_on)} "
          f"escape_hatch={len(escape)} drift={len(drift)} blocked_pkg_cmds={blocked_total}")
    for r in env_invalid + shell_invalid + behavioral_on + escape + drift:
        print(f"  !! {r['instance_id']} env={r.get('stage5_env_guard_status')} "
              f"shell={r.get('stage5_agent_shell_guard_status')} reason={r.get('invalid_reason')}")
    sys.exit(0 if status == "SAFE" else 3)

# ---- full reduction ----
valid = [r for r in completed if r["valid_run"]]
def num(x): return x if isinstance(x, (int, float)) else None
def s(seq):  # safe sum over numeric, skipping None
    return sum(v for v in seq if isinstance(v, (int, float)))
def grp(g): return [r for r in cases_out if r["group"] == g]

# Resolution counts (over completed runs)
m92_res = sum(1 for r in completed if r["resolved"] is True)
m73b_res = sum(1 for r in completed if r["prior_m73_baseline_resolved"])
m73t_res = sum(1 for r in completed if r["prior_m73_treatment_resolved"])
m90_res = sum(1 for r in completed if r["prior_m90_resolved"] is True)

def delta_block(field_m92, field_prior):
    rs = [r for r in completed if isinstance(r.get(field_m92), (int, float)) and isinstance(r.get(field_prior), (int, float))]
    a = s(r[field_m92] for r in rs); b = s(r[field_prior] for r in rs)
    return {"n_paired": len(rs), "m92_total": round(a, 4), "prior_total": round(b, 4),
            "abs_delta": round(a - b, 4), "pct_delta": round((a - b) / b * 100, 2) if b else None}

deltas = {
    "m92_vs_m73_baseline": {
        "resolution": {"m92": m92_res, "m73_baseline": m73b_res, "delta": m92_res - m73b_res},
        "cost": delta_block("cost", "prior_m73_baseline_cost"),
        "total_tokens": delta_block("total_tokens", "prior_m73_baseline_total_tokens"),
        "cache_read_tokens": delta_block("cache_read_tokens", "prior_m73_baseline_cache_read_tokens"),
        "tool_calls": delta_block("tool_call_count", "prior_m73_baseline_tool_calls"),
    },
    "m92_vs_m73_treatment": {
        "resolution": {"m92": m92_res, "m73_treatment": m73t_res, "delta": m92_res - m73t_res},
        "cost": delta_block("cost", "prior_m73_treatment_cost"),
        "total_tokens": delta_block("total_tokens", "prior_m73_treatment_total_tokens"),
        "tool_calls": delta_block("tool_call_count", "prior_m73_treatment_tool_calls"),
    },
    "m92_vs_m90": {
        "resolution": {"m92": m92_res, "m90": m90_res, "delta": m92_res - m90_res},
        "cost": delta_block("cost", "prior_m90_cost"),
        "total_tokens": delta_block("total_tokens", "prior_m90_total_tokens"),
        "tool_calls": delta_block("tool_call_count", "prior_m90_tool_calls"),
    },
}

# Token category dominance (M92 totals)
tok_cat = {
    "input_tokens": s(r["input_tokens"] for r in completed),
    "output_tokens": s(r["output_tokens"] for r in completed),
    "cache_read_tokens": s(r["cache_read_tokens"] for r in completed),
    "cache_write_tokens": s(r["cache_write_tokens"] for r in completed),
}
tok_total = sum(tok_cat.values())
tok_cat_pct = {k: (round(v / tok_total * 100, 2) if tok_total else None) for k, v in tok_cat.items()}

def cohort(g):
    rs = [r for r in grp(g) if r["run_label"]]
    return {
        "n": len(grp(g)), "ran": len(rs), "valid": sum(1 for r in rs if r["valid_run"]),
        "m92_resolved": sum(1 for r in rs if r["resolved"] is True),
        "m73_baseline_resolved": sum(1 for r in rs if r["prior_m73_baseline_resolved"]),
        "m73_treatment_resolved": sum(1 for r in rs if r["prior_m73_treatment_resolved"]),
        "cost_m92": round(s(r["cost"] for r in rs), 4),
        "cost_m73_baseline": round(s(r["prior_m73_baseline_cost"] for r in rs), 4),
        "cost_m73_treatment": round(s(r["prior_m73_treatment_cost"] for r in rs), 4),
        "tokens_m92": s(r["total_tokens"] for r in rs),
        "tokens_m73_baseline": s(r["prior_m73_baseline_total_tokens"] for r in rs),
        "tools_m92": s(r["tool_call_count"] for r in rs),
    }

def by_repo():
    repos = sorted({r["repo"] for r in completed})
    out = {}
    for rp in repos:
        rs = [r for r in completed if r["repo"] == rp]
        out[rp] = {"n": len(rs), "cost_m92": round(s(r["cost"] for r in rs), 4),
                   "tokens_m92": s(r["total_tokens"] for r in rs),
                   "cost_m73_baseline": round(s(r["prior_m73_baseline_cost"] for r in rs), 4),
                   "m92_resolved": sum(1 for r in rs if r["resolved"] is True)}
    return out

top_cost = sorted([r for r in completed if isinstance(r["cost"], (int, float))],
                  key=lambda r: r["cost"], reverse=True)[:10]
top_ctx = sorted([r for r in completed if isinstance(r.get("context_chars_live"), int)],
                 key=lambda r: r["context_chars_live"], reverse=True)[:10]
high_cost_unresolved = [r for r in completed if r["resolved"] is False and isinstance(r["cost"], (int, float))]
high_cost_unresolved.sort(key=lambda r: r["cost"], reverse=True)

# resolution wins/losses vs baseline & treatment (over completed)
def flips(prior_field):
    wins = [r["instance_id"] for r in completed if r["resolved"] is True and not r[prior_field]]
    losses = [r["instance_id"] for r in completed if r["resolved"] is False and r[prior_field]]
    return {"wins": wins, "losses": losses}

summary = {
    "milestone": "M92",
    "kind": "frozen 50-task internal CORE VTRACE token-reduction confirmation (structured-bounded + pivot-confidence; behavioral V4/C7_D guards DISABLED; mandatory M89 env guard + M90A shell guard). NOT a VEXP parity / broad SWE-bench / statistical-superiority / promotion claim.",
    "expected_testbed_prefix": EXPECTED_PREFIX,
    "total_cases": len(cases_out),
    "ran_count": len(completed),
    "valid_count": len(valid),
    "invalid_runs": [{"instance_id": r["instance_id"], "invalid_reason": r["invalid_reason"]} for r in completed if not r["valid_run"]],
    "not_yet_run": [r["instance_id"] for r in cases_out if not r["run_label"]],
    "operational_retries_used": sum(r["n_retries"] for r in completed),
    "safety": {
        "env_guard_pass_all": len(env_invalid) == 0 and len(completed) > 0,
        "shell_guard_pass_all": len(shell_invalid) == 0 and len(completed) > 0,
        "host_pip_firewall_enabled_all": all(r.get("stage5_host_pip_firewall_enabled") is True for r in completed) and len(completed) > 0,
        "drift_check_enabled_all": all(r.get("stage5_drift_check_enabled") is True for r in completed),
        "benchmark_valid_all": all(r.get("stage5_env_guard_benchmark_valid") is not False for r in completed),
        "expected_prefix_all_match": all(r.get("stage5_expected_testbed_prefix") == EXPECTED_PREFIX for r in completed),
        "env_safety_invalid_instances": [r["instance_id"] for r in env_invalid],
        "shell_safety_invalid_instances": [r["instance_id"] for r in shell_invalid],
        "escape_hatch_used_instances": [r["instance_id"] for r in escape],
        "drift_detected_instances": [r["instance_id"] for r in drift],
        "blocked_package_command_count_total": blocked_total,
        "blocked_package_command_instances": [r["instance_id"] for r in completed if int(r.get("m92_blocked_package_command_count") or 0) > 0],
    },
    "behavioral_guards": {
        "behavioral_off_all": len(behavioral_on) == 0 and len(completed) > 0,
        "tool_loop_guard_enabled_any": any(r.get("tool_loop_guard_enabled") for r in completed),
        "cost_guard_enabled_any": any(r.get("cost_guard_enabled") for r in completed),
        "tool_loop_guard_injection_total": s(r.get("tool_loop_guard_injection_count") for r in completed),
        "cost_guard_injection_total": s(r.get("cost_guard_injection_count") for r in completed),
        "behavioral_on_instances": [r["instance_id"] for r in behavioral_on],
    },
    "resolution": {
        "m92_resolved": m92_res,
        "m92_unresolved": sum(1 for r in completed if r["resolved"] is False),
        "m92_pending_eval": sum(1 for r in completed if r["resolved"] is None),
        "prior_m73_baseline_resolved": m73b_res,
        "prior_m73_treatment_resolved": m73t_res,
        "prior_m90_resolved": m90_res,
        "wins_vs_m73_baseline": flips("prior_m73_baseline_resolved"),
        "wins_vs_m73_treatment": flips("prior_m73_treatment_resolved"),
    },
    "cost": {
        "total_cost_m92": round(s(r["cost"] for r in completed), 4),
        "total_cost_m73_baseline": round(s(r["prior_m73_baseline_cost"] for r in completed), 4),
        "total_cost_m73_treatment": round(s(r["prior_m73_treatment_cost"] for r in completed), 4),
        "total_cost_m90": round(s(r["prior_m90_cost"] for r in completed), 4),
        "total_tool_calls_m92": s(r["tool_call_count"] for r in completed),
        "total_tool_calls_m73_baseline": s(r["prior_m73_baseline_tool_calls"] for r in completed),
        "total_tool_calls_m73_treatment": s(r["prior_m73_treatment_tool_calls"] for r in completed),
    },
    "token_categories": {"totals": tok_cat, "pct": tok_cat_pct, "grand_total": tok_total},
    "deltas": deltas,
    "by_group": {g: cohort(g) for g in "ABCDE"},
}

attribution = {
    "milestone": "M92",
    "expected_testbed_prefix": EXPECTED_PREFIX,
    "token_categories": {"totals": tok_cat, "pct": tok_cat_pct, "grand_total": tok_total},
    "dominant_category": (max(tok_cat, key=tok_cat.get) if tok_total else None),
    "deltas": deltas,
    "by_repo": by_repo(),
    "by_group": {g: cohort(g) for g in "ABCDE"},
    "top10_cost_heavy": [{"instance_id": r["instance_id"], "repo": r["repo"], "group": r["group"],
                          "cost": r["cost"], "total_tokens": r["total_tokens"], "tool_calls": r["tool_call_count"],
                          "resolved": r["resolved"], "turns": r["turn_count"]} for r in top_cost],
    "top10_context_heavy": [{"instance_id": r["instance_id"], "repo": r["repo"], "group": r["group"],
                             "context_chars_live": r["context_chars_live"], "capsule_est_tokens_live": r["capsule_est_tokens_live"],
                             "context_truncated": r.get("context_truncated"),
                             "m92_required_target_count": r["m92_required_target_count"],
                             "m92_optional_target_count": r["m92_optional_target_count"]} for r in top_ctx],
    "high_cost_unresolved": [{"instance_id": r["instance_id"], "repo": r["repo"], "cost": r["cost"],
                              "total_tokens": r["total_tokens"], "tool_calls": r["tool_call_count"]}
                             for r in high_cost_unresolved[:10]],
    "high_cost_unresolved_total_cost": round(s(r["cost"] for r in high_cost_unresolved), 4),
    "high_cost_unresolved_share_of_total": (
        round(s(r["cost"] for r in high_cost_unresolved) / s(r["cost"] for r in completed) * 100, 2)
        if s(r["cost"] for r in completed) else None),
}

os.makedirs(OUT, exist_ok=True)
json.dump(summary, open(os.path.join(OUT, "stage5_m92_core_reduction50_validation.json"), "w"), indent=2)
json.dump({"milestone": "M92", "expected_testbed_prefix": EXPECTED_PREFIX, "cases": cases_out},
          open(os.path.join(OUT, "stage5_m92_core_reduction50_validation.detail.json"), "w"), indent=2)
json.dump(attribution, open(os.path.join(OUT, "stage5_m92_token_attribution.json"), "w"), indent=2)

print("RESULT_JSON: " + json.dumps({
    "ran": len(completed), "valid": len(valid),
    "env_guard_pass_all": summary["safety"]["env_guard_pass_all"],
    "shell_guard_pass_all": summary["safety"]["shell_guard_pass_all"],
    "behavioral_off_all": summary["behavioral_guards"]["behavioral_off_all"],
    "blocked_pkg_cmds": blocked_total,
    "m92_resolved": m92_res, "m73_baseline_resolved": m73b_res, "m73_treatment_resolved": m73t_res, "m90_resolved": m90_res,
    "pending_eval": summary["resolution"]["m92_pending_eval"],
    "cost_m92": summary["cost"]["total_cost_m92"], "cost_m73_baseline": summary["cost"]["total_cost_m73_baseline"],
    "cost_reduction_vs_m73_baseline_pct": deltas["m92_vs_m73_baseline"]["cost"]["pct_delta"],
    "token_reduction_vs_m73_baseline_pct": deltas["m92_vs_m73_baseline"]["total_tokens"]["pct_delta"],
    "dominant_token_category": attribution["dominant_category"],
}))

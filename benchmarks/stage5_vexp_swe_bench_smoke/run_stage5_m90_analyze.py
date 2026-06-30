#!/usr/bin/env python3
"""M90 — offline analyzer for the frozen 50-task guarded-confirmation sweep.

Reads ONLY captured run artifacts (no live agents, no Docker, no API spend) plus the prior
M73/M74/M88/M85 metadata, recomputes per-run M90 validity (treatment + V4 + C7_D + mandatory
M89 env guard), and emits the compact validation JSON + per-case detail JSON used by the report.

  python3 run_stage5_m90_analyze.py [--out DIR] [--safety-only]

--safety-only: print a one-line SAFETY verdict over completed runs and exit non-zero if ANY
completed run is env-guard safety-invalid (the M90 hard-stop condition). Used as a live monitor.

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

def safe(inst):
    return re.sub(r"[^a-zA-Z0-9]", "_", inst) + "_"  # driver's safe() adds trailing _ (echo newline)

def load(p, fb=None):
    try:
        return json.load(open(p))
    except Exception:
        return fb

split = load(os.path.join(RESULTS, "stage5_m90_v4_c7d_envguard50_split.json"))
m73 = {r["instance_id"]: r for r in (load(os.path.join(RESULTS, "stage5_m73_final_100_paired.detail.json")) or [])}
m74 = {c["instance_id"]: c for c in (load(os.path.join(RESULTS, "stage5_m74_self_harness_lite_audit.json"), {}) or {}).get("per_task_classification", [])}
m88raw = load(os.path.join(RESULTS, "stage5_m88_v4_c7d_envguard_validation.detail.json"), {}) or {}
m88 = {c["instance_id"]: c for c in m88raw.get("cases", [])}
m88carry = (load(os.path.join(RESULTS, "stage5_m88_v4_c7d_envguard_validation.json"), {}) or {}).get("carryover", {})

def run_dirs_for(inst):
    base = "m90_v4_c7d_envguard50_" + safe(inst)
    labels = [base] + [base[:-1] + "_retry%d_" % i for i in range(1, 11)]
    # the driver builds retry labels as base + '_retry%d' then safe() re-adds trailing _; tolerate both
    out = []
    for d in sorted(glob.glob(os.path.join(RESULTS, "runs", "m90_v4_c7d_envguard50_*"))):
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

ENV_KEYS = ["stage5_env_guard_required", "stage5_env_guard_enabled", "stage5_env_guard_status",
            "stage5_expected_testbed_prefix", "stage5_python_prefix_verified", "stage5_pip_prefix_verified",
            "stage5_drift_check_enabled", "stage5_prefix_drift_summary", "stage5_prefix_guard_failures",
            "stage5_unguarded_live_env_allowed", "stage5_env_guard_benchmark_valid"]

def env_safe(meta):
    """Return (ok, failure_reason). Mirrors the M90 hard-stop conditions."""
    if meta.get("stage5_env_guard_status") != "pass":
        return False, "m90_env_guard_not_pass"
    if meta.get("stage5_python_prefix_verified") is not True:
        return False, "m90_python_prefix_not_verified"
    if meta.get("stage5_pip_prefix_verified") is not True:
        return False, "m90_pip_prefix_not_verified"
    if meta.get("stage5_expected_testbed_prefix") != EXPECTED_PREFIX:
        return False, "m90_expected_prefix_mismatch"
    if "stage5_prefix_drift_summary" not in meta:
        return False, "m90_drift_summary_missing"
    if meta.get("stage5_prefix_guard_failures"):
        return False, "m90_prefix_guard_failures_nonempty"
    if meta.get("stage5_unguarded_live_env_allowed") is True:
        return False, "m90_unguarded_escape_hatch_used"
    if meta.get("stage5_env_guard_required") is not True:
        return False, "m90_env_guard_not_required"
    if meta.get("stage5_drift_check_enabled") is not True:
        return False, "m90_drift_check_missing"
    if meta.get("stage5_env_guard_benchmark_valid") is False:
        return False, "m90_benchmark_not_valid"
    return True, None

def guard_valid(meta):
    reasons = []
    if not meta.get("tool_loop_guard_enabled"): reasons.append("m90_tool_loop_guard_not_enabled")
    if meta.get("tool_loop_guard_mode") not in ("runtime_injection", "inject"): reasons.append("m90_tool_loop_guard_not_runtime")
    if meta.get("tool_loop_guard_calibration") != "v4": reasons.append("m90_tool_loop_guard_not_v4")
    if not meta.get("cost_guard_enabled"): reasons.append("m90_cost_guard_not_enabled")
    if meta.get("cost_guard_mode") not in ("runtime_injection", "inject"): reasons.append("m90_cost_guard_not_runtime")
    if meta.get("cost_guard_calibration") != "c7d": reasons.append("m90_cost_guard_not_c7d")
    return reasons

cases_out = []
for c in split["cases"]:
    inst = c["instance_id"]
    rds = run_dirs_for(inst)
    rec = {
        "instance_id": inst, "repo": c["repo"], "group": c["group"],
        "selection_reason": c["selection_reason"],
        "prior_m73_baseline_resolved": c["prior_m73_baseline_resolved"],
        "prior_m73_treatment_resolved": c["prior_m73_treatment_resolved"],
        "prior_m73_treatment_cost": c["prior_m73_treatment_cost"],
        "prior_m73_treatment_tool_calls": c["prior_m73_treatment_tool_calls"],
        "prior_m88_resolved": c.get("prior_m88_resolved"),
        "prior_m88_cost": c.get("prior_m88_cost"),
        "prior_m85_status": c.get("prior_m85_status"),
        "prior_failure_cluster": c.get("prior_m74_failure_cluster"),
        "prior_guard_behavior": c.get("expected_guard_behavior"),
        "run_label": None, "valid_run": False, "invalid_reason": "no_run_artifacts",
        "patch_produced": False, "resolved": None, "cost": None, "duration_ms": None,
        "input_tokens_total": None, "output_tokens_total": None, "cache_read_tokens_total": None,
        "cache_write_tokens_total": None, "total_tokens": None, "turn_count": None, "tool_call_count": None,
        "read_count": None, "search_grep_count": None, "edit_write_count": None, "verify_test_count": None,
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
    # A completed run that produced no patch (e.g. cost-cap exhaustion before a final patch row)
    # cannot resolve any FAIL_TO_PASS — score it resolved=False, not pending-eval.
    if rec["resolved"] is None and not rec["patch_produced"]:
        rec["resolved"] = False
        rec["cap_exhausted_no_patch"] = True
    rec["cost"] = row.get("costUsd")
    # Cap-exhausted run with no final result row: recover actual spend from the cap line in
    # _run.stderr.txt so the M90<->M73 cost comparison stays fair (M73 counts this case's spend too).
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
    rec["input_tokens_total"] = row.get("inputTokens")
    rec["output_tokens_total"] = row.get("outputTokens")
    rec["cache_read_tokens_total"] = row.get("cacheReadTokens")
    rec["cache_write_tokens_total"] = row.get("cacheCreationTokens")
    rec["total_tokens"] = sum(v for v in [row.get("inputTokens"), row.get("outputTokens"),
                              row.get("cacheReadTokens"), row.get("cacheCreationTokens")] if isinstance(v, int))
    rec["turn_count"] = row.get("numTurns")
    rec["tool_call_count"] = summ.get("totalToolCalls")
    rec["read_count"] = summ.get("fileReadToolCalls")
    rec["search_grep_count"] = summ.get("grepLikeToolCalls")
    rec["edit_write_count"] = summ.get("fileWriteToolCalls")
    rec["verify_test_count"] = summ.get("bashToolCalls")
    # guard metadata
    for k in ["tool_loop_guard_enabled", "tool_loop_guard_mode", "tool_loop_guard_calibration",
              "tool_loop_guard_injection_count", "tool_loop_guard_suppressed_count", "tool_loop_guard_first_event_turn",
              "cost_guard_enabled", "cost_guard_mode", "cost_guard_calibration", "cost_guard_injection_count",
              "cost_guard_first_event_turn", "cost_guard_last_event_turn", "cost_guard_config"]:
        rec[k] = meta.get(k)
    rec["tool_loop_guard_trigger_types"] = sorted({e.get("trigger_type") for e in (meta.get("tool_loop_guard_events") or []) if isinstance(e, dict)} - {None})
    rec["cost_guard_trigger_types"] = sorted({e.get("trigger_type") for e in (meta.get("cost_guard_events") or []) if isinstance(e, dict)} - {None})
    rec["tool_loop_guard_first_event_turn"] = meta.get("tool_loop_guard_first_event_turn")
    # combined hook
    rec["combined_guard_message_count"] = (meta.get("tool_loop_guard_injection_count") or 0) + (meta.get("cost_guard_injection_count") or 0)
    rec["combined_guard_same_turn_count"] = meta.get("combined_guard_same_turn_count", 0)
    rec["cost_guard_coexists_with_tool_loop_guard"] = meta.get("cost_guard_coexists_with_tool_loop_guard")
    # env fields
    for k in ENV_KEYS:
        rec[k] = meta.get(k)
    # validity
    esafe, ereason = env_safe(meta)
    greasons = guard_valid(meta)
    if not esafe:
        rec["valid_run"], rec["invalid_reason"] = False, ereason
    elif greasons:
        rec["valid_run"], rec["invalid_reason"] = False, greasons[0]
    elif not rec["patch_produced"]:
        # a guarded run that produced no patch is still a valid guarded *outcome* (resolved=False);
        # only mark invalid if the row is entirely absent (handled above).
        rec["valid_run"], rec["invalid_reason"] = True, None
    else:
        rec["valid_run"], rec["invalid_reason"] = True, None
    rec["env_safe"] = esafe
    rec["guard_invalid_reasons"] = greasons
    cases_out.append(rec)

completed = [r for r in cases_out if r["run_label"] is not None]
safety_invalid = [r for r in completed if r.get("env_safe") is False]

if SAFETY_ONLY:
    escape = [r for r in completed if r.get("stage5_unguarded_live_env_allowed") is True]
    drift = [r for r in completed if r.get("stage5_prefix_guard_failures")]
    status = "SAFE" if not safety_invalid and not escape and not drift else "UNSAFE"
    print(f"M90 SAFETY={status} completed={len(completed)}/50 env_invalid={len(safety_invalid)} "
          f"escape_hatch={len(escape)} drift={len(drift)}")
    for r in safety_invalid + escape + drift:
        print(f"  !! {r['instance_id']} status={r.get('stage5_env_guard_status')} reason={r.get('invalid_reason')}")
    sys.exit(0 if status == "SAFE" else 3)

# ---- full reduction ----
valid = [r for r in completed if r["valid_run"]]
def grp(g): return [r for r in cases_out if r["group"] == g]

def cohort(g):
    rs = [r for r in grp(g) if r["run_label"]]
    res = sum(1 for r in rs if r["resolved"] is True)
    v4 = sum(1 for r in rs if (r.get("tool_loop_guard_injection_count") or 0) > 0)
    c7 = sum(1 for r in rs if (r.get("cost_guard_injection_count") or 0) > 0)
    cost = sum(r["cost"] for r in rs if isinstance(r["cost"], (int, float)))
    tools = sum(r["tool_call_count"] for r in rs if isinstance(r["tool_call_count"], int))
    m73cost = sum(r["prior_m73_treatment_cost"] for r in rs if isinstance(r["prior_m73_treatment_cost"], (int, float)))
    m73tools = sum(r["prior_m73_treatment_tool_calls"] for r in rs if isinstance(r["prior_m73_treatment_tool_calls"], int))
    m73res = sum(1 for r in rs if r["prior_m73_treatment_resolved"])
    return {"n": len(grp(g)), "ran": len(rs), "valid": sum(1 for r in rs if r["valid_run"]),
            "resolved": res, "v4_fired": v4, "c7_fired": c7,
            "cost_m90": round(cost, 4), "cost_m73": round(m73cost, 4),
            "tools_m90": tools, "tools_m73": m73tools, "m73_treatment_resolved": m73res}

v4_fired = [r for r in completed if (r.get("tool_loop_guard_injection_count") or 0) > 0]
c7_fired = [r for r in completed if (r.get("cost_guard_injection_count") or 0) > 0]
escape = [r for r in completed if r.get("stage5_unguarded_live_env_allowed") is True]
drift = [r for r in completed if r.get("stage5_prefix_guard_failures")]

summary = {
    "milestone": "M90",
    "kind": "frozen 50-task internal guarded confirmation (V4 tool-loop + C7_D cost + mandatory M89 env guard); NOT a VEXP parity / broad SWE-bench / statistical-superiority / promotion claim",
    "expected_testbed_prefix": EXPECTED_PREFIX,
    "total_cases": len(cases_out),
    "ran_count": len(completed),
    "valid_count": len(valid),
    "invalid_runs": [{"instance_id": r["instance_id"], "invalid_reason": r["invalid_reason"]} for r in completed if not r["valid_run"]],
    "not_yet_run": [r["instance_id"] for r in cases_out if not r["run_label"]],
    "env_safety": {
        "env_guard_pass_all": len(safety_invalid) == 0 and len(completed) > 0,
        "safety_invalid_instances": [r["instance_id"] for r in safety_invalid],
        "escape_hatch_used_instances": [r["instance_id"] for r in escape],
        "drift_detected_instances": [r["instance_id"] for r in drift],
        "expected_prefix_all_match": all(r.get("stage5_expected_testbed_prefix") == EXPECTED_PREFIX for r in completed),
        "python_prefix_verified_all": all(r.get("stage5_python_prefix_verified") is True for r in completed),
        "pip_prefix_verified_all": all(r.get("stage5_pip_prefix_verified") is True for r in completed),
        "drift_check_enabled_all": all(r.get("stage5_drift_check_enabled") is True for r in completed),
        "benchmark_valid_all": all(r.get("stage5_env_guard_benchmark_valid") is not False for r in completed),
    },
    "guards": {
        "tool_loop_guard_v4_all": all(r.get("tool_loop_guard_calibration") == "v4" for r in completed),
        "tool_loop_guard_runtime_all": all(r.get("tool_loop_guard_mode") in ("runtime_injection", "inject") for r in completed),
        "cost_guard_c7d_all": all(r.get("cost_guard_calibration") == "c7d" for r in completed),
        "cost_guard_runtime_all": all(r.get("cost_guard_mode") in ("runtime_injection", "inject") for r in completed),
        "v4_fired_count": len(v4_fired),
        "v4_fired_instances": [r["instance_id"] for r in v4_fired],
        "v4_suppressed_total": sum(r.get("tool_loop_guard_suppressed_count") or 0 for r in completed),
        "v4_trigger_types_union": sorted({t for r in v4_fired for t in (r.get("tool_loop_guard_trigger_types") or [])}),
        "c7_fired_count": len(c7_fired),
        "c7_fired_instances": [r["instance_id"] for r in c7_fired],
        "c7_trigger_types_union": sorted({t for r in c7_fired for t in (r.get("cost_guard_trigger_types") or [])}),
        "c7_fired_first_turns": {r["instance_id"]: r.get("cost_guard_first_event_turn") for r in c7_fired},
        "combined_same_turn_total": sum(r.get("combined_guard_same_turn_count") or 0 for r in completed),
        "v4_fired_on_control_or_protected": [r["instance_id"] for r in v4_fired if r["group"] in ("B", "D")],
        "c7_fired_on_control_or_protected": [r["instance_id"] for r in c7_fired if r["group"] in ("B", "D")],
    },
    "resolution": {
        "m90_resolved": sum(1 for r in completed if r["resolved"] is True),
        "m90_unresolved": sum(1 for r in completed if r["resolved"] is False),
        "m90_pending_eval": sum(1 for r in completed if r["resolved"] is None),
        "prior_m73_treatment_resolved": sum(1 for r in completed if r["prior_m73_treatment_resolved"]),
        "prior_m73_baseline_resolved": sum(1 for r in completed if r["prior_m73_baseline_resolved"]),
    },
    "cost": {
        "total_cost_m90": round(sum(r["cost"] for r in completed if isinstance(r["cost"], (int, float))), 4),
        "total_cost_m73_treatment": round(sum(r["prior_m73_treatment_cost"] for r in completed if isinstance(r["prior_m73_treatment_cost"], (int, float))), 4),
        "total_tool_calls_m90": sum(r["tool_call_count"] for r in completed if isinstance(r["tool_call_count"], int)),
        "total_tool_calls_m73_treatment": sum(r["prior_m73_treatment_tool_calls"] for r in completed if isinstance(r["prior_m73_treatment_tool_calls"], int)),
    },
    "by_group": {g: cohort(g) for g in "ABCDE"},
    "carryover": {r["instance_id"]: {
        "group": r["group"], "m73_baseline": r["prior_m73_baseline_resolved"], "m73_treatment": r["prior_m73_treatment_resolved"],
        "m88_resolved": r.get("prior_m88_resolved"), "m85_status": r.get("prior_m85_status"),
        "m90_resolved": r["resolved"], "m90_cost": r["cost"], "m90_tool_calls": r["tool_call_count"],
        "m90_v4_fired": (r.get("tool_loop_guard_injection_count") or 0) > 0,
        "m90_c7_fired": (r.get("cost_guard_injection_count") or 0) > 0,
        "m90_c7_first_turn": r.get("cost_guard_first_event_turn"),
        "valid": r["valid_run"], "invalid_reason": r["invalid_reason"],
    } for r in cases_out if r["group"] == "E"},
}

os.makedirs(OUT, exist_ok=True)
json.dump(summary, open(os.path.join(OUT, "stage5_m90_v4_c7d_envguard50_validation.json"), "w"), indent=2)
json.dump({"milestone": "M90", "expected_testbed_prefix": EXPECTED_PREFIX, "cases": cases_out},
          open(os.path.join(OUT, "stage5_m90_v4_c7d_envguard50_validation.detail.json"), "w"), indent=2)

print("RESULT_JSON: " + json.dumps({
    "ran": len(completed), "valid": len(valid),
    "env_guard_pass_all": summary["env_safety"]["env_guard_pass_all"],
    "safety_invalid": summary["env_safety"]["safety_invalid_instances"],
    "escape_hatch": summary["env_safety"]["escape_hatch_used_instances"],
    "v4_fired": len(v4_fired), "c7_fired": len(c7_fired),
    "resolved": summary["resolution"]["m90_resolved"], "pending_eval": summary["resolution"]["m90_pending_eval"],
    "cost_m90": summary["cost"]["total_cost_m90"], "cost_m73": summary["cost"]["total_cost_m73_treatment"],
    "tools_m90": summary["cost"]["total_tool_calls_m90"], "tools_m73": summary["cost"]["total_tool_calls_m73_treatment"],
}))

#!/usr/bin/env python3
"""M59B report generator.

Consumes the per-run metrics JSON produced by `run_stage5_m58b_analyze.ts` (which uses
the current/M59 `classifyDigestDecisionContract`) plus each run's injected snapshot, then:
  - validity-gates every M59 run against the M59 requirements (digest + decision contract
    + real impact + structured grammar + target_id/decision/reason/files_touched + bounded
    three-way choices + required-target cap + compact mode);
  - builds the run matrix, results table, replicate summary, paired outcomes (baseline /
    M57 / recalibrated-M58 vs M59), paired deltas, and the structured-decision analysis.

Report-only. Does NOT mutate raw artifacts. Reads:
  _m59b_logs/metrics.json  (analyzer output)
Writes:
  results/stage5_m59b_structured_bounded_decision_live_validation.md
  results/stage5_m59b_structured_bounded_decision_live_validation.json
"""
import json
import os
import re
import statistics
import sys

RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNS = os.path.join(RESULTS, "runs")
METRICS = os.path.join(RESULTS, "_m59b_logs", "metrics.json")

DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>"
DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>"
CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>"
CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>"

CASES = [
    ("sphinx-doc__sphinx-7462", "sphinx_7462"),
    ("django__django-11820", "django_11820"),
    ("django__django-13195", "django_13195"),
]


def snapshot_path(label):
    return os.path.join(RUNS, label, "_vtrace_instructions.snapshot.md")


def read_text(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def m59_validity(label):
    """Gate an M59 run on its REAL injected snapshot. Returns (valid, reason)."""
    snap = read_text(snapshot_path(label))
    if snap == "":
        return False, "m59_snapshot_missing"
    if snap.count(DIGEST_START) != 1 or snap.count(DIGEST_END) != 1:
        return False, "m59_digest_not_present"
    if snap.count(CONTRACT_START) != 1 or snap.count(CONTRACT_END) != 1:
        return False, "m59_decision_contract_not_present"
    digest = snap[snap.find(DIGEST_START):snap.find(DIGEST_END)]
    if "→ impact" not in digest:
        return False, "m59_impact_not_enriched"
    block = snap[snap.find(CONTRACT_START):snap.find(CONTRACT_END)]
    has_grammar = (
        re.search(r"target_id: T\d+", block)
        and re.search(r"target: (PIVOT|IMPACT) ", block)
        and "decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT" in block
        and re.search(r"\breason: ", block)
        and re.search(r"\bfiles_touched: ", block)
    )
    if not has_grammar:
        return False, "m59_structured_grammar_not_present"
    n_targets = len(re.findall(r"target_id: T\d+", block))
    if n_targets == 0:
        return False, "m59_required_targets_missing"
    if n_targets > 4:
        return False, "m59_required_target_cap_exceeded"
    if "## VTRACE inspect-first" in snap:
        return False, "m59_compact_mode_not_applied"
    return True, ""


def num(v, d=0):
    return v if isinstance(v, (int, float)) else d


def main():
    metrics = json.load(open(METRICS))
    by_key = {}  # (instance, condition, replicate) -> row
    for row in metrics:
        inst = row.get("instance_id")
        cond = row.get("condition")
        label = row.get("run_label", "")
        rep = ""
        m = re.search(r"_r(\d)$", label)
        if m:
            rep = "r" + m.group(1)
        # M59 validity gate
        if cond == "m59_structured":
            valid, reason = m59_validity(label)
            row["valid_run"] = valid
            row["invalid_reason"] = reason
            row["structured_grammar_present"] = (reason != "m59_structured_grammar_not_present")
        else:
            row["valid_run"] = True
            row["invalid_reason"] = ""
        row["replicate"] = rep
        by_key[(inst, cond, rep)] = row

    def get(inst, cond, rep=""):
        return by_key.get((inst, cond, rep))

    # ---- aggregation ----
    summary = {
        "milestone": "M59B",
        "cases": [c[0] for c in CASES],
        "new_live_runs": 0,
        "run_cap": 9,
        "valid_m59": 0,
        "invalid_m59": 0,
        "per_case": {},
        "paired": {},
    }

    # per-case M59 replicate summaries
    for inst, _safe in CASES:
        reps = [get(inst, "m59_structured", f"r{r}") for r in (1, 2, 3)]
        reps = [r for r in reps if r is not None]
        summary["new_live_runs"] += len(reps)
        valid = [r for r in reps if r.get("valid_run")]
        summary["valid_m59"] += len(valid)
        summary["invalid_m59"] += len(reps) - len(valid)
        toks = [num(r.get("total_tokens")) for r in valid]
        costs = [num(r.get("cost")) for r in valid]
        tools = [num(r.get("tool_call_count")) for r in valid]
        closed = [num(r.get("required_target_closed_count")) for r in valid]
        openc = [num(r.get("required_target_open_count")) for r in valid]
        ignored = [num(r.get("required_target_ignored_count")) for r in valid]
        passes = sum(1 for r in valid if r.get("resolved"))
        summary["per_case"][inst] = {
            "valid_count": len(valid),
            "pass_count": passes,
            "mean_tokens": round(statistics.mean(toks)) if toks else None,
            "median_tokens": round(statistics.median(toks)) if toks else None,
            "mean_cost": round(statistics.mean(costs), 4) if costs else None,
            "median_cost": round(statistics.median(costs), 4) if costs else None,
            "mean_tool_calls": round(statistics.mean(tools), 1) if tools else None,
            "median_tool_calls": statistics.median(tools) if tools else None,
            "mean_closed": round(statistics.mean(closed), 2) if closed else None,
            "mean_open": round(statistics.mean(openc), 2) if openc else None,
            "ignored_total": sum(ignored),
        }

    # paired outcomes vs comparators (resolution)
    def paired(compcond):
        bp = bf = m59o = compo = 0
        for inst, _ in CASES:
            comp = get(inst, compcond)
            for r in (1, 2, 3):
                d = get(inst, "m59_structured", f"r{r}")
                if d is None or not d.get("valid_run") or comp is None:
                    continue
                a = bool(comp.get("resolved"))
                b = bool(d.get("resolved"))
                if a and b:
                    bp += 1
                elif not a and not b:
                    bf += 1
                elif b and not a:
                    m59o += 1
                elif a and not b:
                    compo += 1
        return {"both_pass": bp, "both_fail": bf, "m59_only_pass": m59o, "comparator_only_pass": compo}

    summary["paired"] = {
        "baseline_vs_m59": paired("baseline"),
        "m57_vs_m59": paired("m57_contract"),
        "m58_vs_m59": paired("m58_bounded"),
    }

    # paired deltas: recalibrated M58 vs M59 (per case use M58 single run vs M59 mean of valid)
    deltas = {"token_pct_per_case": {}, "cost_pct_per_case": {}}
    tok_pcts, cost_pcts = [], []
    for inst, _ in CASES:
        m58 = get(inst, "m58_bounded")
        reps = [get(inst, "m59_structured", f"r{r}") for r in (1, 2, 3)]
        valid = [r for r in reps if r and r.get("valid_run")]
        if not m58 or not valid:
            continue
        m58t = num(m58.get("total_tokens"))
        m59t = statistics.mean([num(r.get("total_tokens")) for r in valid])
        m58c = num(m58.get("cost"))
        m59c = statistics.mean([num(r.get("cost")) for r in valid])
        tp = round((m59t - m58t) / m58t * 100, 1) if m58t else None
        cp = round((m59c - m58c) / m58c * 100, 1) if m58c else None
        deltas["token_pct_per_case"][inst] = tp
        deltas["cost_pct_per_case"][inst] = cp
        if tp is not None:
            tok_pcts.append(tp)
        if cp is not None:
            cost_pcts.append(cp)
    deltas["token_pct_mean"] = round(statistics.mean(tok_pcts), 1) if tok_pcts else None
    deltas["cost_pct_mean"] = round(statistics.mean(cost_pcts), 1) if cost_pcts else None
    summary["deltas_m58_vs_m59"] = deltas

    json.dump(summary, open(os.path.join(RESULTS, "stage5_m59b_structured_bounded_decision_live_validation.json"), "w"), indent=2)

    # also dump the gated rows for the report writer (separate, transient)
    json.dump(
        {(f"{k[0]}|{k[1]}|{k[2]}"): v for k, v in by_key.items()},
        open(os.path.join(RESULTS, "_m59b_logs", "gated_rows.json"), "w"),
        indent=2,
    )
    # Emit data-driven Markdown table fragments for embedding into the report.
    write_md_fragments(get, summary)
    print(json.dumps(summary, indent=2))


def _cell(row, key, fmt=None):
    if row is None:
        return "–"
    v = row.get(key)
    if v is None:
        return "–"
    if fmt == "money":
        return f"{v:.3f}" if isinstance(v, (int, float)) else str(v)
    if fmt == "bool":
        return "✓" if v else "✗"
    return str(v)


def write_md_fragments(get, summary):
    lines = []
    # Run matrix
    lines.append("### Run Matrix\n")
    lines.append("| instance_id | baseline (A) | M57 (B) | M58 (C) | M59 replicates (D) | M59 valid | evaluated |")
    lines.append("|---|---|---|---|---|---|---|")
    for inst, safe in CASES:
        reps = []
        ev = 0
        for r in (1, 2, 3):
            d = get(inst, "m59_structured", f"r{r}")
            if d:
                tag = "r%d%s" % (r, "" if d.get("valid_run") else "✗")
                reps.append(tag)
                if d.get("resolved") is not None:
                    ev += 1
        pc = summary["per_case"].get(inst, {})
        lines.append(
            f"| {inst} | m56c_baseline_{safe} | m57b_…_{safe} | m58b_…_{safe} | "
            f"{', '.join(reps)} | {pc.get('valid_count','?')}/3 | {ev}/3 |"
        )
    # Results table (all conditions)
    lines.append("\n### Results Table\n")
    hdr = ("| instance | condition | rep | valid | resolved | patch | total_tokens | cache_read | cost | "
           "tools | reads | searches | rep_reads | req | closed | open | edit | ruled | inspect_only | ignored | invalid |")
    lines.append(hdr)
    lines.append("|" + "---|" * 21)

    def emit(inst, cond, rep, label):
        r = get(inst, cond, rep)
        if r is None:
            return
        lines.append(
            "| {inst} | {label} | {rep} | {valid} | {res} | {patch} | {tt} | {cr} | {cost} | {tools} | {reads} | "
            "{srch} | {rr} | {req} | {cl} | {op} | {ed} | {ro} | {io} | {ig} | {iv} |".format(
                inst=inst.split("__")[-1], label=label, rep=rep or "–",
                valid=_cell(r, "valid_run", "bool"),
                res=_cell(r, "resolved", "bool"), patch=_cell(r, "patch_produced", "bool"),
                tt=_cell(r, "total_tokens"), cr=_cell(r, "cache_read_tokens_total"),
                cost=_cell(r, "cost", "money"), tools=_cell(r, "tool_call_count"),
                reads=_cell(r, "read_count"), srch=_cell(r, "search_count"),
                rr=_cell(r, "repeated_file_reads"), req=_cell(r, "required_target_count"),
                cl=_cell(r, "required_target_closed_count"), op=_cell(r, "required_target_open_count"),
                ed=_cell(r, "required_target_edited_count"), ro=_cell(r, "required_target_ruled_out_count"),
                io=_cell(r, "required_target_inspect_only_no_edit_count"),
                ig=_cell(r, "required_target_ignored_count"),
                iv=_cell(r, "required_target_invalid_decision_count"),
            )
        )

    for inst, _ in CASES:
        emit(inst, "baseline", "", "baseline")
        emit(inst, "m57_contract", "", "M57")
        emit(inst, "m58_bounded", "", "M58")
        for r in (1, 2, 3):
            emit(inst, "m59_structured", f"r{r}", "**M59**")
    open(os.path.join(RESULTS, "_m59b_logs", "report_fragments.md"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()

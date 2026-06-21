#!/usr/bin/env python3
"""M56C metric extractor for the impact-enriched-digest A+D confirmation.

Reads CAPTURED run artifacts (no live agents, no Docker) for the 3 paired cases and
emits the compact JSON summary the report is built from. Pure read-only over:
  runs/<label>/raw/<cond>/swebench-*.jsonl   -> tokens/cost/turns/resolved/modelPatch
  runs/<label>/raw/<cond>/_tool_calls.json   -> ordered read/search/edit calls + paths
  runs/<label>/raw/<cond>/_tool_calls.summary.json
  runs/<label>/raw/<cond>/_run.meta.json     -> vtrace meta
  runs/<label>/_vtrace_instructions.snapshot.md -> injected digest (pivots + impact)
  <dataset>.jsonl                            -> gold patch files + FAIL_TO_PASS (post-hoc only)
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(ROOT, "results")
RUNS = os.path.join(RESULTS, "runs")
DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"

# instance -> (category, baseline_label, digest_label)
CASES = {
    "sphinx-doc__sphinx-7462": ("A", "m56c_baseline_sphinx_7462", "m56c_vtrace_digest_impact_sphinx_7462"),
    "django__django-11820": ("A", "m56c_baseline_django_11820", "m56c_vtrace_digest_impact_django_11820"),
    "django__django-13195": ("D", "m56c_baseline_django_13195", "m56c_vtrace_digest_impact_django_13195"),
}


def load_jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def gold_files_and_tests():
    out = {}
    for r in load_jsonl(DATASET):
        iid = r.get("instance_id") or r.get("instanceId")
        if iid not in CASES:
            continue
        patch = r.get("patch", "") or ""
        gold = sorted(set(re.findall(r"^\+\+\+ b/(.+)$", patch, re.M)))
        f2p = r.get("FAIL_TO_PASS") or r.get("fail_to_pass") or []
        if isinstance(f2p, str):
            try:
                f2p = json.loads(f2p)
            except Exception:
                f2p = [f2p]
        out[iid] = {"gold_files": gold, "fail_to_pass": f2p}
    return out


def repo_relative(p):
    if not p:
        return None
    m = re.search(r"\.bench-repos/[^/]+/(.+)$", p)
    if m:
        return m.group(1)
    return p


def find_cond_dir(label):
    base = os.path.join(RUNS, label, "raw")
    for cond in ("vtrace", "baseline", "vexp"):
        d = os.path.join(base, cond)
        if os.path.isdir(d):
            return d, cond
    return None, None


def parse_digest(snapshot_path):
    """Return dict: present, impact_present, impact_warning_only, dependents, cross_file,
    caller_count, lead_pivot, pivots[], representative_paths[]."""
    res = dict(present=False, impact_present=False, impact_warning_only=False,
               dependents=0, cross_file=0, caller_count=0, representative_count=0,
               lead_pivot=None, pivots=[], representative_paths=[])
    if not os.path.exists(snapshot_path):
        return res
    text = open(snapshot_path).read()
    m = re.search(r"<VTRACE_CAPSULE_V2_DIGEST_START>(.*?)<VTRACE_CAPSULE_V2_DIGEST_END>", text, re.S)
    if not m:
        return res
    res["present"] = True
    block = m.group(1)
    # pivots: lines like "● pivot <path>::<sym>" or "○ skel <path>::<sym>"
    for mm in re.finditer(r"^[●○]\s+(?:pivot|skel)\s+(\S+?)::", block, re.M):
        res["pivots"].append(mm.group(1))
    if res["pivots"]:
        res["lead_pivot"] = res["pivots"][0]
    imp = re.search(r"→ impact\s+(\d+)\s+dependents,\s+(\d+)\s+cross-file", block)
    if imp:
        res["impact_present"] = True
        res["dependents"] = int(imp.group(1))
        res["cross_file"] = int(imp.group(2))
    cm = re.search(r"(\d+)\s+callers", block)
    if cm:
        res["caller_count"] = int(cm.group(1))
    for mm in re.finditer(r"^\s+dependent\s+(\S+?)::", block, re.M):
        res["representative_paths"].append(mm.group(1))
    for mm in re.finditer(r"^\s+caller\s+(\S+?)::", block, re.M):
        res["representative_paths"].append(mm.group(1))
    res["representative_count"] = len(res["representative_paths"])
    if (not res["impact_present"]) and "impact_not_threaded_into_digest" in block:
        res["impact_warning_only"] = True
    return res


def extract_run(label, instance):
    d, cond = find_cond_dir(label)
    if d is None:
        return None
    rows = []
    for fn in os.listdir(d):
        if fn.startswith("swebench-") and fn.endswith(".jsonl"):
            rows = load_jsonl(os.path.join(d, fn))
            break
    row = next((r for r in rows if r.get("instanceId") == instance), rows[0] if rows else {})
    patch = row.get("modelPatch") or ""
    edited = sorted(set(re.findall(r"^\+\+\+ b/(.+)$", patch, re.M)))
    # tool calls
    tc_path = os.path.join(d, "_tool_calls.json")
    calls = json.load(open(tc_path)) if os.path.exists(tc_path) else []
    read_paths, edit_paths = [], []
    n_read = n_search = n_edit = n_other = 0
    for c in calls:
        cat = c.get("category")
        rp = repo_relative(c.get("path"))
        if cat == "read":
            n_read += 1
            if rp:
                read_paths.append(rp)
        elif cat == "search":
            n_search += 1
        elif cat == "edit":
            n_edit += 1
            if rp:
                edit_paths.append(rp)
        else:
            n_other += 1
    repeated_reads = len(read_paths) - len(set(read_paths))
    summ_path = os.path.join(d, "_tool_calls.summary.json")
    summ = json.load(open(summ_path)) if os.path.exists(summ_path) else {}
    cacheRead = row.get("cacheReadTokens", 0) or 0
    cacheWrite = row.get("cacheCreationTokens", 0) or 0
    inp = row.get("inputTokens", 0) or 0
    outp = row.get("outputTokens", 0) or 0
    total = inp + outp + cacheRead + cacheWrite
    return dict(
        label=label, condition=cond, instance=instance,
        resolved=row.get("resolved"), patch_produced=bool(patch.strip()),
        cost=row.get("costUsd"), duration_ms=row.get("durationMs"),
        input_tokens_total=inp, output_tokens_total=outp,
        cache_read_tokens_total=cacheRead, cache_write_tokens_total=cacheWrite,
        total_tokens=total, turn_count=row.get("numTurns"),
        tool_call_count=len(calls), read_count=n_read, search_count=n_search,
        edit_count=n_edit, other_count=n_other, repeated_file_reads=repeated_reads,
        read_paths=sorted(set(read_paths)), edited_files=edited,
        toolcalls_summary={k: summ.get(k) for k in
                           ("totalToolCalls", "fileReadToolCalls", "grepLikeToolCalls",
                            "fileWriteToolCalls", "uniqueFilesTouchedByTools",
                            "repeatedSearchHeuristic")},
    )


def action_for(path, read_paths, edited_files):
    rp = set(read_paths)
    ed = set(edited_files)
    inspected = path in rp
    edited = path in ed
    if edited and inspected:
        return "edited"
    if edited and not inspected:
        return "edited_without_inspection"
    if inspected:
        return "inspected"
    return "ignored"  # discovered-in-digest but never read/edited


def pct(dig, base):
    if base in (None, 0) or dig is None:
        return None
    return round((dig - base) / base * 100, 1)


def main():
    gold = gold_files_and_tests()
    out = {"milestone": "M56C", "cases": [], "pairs": []}
    runs = {}
    for instance, (cat, blabel, dlabel) in CASES.items():
        b = extract_run(blabel, instance)
        dg = extract_run(dlabel, instance)
        snap = os.path.join(RUNS, dlabel, "_vtrace_instructions.snapshot.md")
        digest = parse_digest(snap)
        runs[(instance, "baseline")] = b
        runs[(instance, "digest")] = dg
        gf = gold.get(instance, {})
        # context-to-action for digest run
        c2a = {}
        if dg:
            rps, eds = dg["read_paths"], dg["edited_files"]
            c2a["lead_pivot"] = {"path": digest["lead_pivot"],
                                 "action": action_for(digest["lead_pivot"], rps, eds) if digest["lead_pivot"] else None}
            c2a["impact_representatives"] = [
                {"path": p, "action": action_for(p, rps, eds)} for p in digest["representative_paths"]
            ]
            c2a["digest_pivots"] = [
                {"path": p, "action": action_for(p, rps, eds), "is_gold": p in gf.get("gold_files", [])}
                for p in digest["pivots"]
            ]
            c2a["edited_overlap_gold"] = sorted(set(eds) & set(gf.get("gold_files", [])))
            c2a["edited_overlap_pivots"] = sorted(set(eds) & set(digest["pivots"]))
            c2a["edited_overlap_impact"] = sorted(set(eds) & set(digest["representative_paths"]))
        out["cases"].append(dict(
            instance=instance, category=cat,
            gold_files=gf.get("gold_files"), fail_to_pass_count=len(gf.get("fail_to_pass", [])),
            baseline=b, digest=dg, digest_block=digest, context_to_action=c2a,
        ))
        if b and dg:
            out["pairs"].append(dict(
                instance=instance, category=cat,
                resolved_baseline=b["resolved"], resolved_digest=dg["resolved"],
                token_delta_pct=pct(dg["total_tokens"], b["total_tokens"]),
                cache_read_delta_pct=pct(dg["cache_read_tokens_total"], b["cache_read_tokens_total"]),
                cost_delta_pct=pct(dg["cost"], b["cost"]),
                tool_call_delta=dg["tool_call_count"] - b["tool_call_count"],
                read_delta=dg["read_count"] - b["read_count"],
                search_delta=dg["search_count"] - b["search_count"],
                resolution_delta=(int(bool(dg["resolved"])) - int(bool(b["resolved"]))),
            ))
    # paired outcome tallies
    tally = dict(both_pass=0, both_fail=0, digest_only_pass=0, baseline_only_pass=0)
    for p in out["pairs"]:
        bd, dd = bool(p["resolved_baseline"]), bool(p["resolved_digest"])
        if bd and dd:
            tally["both_pass"] += 1
        elif (not bd) and (not dd):
            tally["both_fail"] += 1
        elif dd and not bd:
            tally["digest_only_pass"] += 1
        else:
            tally["baseline_only_pass"] += 1
    out["paired_outcomes"] = tally
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()

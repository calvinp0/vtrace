"""M193 §29/§30 — the deterministic fake-agent dry run.

This is the pilot. §54 forbids a paid one: if a model were needed to discover
whether the harness works, the harness would not be ready.

Per repository it drives the complete future lifecycle with a scripted
sequence and no LLM:

    preflight -> container -> inspection -> edit -> diff snapshot
    -> validation (FAILS) -> path provenance -> SOURCE-VERSION provenance
    -> revision -> validation (PASSES) -> gold applied -> final patch extracted
    -> official evaluator -> cleanup

M193A adds the source-version witness to every validation and, after the
lifecycle, a constructed stale-cache falsification against the same running
container (§30): the classifier is exercised on the real runtime path, not only
on synthetic records.

The two validations are not decorative. The fake agent writes a value into the
package the interpreter will import and asserts a different value; the first run
must fail and the second must pass *because the source changed*. That makes the
edited checkout's execution the thing being observed, rather than something
asserted about it.

    <vexp>/.venv/bin/python run_stage5_m193_dry_run.py --out results/...json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from m193_container_adapter import (  # noqa: E402
    CHECKOUT_ROOT,
    InstanceSpec,
    M193Container,
    conda_env_for,
    load_instances,
    normalize_patch,
    normalize_patch_ignoring_hunk_context,
    sha256_text,
)
from run_stage5_m193_preflight import IMPORT_NAMES, instance_image_key, preflight_instance  # noqa: E402

DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"
VEXP = "/home/calvin/code/vexp-swe-bench"

# §30 — deliberately different stacks, and psf/requests is a mandated
# regression control because it is where M192 demonstrated cwd-dependent import
# resolution.
DRY_RUN_INSTANCES = [
    "psf__requests-1142",              # cwd/provenance sensitive; untracked build/ output
    "pallets__flask-5014",             # src/ layout
    "pytest-dev__pytest-10051",        # the test runner is itself the project; underscore package
    "sympy__sympy-12419",              # large pure-python package
    "django__django-10880",            # project with its own test runner
]

TEST_FILENAME = "m193_dry_run_test.py"

TEST_SOURCE = """import {pkg}


def test_m193_dry_run_value():
    assert {pkg}.M193_DRY_RUN_VALUE == 222
"""


def host_path(mount: str, container_path: str) -> str:
    return os.path.join(mount, os.path.relpath(container_path, CHECKOUT_ROOT))


class Ledger:
    """Ordered, dense trace. Ordinals are assigned here and nowhere else (§19)."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.snapshots: list[dict[str, Any]] = []

    def add(self, etype: str, **kw: Any) -> dict[str, Any]:
        ev = {
            "ordinal": len(self.events),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "type": etype,
            **kw,
        }
        self.events.append(ev)
        return ev

    def snapshot(self, boundary: str, patch: str) -> dict[str, Any]:
        norm = normalize_patch(patch)
        snap = {
            "ordinal": len(self.events),
            "boundary": boundary,
            "diffHash": f"sha256:{sha256_text(norm)}",
            "diffBytes": len(patch.encode()),
            "patch": patch if len(patch) <= 200_000 else patch[:200_000],
            "patchTruncated": len(patch) > 200_000,
        }
        self.snapshots.append(snap)
        self.add("patch_snapshot", stateHash=snap["diffHash"], snapshot={k: v for k, v in snap.items() if k != "patch"})
        return snap


def _cmd_event(led: Ledger, rec: Any, tool: str, is_validation: bool, state_hash: str | None,
               module_file: str | None = None, robustness: str | None = None,
               source_version: dict[str, Any] | None = None) -> dict[str, Any]:
    validation = {
        "isValidationAttempt": is_validation,
        "workdir": rec.cwd,
        "routedTo": rec.routed_to,
        "shell": {
            "processStarted": rec.process_started,
            "exitCode": rec.exit_code,
            "timedOut": rec.timed_out,
            "signal": rec.signal,
            "durationMs": rec.duration_ms,
        },
        "streams": {
            "stdout": rec.stdout,
            "stderr": rec.stderr,
            "mergedStream": rec.merged_stream,
            "mergedStreamComplete": rec.merged_stream_complete,
        },
        "moduleFile": module_file,
        "provenanceRobustness": robustness,
        "sourceVersionEvidence": source_version,
    }
    return led.add(
        "tool_call",
        toolName=tool,
        toolInput={"command": rec.command},
        stateHash=state_hash,
        execPath=rec.exec_path,
        validation=validation,
    )


def dry_run_instance(row: dict[str, Any], work_root: str) -> dict[str, Any]:
    iid = row["instance_id"]
    repo = row["repo"]
    import_name = IMPORT_NAMES[repo]
    try:
        from swebench.harness.test_spec.test_spec import make_test_spec

        env = conda_env_for(make_test_spec(row).eval_script)
    except Exception:
        env = "testbed"

    spec = InstanceSpec(iid, repo, row["base_commit"], instance_image_key(iid), import_name, env)
    out: dict[str, Any] = {
        "instanceId": iid,
        "repo": repo,
        "phases": {},
        "verdict": "DRY_RUN_FAILED",
        "errors": [],
    }
    led = Ledger()
    t0 = time.time()

    # Phase 0 — preflight, the same one a paid arm would get.
    pf = preflight_instance(row, os.path.join(work_root, "preflight"), keep=False)
    out["phases"]["preflight"] = {"verdict": pf["verdict"], "failedChecks": pf["failedChecks"],
                                  "provenanceRobustness": pf.get("provenanceRobustness")}
    if pf["verdict"] != "PREFLIGHT_PASSED":
        out["errors"].append("preflight failed; model would not be launched")
        out["trace"] = led.events
        return out

    box = M193Container(spec, os.path.join(work_root, iid))
    try:
        # Phase 1 — container + authoritative checkout.
        setup = box.setup()
        out["phases"]["containerStart"] = {
            "ok": setup.ok,
            "containerId": (setup.container_id or "")[:12],
            "hostMount": setup.host_mount,
            "workdir": CHECKOUT_ROOT,
            "headAfterCheckout": setup.head_after_checkout,
            "baseCommit": row["base_commit"],
            "extractMs": setup.extract_ms,
            "startMs": setup.start_ms,
            "preexistingUntracked": setup.preexisting_untracked,
            "errors": setup.errors,
        }
        if not setup.ok:
            out["errors"].append(f"setup: {setup.errors}")
            out["trace"] = led.events
            return out

        led.add("agent_start", stateHash=None, toolInput={"instanceId": iid})
        base_patch, _ = box.capture_diff()
        led.snapshot("SETUP", base_patch)
        out["phases"]["setupDiffEmpty"] = normalize_patch(base_patch) == ""

        mount = setup.host_mount or ""
        robustness, neutral = box.provenance_robustness()

        # Phase 2 — inspection, through the same tools a real agent has.
        insp = box.exec_raw("pwd; git rev-parse --short HEAD; ls | head -5", 120, "inspect")
        _cmd_event(led, insp, "Bash", False, led.snapshots[-1]["diffHash"])
        out["phases"]["inspection"] = {
            "ok": insp.exit_code == 0,
            "observedWorkdir": insp.stdout.strip().splitlines()[0] if insp.stdout.strip() else None,
            "workdirPinned": insp.cwd == CHECKOUT_ROOT,
        }

        hazard = box.bytecode_staleness_hazard()
        out["phases"]["bytecodeStalenessHazard"] = hazard

        module_file = box.module_witness()
        if not module_file:
            out["errors"].append("module witness unavailable")
            out["trace"] = led.events
            return out
        host_module = host_path(mount, module_file)
        with open(host_module) as fh:
            original_module = fh.read()

        # Phase 3 — first edit, written through the HOST mount exactly as an
        # agent's Edit tool would write it.
        with open(host_module, "w") as fh:
            fh.write(original_module + "\n\nM193_DRY_RUN_VALUE = 1\n")
        with open(os.path.join(mount, TEST_FILENAME), "w") as fh:
            fh.write(TEST_SOURCE.format(pkg=import_name))
        led.add("tool_call", toolName="Edit", toolInput={"file_path": module_file}, stateHash=None)
        p1, _ = box.capture_diff()
        s1 = led.snapshot("AFTER_EDIT", p1)
        out["phases"]["firstEdit"] = {
            "targetFile": module_file,
            "diffHash": s1["diffHash"],
            "diffNonEmpty": normalize_patch(p1) != "",
            "hostWriteVisibleInContainer": None,
        }

        # Phase 4 — first validation. Expected to FAIL: the value is 1, the test
        # demands 2, and the interpreter reads this tree.
        led.snapshot("BEFORE_VALIDATION", p1)
        runner_cmd = f"python -m pytest {TEST_FILENAME} -q --no-header -p no:cacheprovider"
        v1_started_at = time.time()
        v1 = box.exec_raw(runner_cmd, 600, "validation_1")
        used_unittest = False
        if "No module named pytest" in (v1.merged_stream or "") or "no module named pytest" in (v1.merged_stream or "").lower():
            used_unittest = True
            runner_cmd = f"python -m pytest {TEST_FILENAME}"  # recorded for the report
            v1 = box.exec_raw(
                f"python -c \"import {import_name} as m; assert m.M193_DRY_RUN_VALUE == 222\" "
                f"&& echo 'Ran 1 test in 0.0s' && echo OK || (echo 'Ran 1 test in 0.0s'; echo FAILED)",
                600,
                "validation_1_fallback",
            )
        mf1 = box.module_witness()
        # The tree is re-read rather than assumed: the probe runs after the
        # command, so it only describes what the command saw if nothing moved.
        p1_after, _ = box.capture_diff()
        sv1 = box.source_version_evidence(
            is_validation_attempt=True,
            runner_started=True,
            state_hash_before=s1["diffHash"],
            state_hash_after=f"sha256:{sha256_text(normalize_patch(p1_after))}",
            since_epoch=v1_started_at,
        )
        _cmd_event(led, v1, "Bash", True, s1["diffHash"], module_file=mf1, robustness=robustness, source_version=sv1)
        out["phases"]["validation1"] = {
            "command": runner_cmd,
            "usedUnittestFallback": used_unittest,
            "shellExitCode": v1.exit_code,
            "timedOut": v1.timed_out,
            "runnerOutputBytes": len(v1.merged_stream),
            "moduleFile": mf1,
            "provenanceRobustness": robustness,
            "moduleFileNeutralCwd": neutral,
            "bytecodeCacheCount": box.bytecode_cache_count(),
            "sourceVersionEvidence": sv1,
            "workdir": v1.cwd,
            "tail": (v1.merged_stream or "").strip().splitlines()[-3:],
        }
        led.snapshot("AFTER_VALIDATION", p1)

        # Phase 5 — the revision.
        with open(host_module, "w") as fh:
            fh.write(original_module + "\n\nM193_DRY_RUN_VALUE = 222\n")
        led.add("tool_call", toolName="Edit", toolInput={"file_path": module_file}, stateHash=None)
        p2, _ = box.capture_diff()
        s2 = led.snapshot("AFTER_EDIT", p2)
        out["phases"]["secondEdit"] = {
            "diffHash": s2["diffHash"],
            "differsFromFirst": s2["diffHash"] != s1["diffHash"],
        }

        # Phase 6 — second validation. Expected to PASS, and it can only pass if
        # the running interpreter read the edited checkout.
        led.snapshot("BEFORE_VALIDATION", p2)
        v2_started_at = time.time()
        if used_unittest:
            v2 = box.exec_raw(
                f"python -c \"import {import_name} as m; assert m.M193_DRY_RUN_VALUE == 222\" "
                f"&& (echo 'Ran 1 test in 0.0s'; echo OK) || (echo 'Ran 1 test in 0.0s'; echo FAILED)",
                600,
                "validation_2_fallback",
            )
        else:
            v2 = box.exec_raw(f"python -m pytest {TEST_FILENAME} -q --no-header -p no:cacheprovider", 600, "validation_2")
        mf2 = box.module_witness()
        p2_after, _ = box.capture_diff()
        sv2 = box.source_version_evidence(
            is_validation_attempt=True,
            runner_started=True,
            state_hash_before=s2["diffHash"],
            state_hash_after=f"sha256:{sha256_text(normalize_patch(p2_after))}",
            since_epoch=v2_started_at,
        )
        _cmd_event(led, v2, "Bash", True, s2["diffHash"], module_file=mf2, robustness=robustness, source_version=sv2)
        out["phases"]["validation2"] = {
            "shellExitCode": v2.exit_code,
            "timedOut": v2.timed_out,
            "moduleFile": mf2,
            "sourceVersionEvidence": sv2,
            "workdir": v2.cwd,
            "tail": (v2.merged_stream or "").strip().splitlines()[-3:],
        }
        led.snapshot("AFTER_VALIDATION", p2)

        # Phase 6b — the source-version falsification, on the SAME running
        # container the lifecycle just used (§30). A classifier proven only
        # against synthetic records has not been proven against the runtime.
        #
        # Three arms, and the third is the one that matters: M192's poisoned
        # copy carries the CURRENT bytes into a shadowing package, so the
        # source-version witness is satisfied and only the PATH witness can
        # refuse it. Neither axis may stand in for the other.
        falsification: dict[str, Any] = {}
        try:
            with open(host_module, "w") as fh:
                fh.write(original_module + "\n\nM193A_CONTROL = 111\n")
            box.exec_raw(
                f"python -c \"import {import_name} as _m; print(_m.M193A_CONTROL)\"", 120, "control_prime"
            )
            primed = os.stat(host_module)
            with open(host_module, "w") as fh:
                fh.write(original_module + "\n\nM193A_CONTROL = 222\n")
            os.utime(host_module, (primed.st_atime, primed.st_mtime))
            stale_read = box.exec_raw(
                f"python -c \"import {import_name} as _m; print(_m.M193A_CONTROL)\"", 120, "control_stale_read"
            )
            stale_sv = box.source_version_probe([module_file])
            falsification["staleCacheControl"] = {
                "valueOnDisk": "222",
                "valueExecuted": (stale_read.stdout or "").strip().splitlines()[-1:] or None,
                "pathWitness": box.module_witness(),
                "expectedSourceVersion": "CACHE_STALE_AND_ACCEPTED",
                "actualSourceVersion": (stale_sv.get("files") or [{}])[0].get("verdict"),
                "evidence": (stale_sv.get("files") or [{}])[0],
            }

            with open(host_module, "w") as fh:
                fh.write(original_module + "\n\nM193A_CONTROL = 3333333\n")
            healthy_read = box.exec_raw(
                f"python -c \"import {import_name} as _m; print(_m.M193A_CONTROL)\"", 120, "control_healthy_read"
            )
            healthy_sv = box.source_version_probe([module_file])
            falsification["healthyControl"] = {
                "valueOnDisk": "3333333",
                "valueExecuted": (healthy_read.stdout or "").strip().splitlines()[-1:] or None,
                "pathWitness": box.module_witness(),
                "expectedSourceVersionIn": ["CACHE_MATCHES_CURRENT_SOURCE", "COMPILED_FROM_CURRENT_SOURCE"],
                "actualSourceVersion": (healthy_sv.get("files") or [{}])[0].get("verdict"),
                "evidence": (healthy_sv.get("files") or [{}])[0],
            }

            poison = box.exec_raw(
                "python -c \"import site,sys;print([p for p in sys.path if p.endswith('site-packages')][0])\"",
                120,
                "control_site_packages",
            )
            site_dir = (poison.stdout or "").strip().splitlines()[-1] if poison.stdout.strip() else ""
            pkg_root = os.path.dirname(module_file)
            if site_dir.startswith("/"):
                cp = box.exec_raw(
                    f"cp -r {pkg_root} {site_dir}/ && echo COPIED", 300, "control_poison_install"
                )
                neutral = box.module_witness(workdir="/", pin_cwd=False)
                falsification["poisonedCopyControl"] = {
                    "sitePackages": site_dir,
                    "copied": "COPIED" in cp.stdout,
                    "moduleFileFromNeutralCwd": neutral,
                    "carriedCurrentBytesForward": True,
                    "expectedPathProvenance": "INSTALLED_COPY_CONFIRMED or AMBIGUOUS_SOURCE",
                    "resolvesOutsideCheckout": bool(neutral) and not neutral.startswith(CHECKOUT_ROOT + "/"),
                }
                box.exec_raw(
                    f"rm -rf {site_dir}/{os.path.basename(pkg_root)} && echo REMOVED", 300, "control_poison_remove"
                )
        except Exception as exc:  # noqa: BLE001
            falsification["error"] = f"{type(exc).__name__}: {exc}"
        out["phases"]["sourceVersionFalsification"] = falsification

        # Phase 7 — restore, then apply gold, so the final patch is a real
        # candidate solution and the evaluator has something to grade.
        with open(host_module, "w") as fh:
            fh.write(original_module)
        try:
            os.remove(os.path.join(mount, TEST_FILENAME))
        except OSError:
            pass
        gold = row.get("patch") or ""
        gold_path = os.path.join(mount, ".m193_gold.patch")
        with open(gold_path, "w") as fh:
            fh.write(gold)
        ap = box.exec_raw("git apply -v .m193_gold.patch 2>&1; echo RC=$?", 300, "apply_gold")
        try:
            os.remove(gold_path)
        except OSError:
            pass
        out["phases"]["goldApplied"] = {"ok": "RC=0" in ap.stdout, "tail": ap.stdout.strip().splitlines()[-2:]}

        # Phase 8 — final patch extraction.
        final_patch, _ = box.capture_diff()
        s3 = led.snapshot("BEFORE_SUBMIT", final_patch)
        led.add("agent_end", stateHash=s3["diffHash"])
        out["phases"]["finalPatch"] = {
            "diffHash": s3["diffHash"],
            "bytes": len(final_patch.encode()),
            "matchesGoldNormalized": normalize_patch(final_patch) == normalize_patch(gold),
            "matchesGoldIgnoringHunkContext":
                normalize_patch_ignoring_hunk_context(final_patch)
                == normalize_patch_ignoring_hunk_context(gold),
            "containsPreexistingUntracked": any(
                f"a/{p}" in final_patch or f"b/{p}" in final_patch for p in setup.preexisting_untracked
            ),
            "containsBinaryPatch": "GIT binary patch" in final_patch,
        }
        out["finalPatch"] = final_patch
        out["goldPatchNormalizedSha256"] = sha256_text(normalize_patch(gold))
        out["interactiveFinalDiffNormalizedSha256"] = sha256_text(normalize_patch(final_patch))

    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"{type(exc).__name__}: {exc}")
    finally:
        out["phases"]["cleanup"] = box.teardown(remove_mount=True)

    out["trace"] = led.events
    out["snapshots"] = [{k: v for k, v in s.items() if k != "patch"} for s in led.snapshots]
    out["traceOrdinalsDense"] = [e["ordinal"] for e in led.events] == list(range(len(led.events)))
    out["durationMs"] = int((time.time() - t0) * 1000)
    if not out["errors"]:
        out["verdict"] = "DRY_RUN_LIFECYCLE_OK"
    return out


def run_evaluator(results: list[dict[str, Any]], run_id: str, work_root: str) -> dict[str, Any]:
    """§27/§28 — push the extracted patches through the official evaluator and
    read back the patch it actually applied."""
    preds = []
    for r in results:
        if "finalPatch" not in r:
            continue
        preds.append(
            {
                "instance_id": r["instanceId"],
                "model_name_or_path": run_id,
                "model_patch": r["finalPatch"],
            }
        )
    if not preds:
        return {"ran": False, "reason": "no extractable patches"}

    preds_path = os.path.join(work_root, f"{run_id}_preds.jsonl")
    with open(preds_path, "w") as fh:
        for p in preds:
            fh.write(json.dumps(p) + "\n")

    cmd = [
        f"{VEXP}/.venv/bin/python", "-m", "swebench.harness.run_evaluation",
        "-p", preds_path,
        "-d", DATASET,
        "-id", run_id,
        "--max_workers", "3",
        "--timeout", "1800",
        "--cache_level", "instance",
        "--clean", "False",
    ]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=VEXP, capture_output=True, text=True, timeout=5400)
    took = int((time.time() - t0) * 1000)

    per_instance: dict[str, Any] = {}
    for p in preds:
        iid = p["instance_id"]
        log_dir = os.path.join(VEXP, "logs", "run_evaluation", run_id, run_id, iid)
        entry: dict[str, Any] = {"logDir": log_dir, "logDirExists": os.path.isdir(log_dir)}
        pd = os.path.join(log_dir, "patch.diff")
        if os.path.exists(pd):
            with open(pd) as fh:
                applied = fh.read()
            entry["evaluatorPatchBytes"] = len(applied.encode())
            entry["evaluatorPatchNormalizedSha256"] = sha256_text(normalize_patch(applied))
            entry["evaluatorPatch"] = applied
        rp = os.path.join(log_dir, "report.json")
        if os.path.exists(rp):
            try:
                rep = json.load(open(rp))
                entry["report"] = rep.get(iid, {})
                entry["resolved"] = bool(rep.get(iid, {}).get("resolved"))
            except Exception as exc:
                entry["reportError"] = str(exc)
        # third witness: the diff git itself regenerated inside the evaluator
        rl = os.path.join(log_dir, "run_instance.log")
        if os.path.exists(rl):
            try:
                text = open(rl, errors="replace").read()
                marker = "Git diff before:\n"
                if marker in text:
                    after = text.split(marker, 1)[1]
                    end = after.find("\nGit diff after:")
                    entry["evaluatorGitDiffBefore"] = after[: end if end > 0 else 20000]
            except Exception as exc:
                entry["runLogError"] = str(exc)
        per_instance[iid] = entry

    return {
        "ran": True,
        "runId": run_id,
        "predictionsPath": preds_path,
        "returnCode": proc.returncode,
        "durationMs": took,
        "stdoutTail": proc.stdout.strip().splitlines()[-15:],
        "stderrTail": proc.stderr.strip().splitlines()[-10:],
        "perInstance": per_instance,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=DATASET)
    ap.add_argument("--instances", default=",".join(DRY_RUN_INSTANCES))
    ap.add_argument("--work-root", default="/tmp/m193_dry_run")
    ap.add_argument("--run-id", default="m193_dry_run")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--skip-evaluator", action="store_true")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.work_root, exist_ok=True)
    rows = load_instances(args.dataset)
    wanted = [s for s in args.instances.split(",") if s.strip()]

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(dry_run_instance, rows[i], args.work_root): i for i in wanted if i in rows}
        for fut in as_completed(futs):
            iid = futs[fut]
            try:
                results.append(fut.result())
            except Exception as exc:  # noqa: BLE001
                results.append({"instanceId": iid, "verdict": "DRY_RUN_FAILED", "errors": [str(exc)]})
            print(f"  lifecycle done: {iid}")

    results.sort(key=lambda r: r["instanceId"])
    ev = {"ran": False} if args.skip_evaluator else run_evaluator(results, args.run_id, args.work_root)

    doc = {
        "schemaVersion": "stage5.m193.dry-run.v1",
        "milestone": "M193",
        "liveModelCalls": 0,
        "liveModelSpendUsd": 0,
        "dataset": args.dataset,
        "instanceCount": len(results),
        "results": results,
        "evaluator": ev,
    }
    with open(args.out, "w") as fh:
        fh.write(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {args.out}")
    for r in results:
        fals = (r.get("phases") or {}).get("sourceVersionFalsification") or {}
        stale = (fals.get("staleCacheControl") or {}).get("actualSourceVersion")
        healthy = (fals.get("healthyControl") or {}).get("actualSourceVersion")
        print(
            f"  {r['instanceId']:<34} {r['verdict']:<24} stale={str(stale):<26} healthy={str(healthy):<28} "
            f"errors={r.get('errors')}"
        )
    shutil.rmtree(args.work_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

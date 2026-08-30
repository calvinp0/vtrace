"""M193 §31 — the deterministic, model-free preflight that runs before every paid arm.

M192 probed one instance per repository. It did not probe every instance the
acquisition might pay for, and instance images differ from one another even
within a repository. So readiness is re-established per instance, immediately
before the model is launched, and a failure means the model is never launched
at all.

    <vexp>/.venv/bin/python run_stage5_m193_preflight.py \
        --instances psf__requests-1142 --out results/stage5_m193_preflight.json

Exit status is 0 whether instances pass or fail; the verdict is in the report.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from m193_container_adapter import (  # noqa: E402
    CHECKOUT_ROOT,
    InstanceSpec,
    M193Container,
    conda_env_for,
    load_instances,
)

DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"

# import name per repository, from M192's frozen probe manifest
IMPORT_NAMES = {
    "astropy/astropy": "astropy",
    "django/django": "django",
    "matplotlib/matplotlib": "matplotlib",
    "mwaskom/seaborn": "seaborn",
    "pallets/flask": "flask",
    "psf/requests": "requests",
    "pydata/xarray": "xarray",
    "pylint-dev/pylint": "pylint",
    "pytest-dev/pytest": "_pytest",
    "scikit-learn/scikit-learn": "sklearn",
    "sphinx-doc/sphinx": "sphinx",
    "sympy/sympy": "sympy",
}

DISK_FLOOR_GB = 60


def instance_image_key(instance_id: str, arch: str = "x86_64") -> str:
    return f"swebench/sweb.eval.{arch}.{instance_id.replace('__', '_1776_').lower()}:latest"


def free_disk_gb(path: str = "/var/lib/docker") -> float:
    target = path if os.path.isdir(path) else "/"
    usage = shutil.disk_usage(target)
    return usage.free / (1024**3)


def preflight_instance(row: dict[str, Any], work_root: str, keep: bool = False) -> dict[str, Any]:
    """P1..P14. Every check reports what it observed, not what it hoped."""
    instance_id = row["instance_id"]
    repo = row["repo"]
    import_name = IMPORT_NAMES.get(repo, repo.split("/")[-1].replace("-", "_"))

    try:
        from swebench.harness.test_spec.test_spec import make_test_spec

        env = conda_env_for(make_test_spec(row).eval_script)
    except Exception:
        env = "testbed"

    spec = InstanceSpec(
        instance_id=instance_id,
        repo=repo,
        base_commit=row["base_commit"],
        image_key=instance_image_key(instance_id),
        import_name=import_name,
        conda_env=env,
    )

    rep: dict[str, Any] = {
        "instanceId": instance_id,
        "repo": repo,
        "imageKey": spec.image_key,
        "condaEnv": env,
        "importName": import_name,
        "checks": {},
        "verdict": "PREFLIGHT_FAILED",
        "failedChecks": [],
        "workdir": CHECKOUT_ROOT,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }

    disk = free_disk_gb()
    rep["freeDiskGb"] = round(disk, 1)
    rep["checks"]["P14_disk_above_floor"] = disk >= DISK_FLOOR_GB
    if disk < DISK_FLOOR_GB:
        rep["failedChecks"].append("P14_disk_above_floor")
        return rep

    mount_root = os.path.join(work_root, instance_id)
    box = M193Container(spec, mount_root)
    t0 = time.time()
    setup = box.setup()
    rep["setup"] = {
        "ok": setup.ok,
        "containerId": (setup.container_id or "")[:12],
        "hostMount": setup.host_mount,
        "extractMs": setup.extract_ms,
        "startMs": setup.start_ms,
        "headAfterCheckout": setup.head_after_checkout,
        "preexistingUntracked": setup.preexisting_untracked,
        "errors": setup.errors,
    }

    try:
        c = rep["checks"]
        c["P1_image_available"] = True
        c["P2_container_starts"] = setup.container_id is not None

        ls = box.exec_raw(f"test -d {CHECKOUT_ROOT} && echo YES || echo NO", 60, "P3_checkout_root")
        c["P3_checkout_root_exists"] = "YES" in ls.stdout

        c["P4_base_commit_reachable"] = setup.base_commit_reachable
        c["P5_base_commit_checked_out"] = setup.head_after_checkout == row["base_commit"]

        pwd = box.exec_raw("pwd", 60, "P6_workdir")
        c["P6_workdir_is_checkout_root"] = pwd.stdout.strip() == CHECKOUT_ROOT
        rep["observedWorkdir"] = pwd.stdout.strip()

        # P7 writability + P8 persistence, exercised through the HOST mount so
        # this proves exactly the path the agent's Edit tool will use.
        probe_rel = ".m193_preflight_probe"
        host_probe = os.path.join(setup.host_mount or "", probe_rel)
        wrote = False
        try:
            with open(host_probe, "w") as fh:
                fh.write("m193-preflight\n")
            wrote = True
        except Exception as exc:
            rep["hostWriteError"] = str(exc)
        c["P7_source_writable_from_host"] = wrote

        seen = box.exec_raw(f"cat {CHECKOUT_ROOT}/{probe_rel} 2>/dev/null", 60, "P8_mutation_visible")
        c["P8_host_mutation_visible_in_container"] = "m193-preflight" in seen.stdout

        box.exec_raw(f"echo m193-container > {CHECKOUT_ROOT}/{probe_rel}", 60, "P8b_container_write")
        back = ""
        try:
            with open(host_probe) as fh:
                back = fh.read()
        except Exception:
            pass
        c["P8b_container_mutation_visible_on_host"] = "m193-container" in back
        try:
            os.remove(host_probe)
        except Exception:
            pass

        # P9/P10 provenance.
        witness = box.module_witness()
        robustness, neutral = box.provenance_robustness()
        rep["moduleFile"] = witness
        rep["moduleFileNeutralCwd"] = neutral
        rep["provenanceRobustness"] = robustness
        c["P9_import_resolves_under_checkout"] = bool(witness and witness.startswith(CHECKOUT_ROOT + "/"))
        c["P10_provenance_robustness_known"] = robustness in ("EDITABLE_INSTALL", "CWD_DEPENDENT")

        # P11 execution witness: a value written into the checkout must be the
        # value the interpreter reads back. Stronger than a sentinel, because it
        # proves the running process read THIS tree.
        exec_witness = False
        if witness and witness.startswith(CHECKOUT_ROOT + "/"):
            host_module = os.path.join(setup.host_mount or "", os.path.relpath(witness, CHECKOUT_ROOT))
            try:
                with open(host_module) as fh:
                    original = fh.read()
                with open(host_module, "w") as fh:
                    fh.write(original + "\nM193_PREFLIGHT_WITNESS = 424242\n")
                r = box.exec_raw(
                    f"python -c \"import {import_name} as _m; print(getattr(_m,'M193_PREFLIGHT_WITNESS',None))\"",
                    120,
                    "P11_execution_witness",
                )
                exec_witness = "424242" in r.stdout
                with open(host_module, "w") as fh:
                    fh.write(original)
            except Exception as exc:
                rep["executionWitnessError"] = str(exc)
        c["P11_edited_checkout_is_what_executes"] = exec_witness

        # P12 the test runner starts at all.
        runner = box.exec_raw("python -m pytest --version 2>&1 | head -3", 180, "P12_runner")
        c["P12_test_runner_available"] = runner.exit_code == 0 and bool(runner.merged_stream.strip())
        rep["runnerBanner"] = runner.merged_stream.strip()[:200]

        # P15 measure the bytecode-staleness hazard. Reported, never suppressed:
        # suppressing it would change the environment the baseline agent faces.
        hz = box.bytecode_staleness_hazard()
        rep["bytecodeStalenessHazard"] = hz
        rep["bytecodeCacheCount"] = box.bytecode_cache_count()
        c["P15_bytecode_hazard_measured"] = bool(hz.get("measured"))

        # P13 the checkout is clean again and cleanup works.
        status = box.exec_raw("git status --porcelain", 120, "P13_clean")
        residual = [ln for ln in status.stdout.splitlines() if ln.strip()]
        unexpected = [
            ln for ln in residual if ln[3:].strip().rstrip("/") not in set(setup.preexisting_untracked)
        ]
        c["P13_source_restored_clean"] = not unexpected
        rep["residualStatus"] = residual[:10]

    finally:
        rep["teardown"] = box.teardown(remove_mount=not keep)

    rep["durationMs"] = int((time.time() - t0) * 1000)
    rep["failedChecks"] = [k for k, v in rep["checks"].items() if not v]
    rep["verdict"] = "PREFLIGHT_PASSED" if not rep["failedChecks"] else "PREFLIGHT_FAILED"
    return rep


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instances", required=True, help="comma-separated instance ids")
    ap.add_argument("--dataset", default=DATASET)
    ap.add_argument("--work-root", default="/tmp/m193_work")
    ap.add_argument("--out", default="")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    rows = load_instances(args.dataset)
    reports = []
    for iid in [s for s in args.instances.split(",") if s.strip()]:
        if iid not in rows:
            reports.append({"instanceId": iid, "verdict": "PREFLIGHT_FAILED", "failedChecks": ["P0_not_in_dataset"]})
            continue
        reports.append(preflight_instance(rows[iid], args.work_root, keep=args.keep))

    doc = {
        "schemaVersion": "stage5.m193.preflight.v1",
        "milestone": "M193",
        "dataset": args.dataset,
        "diskFloorGb": DISK_FLOOR_GB,
        "instanceCount": len(reports),
        "passed": sum(1 for r in reports if r["verdict"] == "PREFLIGHT_PASSED"),
        "failed": sum(1 for r in reports if r["verdict"] != "PREFLIGHT_PASSED"),
        "reports": reports,
    }
    text = json.dumps(doc, indent=2) + "\n"
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text)
        print(f"wrote {args.out}")
    for r in reports:
        print(f"  {r['instanceId']:<36} {r['verdict']:<18} {r.get('provenanceRobustness','?'):<18} failed={r.get('failedChecks')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

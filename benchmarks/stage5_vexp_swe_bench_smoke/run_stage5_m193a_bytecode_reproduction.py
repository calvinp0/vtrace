"""M193A §4/§5 — reproduce the bytecode-staleness hazard on the real substrate.

M193 reported the hazard on 3 of 5 dry-run repositories. This does not take that
on trust: it re-derives the affected set on current HEAD by driving the same
containers through the same seam, and it records enough of the interpreter's own
state to explain WHY a stale cache stays valid rather than asserting that it
does.

Per repository:

    container start (real bind-mounted checkout, base commit checked out)
    -> interpreter identity + cache invalidation mode
    -> the witness module's source and cache state, before anything is touched
    -> S0 -> S1 same-size same-second edit (the natural collision)
    -> runtime path witness, execution witness, observed semantics
    -> the M193A source-version probe's verdict on the same file

The edit is reverted afterwards, and the container is destroyed. No model is
invoked; no benchmark outcome is read.

    <vexp>/.venv/bin/python run_stage5_m193a_bytecode_reproduction.py --out results/...json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
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
)
from run_stage5_m193_preflight import IMPORT_NAMES, instance_image_key  # noqa: E402

DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"

# The committed M193 dry-run set, unchanged (§29).
SPECIMENS = [
    "psf__requests-1142",
    "pallets__flask-5014",
    "pytest-dev__pytest-10051",
    "sympy__sympy-12419",
    "django__django-10880",
]

# One line, written and rewritten at the same length so the (mtime, size) pair
# CPython validates against cannot move. This is the natural collision, not an
# artificial one: an agent flipping a constant, a comparison operator or a
# single character produces exactly this shape.
PROBE_LINE_A = "\nM193A_STALE_PROBE = 1\n"
PROBE_LINE_B = "\nM193A_STALE_PROBE = 2\n"
# The forced arm's own setup write must not be able to hit the collision it is
# about to construct. Giving it a DIFFERENT length from the natural arm's lines
# moves the size field, which invalidates any cache the natural arm left behind
# no matter what the clock did. Without this the control silently measured a
# stale cache instead of installing a fresh one, and reported a false negative
# on pytest-dev/pytest.
FORCED_LINE_A = "\nM193A_STALE_PROBE = 111\n"
FORCED_LINE_B = "\nM193A_STALE_PROBE = 222\n"
# A third length again, for the healthy arm: the size field alone invalidates
# the cache, so the interpreter must recompile.
PROBE_LINE_C = "\nM193A_STALE_PROBE = 33333\n"

assert len(FORCED_LINE_A) == len(FORCED_LINE_B) != len(PROBE_LINE_A)
assert len(PROBE_LINE_A) == len(PROBE_LINE_B)


def host_path(mount: str, container_path: str) -> str:
    return os.path.join(mount, os.path.relpath(container_path, CHECKOUT_ROOT))


def read_value(box: M193Container, label: str) -> dict[str, Any]:
    """The execution witness: what the interpreter actually reads back."""
    rec = box.exec_raw(
        f"python -c \"import {box.spec.import_name} as _m; "
        f"print('VALUE=' + str(getattr(_m,'M193A_STALE_PROBE',None)))\"",
        120,
        label,
    )
    value = None
    for line in (rec.merged_stream or "").splitlines():
        if line.startswith("VALUE="):
            value = line[len("VALUE="):].strip()
    return {
        "label": label,
        "executionWitnessFired": value is not None,
        "value": value,
        "exitCode": rec.exit_code,
        "durationMs": rec.duration_ms,
    }


def file_state(box: M193Container, container_file: str) -> dict[str, Any]:
    """Source and cache state read through the container's own interpreter."""
    rec = box.exec_raw(
        "python - <<'PYSTATE'\n"
        "import importlib.util, json, os, sys\n"
        f"p = {container_file!r}\n"
        "st = os.stat(p) if os.path.isfile(p) else None\n"
        "pyc = importlib.util.cache_from_source(p)\n"
        "h = None\n"
        "if os.path.exists(pyc):\n"
        "    with open(pyc,'rb') as fh: h = fh.read(16).hex()\n"
        "print(json.dumps({'source': p, 'sourceSize': st.st_size if st else None,\n"
        "  'sourceMtime': int(st.st_mtime) if st else None,\n"
        "  'pycPath': pyc, 'pycExists': os.path.exists(pyc),\n"
        "  'pycSize': os.path.getsize(pyc) if os.path.exists(pyc) else None,\n"
        "  'pycHeaderHex': h}))\n"
        "PYSTATE",
        120,
        "file_state",
    )
    for line in reversed((rec.stdout or "").splitlines()):
        try:
            return json.loads(line)
        except Exception:
            continue
    return {"error": "unreadable", "tail": (rec.merged_stream or "")[-400:]}


def specimen(row: dict[str, Any], work_root: str) -> dict[str, Any]:
    iid = row["instance_id"]
    repo = row["repo"]
    try:
        from swebench.harness.test_spec.test_spec import make_test_spec

        env = conda_env_for(make_test_spec(row).eval_script)
    except Exception:
        env = "testbed"

    spec = InstanceSpec(iid, repo, row["base_commit"], instance_image_key(iid), IMPORT_NAMES[repo], env)
    out: dict[str, Any] = {"instanceId": iid, "repo": repo, "verdict": "REPRODUCTION_FAILED", "errors": []}
    box = M193Container(spec, os.path.join(work_root, iid))
    t0 = time.time()
    try:
        setup = box.setup()
        out["containerStarted"] = setup.ok
        if not setup.ok:
            out["errors"].append(f"setup: {setup.errors}")
            return out
        mount = setup.host_mount or ""

        # 1. interpreter identity and cache policy, from the interpreter itself.
        interp = box.source_version_probe([])
        out["interpreter"] = interp.get("interpreter")
        out["probeInstalled"] = bool(interp.get("probeRan"))

        # 2. the module the validation will import, and its cache, untouched.
        witness = box.module_witness()
        out["moduleWitness"] = witness
        if not witness or not witness.startswith(CHECKOUT_ROOT + "/"):
            out["errors"].append(f"module witness outside the checkout: {witness}")
            return out
        out["preEditFileState"] = file_state(box, witness)
        out["bytecodeCacheCountBefore"] = box.bytecode_cache_count()

        host_module = host_path(mount, witness)
        with open(host_module) as fh:
            original = fh.read()

        # 3. S0: write the first value, then read it, which is what populates or
        #    refreshes the cache the second write has to defeat.
        with open(host_module, "w") as fh:
            fh.write(original + PROBE_LINE_A)
        s0_state = file_state(box, witness)
        s0_read = read_value(box, "read_S0")
        s0_after = file_state(box, witness)

        # 4. S1: same length, written immediately, so both header fields hold.
        with open(host_module, "w") as fh:
            fh.write(original + PROBE_LINE_B)
        s1_state = file_state(box, witness)
        s1_read = read_value(box, "read_S1")
        sv = box.source_version_probe([witness])
        s1_file = (sv.get("files") or [{}])[0]

        same_second = s0_state.get("sourceMtime") == s1_state.get("sourceMtime")
        same_size = s0_state.get("sourceSize") == s1_state.get("sourceSize")
        stale_read = s0_read["value"] == "1" and s1_read["value"] == "1"

        out["scenario"] = {
            "s0": {"state": s0_state, "read": s0_read, "stateAfterRead": s0_after},
            "s1": {"state": s1_state, "read": s1_read},
            "sameMtimeSecond": same_second,
            "sameSize": same_size,
            "cacheAcceptedDespiteEdit": stale_read,
        }
        out["sourceVersionProbe"] = s1_file
        out["pathWitnessAfterStaleRead"] = box.module_witness()
        out["executionWitnessFired"] = s1_read["executionWitnessFired"]
        out["observedSemantics"] = (
            "read S0 while the file on disk held S1" if stale_read else "read S1, matching the file on disk"
        )
        out["hazardReproduced"] = bool(stale_read)
        out["sourceVersionVerdict"] = s1_file.get("verdict")
        out["bytecodeCacheCountAfter"] = box.bytecode_cache_count()

        # 4b. The natural arm is a race with the wall clock, so on its own it
        #     cannot establish anything about a repository. The forced arm
        #     removes the race and nothing else: the second write's mtime is set
        #     back to the first's, which is the only manipulation needed to
        #     reproduce the collision CPython's own validator is subject to
        #     (§11). Size is already equal by construction.
        with open(host_module, "w") as fh:
            fh.write(original + FORCED_LINE_A)
        f0_read = read_value(box, "forced_read_S0")
        f_stat = os.stat(host_module)
        with open(host_module, "w") as fh:
            fh.write(original + FORCED_LINE_B)
        os.utime(host_module, (f_stat.st_atime, f_stat.st_mtime))
        f1_state = file_state(box, witness)
        f1_read = read_value(box, "forced_read_S1")
        f_sv = box.source_version_probe([witness])
        f_file = (f_sv.get("files") or [{}])[0]
        out["forcedCollision"] = {
            "s0Read": f0_read,
            "s1State": f1_state,
            "s1Read": f1_read,
            "pathWitness": box.module_witness(),
            "setupRecompiledAsExpected": f0_read["value"] == "111",
            "staleExecutionObserved": f0_read["value"] == "111" and f1_read["value"] == "111",
            "currentSourceValueOnDisk": "222",
            "sourceVersionVerdict": f_file.get("verdict"),
            "sourceVersionReason": f_file.get("reason"),
            "evidence": f_file,
        }

        # 4c. The positive control (§12). A different-length edit moves the size
        #     field, so the cache is invalidated on its own terms and the
        #     interpreter must read the current bytes. A classifier that only
        #     ever says "ambiguous" would fail here.
        with open(host_module, "w") as fh:
            fh.write(original + PROBE_LINE_C)
        h_read = read_value(box, "healthy_read")
        h_sv = box.source_version_probe([witness])
        h_file = (h_sv.get("files") or [{}])[0]
        out["healthyControl"] = {
            "read": h_read,
            "currentSourceObserved": h_read["value"] == "33333",
            "sourceVersionVerdict": h_file.get("verdict"),
            "sourceVersionReason": h_file.get("reason"),
            "evidence": h_file,
        }

        # 5. restore, so nothing about the specimen is left changed.
        with open(host_module, "w") as fh:
            fh.write(original)
        out["restored"] = open(host_module).read() == original
        out["verdict"] = "REPRODUCTION_OK"
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"{type(exc).__name__}: {exc}")
    finally:
        out["cleanup"] = box.teardown(remove_mount=True)
        out["durationMs"] = int((time.time() - t0) * 1000)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=DATASET)
    ap.add_argument("--instances", default=",".join(SPECIMENS))
    ap.add_argument("--work-root", default="/tmp/m193a_bytecode")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.work_root, exist_ok=True)
    rows = load_instances(args.dataset)
    wanted = [s for s in args.instances.split(",") if s.strip()]

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(specimen, rows[i], args.work_root): i for i in wanted if i in rows}
        for fut in as_completed(futs):
            iid = futs[fut]
            try:
                results.append(fut.result())
            except Exception as exc:  # noqa: BLE001
                results.append({"instanceId": iid, "verdict": "REPRODUCTION_FAILED", "errors": [str(exc)]})
            print(f"  specimen done: {iid}")
    results.sort(key=lambda r: r["instanceId"])

    hazardous = [r["instanceId"] for r in results if r.get("hazardReproduced")]
    forced_stale = [r["instanceId"] for r in results if (r.get("forcedCollision") or {}).get("staleExecutionObserved")]
    forced_setup_ok = [r["instanceId"] for r in results if (r.get("forcedCollision") or {}).get("setupRecompiledAsExpected")]
    forced_classified = [
        r["instanceId"] for r in results
        if (r.get("forcedCollision") or {}).get("sourceVersionVerdict") == "CACHE_STALE_AND_ACCEPTED"
    ]
    healthy_ok = [
        r["instanceId"] for r in results
        if (r.get("healthyControl") or {}).get("currentSourceObserved")
        and (r.get("healthyControl") or {}).get("sourceVersionVerdict")
        in ("CACHE_MATCHES_CURRENT_SOURCE", "COMPILED_FROM_CURRENT_SOURCE")
    ]
    doc = {
        "schemaVersion": "stage5.m193a.bytecode-reproduction.v1",
        "milestone": "M193A",
        "liveModelCalls": 0,
        "liveModelSpendUsd": 0,
        "question": "Does a same-size same-second edit still execute stale bytecode while every path witness says otherwise?",
        "dataset": args.dataset,
        "specimenCount": len(results),
        "naturalHazardInstances": hazardous,
        "naturalHazardCount": len(hazardous),
        "m193ReportedHazardousCount": 3,
        "m193ReportedHazardousInstances": ["psf__requests-1142", "pytest-dev__pytest-10051", "sympy__sympy-12419"],
        "forcedCollisionSetupCleanInstances": forced_setup_ok,
        "forcedCollisionStaleInstances": forced_stale,
        "forcedCollisionClassifiedStaleInstances": forced_classified,
        "healthyControlConfirmedInstances": healthy_ok,
        "attributionNote": (
            "The natural arm is a race against the wall clock, not a property of a repository. "
            "Whether an edit lands in the same whole second as the cache's recorded mtime decides it, "
            "so the affected set is expected to differ between runs on identical repositories. "
            "The forced arm removes the race and is the reproducible measurement."
        ),
        "results": results,
    }
    with open(args.out, "w") as fh:
        fh.write(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {args.out}")
    for r in results:
        fc = r.get("forcedCollision") or {}
        hc = r.get("healthyControl") or {}
        print(
            f"  {r['instanceId']:<32} natural={str(r.get('hazardReproduced')):<5} "
            f"forced={str(fc.get('staleExecutionObserved')):<5} {str(fc.get('sourceVersionVerdict')):<26} "
            f"healthy={str(hc.get('sourceVersionVerdict')):<28} py={(r.get('interpreter') or {}).get('version')}"
        )
    shutil.rmtree(args.work_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

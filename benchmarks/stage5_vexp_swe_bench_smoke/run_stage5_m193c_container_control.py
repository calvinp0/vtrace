"""M193C §21 — patch-snapshot purity against a real instance container.

Temporary Git repositories prove the command is read-only. They do not prove it
is read-only on the tree an arm actually gets: a SWE-bench image ships its own
untracked build output, its own `.gitignore`, its own conda checkout ownership,
and a `git` old enough to have its own defaults. So every Git state class an arm
can leave behind is reproduced inside the real container, through the same host
bind mount an agent's Edit and Write tools write through, and observed through
`M193Container.capture_patch_snapshot()` — the production path, not a
re-statement of it.

The repository is fingerprinted either side of the observation. The last thing
each instance does is run the SUPERSEDED command on the same tree, so the
fingerprint is shown to be capable of reporting a mutation rather than merely
reporting none.

No model is called. No agent is launched. The mutations here are performed by
this script.
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
    exclusion_pathspec,
    load_instances,
)
from m193c_patch_snapshot import repository_state_differences  # noqa: E402
from run_stage5_m193_preflight import instance_image_key  # noqa: E402

DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"

# The two instances that have already exposed provenance/instrumentation edge
# cases: psf/requests leaves an untracked `build/` in the checkout, which is the
# only place the pre-agent exclusion can be tested against something real, and
# pallets/flask is the src/ layout.
CONTROL_INSTANCES = ["psf__requests-1142", "pallets__flask-5014"]

P3_S1 = "M193C_P3 = 1  # staged\n"
P3_S2 = "M193C_P3 = 2  # current bytes, never staged\n"

# The pre-M193C production command, run LAST and only so that "0 mutations" is
# shown to be a measurement rather than an instrument that cannot report one.
SUPERSEDED_LABEL = "git add -A -- . <excl>; git diff --cached; git reset -q"


def host_path(mount: str, container_path: str) -> str:
    """The host side of the bind mount, which IS the checkout root."""
    return os.path.join(mount, os.path.relpath(container_path, CHECKOUT_ROOT))


def pick_targets(box: M193Container) -> dict[str, str] | None:
    """Four tracked .py files in the package under test, chosen deterministically."""
    rec = box.exec_raw(
        f"git -C {CHECKOUT_ROOT} ls-files '*.py' | grep -v '^tests\\?/' | sort | head -40",
        timeout=120,
        label="m193c_pick_targets",
    )
    files = [f for f in rec.stdout.split() if f.endswith(".py")]
    if len(files) < 4:
        return None
    return {"p2": files[0], "p3": files[1], "p5": files[2], "p6": files[3]}


def run_instance(row: dict[str, Any], work_root: str) -> dict[str, Any]:
    iid = row["instance_id"]
    try:
        from swebench.harness.test_spec.test_spec import make_test_spec

        env = conda_env_for(make_test_spec(row).eval_script)
    except Exception:
        env = "testbed"

    spec = InstanceSpec(iid, row["repo"], row["base_commit"], instance_image_key(iid), "", env)
    out: dict[str, Any] = {"instanceId": iid, "repo": row["repo"], "verdict": "CONTROL_FAILED", "errors": []}
    box = M193Container(spec, os.path.join(work_root, iid))
    try:
        setup = box.setup()
        out["preexistingUntracked"] = list(setup.preexisting_untracked)
        out["headAfterCheckout"] = setup.head_after_checkout
        if not setup.ok:
            out["errors"].append(f"setup: {setup.errors}")
            return out

        targets = pick_targets(box)
        if targets is None:
            out["errors"].append("fewer than four tracked python files to mutate")
            return out
        out["targets"] = targets
        mount = setup.host_mount or ""

        # A clean tree must snapshot to the empty patch, and must ANSWER while
        # doing so. If it does not, everything afterwards measures the image.
        clean_before = box.capture_repository_state()
        clean, _ = box.capture_patch_snapshot()
        clean_after = box.capture_repository_state()
        out["cleanTree"] = {
            "ok": clean["ok"],
            "status": clean["status"],
            "patchEmpty": clean["patch"] == "",
            "moved": repository_state_differences(clean_before, clean_after),
            "error": clean["error"],
        }

        def h(rel: str) -> str:
            return host_path(mount, os.path.join(CHECKOUT_ROOT, rel))

        # ── every Git state class an arm can leave behind ──
        with open(h(targets["p2"]), "a") as fh:  # P2 unstaged tracked edit
            fh.write("\n\nM193C_P2 = 1\n")

        with open(h(targets["p3"]), "a") as fh:  # P3 staged S1 ...
            fh.write("\n\n" + P3_S1)
        box.exec_raw(f"git -C {CHECKOUT_ROOT} add -- {targets['p3']}", 120, "m193c_stage_p3")
        p3_body = open(h(targets["p3"]), "rb").read()
        p3_s2_body = p3_body[: -len(P3_S1.encode())] + P3_S2.encode()
        with open(h(targets["p3"]), "wb") as fh:  # ... then unstaged S2
            fh.write(p3_s2_body)

        p1_rel = "m193c_agent_staged_new.py"  # P1 staged-only, a new file
        with open(h(p1_rel), "w") as fh:
            fh.write("M193C_P1 = 1\n")
        box.exec_raw(f"git -C {CHECKOUT_ROOT} add -- {p1_rel}", 120, "m193c_stage_p1")

        p4_rel = "m193c_agent_created.py"  # P4 untracked new source, via Write
        with open(h(p4_rel), "w") as fh:
            fh.write("M193C_P4 = 1\n")

        os.remove(h(targets["p5"]))  # P5 deletion
        p6_new = os.path.join(os.path.dirname(targets["p6"]), "m193c_renamed.py")  # P6 rename
        box.exec_raw(f"git -C {CHECKOUT_ROOT} mv -- {targets['p6']} {p6_new}", 120, "m193c_rename_p6")

        # ── the observation, bracketed by two whole-repository fingerprints ──
        before = box.capture_repository_state()
        status_before = box.exec_raw(f"git -C {CHECKOUT_ROOT} status --porcelain=v2", 120, "m193c_status_before").stdout
        index_before = box.exec_raw(f"git -C {CHECKOUT_ROOT} ls-files -s", 120, "m193c_index_before").stdout
        p3_staged_before = box.exec_raw(
            f"git -C {CHECKOUT_ROOT} rev-parse :{targets['p3']}", 120, "m193c_p3_staged_before"
        ).stdout.strip()

        snap, _rec = box.capture_patch_snapshot()

        after = box.capture_repository_state()
        status_after = box.exec_raw(f"git -C {CHECKOUT_ROOT} status --porcelain=v2", 120, "m193c_status_after").stdout
        index_after = box.exec_raw(f"git -C {CHECKOUT_ROOT} ls-files -s", 120, "m193c_index_after").stdout
        p3_staged_after = box.exec_raw(
            f"git -C {CHECKOUT_ROOT} rev-parse :{targets['p3']}", 120, "m193c_p3_staged_after"
        ).stdout.strip()

        moved = repository_state_differences(before, after)
        out["purity"] = {
            "moved": moved,
            "mutationCount": len(moved),
            "statusUnchanged": status_before == status_after,
            "indexUnchanged": index_before == index_after,
            "stagedBlobUnchanged": p3_staged_before == p3_staged_after,
            "stagedBlob": p3_staged_before,
        }

        patch = snap["patch"]
        expected = {
            "P1_staged_only_new_file": (p1_rel, f"a/{p1_rel}"),
            "P2_unstaged_modification": (targets["p2"], "M193C_P2 = 1"),
            "P3_staged_plus_unstaged": (targets["p3"], P3_S2.strip()),
            "P4_untracked_new_source": (p4_rel, f"a/{p4_rel}"),
            "P5_deletion": (targets["p5"], f"a/{targets['p5']}"),
            "P6_rename_new_path": (p6_new, f"a/{p6_new}"),
            "P6_rename_vacated_path": (targets["p6"], f"a/{targets['p6']}"),
        }
        out["stateClasses"] = {
            k: {"path": p, "represented": needle in patch} for k, (p, needle) in expected.items()
        }
        out["snapshot"] = {
            "ok": snap["ok"],
            "status": snap["status"],
            "authority": snap["authority"],
            "trackedCount": snap["trackedCount"],
            "untrackedCount": snap["untrackedCount"],
            "patchBytes": len(patch.encode()),
            "binaryPaths": snap["binaryPaths"],
            "gitState": snap["gitState"],
            "error": snap["error"],
        }
        # §14: the captured patch must hold the worktree bytes, never the staged
        # ones, while the staged ones stay in the index.
        out["currentByteProof"] = {
            "path": targets["p3"],
            "capturedHoldsWorktreeBytes": P3_S2.strip() in patch,
            "capturedHoldsStagedBytes": P3_S1.strip() in patch,
            "indexStillHoldsStagedBytes": p3_staged_after == p3_staged_before,
        }
        out["preexistingUntrackedExcluded"] = not any(
            f"a/{p}" in patch or f"b/{p}" in patch for p in box.preexisting_untracked
        )

        # ── the superseded implementation, on the same real tree, LAST ──
        # It resets the index, so nothing above may depend on state after it.
        excl = exclusion_pathspec(box.preexisting_untracked)
        sup_before = box.capture_repository_state()
        box.exec_raw(
            f"git -C {CHECKOUT_ROOT} -c core.fileMode=false add -A -- . {excl} >/dev/null 2>&1; "
            f"git -C {CHECKOUT_ROOT} -c core.fileMode=false diff --cached >/dev/null; "
            f"git -C {CHECKOUT_ROOT} reset -q >/dev/null 2>&1",
            300,
            "m193c_superseded_authority",
        )
        sup_after = box.capture_repository_state()
        sup_moved = repository_state_differences(sup_before, sup_after)
        staged_after_sup = box.exec_raw(
            f"git -C {CHECKOUT_ROOT} diff --cached --name-only", 120, "m193c_staged_after_superseded"
        ).stdout
        out["supersededAuthority"] = {
            "command": SUPERSEDED_LABEL,
            "moved": sup_moved,
            "mutationCount": len(sup_moved),
            "destroyedAgentStaging": staged_after_sup.strip() == "",
            # the fingerprint has now reported a real mutation on this same tree
            "fingerprintCanReportMutation": len(sup_moved) > 0,
        }

        checks = {
            "clean_tree_answers_empty": clean["ok"] and clean["patch"] == "" and not out["cleanTree"]["moved"],
            "all_state_classes_represented": all(v["represented"] for v in out["stateClasses"].values()),
            "snapshot_answered": snap["ok"],
            "zero_mutations": len(moved) == 0,
            "status_unchanged": status_before == status_after,
            "index_unchanged": index_before == index_after,
            "staged_blob_unchanged": p3_staged_before == p3_staged_after and bool(p3_staged_before),
            "captured_worktree_not_staged_bytes": out["currentByteProof"]["capturedHoldsWorktreeBytes"]
            and not out["currentByteProof"]["capturedHoldsStagedBytes"],
            "preexisting_untracked_excluded": out["preexistingUntrackedExcluded"],
            "fingerprint_can_report_mutation": out["supersededAuthority"]["fingerprintCanReportMutation"],
        }
        out["checks"] = checks
        out["failedChecks"] = sorted(k for k, v in checks.items() if not v)
        out["verdict"] = "CONTROL_PASSED" if not out["failedChecks"] else "CONTROL_FAILED"
        return out
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"{type(exc).__name__}: {exc}")
        return out
    finally:
        box.teardown()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=DATASET)
    ap.add_argument("--instances", default=",".join(CONTROL_INSTANCES))
    ap.add_argument("--work-root", default="/tmp/m193c_container_control")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.work_root, exist_ok=True)
    rows = load_instances(args.dataset)
    wanted = [s for s in args.instances.split(",") if s.strip()]

    results = []
    for iid in wanted:
        if iid not in rows:
            results.append({"instanceId": iid, "verdict": "CONTROL_FAILED", "errors": ["not in dataset"]})
            continue
        t0 = time.time()
        r = run_instance(rows[iid], args.work_root)
        r["durationMs"] = int((time.time() - t0) * 1000)
        results.append(r)
        print(f"  {iid:<28} {r['verdict']:<16} failed={r.get('failedChecks')} errors={r.get('errors')}")

    doc = {
        "schemaVersion": "stage5.m193c.container-control.v1",
        "milestone": "M193C",
        "liveModelCalls": 0,
        "liveModelSpendUsd": 0,
        "dataset": args.dataset,
        "results": results,
        "verdict": "ALL_CONTROLS_PASSED"
        if results and all(r["verdict"] == "CONTROL_PASSED" for r in results)
        else "CONTROL_FAILED",
    }
    with open(args.out, "w") as fh:
        fh.write(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {args.out}\nverdict: {doc['verdict']}")
    shutil.rmtree(args.work_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

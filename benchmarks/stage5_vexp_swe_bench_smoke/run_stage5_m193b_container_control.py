"""M193B §14 — the changed-source authority against a real instance container.

Temporary Git repositories prove the command is correct. They do not prove it is
correct on the tree an arm actually gets: a SWE-bench image ships its own
untracked build output, its own `.gitignore`, its own conda checkout ownership,
and a `git` old enough to have its own defaults. So the change classes are
reproduced inside the real container, through the same host bind mount an
agent's Edit and Write tools write through, and read back through
`M193Container.changed_source_state()` — the production path, not a re-statement
of it.

No model is called. No agent is launched. The mutations here are performed by
this script.
"""

from __future__ import annotations

import argparse
import hashlib
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
from run_stage5_m193_preflight import instance_image_key  # noqa: E402

DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"

# psf/requests is the mandated regression control: it is the instance whose
# image leaves an untracked `build/` in the checkout, so it is the only place
# the pre-agent exclusion (§10) can be tested against something real.
CONTROL_INSTANCES = ["psf__requests-1142", "pallets__flask-5014"]

C3_S1 = "M193B_C3 = 1  # staged\n"
C3_S2 = "M193B_C3 = 2  # current bytes, never staged\n"


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def host_path(mount: str, container_path: str) -> str:
    """The host side of the bind mount, which IS the checkout root."""
    return os.path.join(mount, os.path.relpath(container_path, CHECKOUT_ROOT))


def pick_targets(box: M193Container) -> dict[str, str] | None:
    """Five tracked .py files in the package under test, chosen deterministically."""
    rec = box.exec_raw(
        f"git -C {CHECKOUT_ROOT} ls-files '*.py' | grep -v '^tests\\?/' | sort | head -40",
        timeout=120,
        label="m193b_pick_targets",
    )
    files = [f for f in rec.stdout.split() if f.endswith(".py")]
    if len(files) < 5:
        return None
    return {"c1": files[0], "c2": files[1], "c3": files[2], "c5": files[3], "c6": files[4]}


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
            out["errors"].append("fewer than five tracked python files to mutate")
            return out
        out["targets"] = targets
        mount = setup.host_mount or ""

        # A clean tree must enumerate to nothing. If it does not, everything
        # afterwards is measuring the image rather than the agent.
        clean = box.changed_source_state()
        out["cleanTree"] = {"ok": clean["ok"], "paths": clean["relativePaths"], "error": clean["error"]}

        # ── the change classes, written through the host mount ──
        def h(rel: str) -> str:
            return host_path(mount, os.path.join(CHECKOUT_ROOT, rel))

        with open(h(targets["c1"]), "a") as fh:  # C1 unstaged tracked edit
            fh.write("\n\nM193B_C1 = 1\n")

        with open(h(targets["c2"]), "a") as fh:  # C2 staged
            fh.write("\n\nM193B_C2 = 1\n")
        box.exec_raw(f"git -C {CHECKOUT_ROOT} add -- {targets['c2']}", 120, "m193b_stage_c2")

        with open(h(targets["c3"]), "a") as fh:  # C3 staged S1 ...
            fh.write("\n\n" + C3_S1)
        box.exec_raw(f"git -C {CHECKOUT_ROOT} add -- {targets['c3']}", 120, "m193b_stage_c3")
        c3_body = open(h(targets["c3"]), "rb").read()
        c3_s2_body = c3_body[: -len(C3_S1.encode())] + C3_S2.encode()
        with open(h(targets["c3"]), "wb") as fh:  # ... then unstaged S2
            fh.write(c3_s2_body)

        new_rel = "m193b_agent_created.py"  # C4 untracked new source, via Write
        with open(h(new_rel), "w") as fh:
            fh.write("M193B_C4 = 1\n")

        os.remove(h(targets["c5"]))  # C5 deletion
        c6_new = os.path.join(os.path.dirname(targets["c6"]), "m193b_renamed.py")
        box.exec_raw(f"git -C {CHECKOUT_ROOT} mv -- {targets['c6']} {c6_new}", 120, "m193b_rename_c6")

        status_before = box.exec_raw(f"git -C {CHECKOUT_ROOT} status --porcelain", 120, "m193b_status_before").stdout
        staged_before = box.exec_raw(
            f"git -C {CHECKOUT_ROOT} diff --cached --name-only", 120, "m193b_staged_before"
        ).stdout

        # ── the production authority, on the real tree ──
        state = box.changed_source_state()
        rels = set(state["relativePaths"])
        expected = {
            "C1_unstaged_modification": targets["c1"],
            "C2_staged_modification": targets["c2"],
            "C3_staged_plus_unstaged": targets["c3"],
            "C4_untracked_new_source": new_rel,
            "C5_deletion": targets["c5"],
            "C6_rename_new_path": c6_new,
            "C6_rename_vacated_path": targets["c6"],
        }
        out["changeClasses"] = {k: {"path": v, "discovered": v in rels} for k, v in expected.items()}
        out["enumeration"] = {
            "ok": state["ok"],
            "error": state["error"],
            "count": len(state["relativePaths"]),
            "paths": state["relativePaths"],
            "authority": state["authority"],
        }

        status_after = box.exec_raw(f"git -C {CHECKOUT_ROOT} status --porcelain", 120, "m193b_status_after").stdout
        staged_after = box.exec_raw(
            f"git -C {CHECKOUT_ROOT} diff --cached --name-only", 120, "m193b_staged_after"
        ).stdout
        out["nonMutating"] = {
            "statusUnchanged": status_before == status_after,
            "stagedUnchanged": staged_before == staged_after,
            "stagedPathsStillPresent": sorted(p for p in staged_after.split() if p),
        }

        # ── §8 current bytes ──
        sv = box.source_version_evidence(
            is_validation_attempt=True,
            runner_started=True,
            state_hash_before="h",
            state_hash_after="h",
        )
        c3_abs = os.path.join(CHECKOUT_ROOT, targets["c3"])
        c3_rec = next((f for f in (sv.get("files") or []) if f.get("path") == c3_abs), None)
        out["currentByteProof"] = {
            "path": c3_abs,
            "stagedBlobSha256": sha256_bytes(
                box.exec_raw(
                    f"git -C {CHECKOUT_ROOT} show :{targets['c3']}", 120, "m193b_show_staged"
                ).stdout.encode()
            ),
            "worktreeSha256": sha256_bytes(c3_s2_body),
            "probeSourceSha256": (c3_rec or {}).get("sourceSha256"),
            "probeSawWorktreeBytes": (c3_rec or {}).get("sourceSha256") == sha256_bytes(c3_s2_body),
        }
        out["sourceVersionEvidence"] = {
            "probeRan": sv.get("probeRan"),
            "changedSourceFileCount": sv.get("changedSourceFileCount"),
            "fileVerdictCount": len(sv.get("fileVerdicts") or []),
            "countsAgree": sv.get("changedSourceFileCount") == len(sv.get("fileVerdicts") or []),
            "verdicts": sorted(set(sv.get("fileVerdicts") or [])),
            "error": sv.get("error"),
        }

        # ── the superseded implementation, on the same real tree, LAST ──
        # It resets the index, so nothing above may depend on state after it.
        excl = exclusion_pathspec(box.preexisting_untracked)
        sup = box.exec_raw(
            f"git -C {CHECKOUT_ROOT} -c core.fileMode=false add -A -- . {excl} >/dev/null 2>&1; "
            f"git -C {CHECKOUT_ROOT} -c core.fileMode=false diff --cached --name-only; "
            f"git -C {CHECKOUT_ROOT} reset -q >/dev/null 2>&1",
            300,
            "m193b_superseded_authority",
        )
        sup_rels = {p for p in sup.stdout.split() if p}
        staged_after_sup = box.exec_raw(
            f"git -C {CHECKOUT_ROOT} diff --cached --name-only", 120, "m193b_staged_after_superseded"
        ).stdout
        out["supersededAuthority"] = {
            "command": "git add -A -- . <excl>; git diff --cached --name-only; git reset -q",
            "count": len(sup_rels),
            "missedRenameVacatedPath": targets["c6"] not in sup_rels,
            "sawRenameNewPath": c6_new in sup_rels,
            "destroyedAgentStaging": staged_after_sup.strip() == "",
        }

        checks = [
            clean["ok"] and not clean["relativePaths"],
            all(v["discovered"] for v in out["changeClasses"].values()),
            state["ok"],
            not (set(box.preexisting_untracked) & rels),
            out["nonMutating"]["statusUnchanged"] and out["nonMutating"]["stagedUnchanged"],
            out["currentByteProof"]["probeSawWorktreeBytes"] is True,
            out["sourceVersionEvidence"]["countsAgree"] is True,
        ]
        out["failedChecks"] = [i for i, c in enumerate(checks) if not c]
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
    ap.add_argument("--work-root", default="/tmp/m193b_container_control")
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
        "schemaVersion": "stage5.m193b.container-control.v1",
        "milestone": "M193B",
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

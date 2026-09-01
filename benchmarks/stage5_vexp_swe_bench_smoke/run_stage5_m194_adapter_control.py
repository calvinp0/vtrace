"""M194 — the adapter control: prove the execution seam on a real container,
before any model is launched.

The Claude Code CLI falls back to the ORIGINAL tool input when a PreToolUse hook
returns no usable `updatedInput`. An adapter that is merely probably correct
would therefore not fail loudly; it would run the agent's `pytest` on the host,
in an environment where the package under test is absent, and every arm in the
corpus would record a natural-looking validation failure that the agent never
caused. So the seam is exercised end to end here, for $0, against a real
instance image:

  1. the frozen wrapper this adapter builds is byte-identical to the frozen
     wrapper the container adapter builds;
  2. a PreToolUse payload produces a routed command, and running that command
     the way the Bash tool would runs it in the CONTAINER, at /testbed, with the
     package importable;
  3. the two streams come back separated and complete, including the case where
     the runner writes its markers to one and its results to the other;
  4. a host absolute path inside the mount is translated rather than handed to
     the container as a path that does not exist there;
  5. an unroutable call is DENIED rather than allowed through to the host;
  6. the snapshot boundaries fire, and the repository state either side of every
     observation is identical — the observer does not write.

    <vexp>/.venv/bin/python run_stage5_m194_adapter_control.py \
        --instance pallets__flask-5014 --out results/stage5_m194_adapter_control.json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import shlex
import tempfile
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
from m193c_patch_snapshot import repository_state_differences  # noqa: E402
from run_stage5_m194_acquire import CLI_BINARY, CLI_VERSION, sandbox_prefix  # noqa: E402
import m194_adapter_hooks as adapter  # noqa: E402

DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"
IMPORT_NAMES = {
    "astropy/astropy": "astropy", "django/django": "django",
    "matplotlib/matplotlib": "matplotlib", "mwaskom/seaborn": "seaborn",
    "pallets/flask": "flask", "psf/requests": "requests",
    "pydata/xarray": "xarray", "pylint-dev/pylint": "pylint",
    "pytest-dev/pytest": "_pytest", "scikit-learn/scikit-learn": "sklearn",
    "sphinx-doc/sphinx": "sphinx", "sympy/sympy": "sympy",
}


def instance_image_key(iid: str, arch: str = "x86_64") -> str:
    return f"swebench/sweb.eval.{arch}.{iid.replace('__', '_1776_').lower()}:latest"


def hook(config_path: str, event: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Invoke the hook exactly as Claude Code would: argv, stdin JSON, stdout JSON."""
    proc = subprocess.run(
        [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "m194_adapter_hooks.py"),
         "--config", config_path, "--event", event],
        input=json.dumps(payload), capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        return {"_hookFailed": True, "stderr": proc.stderr[-2000:]}
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except Exception as exc:  # noqa: BLE001
        return {"_unparseable": str(exc), "stdout": out[-2000:], "stderr": proc.stderr[-2000:]}


def run_as_bash_tool(command: str, timeout: int = 600) -> dict[str, Any]:
    """What the Bash tool does with the rewritten command: run it on the host."""
    t0 = time.time()
    proc = subprocess.run(["/bin/bash", "-c", command], capture_output=True, text=True,
                          timeout=timeout, errors="replace")
    return {
        "exitCode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "durationMs": int((time.time() - t0) * 1000),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", default="pallets__flask-5014")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rows = load_instances(DATASET)
    row = rows[args.instance]
    repo = row["repo"]
    try:
        from swebench.harness.test_spec.test_spec import make_test_spec
        env = conda_env_for(make_test_spec(row).eval_script)
    except Exception:
        env = "testbed"

    spec = InstanceSpec(args.instance, repo, row["base_commit"], instance_image_key(args.instance),
                        IMPORT_NAMES[repo], env)

    work = tempfile.mkdtemp(prefix="m194-adapter-control-")
    arm_root = os.path.join(work, "arm")
    os.makedirs(os.path.join(arm_root, "raw", "snapshots"), exist_ok=True)

    report: dict[str, Any] = {
        "schemaVersion": "stage5.m194.adapter-control.v1",
        "milestone": "M194",
        "instanceId": args.instance,
        "repo": repo,
        "checks": {},
        "evidence": {},
        "verdict": "ADAPTER_CONTROL_FAILED",
    }

    box = M193Container(spec, arm_root)
    try:
        setup = box.setup()
        report["evidence"]["setup"] = {
            "ok": setup.ok, "errors": setup.errors, "head": setup.head_after_checkout,
            "baseCommit": row["base_commit"], "hostMount": setup.host_mount,
            "preexistingUntracked": setup.preexisting_untracked,
        }
        if not setup.ok:
            report["checks"]["C0_container"] = False
            return finish(report, args.out, box, work)
        report["checks"]["C0_container"] = True

        robustness, neutral = box.provenance_robustness()
        config = {
            "armId": "control", "instanceId": args.instance, "repo": repo,
            "armRoot": arm_root,
            "baseCommit": row["base_commit"],
            "imageKey": spec.image_key,
            "importName": spec.import_name,
            "provenanceRobustness": robustness,
            "moduleFileNeutralCwd": neutral,
            "containerName": box.name,
            "condaEnv": env,
            "hostMount": box.host_mount,
            "hostUid": box.host_uid, "hostGid": box.host_gid,
            "preexistingUntracked": box.preexisting_untracked,
            "eventLogPath": os.path.join(arm_root, "raw", "adapter_events.jsonl"),
            "sequencePath": os.path.join(arm_root, "raw", "adapter_sequence"),
            "snapshotDir": os.path.join(arm_root, "raw", "snapshots"),
        }
        config_path = os.path.join(arm_root, "adapter.json")
        with open(config_path, "w") as fh:
            json.dump(config, fh, indent=2)

        # ── 1. the wrapper does not drift from the frozen one ────────
        mine = adapter.frozen_wrapper(config, "echo probe")
        theirs = box.wrap("echo probe")
        report["checks"]["C1_wrapper_identical_to_frozen"] = mine == theirs
        report["evidence"]["wrapper"] = {"adapter": mine, "frozen": theirs}

        # ── 2. a routed command runs in the container ────────────────
        state_before = box.capture_repository_state()

        probe_cmd = (
            "pwd; python -c \"import %s as m; print('MODULE', m.__file__)\"; "
            "echo 'ON_STDERR' 1>&2" % spec.import_name
        )
        pre = hook(config_path, "pre", {
            "tool_name": "Bash", "tool_use_id": "probe-1",
            "tool_input": {"command": probe_cmd, "description": "probe"},
        })
        routed = (((pre or {}).get("hookSpecificOutput") or {}).get("updatedInput") or {}).get("command")
        report["checks"]["C2_pre_returned_updated_input"] = isinstance(routed, str) and "docker exec" in routed
        report["evidence"]["routedCommandHead"] = (routed or "")[:300]

        result = run_as_bash_tool(routed) if routed else {"exitCode": None, "stdout": "", "stderr": ""}
        merged = result["stdout"] + result["stderr"]
        report["evidence"]["probeResult"] = {
            "exitCode": result["exitCode"],
            "stdoutTail": result["stdout"][-600:],
            "stderrTail": result["stderr"][-600:],
        }
        report["checks"]["C3_workdir_is_checkout_root"] = CHECKOUT_ROOT in result["stdout"].splitlines()[0:1]
        report["checks"]["C4_package_imports_in_container"] = f"MODULE {CHECKOUT_ROOT}/" in merged
        report["checks"]["C5_stderr_reaches_agent"] = "ON_STDERR" in merged

        post = hook(config_path, "post", {
            "tool_name": "Bash", "tool_use_id": "probe-1",
            "tool_input": {"command": routed},
            "tool_response": {"stdout": result["stdout"], "stderr": result["stderr"]},
        })
        report["evidence"]["postReturned"] = post

        events = read_events(config["eventLogPath"])
        bash_post = [e for e in events if e.get("kind") == "bash_post"]
        report["checks"]["C6_streams_captured_separately"] = bool(
            bash_post and bash_post[-1]["streamsCaptured"]
            and f"MODULE {CHECKOUT_ROOT}/" in bash_post[-1]["stdout"]
            and "ON_STDERR" in bash_post[-1]["stderr"]
            and "ON_STDERR" not in bash_post[-1]["stdout"]
        )
        report["checks"]["C21_exit_code_observed"] = bool(
            bash_post and bash_post[-1].get("shellExitObserved") and bash_post[-1].get("exitCode") == 0
        )
        report["evidence"]["capturedStreams"] = {
            "exitCode": (bash_post[-1].get("exitCode") if bash_post else None),
            "stdoutTail": (bash_post[-1]["stdout"][-400:] if bash_post else None),
            "stderrTail": (bash_post[-1]["stderr"][-400:] if bash_post else None),
        }

        # ── 3. a host absolute path is translated ────────────────────
        # A path that certainly exists at every base commit of every repository
        # in the fixture: the checkout root itself. An earlier version named
        # setup.py, which pallets/flask does not ship at this commit, and the
        # control reported a translation failure for a translation that worked.
        host_abs = box.host_mount
        pre2 = hook(config_path, "pre", {
            "tool_name": "Bash", "tool_use_id": "probe-2",
            "tool_input": {"command": f"ls -d {host_abs} && echo TRANSLATED_OK"},
        })
        routed2 = (((pre2 or {}).get("hookSpecificOutput") or {}).get("updatedInput") or {}).get("command")
        res2 = run_as_bash_tool(routed2) if routed2 else {"stdout": "", "stderr": "", "exitCode": None}
        report["checks"]["C7_host_path_translated"] = "TRANSLATED_OK" in (res2["stdout"] + res2["stderr"])
        report["evidence"]["translation"] = {
            "hostAbsolute": host_abs,
            "tail": (res2["stdout"] + res2["stderr"])[-300:],
        }

        # ── 4. an unroutable call is denied, not allowed ─────────────
        denied = hook(config_path, "pre", {
            "tool_name": "Bash", "tool_use_id": "probe-3", "tool_input": {"command": "   "},
        })
        decision = ((denied or {}).get("hookSpecificOutput") or {}).get("permissionDecision")
        report["checks"]["C8_empty_command_denied"] = decision == "deny"

        broken_cfg = os.path.join(arm_root, "missing.json")
        denied2 = hook(broken_cfg, "pre", {
            "tool_name": "Bash", "tool_use_id": "probe-4", "tool_input": {"command": "echo hi"},
        })
        decision2 = ((denied2 or {}).get("hookSpecificOutput") or {}).get("permissionDecision")
        report["checks"]["C9_unreadable_config_denied"] = decision2 == "deny"
        report["evidence"]["denials"] = {"emptyCommand": denied, "unreadableConfig": denied2}

        # ── 5. the boundaries fire ───────────────────────────────────
        witness = box.module_witness()
        host_module = os.path.join(box.host_mount, os.path.relpath(witness, CHECKOUT_ROOT))
        with open(host_module) as fh:
            original = fh.read()
        with open(host_module, "w") as fh:
            fh.write(original + "\n\nM194_ADAPTER_CONTROL = 1\n")
        hook(config_path, "post", {
            "tool_name": "Edit", "tool_use_id": "edit-1",
            "tool_input": {"file_path": host_module}, "tool_response": {"ok": True},
        })

        val_cmd = "python -m pytest tests -q --no-header -x -k test_nonexistent_marker_xyz"
        pre3 = hook(config_path, "pre", {
            "tool_name": "Bash", "tool_use_id": "val-1", "tool_input": {"command": val_cmd},
        })
        routed3 = (((pre3 or {}).get("hookSpecificOutput") or {}).get("updatedInput") or {}).get("command")
        res3 = run_as_bash_tool(routed3) if routed3 else {"stdout": "", "stderr": "", "exitCode": None}
        hook(config_path, "post", {
            "tool_name": "Bash", "tool_use_id": "val-1", "tool_input": {"command": routed3},
            "tool_response": {"stdout": res3["stdout"], "stderr": res3["stderr"]},
        })
        hook(config_path, "stop", {"hook_event_name": "Stop"})

        events = read_events(config["eventLogPath"])
        boundaries = [e["boundary"] for e in events if e.get("kind") == "patch_snapshot"]
        report["evidence"]["boundaries"] = boundaries
        report["checks"]["C10_after_edit_boundary"] = "AFTER_EDIT" in boundaries
        report["checks"]["C11_validation_boundaries"] = (
            "BEFORE_VALIDATION" in boundaries and "AFTER_VALIDATION" in boundaries
        )
        report["checks"]["C12_submit_boundary"] = "BEFORE_SUBMIT" in boundaries
        report["checks"]["C13_all_snapshots_ok"] = all(
            e.get("ok") for e in events if e.get("kind") == "patch_snapshot"
        )
        edit_snaps = [e for e in events if e.get("kind") == "patch_snapshot" and e["boundary"] == "AFTER_EDIT"]
        report["checks"]["C14_edit_visible_in_snapshot"] = bool(edit_snaps) and all(
            e["diffBytes"] > 0 for e in edit_snaps
        )

        prov = [e for e in events if e.get("kind") == "validation_provenance"]
        report["checks"]["C18_validation_provenance_captured"] = bool(prov and prov[-1].get("captured"))
        report["checks"]["C19_source_version_probe_ran"] = bool(
            prov and (prov[-1].get("probe") or {}).get("probeRan")
        )
        report["checks"]["C20_module_file_under_checkout"] = bool(
            prov and (prov[-1].get("moduleFile") or "").startswith(CHECKOUT_ROOT + "/")
        )
        report["evidence"]["provenance"] = {
            "robustness": robustness,
            "moduleFileNeutralCwd": neutral,
            "moduleFile": prov[-1].get("moduleFile") if prov else None,
            "probeRan": (prov[-1].get("probe") or {}).get("probeRan") if prov else None,
            "changedSourceFileCount": len(((prov[-1].get("probe") or {}).get("requestedPaths") or [])) if prov else None,
            "fileVerdicts": [f.get("verdict") for f in ((prov[-1].get("probe") or {}).get("files") or [])] if prov else None,
            "stateHashBefore": prov[-1].get("stateHashBefore") if prov else None,
            "stateHashAfter": prov[-1].get("stateHashAfter") if prov else None,
            "error": prov[-1].get("error") if prov else None,
        }

        # ── 5b. path unity: the agent's side is /testbed too ────────
        #
        # Everything above proved the CONTAINER half of the seam. This proves
        # the host half: inside the arm's mount namespace the same tree carries
        # the same absolute path, so `pwd`, a traceback and the Read tool cannot
        # disagree about where a file is.
        sb = sandbox_prefix(box.host_mount, arm_root)
        probe_script = (
            f"echo PWD=$(pwd); "
            f"test -f {CHECKOUT_ROOT}/{os.path.relpath(witness, CHECKOUT_ROOT)} && echo FILE_AT_TESTBED; "
            f"{CLI_BINARY} --version; "
            f"docker inspect -f ok {box.name}"
        )
        sandboxed = subprocess.run(sb + ["/bin/bash", "-c", probe_script],
                                   capture_output=True, text=True, timeout=300)
        sb_out = sandboxed.stdout + sandboxed.stderr
        report["evidence"]["sandbox"] = {"tail": sb_out[-500:], "exitCode": sandboxed.returncode}
        report["checks"]["C22_sandbox_cwd_is_checkout_root"] = "PWD=" + CHECKOUT_ROOT in sb_out
        report["checks"]["C23_source_visible_at_checkout_root"] = "FILE_AT_TESTBED" in sb_out
        report["checks"]["C24_pinned_cli_runs_in_sandbox"] = CLI_VERSION in sb_out
        report["checks"]["C25_docker_reachable_in_sandbox"] = "ok" in sb_out

        # The hooks themselves run inside that namespace, because the CLI spawns
        # them, so the routing is exercised from there rather than from here.
        hook_payload = json.dumps({
            "tool_name": "Bash", "tool_use_id": "sandbox-1",
            "tool_input": {"command": "pwd && python -c \"import %s as m; print(m.__file__)\"" % spec.import_name},
        })
        hook_cmd = (
            f"printf %s {shlex.quote(hook_payload)} | "
            f"{shlex.quote(sys.executable)} {shlex.quote(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'm194_adapter_hooks.py'))} "
            f"--config {shlex.quote(config_path)} --event pre"
        )
        hooked = subprocess.run(sb + ["/bin/bash", "-c", hook_cmd], capture_output=True, text=True, timeout=300)
        routed_sb = None
        try:
            routed_sb = json.loads(hooked.stdout)["hookSpecificOutput"]["updatedInput"]["command"]
        except Exception:  # noqa: BLE001
            pass
        report["checks"]["C26_hook_routes_from_inside_sandbox"] = bool(routed_sb and "docker exec" in routed_sb)
        ran_sb = subprocess.run(sb + ["/bin/bash", "-c", routed_sb], capture_output=True, text=True,
                                timeout=600) if routed_sb else None
        sb_ran_out = (ran_sb.stdout + ran_sb.stderr) if ran_sb else ""
        report["checks"]["C27_routed_command_runs_from_sandbox"] = (
            CHECKOUT_ROOT in sb_ran_out and f"{CHECKOUT_ROOT}/" in sb_ran_out
        )
        report["evidence"]["sandboxRouted"] = {"tail": sb_ran_out[-400:]}

        # ── 6. the observer did not write ───────────────────────────
        with open(host_module, "w") as fh:
            fh.write(original)
        state_after = box.capture_repository_state()
        diffs = repository_state_differences(state_before, state_after)
        report["checks"]["C15_observation_did_not_write"] = diffs == []
        report["evidence"]["repositoryStateDifferences"] = diffs

        # ── 7. ordering is a strict total order ──────────────────────
        seqs = [e["sequence"] for e in events if "sequence" in e]
        report["checks"]["C16_sequence_strictly_increasing"] = seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
        report["evidence"]["sequenceCount"] = len(seqs)
        report["evidence"]["adapterErrors"] = [e for e in events if e.get("kind") == "adapter_error"]
        report["checks"]["C17_no_adapter_errors"] = not report["evidence"]["adapterErrors"]

        return finish(report, args.out, box, work)
    finally:
        try:
            box.teardown()
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(work, ignore_errors=True)


def read_events(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as fh:
        for ln in fh:
            if ln.strip():
                out.append(json.loads(ln))
    return out


def finish(report: dict[str, Any], out_path: str, box: Any, work: str) -> int:
    failed = [k for k, v in report["checks"].items() if not v]
    report["failedChecks"] = failed
    report["verdict"] = "M194_ADAPTER_CONTROL_PASSED" if not failed else "ADAPTER_CONTROL_FAILED"
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(report, fh, indent=2)
        fh.write("\n")
    for k in sorted(report["checks"]):
        print(f"  {'PASS' if report['checks'][k] else 'FAIL'}  {k}")
    print(f"\n{report['verdict']}")
    print(f"wrote {out_path}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())

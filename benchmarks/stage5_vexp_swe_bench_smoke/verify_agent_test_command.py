#!/usr/bin/env python3
"""M27 — diagnostic-only isolated agent-command runner (NON-ORACLE SWE-bench seam).

This script runs ONE planner-approved, canonicalized test command inside the correct
per-instance SWE-bench testbed and reports the raw outcome as JSON. It deliberately uses ONLY
the non-oracle environment seam identified in M25:

    make_test_spec → build_container → copy_to_container → GIT_APPLY_CMDS
    → exec_run_with_timeout (our command) → cleanup_container

and STOPS BEFORE any grading:

    grading.py / get_eval_report / get_resolution_status / resolved scoring

It NEVER imports or calls SWE-bench grading, NEVER consumes FAIL_TO_PASS/PASS_TO_PASS, and emits
JSON only — no oracle report. It is the future opt-in execution backend for
`--mode verify-agent-test-command --allow-docker-verify`; the TypeScript harness only invokes it
when Docker execution is explicitly authorized. It is NOT run during M27.

Output JSON shape (consumed by `defaultAgentCommandRunner`):

    {
      "dockerStarted": bool,
      "patchApplied": bool,
      "appliedPatchSha256": str | null,
      "commandRan": bool,
      "exitCode": int | null,
      "rawToolSuccess": bool | null,
      "stdout": str,
      "stderr": str,
      "worktreeDiffHashBeforeCommand": str | null,
      "worktreeDiffHashAfterCommand": str | null,
      "error": str | null
    }
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _emit(result: dict, output_path: str) -> None:
    payload = json.dumps(result, indent=2)
    Path(output_path).write_text(payload)
    # Also echo to stdout so the caller can capture it directly if it wants.
    sys.stdout.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnostic isolated agent-command runner (non-oracle).")
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--patch", required=True, help="Path to the patch file to apply.")
    parser.add_argument("--command", required=True, help="Canonical safe test command to run in the testbed.")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--output", required=True, help="Path to write the JSON result.")
    parser.add_argument("--dataset", default="princeton-nlp/SWE-bench", help="Dataset name or path for make_test_spec.")
    # Namespace selects the PREBUILT instance image on Docker Hub (TestSpec.is_remote_image ⇒
    # build_container PULLS swebench/sweb.eval.<arch>.<id __→_1776_>:<tag> instead of building the
    # base→env→instance chain locally). "swebench" matches the planner's derived expectedImageKey;
    # pass "" to force a local build instead.
    parser.add_argument("--namespace", default="swebench", help="Docker Hub namespace for the prebuilt instance image; empty string ⇒ build locally.")
    args = parser.parse_args()

    result: dict = {
        "dockerStarted": False,
        "patchApplied": False,
        "appliedPatchSha256": None,
        "commandRan": False,
        "exitCode": None,
        "rawToolSuccess": None,
        "stdout": "",
        "stderr": "",
        "worktreeDiffHashBeforeCommand": None,
        "worktreeDiffHashAfterCommand": None,
        "error": None,
    }

    patch_text = Path(args.patch).read_text()
    result["appliedPatchSha256"] = _sha256_text(patch_text)

    container = None
    client = None
    logger = None
    try:
        # NON-ORACLE seam imports only. No swebench.harness.grading, get_eval_report, etc.
        import docker  # type: ignore
        from swebench.harness.constants import (  # type: ignore
            DOCKER_PATCH,
            DOCKER_USER,
            DOCKER_WORKDIR,
            KEY_INSTANCE_ID,
            UTF8,
        )

        # GIT_APPLY_CMDS moved out of `swebench.harness.constants` (it now lives in
        # `swebench.harness.run_evaluation`, swebench >=4.x). We INLINE it rather than import
        # from run_evaluation on purpose: that module transitively imports the grading path
        # (get_eval_report / resolution scoring), which would violate this seam's non-oracle
        # guarantee. The value is a stable 3-element ordered list of patch-apply fallbacks.
        GIT_APPLY_CMDS = [
            "git apply --verbose",
            "git apply --verbose --reject",
            "patch --batch --fuzz=5 -p1 -i",
        ]
        from swebench.harness.docker_build import build_container  # type: ignore
        from swebench.harness.docker_utils import (  # type: ignore
            cleanup_container,
            copy_to_container,
            exec_run_with_timeout,
        )
        from swebench.harness.test_spec.test_spec import make_test_spec  # type: ignore
        from swebench.harness.utils import load_swebench_dataset  # type: ignore
        from swebench.harness.docker_build import setup_logger  # type: ignore

        # Resolve the instance + build its TestSpec (image/testbed identity). No grading data read.
        instances = load_swebench_dataset(args.dataset, instance_ids=[args.instance_id])
        instance = next(i for i in instances if i[KEY_INSTANCE_ID] == args.instance_id)
        namespace = args.namespace or None
        test_spec = make_test_spec(instance, namespace=namespace)

        run_id = f"vtrace-verify-{args.instance_id}"
        log_dir = Path("logs") / "verify" / args.instance_id
        log_dir.mkdir(parents=True, exist_ok=True)
        logger = setup_logger(args.instance_id, log_dir / "verify.log")
        client = docker.from_env()

        # Build + start the instance container (build the image if needed; non-oracle).
        container = build_container(test_spec, client, run_id, logger, nocache=False, force_rebuild=False)
        container.start()
        result["dockerStarted"] = True

        # Copy + apply the patch using SWE-bench's own GIT_APPLY_CMDS (no grading involved).
        patch_file = log_dir / "patch.diff"
        patch_file.write_text(patch_text)
        copy_to_container(container, patch_file, PurePosixPath(DOCKER_PATCH))
        for git_apply_cmd in GIT_APPLY_CMDS:
            val = container.exec_run(f"{git_apply_cmd} {DOCKER_PATCH}", workdir=DOCKER_WORKDIR, user=DOCKER_USER)
            if val.exit_code == 0:
                result["patchApplied"] = True
                break
        if not result["patchApplied"]:
            result["error"] = "patch_apply_failed"
            _emit(result, args.output)
            return 0

        # Record the worktree diff before our command.
        diff_before = container.exec_run(
            "git -c core.fileMode=false diff", workdir=DOCKER_WORKDIR
        ).output.decode(UTF8)
        result["worktreeDiffHashBeforeCommand"] = _sha256_text(diff_before)

        # Run OUR canonical safe command (NOT test_spec.eval_script — that path leads to grading).
        output, timed_out, _runtime = exec_run_with_timeout(
            container, f"/bin/bash -lc {json.dumps(args.command)}", args.timeout
        )
        result["commandRan"] = True
        result["stdout"] = output
        result["rawToolSuccess"] = (not timed_out)
        if timed_out:
            result["error"] = "command_timed_out"

        # Record the worktree diff after our command (tests may write artifacts; this proves state).
        diff_after = container.exec_run(
            "git -c core.fileMode=false diff", workdir=DOCKER_WORKDIR
        ).output.decode(UTF8)
        result["worktreeDiffHashAfterCommand"] = _sha256_text(diff_after)

    except Exception as exc:  # noqa: BLE001 — diagnostic surface; report, never grade.
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if container is not None and client is not None and logger is not None:
            try:
                cleanup_container(client, container, logger)
            except Exception:  # noqa: BLE001
                pass

    _emit(result, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

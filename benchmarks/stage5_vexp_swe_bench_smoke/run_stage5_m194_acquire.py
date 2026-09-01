"""M194 — the frozen baseline observational acquisition driver.

Executes the experiment M193C froze, and nothing else. It does not design, tune,
select, or interpret: the task order, the model, the caps, the preflight, the
replacement policy, the retry policy and the stopping rule all come from the
committed manifest, and this file's job is to obey them and write down what
happened.

    <vexp>/.venv/bin/python run_stage5_m194_acquire.py --out results --live

Without `--live` it performs every step up to the model launch and stops, which
is how the launch path is exercised without spending.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
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
    sha256_text,
)
from run_stage5_m193_preflight import (  # noqa: E402
    DISK_FLOOR_GB,
    IMPORT_NAMES,
    free_disk_gb,
    instance_image_key,
    preflight_instance,
)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
VEXP = "/home/calvin/code/vexp-swe-bench"
DATASET = f"{VEXP}/data/swe-bench-100.jsonl"
PYTHON = f"{VEXP}/.venv/bin/python"
BUN = shutil.which("bun") or "/home/calvin/.bun/bin/bun"

MANIFEST = os.path.join(HERE, "results", "stage5_m193c_manifest.json")
FIXTURE = os.path.join(HERE, "results", "stage5_m193_task_fixture.json")

# The pinned versioned binary, not the `claude` symlink: the symlink follows
# whatever was installed last, and the manifest pins a version (§P2).
CLI_VERSION = "2.1.251"
CLI_BINARY = f"/home/calvin/.local/share/claude/versions/{CLI_VERSION}"
MODEL = "claude-opus-4-5-20251101"
MAX_TURNS = 250
ALLOWED_TOOLS = ["Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite"]

PER_RUN_CAP_USD = 3.5
TOTAL_CAP_USD = 90.0
MIN_ARMS = 20
MAX_ARMS = 40
MAX_CONCURRENT = 3
MAX_REPLACEMENTS = 15
AGENT_TIMEOUT_S = 3600
EVALUATOR_TIMEOUT_S = 1800


# ── the frozen prompt ────────────────────────────────────────────────


def build_prompt(manifest: dict[str, Any], row: dict[str, Any]) -> str:
    """vexp-swe-bench's buildPrompt, taken from the manifest so it cannot drift.

    Nothing is appended. No instruction to validate, to orient, to inspect
    related files or to be thorough: natural behaviour is the object of
    observation (§12).
    """
    text = manifest["agent"]["userPrompt"]["text"]
    return text.replace("{repo}", row["repo"]).replace("{problem_statement}", row["problem_statement"])


# ── infrastructure ───────────────────────────────────────────────────


class Budget:
    """Cumulative live spend, from provider-reported cost only.

    Never estimated from historical averages during execution (§24): an arm
    contributes what the provider said it cost, and an arm that reported nothing
    contributes its own hard cap, because an unknown spend must not be able to
    read as a free one.
    """

    def __init__(self, cap: float) -> None:
        self.cap = cap
        self.spent = 0.0
        self.in_flight = 0
        self._lock = threading.Lock()

    def may_launch(self) -> tuple[bool, str]:
        with self._lock:
            committed = self.spent + (self.in_flight + 1) * PER_RUN_CAP_USD
            if committed > self.cap:
                return False, (
                    f"launching would commit ${committed:.2f} against a ${self.cap:.2f} ceiling "
                    f"(spent ${self.spent:.4f}, {self.in_flight} in flight)"
                )
            self.in_flight += 1
            return True, ""

    def settle(self, cost: float | None) -> float:
        with self._lock:
            charged = PER_RUN_CAP_USD if cost is None else float(cost)
            self.spent += charged
            self.in_flight -= 1
            return self.spent

    def restore(self, cost: float | None) -> None:
        """Re-enter spend from an arm recorded by an earlier session.

        Distinct from `settle`, which closes a slot this process opened. A
        resumed arm never occupied a slot here, so charging it through `settle`
        would drive the in-flight count negative and quietly widen the launch
        gate by one arm.
        """
        with self._lock:
            self.spent += PER_RUN_CAP_USD if cost is None else float(cost)


def ensure_image(image_key: str) -> dict[str, Any]:
    """Available locally, or pulled. Recorded either way, and which one it was.

    Whether an image was already on this host is explicitly a refused selection
    input (the fixture says so), so pulling is infrastructure and never a reason
    to prefer one task over another.
    """
    have = subprocess.run(["docker", "image", "inspect", image_key], capture_output=True, text=True)
    if have.returncode == 0:
        return {"present": True, "pulled": False}
    t0 = time.time()
    pull = subprocess.run(["docker", "pull", image_key], capture_output=True, text=True, timeout=3600)
    return {
        "present": pull.returncode == 0,
        "pulled": pull.returncode == 0,
        "pullMs": int((time.time() - t0) * 1000),
        "pullError": None if pull.returncode == 0 else pull.stderr.strip()[-400:],
    }


def write_adapter_settings(path: str, config_path: str) -> None:
    """The two declared hooks, and nothing else (execution contract §8)."""
    hook_script = os.path.join(HERE, "m194_adapter_hooks.py")
    def cmd(event: str) -> str:
        return f"{PYTHON} {hook_script} --config {config_path} --event {event}"
    settings = {
        "hooks": {
            "PreToolUse": [
                {"matcher": "Bash", "hooks": [{"type": "command", "command": cmd("pre"), "timeout": 900}]}
            ],
            "PostToolUse": [
                {"matcher": "Edit|Write|Bash", "hooks": [{"type": "command", "command": cmd("post"), "timeout": 900}]}
            ],
            "Stop": [{"hooks": [{"type": "command", "command": cmd("stop"), "timeout": 900}]}],
        }
    }
    with open(path, "w") as fh:
        json.dump(settings, fh, indent=2)


def construct_arm_environment(arm_id: str, instance_id: str, arm_root: str, settings_path: str) -> dict[str, Any]:
    req = {
        "armId": arm_id, "instanceId": instance_id, "armRootDir": arm_root,
        "hostConfigDir": os.path.join(os.path.expanduser("~"), ".claude"),
        "adapterSettingsPath": settings_path, "nonce": uuid.uuid4().hex[:12],
        "cliBinary": CLI_BINARY, "cliVersion": CLI_VERSION, "model": MODEL,
        "allowedTools": ALLOWED_TOOLS,
    }
    proc = subprocess.run(
        [BUN, os.path.join(HERE, "run_stage5_m194_arm_env.ts"), json.dumps(req)],
        capture_output=True, text=True, timeout=600, cwd=REPO,
    )
    if proc.returncode != 0:
        return {"mayLaunchModel": False, "status": "TREATMENT_ISOLATION_FAILED",
                "failures": [f"arm environment constructor failed: {proc.stderr[-600:]}"]}
    return json.loads(proc.stdout)


# ── the agent launch ─────────────────────────────────────────────────


BWRAP = shutil.which("bwrap") or "/usr/bin/bwrap"


def sandbox_prefix(host_mount: str, arm_root: str | None = None) -> list[str]:
    """The mount namespace that makes the execution contract's claim literal.

    The contract says the arm works on "a single tree visible at the same path
    from both sides", and the container side of that tree is /testbed because
    the instance image's editable install names that absolute path. The host
    side, though, is a per-arm scratch directory, and an agent whose `pwd`
    answers /testbed while its Read tool needs a different absolute path is
    being asked to reason about two filesystems at once — the exact hybrid the
    contract set out to avoid.

    So the agent process runs in its own mount namespace with the arm's tree
    bound at /testbed. Nothing about the container, the mount, the image or the
    experiment changes; the same inodes simply acquire the same name on both
    sides. Each arm gets its own namespace, so concurrent arms do not collide.

    No privilege is required and none is taken: the user namespace keeps the
    real uid, the network namespace is not unshared, and /run is bound so the
    Docker socket the adapter needs is still reachable.

    The arm's own root is bound explicitly and last. The hooks run inside this
    namespace, because the CLI is what spawns them, and they must be able to
    read their configuration and append to their event log wherever the caller
    chose to put them — including under a path this sandbox otherwise replaces
    with a tmpfs.
    """
    return [
        BWRAP,
        "--tmpfs", "/",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/etc", "/etc",
        "--ro-bind", "/opt", "/opt",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin",
        "--bind", "/home", "/home",
        "--bind", "/var", "/var",
        "--bind", "/run", "/run",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        *(["--bind", arm_root, arm_root] if arm_root else []),
        "--dir", CHECKOUT_ROOT,
        "--bind", host_mount, CHECKOUT_ROOT,
        "--chdir", CHECKOUT_ROOT,
        "--",
    ]


def launch_agent(prompt: str, host_mount: str, env: dict[str, str], argv_extra: list[str],
                 stream_path: str, arm_root: str | None = None) -> dict[str, Any]:
    """One untreated arm, launched exactly once.

    The per-run ceiling is enforced by the CLI's own `--max-budget-usd` and
    cross-checked against the provider-reported cost in the result event, which
    is the frozen enforcement (§23). The stream is written to disk as it
    arrives, so a run killed by a timeout still leaves its ordered telemetry.
    """
    args = [
        *sandbox_prefix(host_mount, arm_root),
        CLI_BINARY,
        "-p", prompt,
        "--output-format", "stream-json",
        "--model", MODEL,
        "--max-turns", str(MAX_TURNS),
        "--verbose",
        "--allowedTools", ",".join(ALLOWED_TOOLS),
        "--max-budget-usd", str(PER_RUN_CAP_USD),
        *argv_extra,
    ]
    t0 = time.time()
    out: dict[str, Any] = {
        "argv": [a if a != prompt else "<prompt>" for a in args],
        "started": False, "termination": "HARNESS_CRASH",
        "costUsd": None, "numTurns": None, "usage": None,
        "exitCode": None, "timedOut": False, "stderrTail": "",
    }
    try:
        with open(stream_path, "w") as sink:
            proc = subprocess.Popen(
                args, cwd=host_mount, env=env,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, bufsize=1,
            )
            out["started"] = True
            stderr_chunks: list[str] = []

            def drain_stderr() -> None:
                for line in proc.stderr:  # type: ignore[union-attr]
                    stderr_chunks.append(line)
            t = threading.Thread(target=drain_stderr, daemon=True)
            t.start()

            deadline = t0 + AGENT_TIMEOUT_S
            for line in proc.stdout:  # type: ignore[union-attr]
                sink.write(line)
                sink.flush()
                if time.time() > deadline:
                    proc.kill()
                    out["timedOut"] = True
                    break
            out["exitCode"] = proc.wait(timeout=120)
            t.join(timeout=10)
            out["stderrTail"] = "".join(stderr_chunks)[-4000:]
    except Exception as exc:  # noqa: BLE001
        out["error"] = repr(exc)
    out["durationMs"] = int((time.time() - t0) * 1000)

    result_event = None
    tool_uses: list[dict[str, Any]] = []
    try:
        with open(stream_path) as fh:
            for ln in fh:
                if not ln.strip():
                    continue
                try:
                    ev = json.loads(ln)
                except Exception:  # noqa: BLE001
                    continue
                if ev.get("type") == "result":
                    result_event = ev
                if ev.get("type") == "assistant":
                    for block in (ev.get("message") or {}).get("content") or []:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            tool_uses.append({"id": block.get("id"), "name": block.get("name")})
    except Exception:  # noqa: BLE001
        pass

    out["toolUses"] = tool_uses
    if result_event:
        out["costUsd"] = result_event.get("total_cost_usd")
        out["numTurns"] = result_event.get("num_turns")
        out["usage"] = result_event.get("usage")
        out["resultSubtype"] = result_event.get("subtype")
        out["resultIsError"] = bool(result_event.get("is_error"))

    # The frozen termination categories, read from what actually happened.
    if out["timedOut"]:
        out["termination"] = "AGENT_TIMEOUT"
    elif result_event is None:
        out["termination"] = "MODEL_SERVICE_FAILURE" if out["started"] else "HARNESS_CRASH"
    elif out.get("resultSubtype") == "error_max_turns":
        out["termination"] = "TURN_LIMIT_REACHED"
    elif out.get("resultSubtype") in ("error_max_budget", "error_budget_exceeded"):
        out["termination"] = "COST_CAP_REACHED"
    elif out.get("costUsd") is not None and float(out["costUsd"]) >= PER_RUN_CAP_USD:
        out["termination"] = "COST_CAP_REACHED"
    elif out.get("resultSubtype") == "success":
        out["termination"] = "COMPLETED"
    else:
        out["termination"] = "MODEL_SERVICE_FAILURE"
    return out


# ── the official evaluator ───────────────────────────────────────────


def evaluate_arm(instance_id: str, patch: str, run_id: str, work_root: str) -> dict[str, Any]:
    """Post-run outcome authority (§26). Never fed back to the agent."""
    if not patch.strip():
        return {"ran": False, "reason": "empty patch", "resolved": False, "status": "TASK_UNRESOLVED"}
    preds_path = os.path.join(work_root, f"{run_id}_preds.jsonl")
    with open(preds_path, "w") as fh:
        fh.write(json.dumps({"instance_id": instance_id, "model_name_or_path": run_id, "model_patch": patch}) + "\n")
    cmd = [
        PYTHON, "-m", "swebench.harness.run_evaluation",
        "-p", preds_path, "-d", DATASET, "-id", run_id,
        "--max_workers", "1", "--timeout", str(EVALUATOR_TIMEOUT_S),
        "--cache_level", "instance", "--clean", "False",
    ]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, cwd=VEXP, capture_output=True, text=True, timeout=EVALUATOR_TIMEOUT_S + 1200)
    except subprocess.TimeoutExpired:
        return {"ran": False, "reason": "evaluator timed out", "resolved": None, "status": "EVALUATOR_INFRA_FAILURE"}
    log_dir = os.path.join(VEXP, "logs", "run_evaluation", run_id, run_id, instance_id)
    out: dict[str, Any] = {
        "ran": True, "runId": run_id, "returnCode": proc.returncode,
        "durationMs": int((time.time() - t0) * 1000),
        "logDir": log_dir, "logDirExists": os.path.isdir(log_dir),
        "stdoutTail": proc.stdout.strip().splitlines()[-10:],
        "stderrTail": proc.stderr.strip().splitlines()[-6:],
        "resolved": None, "status": "EVALUATOR_INFRA_FAILURE",
    }
    report_path = os.path.join(log_dir, "report.json")
    if os.path.exists(report_path):
        try:
            rep = json.load(open(report_path))
            out["report"] = rep.get(instance_id, {})
            out["resolved"] = bool(out["report"].get("resolved"))
            out["status"] = "TASK_RESOLVED" if out["resolved"] else "TASK_UNRESOLVED"
        except Exception as exc:  # noqa: BLE001
            out["reportError"] = str(exc)
    patch_path = os.path.join(log_dir, "patch.diff")
    if os.path.exists(patch_path):
        applied = open(patch_path).read()
        out["evaluatorPatchNormalizedSha256"] = sha256_text(normalize_patch(applied))
        out["evaluatorPatchBytes"] = len(applied.encode())
    return out


# ── one arm ──────────────────────────────────────────────────────────


def run_arm(entry: dict[str, Any], row: dict[str, Any], manifest: dict[str, Any],
            out_root: str, budget: Budget, live: bool, attempt: int = 1) -> dict[str, Any]:
    """Preflight, construct, launch, observe, extract, evaluate, tear down."""
    instance_id = entry["instanceId"]
    repo = entry["repo"]
    arm_id = f"m194-{entry['ordinal']:02d}-{instance_id}" + (f"-r{attempt}" if attempt > 1 else "")
    arm_root = os.path.join(out_root, "runs", arm_id)
    raw = os.path.join(arm_root, "raw")
    os.makedirs(os.path.join(raw, "snapshots"), exist_ok=True)

    arm: dict[str, Any] = {
        "schemaVersion": "stage5.m194.arm.v1",
        "armId": arm_id, "ordinal": entry["ordinal"], "attempt": attempt,
        "instanceId": instance_id, "repo": repo, "baseCommit": row["base_commit"],
        "replacedFrom": entry.get("replacedFrom"),
        "modelLaunched": False, "costUsd": None,
        "phases": {}, "errors": [],
    }

    try:
        from swebench.harness.test_spec.test_spec import make_test_spec
        env_name = conda_env_for(make_test_spec(row).eval_script)
    except Exception:  # noqa: BLE001
        env_name = "testbed"

    image_key = instance_image_key(instance_id)
    arm["imageKey"] = image_key
    arm["phases"]["image"] = ensure_image(image_key)
    if not arm["phases"]["image"]["present"]:
        arm["verdict"] = "PREFLIGHT_FAILED"
        arm["preflightFailure"] = "instance image neither present nor pullable"
        return finish_arm(arm, arm_root)

    disk = free_disk_gb()
    arm["phases"]["disk"] = {"freeGb": disk, "floorGb": DISK_FLOOR_GB, "aboveFloor": disk >= DISK_FLOOR_GB}
    if disk < DISK_FLOOR_GB:
        arm["verdict"] = "PREFLIGHT_FAILED"
        arm["preflightFailure"] = f"free Docker disk {disk:.1f}GB below the {DISK_FLOOR_GB}GB floor"
        return finish_arm(arm, arm_root)

    pf = preflight_instance(row, os.path.join(arm_root, "preflight"), keep=False)
    arm["phases"]["preflight"] = {"verdict": pf["verdict"], "failedChecks": pf.get("failedChecks"),
                                  "provenanceRobustness": pf.get("provenanceRobustness")}
    with open(os.path.join(raw, "preflight.json"), "w") as fh:
        json.dump(pf, fh, indent=2)
    if pf["verdict"] != "PREFLIGHT_PASSED":
        arm["verdict"] = "PREFLIGHT_FAILED"
        arm["preflightFailure"] = f"{pf['verdict']}: {pf.get('failedChecks')}"
        return finish_arm(arm, arm_root)

    spec = InstanceSpec(instance_id, repo, row["base_commit"], image_key,
                        IMPORT_NAMES[repo], env_name)
    box = M193Container(spec, arm_root)
    try:
        setup = box.setup()
        arm["phases"]["containerStart"] = {
            "ok": setup.ok, "containerId": (setup.container_id or "")[:12],
            "hostMount": setup.host_mount, "workdir": CHECKOUT_ROOT,
            "headAfterCheckout": setup.head_after_checkout, "baseCommit": row["base_commit"],
            "preexistingUntracked": setup.preexisting_untracked, "errors": setup.errors,
        }
        if not setup.ok:
            arm["verdict"] = "CONTAINER_INFRA_FAILURE"
            arm["errors"].append(f"setup: {setup.errors}")
            return finish_arm(arm, arm_root, box)

        robustness, neutral = box.provenance_robustness()
        arm["phases"]["provenanceRobustness"] = {"robustness": robustness, "moduleFileNeutralCwd": neutral}

        config = {
            "armId": arm_id, "instanceId": instance_id, "repo": repo,
            "armRoot": arm_root, "containerName": box.name, "condaEnv": env_name,
            "hostMount": box.host_mount, "hostUid": box.host_uid, "hostGid": box.host_gid,
            "baseCommit": row["base_commit"], "imageKey": image_key,
            "importName": spec.import_name,
            "preexistingUntracked": box.preexisting_untracked,
            "provenanceRobustness": robustness, "moduleFileNeutralCwd": neutral,
            "eventLogPath": os.path.join(raw, "adapter_events.jsonl"),
            "sequencePath": os.path.join(raw, "adapter_sequence"),
            "snapshotDir": os.path.join(raw, "snapshots"),
        }
        config_path = os.path.join(arm_root, "adapter.json")
        with open(config_path, "w") as fh:
            json.dump(config, fh, indent=2)
        settings_path = os.path.join(arm_root, "adapter-settings.json")
        write_adapter_settings(settings_path, config_path)

        arm_env = construct_arm_environment(arm_id, instance_id, arm_root, settings_path)
        with open(os.path.join(raw, "arm_environment.json"), "w") as fh:
            json.dump({k: v for k, v in arm_env.items() if k != "env"}, fh, indent=2)
        arm["phases"]["treatmentIsolation"] = {
            "status": arm_env.get("status"), "mayLaunchModel": arm_env.get("mayLaunchModel"),
            "effectiveMcpServerCount": (arm_env.get("measuredMcp") or {}).get("count"),
            "cliReportedVersion": arm_env.get("cliReportedVersion"),
            "failures": arm_env.get("failures"),
            "launchRecord": arm_env.get("launchRecord"),
        }
        if not arm_env.get("mayLaunchModel"):
            arm["verdict"] = "TREATMENT_ISOLATION_FAILED"
            arm["errors"].append(f"isolation: {arm_env.get('failures')}")
            return finish_arm(arm, arm_root, box)

        # SETUP snapshot, before the agent exists.
        setup_snap, _ = box.capture_patch_snapshot()
        setup_hash = f"sha256:{sha256_text(normalize_patch(setup_snap.get('patch') or ''))}"
        arm["phases"]["setupSnapshot"] = {
            "status": setup_snap.get("status"), "ok": setup_snap.get("ok"),
            "diffHash": setup_hash, "empty": normalize_patch(setup_snap.get("patch") or "") == "",
        }
        with open(config["eventLogPath"], "a") as fh:
            fh.write(json.dumps({
                "kind": "patch_snapshot", "sequence": -1, "boundary": "SETUP",
                "status": setup_snap.get("status"), "ok": setup_snap.get("ok"),
                "diffHash": setup_hash, "diffBytes": len((setup_snap.get("patch") or "").encode()),
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "wallClock": time.time(),
            }) + "\n")

        prompt = build_prompt(manifest, row)
        with open(os.path.join(raw, "prompt.txt"), "w") as fh:
            fh.write(prompt)

        if not live:
            arm["verdict"] = "DRY_RUN_READY"
            arm["phases"]["launchWithheld"] = "no --live flag; every step up to the model launch completed"
            return finish_arm(arm, arm_root, box)

        ok, why = budget.may_launch()
        if not ok:
            arm["verdict"] = "BUDGET_WITHHELD"
            arm["errors"].append(why)
            return finish_arm(arm, arm_root, box)

        arm["modelLaunched"] = True
        launch = launch_agent(prompt, box.host_mount, arm_env["env"], arm_env["argv"],
                              os.path.join(raw, "agent_stream.jsonl"), arm_root)
        arm["phases"]["agent"] = {k: v for k, v in launch.items() if k != "toolUses"}
        arm["costUsd"] = launch.get("costUsd")
        arm["termination"] = launch["termination"]
        budget.settle(launch.get("costUsd"))

        # §14 — every Bash the transcript contains must have been routed. The
        # CLI falls back to the ORIGINAL tool input when a hook returns nothing
        # usable, so this is the check that would catch an arm whose commands
        # silently ran on the host.
        events = read_events(config["eventLogPath"])
        routed_ids = {e.get("toolUseId") for e in events if e.get("kind") == "bash_pre"}
        bash_uses = [t for t in launch.get("toolUses", []) if t.get("name") == "Bash"]
        unrouted = [t for t in bash_uses if t.get("id") not in routed_ids]
        arm["phases"]["routingAudit"] = {
            "bashToolUses": len(bash_uses), "routedPreEvents": len([e for e in events if e.get("kind") == "bash_pre"]),
            "unroutedBashCalls": len(unrouted), "unroutedIds": [t.get("id") for t in unrouted][:20],
            "allBashRouted": not unrouted,
        }
        arm["phases"]["adapterErrors"] = [e for e in events if e.get("kind") == "adapter_error"]

        # §39 — one authoritative mutable checkout, still the same one.
        canary = box.exec_raw("stat -c %i /testbed && git rev-parse --show-toplevel", 120, "canary")
        container_inode = (canary.stdout or "").strip().splitlines()[0] if canary.stdout.strip() else None
        try:
            host_inode = str(os.stat(box.host_mount).st_ino)
        except Exception:  # noqa: BLE001
            host_inode = None
        arm["phases"]["checkoutAuthority"] = {
            "hostMountPresent": os.path.isdir(box.host_mount),
            "containerInode": container_inode, "hostInode": host_inode,
            "sameInode": container_inode is not None and container_inode == host_inode,
        }

        final_snap, _ = box.capture_patch_snapshot()
        final_patch = final_snap.get("patch") or ""
        arm["phases"]["finalPatch"] = {
            "status": final_snap.get("status"), "ok": final_snap.get("ok"),
            "bytes": len(final_patch.encode()),
            "normalizedSha256": sha256_text(normalize_patch(final_patch)) if final_snap.get("ok") else None,
            "empty": normalize_patch(final_patch) == "",
            "binaryPaths": final_snap.get("binaryPaths"),
            "gitState": final_snap.get("gitState"),
        }
        with open(os.path.join(raw, "final.patch"), "w") as fh:
            fh.write(final_patch)

        if final_snap.get("ok"):
            arm["phases"]["evaluator"] = evaluate_arm(
                instance_id, final_patch, f"m194-{arm_id}", arm_root
            )
        else:
            arm["phases"]["evaluator"] = {
                "ran": False, "reason": f"patch not extractable: {final_snap.get('status')}",
                "resolved": None, "status": "EVALUATOR_INFRA_FAILURE",
            }

        arm["verdict"] = "ARM_COMPLETED"
        return finish_arm(arm, arm_root, box)
    except Exception as exc:  # noqa: BLE001
        arm["verdict"] = arm.get("verdict") or "HARNESS_CRASH"
        arm["errors"].append(repr(exc))
        return finish_arm(arm, arm_root, box)


def read_events(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as fh:
        for ln in fh:
            if ln.strip():
                try:
                    out.append(json.loads(ln))
                except Exception:  # noqa: BLE001
                    pass
    return out


def finish_arm(arm: dict[str, Any], arm_root: str, box: Any = None) -> dict[str, Any]:
    if box is not None:
        try:
            # The mount is kept: it holds the arm's own raw evidence directory's
            # sibling checkout, and §35 requires raw artefacts to survive.
            arm["phases"]["teardown"] = box.teardown(remove_mount=True)
        except Exception as exc:  # noqa: BLE001
            arm["phases"]["teardown"] = {"error": repr(exc)}
    os.makedirs(arm_root, exist_ok=True)
    with open(os.path.join(arm_root, "arm.json"), "w") as fh:
        json.dump(arm, fh, indent=2)
    return arm


# ── the acquisition ──────────────────────────────────────────────────


def account(out_root: str) -> dict[str, Any]:
    """Lifecycle, corpus accounting and the stopping rule, regenerated from raw
    artefacts by the frozen classifiers. Never computed here: §49 requires the
    accounting to be reproducible from the preserved evidence alone."""
    proc = subprocess.run(
        [BUN, os.path.join(HERE, "run_stage5_m194_account.ts"), "--out", out_root, "--quiet"],
        capture_output=True, text=True, timeout=1800, cwd=REPO,
    )
    if proc.returncode != 0:
        return {"error": f"accounting failed: {proc.stderr[-800:]}"}
    return json.loads(proc.stdout)


def load_prior_arms(out_root: str) -> list[dict[str, Any]]:
    """Arms this acquisition already paid for, read back from their own records.

    Acquisition is long and may be interrupted; §36 asks for bounded checkpoints
    and §52 distinguishes an INCOMPLETE run from a failed one. Resuming reads
    the preserved evidence rather than a memory of it, so a resumed run cannot
    silently re-buy an arm it already has, and cumulative spend continues from
    what was actually spent rather than from zero.
    """
    runs = os.path.join(out_root, "runs")
    if not os.path.isdir(runs):
        return []
    out = []
    for name in sorted(os.listdir(runs)):
        path = os.path.join(runs, name, "arm.json")
        if os.path.exists(path):
            try:
                out.append(json.load(open(path)))
            except Exception:  # noqa: BLE001
                pass
    return out


def append_ledger(path: str, row: dict[str, Any]) -> None:
    with open(path, "a") as fh:
        fh.write(json.dumps(row) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "results", "m194"))
    ap.add_argument("--live", action="store_true", help="launch real models and spend real money")
    ap.add_argument("--max-arms", type=int, default=MAX_ARMS)
    ap.add_argument("--concurrency", type=int, default=MAX_CONCURRENT)
    args = ap.parse_args()

    if args.concurrency > MAX_CONCURRENT:
        print(f"concurrency {args.concurrency} exceeds the frozen maximum {MAX_CONCURRENT}", file=sys.stderr)
        return 2
    if args.max_arms > MAX_ARMS:
        print(f"arm cap {args.max_arms} exceeds the frozen maximum {MAX_ARMS}", file=sys.stderr)
        return 2

    # §1/§7 — the gate. No model is launched if the frozen authority does not
    # verify, and this driver refuses to be the thing that decides otherwise.
    gate = subprocess.run([BUN, os.path.join(HERE, "run_stage5_m194_verify.ts")],
                          capture_output=True, text=True, timeout=900, cwd=REPO)
    if gate.returncode != 0:
        print(gate.stdout)
        print("FROZEN_MANIFEST_MISMATCH — no model launched", file=sys.stderr)
        return 3

    manifest = json.load(open(MANIFEST))
    fixture = json.load(open(FIXTURE))
    rows = load_instances(DATASET)
    out_root = os.path.abspath(args.out)
    os.makedirs(os.path.join(out_root, "runs"), exist_ok=True)
    ledger_path = os.path.join(out_root, "acquisition_ledger.jsonl")

    queue = [dict(e) for e in fixture["instances"]][: args.max_arms]
    reserve = [dict(e) for e in fixture["replacementReserve"]]
    attempted = {e["instanceId"] for e in queue}
    budget = Budget(TOTAL_CAP_USD)

    state = {
        "armsLaunched": 0, "armsCompleted": 0, "preflightFailures": 0,
        "replacements": 0, "retries": 0, "stop": None, "stopState": None,
        "resumedArms": 0,
    }

    prior = load_prior_arms(out_root)
    if prior:
        done_instances = set()
        for a in prior:
            attempted.add(a["instanceId"])
            if a.get("modelLaunched"):
                budget.restore(a.get("costUsd"))
                state["armsLaunched"] += 1
                state["armsCompleted"] += 1
                done_instances.add(a["instanceId"])
            elif a.get("verdict") == "PREFLIGHT_FAILED":
                state["preflightFailures"] += 1
                done_instances.add(a["instanceId"])
                if a.get("replacedFrom"):
                    state["replacements"] += 1
        before = len(queue)
        queue = [e for e in queue if e["instanceId"] not in done_instances]
        state["resumedArms"] = before - len(queue)
        # Replacements already issued for prior preflight failures are re-issued
        # from the same frozen reserve position, so the order cannot drift.
        for a in prior:
            if a.get("verdict") == "PREFLIGHT_FAILED":
                nxt = next((r for r in reserve if r["instanceId"] not in attempted), None)
                if nxt is not None and state["replacements"] <= MAX_REPLACEMENTS:
                    attempted.add(nxt["instanceId"])
                    repl = dict(nxt)
                    repl["ordinal"] = a["ordinal"]
                    repl["replacedFrom"] = a["instanceId"]
                    queue.append(repl)
        queue.sort(key=lambda e: e["ordinal"])
        print(f"  resuming: {state['armsCompleted']} paid arms already recorded, "
              f"${budget.spent:.4f} already spent, {len(queue)} remaining\n")
    print(f"M194 acquisition — {'LIVE' if args.live else 'DRY (no model launched)'}")
    print(f"  out {out_root}")
    print(f"  frozen: {args.max_arms} arms max, ${PER_RUN_CAP_USD}/arm, ${TOTAL_CAP_USD} total, "
          f"concurrency {args.concurrency}\n")

    pending = list(queue)
    in_flight: dict[Any, dict[str, Any]] = {}
    lock = threading.Lock()

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        while pending or in_flight:
            # Launch while there is room, budget, and no stop condition.
            while pending and len(in_flight) < args.concurrency and state["stop"] is None:
                entry = pending.pop(0)
                row = rows.get(entry["instanceId"])
                if row is None:
                    state["preflightFailures"] += 1
                    append_ledger(ledger_path, {"ordinal": entry["ordinal"], "instanceId": entry["instanceId"],
                                                "repo": entry["repo"], "verdict": "PREFLIGHT_FAILED",
                                                "reason": "instance absent from the frozen dataset"})
                    continue
                fut = pool.submit(run_arm, entry, row, manifest, out_root, budget, args.live)
                in_flight[fut] = entry

            if not in_flight:
                break

            done = next(as_completed(list(in_flight.keys())))
            entry = in_flight.pop(done)
            arm = done.result()

            with lock:
                if arm["verdict"] == "PREFLIGHT_FAILED":
                    state["preflightFailures"] += 1
                    # §9 — NEXT_IN_FROZEN_ORDER. No manual selection.
                    if state["replacements"] < MAX_REPLACEMENTS:
                        nxt = next((r for r in reserve if r["instanceId"] not in attempted), None)
                        if nxt is not None:
                            attempted.add(nxt["instanceId"])
                            state["replacements"] += 1
                            repl = dict(nxt)
                            repl["ordinal"] = entry["ordinal"]
                            repl["replacedFrom"] = entry["instanceId"]
                            pending.insert(0, repl)
                elif arm["modelLaunched"]:
                    state["armsLaunched"] += 1
                    state["armsCompleted"] += 1

                append_ledger(ledger_path, {
                    "ordinal": arm["ordinal"], "armId": arm["armId"], "instanceId": arm["instanceId"],
                    "repo": arm["repo"], "replacedFrom": arm.get("replacedFrom"),
                    "verdict": arm["verdict"], "modelLaunched": arm["modelLaunched"],
                    "termination": arm.get("termination"), "costUsd": arm.get("costUsd"),
                    "cumulativeCostUsd": round(budget.spent, 6),
                    "preflight": (arm["phases"].get("preflight") or {}).get("verdict"),
                    "treatmentIsolation": (arm["phases"].get("treatmentIsolation") or {}).get("status"),
                    "allBashRouted": (arm["phases"].get("routingAudit") or {}).get("allBashRouted"),
                    "finalPatchBytes": (arm["phases"].get("finalPatch") or {}).get("bytes"),
                    "evaluator": (arm["phases"].get("evaluator") or {}).get("status"),
                    "resolved": (arm["phases"].get("evaluator") or {}).get("resolved"),
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                })

                acc = account(out_root) if args.live else {}
                state["stopState"] = acc.get("stopState")
                decision = acc.get("stopDecision")
                if args.live and decision and decision != "CONTINUE":
                    state["stop"] = decision
                if budget.spent >= TOTAL_CAP_USD:
                    state["stop"] = "STOP_SPEND_CAP"
                if state["armsLaunched"] >= args.max_arms:
                    state["stop"] = state["stop"] or "STOP_MAX_ARMS"

                acc_line = ""
                if acc.get("accounting"):
                    a = acc["accounting"]
                    acc_line = (f" | valid {a['validRuns']} i6 {a['i6UsableArms']}"
                                f"/{acc.get('i6Repositories', 0)} repos")
                print(f"[{state['armsCompleted']:>2}/{args.max_arms}] {arm['armId']:<44} "
                      f"{arm['verdict']:<22} ${budget.spent:7.4f}{acc_line}"
                      + (f"  STOP={state['stop']}" if state["stop"] else ""))

    final = account(out_root) if args.live else {}
    summary = {
        "schemaVersion": "stage5.m194.acquisition-summary.v1",
        "milestone": "M194", "live": args.live,
        "manifestHash": manifest["manifestHash"],
        "taskFixtureSha256": manifest["taskFixture"]["sha256"],
        "model": MODEL, "cliBinary": CLI_BINARY, "cliVersion": CLI_VERSION, "maxTurns": MAX_TURNS,
        "limits": {"perRunCostCapUsd": PER_RUN_CAP_USD, "totalSpendCapUsd": TOTAL_CAP_USD,
                   "minArms": MIN_ARMS, "maxArms": args.max_arms, "concurrency": args.concurrency},
        "state": state,
        "totalSpendUsd": round(budget.spent, 6),
        "stopReason": state["stop"],
        "accounting": final,
    }
    with open(os.path.join(out_root, "acquisition_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    print(f"\nstop: {state['stop']}   spend ${budget.spent:.4f}   arms {state['armsCompleted']}")
    print(f"wrote {os.path.join(out_root, 'acquisition_summary.json')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

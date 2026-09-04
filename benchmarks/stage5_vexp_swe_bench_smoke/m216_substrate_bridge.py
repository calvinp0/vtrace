"""M216 — the substrate bridge: one process boundary, no second scheduler.

M215 built the executor and left three interfaces unbound. The operations behind
those interfaces already exist and are already audited — M193's container
authority, M193B's changed-source authority, M193C's patch-snapshot authority,
M194's agent launch and evaluator — and they are written in Python, against the
Docker SDK and the swebench package. Rewriting them in TypeScript would produce
a second implementation of code that five milestones' worth of controls were
written against, and every defect those controls found would be re-openable.

So the executor keeps the experiment and this process keeps the machinery. The
boundary carries SUBSTRATE OPERATIONS ONLY:

    TypeScript executor  --  {"op": ..., "params": ...}  -->  this process
                         <--  {"ok": ..., "result": ...} --

What this file must never acquire is a decision. It does not know which task
runs next, which arm follows which, whether a result is valid, whether to retry,
or whether the cohort is finished. Those are M215 authorities, and a substrate
that started answering them would be a second benchmark harness competing with
the one that was falsified. Every request names an operation that has already
been authorised.

Two guards that are this file's own responsibility, because they are properties
of touching the real world:

* §35 FROZEN-POPULATION REFUSAL. A real container, a real agent process or a
  real evaluation for an instance in M214's frozen 100 is refused unless the
  caller declares COHORT mode. "Just for infrastructure" is exactly how a frozen
  task acquires an outcome nobody meant to create.
* §20/§57 PROVIDER BOUNDARY. `agent.run` takes an explicit boundary. `REPLAY`
  runs the whole production path — argv, environment, sandbox, spawn, stream
  parse, termination classification — against a recorded event source and
  contacts no provider. `LIVE` is the only mode that can spend, and it refuses
  unless the caller is in COHORT mode with spend authorisation.

    <vexp>/.venv/bin/python m216_substrate_bridge.py --manifest <path>
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from m193_container_adapter import (  # noqa: E402
    CHECKOUT_ROOT,
    InstanceSpec,
    M193Container,
    conda_env_for,
    normalize_patch,
    sha256_text,
)
from m193c_patch_snapshot import (  # noqa: E402
    PATCH_SNAPSHOT_AUTHORITY_VERSION,
    parse_patch_snapshot_output,
)
# M194's mount namespace, reused rather than reproduced. The execution contract
# says the arm works on ONE tree visible at the SAME path from both sides, and
# /testbed is that path because the instance image's editable install names it
# absolutely. Without this the agent's cwd is a directory that does not exist on
# the host, which is exactly the failure the M216 integration run hit first.
from run_stage5_m194_acquire import sandbox_prefix  # noqa: E402

BRIDGE_VERSION = "stage5.m216.substrate-bridge.v1"

HERE = os.path.dirname(os.path.abspath(__file__))
VEXP = "/home/calvin/code/vexp-swe-bench"
DATASET = f"{VEXP}/data/swe-bench-100.jsonl"
PYTHON = f"{VEXP}/.venv/bin/python"

EVALUATOR_TIMEOUT_S = 1800

# swebench's own words when the model patch cannot be applied by any of its three
# strategies. Matched literally rather than by exit status, because the harness
# exits non-zero for that AND for infrastructure failures.
PATCH_APPLY_FAILED_MARKER = ">>>>> Patch Apply Failed:"


# ── the pre-agent untracked snapshot, at the granularity M215 measured ──
#
# M215's D4 layer measured, on real Git, that the granularity of this one
# enumeration decides whether treatment metadata written DURING the agent run is
# attributed to the agent:
#
#   with --directory     -> ['.vtrace']            -> a later .vtrace file is excluded
#   without --directory  -> ['.vtrace/a', ...]     -> a later .vtrace file is CAPTURED
#
# M193C's `patch_snapshot_command` enumerates WITHOUT `--directory`, and it is
# right to: that is the CAPTURE lane, which has to reach each untracked file
# individually to diff it. The SNAPSHOT is a different question asked of the same
# command, and it is asked here, once, by the benchmark that needs the coarser
# answer. M193C is not modified: a global change would alter what five earlier
# milestones' controls were written against, to fix a caller that did not exist.
UNTRACKED_SNAPSHOT_AUTHORITY_VERSION = "stage5.m216.untracked-snapshot.v1"


def untracked_snapshot_command(granularity: str) -> str:
    """The pre-agent snapshot's exact shell. `-z` because paths may hold newlines."""
    directory = " --directory" if granularity == "DIRECTORY" else ""
    return (
        f"git -c core.fileMode=false ls-files --others --exclude-standard{directory} -z "
        f"| base64 | tr -d '\\n'; printf ' %s\\n' \"${{PIPESTATUS[0]}}\""
    )


def parse_untracked_snapshot(stdout: str) -> tuple[list[str], int | None]:
    """Fails closed: an enumeration that did not complete is not an empty one.

    The line is deliberately NOT stripped before splitting. When git enumerates
    nothing the payload is empty and the line is " 0" — a leading space carrying
    a real exit status — and `strip()` eats the separator, turning the healthiest
    possible answer into an unparseable one. The M216 container smoke found
    exactly that: every clean checkout reported `complete: false`.
    """
    lines = [ln for ln in (stdout or "").splitlines() if ln.strip()]
    if not lines:
        return [], None
    parts = lines[-1].rstrip("\r\n").rsplit(" ", 1)
    if len(parts) != 2:
        return [], None
    payload, rc_text = parts
    try:
        rc = int(rc_text)
    except ValueError:
        return [], None
    raw = base64.b64decode(payload.encode() or b"") if payload else b""
    paths = [p for p in raw.decode("utf-8", "surrogateescape").split("\0") if p]
    return sorted(p.rstrip("/") for p in paths), rc


# ── source identity ─────────────────────────────────────────────────


TRACKED_SOURCE_DIGEST_VERSION = "stage5.m216.tracked-source-digest.v1"


def tracked_source_digest_command() -> str:
    """A digest over TRACKED source content only.

    `ls-files -s` names every tracked path with the blob the INDEX holds, which
    is not what the working tree contains after an edit. `hash-object` over the
    working-tree bytes is, so the digest changes when a file changes and not
    when the index is touched. Untracked paths are deliberately absent: this is
    the number the two arms must agree on, and the treatment's own generated
    state is untracked by construction.
    """
    return (
        "git -c core.fileMode=false ls-files -z | "
        "xargs -0 -r git -c core.fileMode=false hash-object -- | "
        "sha256sum | cut -d' ' -f1; printf 'RC %s\\n' \"${PIPESTATUS[0]}\""
    )


# ── the operations ──────────────────────────────────────────────────


class Bridge:
    def __init__(self, frozen_instance_ids: set[str], dataset: str = DATASET):
        self.frozen = frozen_instance_ids
        self.dataset = dataset
        self.containers: dict[str, M193Container] = {}
        self.commands: list[dict[str, Any]] = []
        self.counters = {"containersCreated": 0, "containersStarted": 0, "containersTornDown": 0}
        self.frozen_instances_touched: set[str] = set()
        self.nonfrozen_instances_touched: set[str] = set()

    # ── §35 ─────────────────────────────────────────────────────────

    def assert_population(self, instance_id: str, mode: str, op: str) -> None:
        """A real substrate operation on a frozen task requires COHORT mode.

        The refusal is unconditional in research mode and does not consult
        intent. An operator who genuinely needs a frozen instance is running the
        cohort, and running the cohort has its own authorisation.
        """
        if instance_id in self.frozen:
            if mode != "COHORT":
                raise PermissionError(
                    f"{op} refused: {instance_id} is in M214's frozen 100 and the caller declared "
                    f"mode={mode}. A frozen task may not be touched by the real substrate outside a "
                    "COHORT run, including 'just for infrastructure'."
                )
            self.frozen_instances_touched.add(instance_id)
        else:
            self.nonfrozen_instances_touched.add(instance_id)

    # ── identity ────────────────────────────────────────────────────

    def op_substrate_identity(self, params: dict[str, Any]) -> dict[str, Any]:
        def version(module: str) -> str | None:
            try:
                return __import__(module).__version__
            except Exception:  # noqa: BLE001
                return None

        docker_server = None
        try:
            import docker as docker_sdk

            docker_server = docker_sdk.from_env().version().get("Version")
        except Exception:  # noqa: BLE001
            pass
        return {
            "bridgeVersion": BRIDGE_VERSION,
            "python": sys.version.split()[0],
            "pythonExecutable": sys.executable,
            "dockerSdk": version("docker"),
            "dockerServer": docker_server,
            "swebench": version("swebench"),
            "containerAuthority": "m193_container_adapter.M193Container",
            "patchSnapshotAuthority": PATCH_SNAPSHOT_AUTHORITY_VERSION,
            "untrackedSnapshotAuthority": UNTRACKED_SNAPSHOT_AUTHORITY_VERSION,
            "trackedSourceDigestAuthority": TRACKED_SOURCE_DIGEST_VERSION,
            "dataset": self.dataset,
            "frozenPopulationSize": len(self.frozen),
        }

    # ── containers ──────────────────────────────────────────────────

    def _container(self, handle: str) -> M193Container:
        box = self.containers.get(handle)
        if box is None:
            raise KeyError(f"unknown container handle: {handle}")
        return box

    def _exec(self, box: M193Container, command: str, timeout: int, label: str) -> Any:
        record = box.exec_raw(command, timeout=timeout, label=label)
        self.commands.append({"label": label, "exitCode": record.exit_code, "timedOut": record.timed_out})
        return record

    def op_container_start(self, params: dict[str, Any]) -> dict[str, Any]:
        instance_id = params["instanceId"]
        self.assert_population(instance_id, params["mode"], "container.start")
        spec = InstanceSpec(
            instance_id=instance_id,
            repo=params["repo"],
            base_commit=params["baseCommit"],
            image_key=params["image"],
            import_name=params.get("importName") or params["repo"].split("/")[-1],
            conda_env=params.get("condaEnv") or conda_env_for(params.get("evalScript") or ""),
        )
        box = M193Container(spec, params["hostRoot"])
        self.counters["containersCreated"] += 1
        report = box.setup()
        if not report.ok:
            try:
                box.teardown()
            except Exception:  # noqa: BLE001
                pass
            return {
                "started": False,
                "failureCategory": "CONTAINER_CANNOT_START",
                "errors": report.errors,
                "headAfterCheckout": report.head_after_checkout,
            }
        self.counters["containersStarted"] += 1
        handle = f"m216-{instance_id}-{report.container_id[:12]}"
        self.containers[handle] = box
        image_digest = ""
        try:
            import docker as docker_sdk

            image = docker_sdk.from_env().images.get(spec.image_key)
            image_digest = (image.attrs.get("RepoDigests") or [""])[0] or image.id
        except Exception:  # noqa: BLE001
            image_digest = ""
        return {
            "started": True,
            "handle": handle,
            "containerId": report.container_id,
            "hostMount": report.host_mount,
            "workingDirectory": CHECKOUT_ROOT,
            "image": spec.image_key,
            "imageDigest": image_digest,
            "dependencyEnvironment": spec.conda_env,
            "headAfterCheckout": report.head_after_checkout,
            "baseCommitReachable": report.base_commit_reachable,
            "preexistingUntracked": report.preexisting_untracked,
            "extractMs": report.extract_ms,
            "startMs": report.start_ms,
        }

    def op_container_reset(self, params: dict[str, Any]) -> dict[str, Any]:
        """Deliberate source establishment, never inherited cleanliness (§13).

        `checkout -f` alone leaves untracked files behind, so a tree that a
        previous step dirtied would silently become this run's starting state.
        The reset is therefore checkout + a clean that removes untracked and
        ignored paths, and the result reports the state it actually reached
        rather than asserting success.
        """
        box = self._container(params["handle"])
        base = params["baseCommit"]
        self._exec(box, f"git checkout -f {base}", 600, "reset_checkout")
        self._exec(box, "git clean -xdff", 600, "reset_clean")
        head = self._exec(box, "git rev-parse HEAD", 60, "reset_head").stdout.strip()
        status = self._exec(box, "git status --porcelain", 300, "reset_status").stdout
        # The image's own untracked build output is regenerated by the clean's
        # absence, so it is re-observed here rather than carried over.
        untracked = sorted(
            line[3:].strip().rstrip("/") for line in status.splitlines() if line.startswith("??")
        )
        tracked_dirty = [line for line in status.splitlines() if not line.startswith("??")]
        box.preexisting_untracked = untracked
        box.normalize_ownership()
        return {
            "head": head,
            "headMatchesBaseCommit": head == base,
            "trackedChanges": tracked_dirty,
            "untrackedAfterReset": untracked,
        }

    def op_container_head(self, params: dict[str, Any]) -> dict[str, Any]:
        box = self._container(params["handle"])
        return {"head": self._exec(box, "git rev-parse HEAD", 60, "head").stdout.strip()}

    def op_container_tracked_digest(self, params: dict[str, Any]) -> dict[str, Any]:
        box = self._container(params["handle"])
        record = self._exec(box, tracked_source_digest_command(), 900, "tracked_source_digest")
        lines = [ln for ln in record.stdout.splitlines() if ln.strip()]
        rc = None
        digest = ""
        for ln in lines:
            if ln.startswith("RC "):
                try:
                    rc = int(ln[3:].strip())
                except ValueError:
                    rc = None
            elif ln.strip():
                digest = ln.strip()
        if rc != 0 or not digest:
            return {"digest": None, "complete": False, "rc": rc}
        return {"digest": digest, "complete": True, "rc": rc, "authority": TRACKED_SOURCE_DIGEST_VERSION}

    def op_container_untracked(self, params: dict[str, Any]) -> dict[str, Any]:
        box = self._container(params["handle"])
        granularity = params.get("granularity", "DIRECTORY")
        record = self._exec(
            box, untracked_snapshot_command(granularity), 600, f"untracked_{granularity.lower()}"
        )
        paths, rc = parse_untracked_snapshot(record.stdout)
        return {
            "paths": paths,
            "complete": rc == 0,
            "rc": rc,
            "granularity": granularity,
            "authority": UNTRACKED_SNAPSHOT_AUTHORITY_VERSION,
        }

    def op_container_untracked_source_affecting(self, params: dict[str, Any]) -> dict[str, Any]:
        """Untracked paths that would change what the interpreter imports.

        M193's bytecode-staleness finding is why `.pyc` is here at all: a stale
        cache once stood in for a source file that had been edited, so untracked
        compiled output is source-affecting even though it is not source.
        """
        box = self._container(params["handle"])
        record = self._exec(box, untracked_snapshot_command("FILE"), 600, "untracked_source_affecting")
        paths, rc = parse_untracked_snapshot(record.stdout)
        suffixes = tuple(params.get("sourceSuffixes") or [".py", ".pyx", ".pyi", ".pyc", ".so"])
        return {
            "paths": [p for p in paths if p.endswith(suffixes)],
            "complete": rc == 0,
            "rc": rc,
        }

    def op_container_exec(self, params: dict[str, Any]) -> dict[str, Any]:
        box = self._container(params["handle"])
        record = self._exec(
            box, params["command"], int(params.get("timeoutSeconds", 600)), params.get("label", "exec")
        )
        return {
            "exitCode": record.exit_code,
            "timedOut": record.timed_out,
            "stdout": record.stdout,
            "stderr": record.stderr[-4000:],
            "processStarted": record.process_started,
        }

    def op_container_capture_patch(self, params: dict[str, Any]) -> dict[str, Any]:
        """M193C's authority, driven by exclusions the EXECUTOR derived.

        The exclusion list is an input, not a decision made here. M214's rule is
        "what changed, minus what already existed before the agent ran", and the
        before-set is the executor's pre-agent snapshot. Nothing in this method
        names a vendor directory.
        """
        box = self._container(params["handle"])
        exclusions = list(params.get("exclusions") or [])
        from m193c_patch_snapshot import patch_snapshot_command

        record = self._exec(box, patch_snapshot_command(exclusions), 900, "capture_patch")
        parsed = parse_patch_snapshot_output(record.stdout, CHECKOUT_ROOT)
        patch = parsed.get("patch") or ""
        paths = sorted(set(parsed.get("trackedPaths") or []) | set(parsed.get("untrackedPaths") or []))
        return {
            "ok": bool(parsed.get("ok")),
            "status": parsed.get("status"),
            "patch": patch,
            "paths": paths,
            "trackedPaths": parsed.get("trackedPaths") or [],
            "untrackedPaths": parsed.get("untrackedPaths") or [],
            "exclusions": exclusions,
            "normalizedSha256": sha256_text(normalize_patch(patch)) if patch else None,
            "authority": PATCH_SNAPSHOT_AUTHORITY_VERSION,
            "error": parsed.get("error"),
            "gitState": parsed.get("gitState"),
        }

    def op_container_stop(self, params: dict[str, Any]) -> dict[str, Any]:
        handle = params["handle"]
        box = self.containers.pop(handle, None)
        if box is None:
            return {"stopped": False, "reason": "unknown handle"}
        out = box.teardown(remove_mount=bool(params.get("removeMount", True)))
        if out.get("containerRemoved"):
            self.counters["containersTornDown"] += 1
        out["stopped"] = bool(out.get("containerRemoved"))
        return out

    # ── the agent process ───────────────────────────────────────────

    def op_agent_run(self, params: dict[str, Any], emit) -> dict[str, Any]:
        """Spawn the agent process the executor constructed, and stream it back.

        The argv, the environment and the working directory all arrive already
        built: this method must not be able to add a flag, because a substrate
        that could would be a place for an arm difference to hide.

        Ordered events are emitted AS THEY ARRIVE rather than after the process
        exits. That is what lets the executor's model-identity hook run during
        initialisation — the whole point of the hook being a hook — and it is
        also why a run killed by a timeout still leaves its telemetry.
        """
        mode = params["mode"]
        boundary = params["providerBoundary"]
        instance_id = params["instanceId"]
        self.assert_population(instance_id, mode, "agent.run")
        if boundary == "LIVE" and mode != "COHORT":
            raise PermissionError(
                "agent.run refused: providerBoundary=LIVE requires mode=COHORT. A paid provider "
                "call is not an infrastructure operation."
            )
        if boundary == "LIVE" and not params.get("spendAuthorized"):
            raise PermissionError(
                "agent.run refused: providerBoundary=LIVE requires the caller to carry explicit "
                "spend authorisation."
            )
        if boundary not in ("LIVE", "REPLAY"):
            raise ValueError(f"unknown provider boundary: {boundary}")

        argv = list(params["argv"])
        env = dict(params["env"])
        host_mount = params.get("hostMount")
        arm_root = params.get("armRoot")
        if host_mount:
            argv = [*sandbox_prefix(host_mount, arm_root), *argv]
        # Inside the namespace the checkout is at /testbed; outside it, the
        # working directory has to be a path that exists on the host.
        cwd = host_mount or params["cwd"]
        stream_path = params["streamPath"]
        abort_path = params.get("abortPath")
        timeout_s = int(params.get("timeoutSeconds", 3600))

        os.makedirs(os.path.dirname(stream_path), exist_ok=True)
        started = False
        timed_out = False
        exit_code: int | None = None
        stderr_chunks: list[str] = []
        t0 = time.time()
        ordinal = 0

        try:
            with open(stream_path, "w") as sink:
                proc = subprocess.Popen(
                    argv, cwd=cwd, env=env,
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, bufsize=1,
                )
                started = True

                def drain_stderr() -> None:
                    for line in proc.stderr:  # type: ignore[union-attr]
                        stderr_chunks.append(line)

                thread = threading.Thread(target=drain_stderr, daemon=True)
                thread.start()

                # The abort sentinel is how the executor's model-identity hook
                # STOPS a run rather than labelling it afterwards. It is a
                # watchdog rather than a check inside the read loop because a
                # process that has stopped emitting is exactly the process an
                # abort most needs to reach.
                aborted = threading.Event()

                def watch_abort() -> None:
                    while proc.poll() is None:
                        if abort_path and os.path.exists(abort_path):
                            aborted.set()
                            proc.kill()
                            return
                        time.sleep(0.25)

                watchdog = threading.Thread(target=watch_abort, daemon=True)
                if abort_path:
                    watchdog.start()

                deadline = t0 + timeout_s
                for line in proc.stdout:  # type: ignore[union-attr]
                    sink.write(line)
                    sink.flush()
                    text = line.strip()
                    if text:
                        emit({"stream": "agent.event", "ordinal": ordinal, "line": text})
                        ordinal += 1
                    if time.time() > deadline:
                        proc.kill()
                        timed_out = True
                        break
                exit_code = proc.wait(timeout=120)
                thread.join(timeout=10)
                if abort_path:
                    watchdog.join(timeout=5)
                    was_aborted = aborted.is_set()
                else:
                    was_aborted = False
        except Exception as exc:  # noqa: BLE001
            return {
                "started": started, "error": repr(exc), "exitCode": exit_code,
                "timedOut": timed_out, "eventCount": ordinal,
                "durationMs": int((time.time() - t0) * 1000),
                "stderrTail": "".join(stderr_chunks)[-4000:], "streamPath": stream_path,
                "providerBoundary": boundary,
            }

        return {
            "started": started,
            "sandboxed": bool(host_mount),
            "spawnedArgv": argv[: len(argv) - len(params["argv"])],
            "exitCode": exit_code,
            "timedOut": timed_out,
            "aborted": was_aborted,
            "eventCount": ordinal,
            "durationMs": int((time.time() - t0) * 1000),
            "stderrTail": "".join(stderr_chunks)[-4000:],
            "streamPath": stream_path,
            "providerBoundary": boundary,
        }

    # ── the evaluator ───────────────────────────────────────────────

    def op_evaluator_identity(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            import swebench

            version = getattr(swebench, "__version__", None)
        except Exception:  # noqa: BLE001
            version = None
        return {
            "implementation": "swebench.harness.run_evaluation",
            "package": "swebench",
            "version": version,
            "python": PYTHON,
            "dataset": self.dataset,
        }

    def op_evaluator_evaluate(self, params: dict[str, Any]) -> dict[str, Any]:
        """The official evaluator, with infrastructure failure kept distinct (§27).

        `resolved=false` and "the evaluator never produced a report" are the same
        empty answer to a careless reader and must never be the same outcome:
        collapsing them scores an infrastructure failure as an agent failure, on
        whichever arm happened to break.
        """
        instance_id = params["instanceId"]
        self.assert_population(instance_id, params["mode"], "evaluator.evaluate")
        patch = params.get("patch") or ""
        run_id = params["runId"]
        work_root = params["workRoot"]
        dataset = params.get("dataset") or self.dataset
        identity = self.op_evaluator_identity({})
        base = {
            "evaluatorIdentity": (
                f"swebench=={identity['version']} run_evaluation; dataset={os.path.basename(dataset)}"
            ),
            "evaluatorImplementation": identity["implementation"],
            "evaluatorVersion": identity["version"],
            "dataset": dataset,
            "instanceId": instance_id,
            "runId": run_id,
        }
        if not patch.strip():
            # An empty patch is a real, ordinary agent outcome: nothing to apply,
            # so nothing resolves. The evaluator is not asked, and the result says
            # so rather than claiming an evaluation that did not happen.
            return {
                **base, "evaluatorRan": True, "exitStatus": 0, "resolved": False,
                "outcome": "TASK_UNRESOLVED", "rawResult": json.dumps({"reason": "empty patch"}),
                "command": "(not invoked: empty patch)",
            }

        os.makedirs(work_root, exist_ok=True)
        preds_path = os.path.join(work_root, f"{run_id}_preds.jsonl")
        with open(preds_path, "w") as fh:
            fh.write(json.dumps({
                "instance_id": instance_id, "model_name_or_path": run_id, "model_patch": patch,
            }) + "\n")
        cmd = [
            PYTHON, "-m", "swebench.harness.run_evaluation",
            "-p", preds_path, "-d", dataset, "-id", run_id,
            "--max_workers", "1", "--timeout", str(EVALUATOR_TIMEOUT_S),
            "--cache_level", "instance", "--clean", "False",
        ]
        pre_existing_log_dir = os.path.isdir(
            os.path.join(VEXP, "logs", "run_evaluation", run_id, run_id, instance_id)
        )
        t0 = time.time()
        try:
            proc = subprocess.run(
                cmd, cwd=VEXP, capture_output=True, text=True, timeout=EVALUATOR_TIMEOUT_S + 1200,
            )
        except subprocess.TimeoutExpired:
            return {
                **base, "evaluatorRan": False, "exitStatus": -1, "resolved": False,
                "outcome": "EVALUATOR_INFRA_FAILURE", "rawResult": "", "command": " ".join(cmd),
                "reason": "evaluator timed out",
            }
        log_dir = os.path.join(VEXP, "logs", "run_evaluation", run_id, run_id, instance_id)
        report_path = os.path.join(log_dir, "report.json")
        if pre_existing_log_dir:
            # A directory that was already there means this run id has been
            # evaluated before, and anything read out of it might be that
            # evaluation's answer rather than this one's. Fail closed.
            return {
                **base, "evaluatorRan": False, "exitStatus": proc.returncode, "resolved": False,
                "outcome": "EVALUATOR_INFRA_FAILURE", "rawResult": "", "command": " ".join(cmd),
                "reason": f"the evaluator log directory already existed: {log_dir}",
            }
        out = {
            **base,
            "command": " ".join(cmd),
            "exitStatus": proc.returncode,
            "durationMs": int((time.time() - t0) * 1000),
            "logDir": log_dir,
            "logDirExists": os.path.isdir(log_dir),
            "stdoutTail": proc.stdout.strip().splitlines()[-12:],
            "stderrTail": proc.stderr.strip().splitlines()[-8:],
            "evaluatorRan": False,
            "resolved": False,
            "outcome": "EVALUATOR_INFRA_FAILURE",
            "rawResult": "",
        }
        if os.path.exists(report_path):
            try:
                report = json.load(open(report_path))
                out["rawResult"] = json.dumps(report, sort_keys=True)
                # The instance must be IN the report. A report that exists but
                # does not mention this instance is an evaluation that did not
                # happen, and `report.get(id, {})` would quietly turn it into
                # `resolved: false` -- an infrastructure failure wearing an
                # ordinary unresolved outcome's clothes, which is exactly the
                # collapse the evaluator interface exists to prevent. The M216
                # control that asked swebench for an instance outside its
                # dataset found this.
                if instance_id not in report:
                    out["reason"] = (
                        f"the evaluator's report does not contain {instance_id}; it graded "
                        f"{sorted(report)[:5]}"
                    )
                    out["outcome"] = "EVALUATOR_INFRA_FAILURE"
                else:
                    row = report[instance_id]
                    out["report"] = row
                    out["resolved"] = bool(row.get("resolved"))
                    out["evaluatorRan"] = True
                    out["outcome"] = "TASK_RESOLVED" if out["resolved"] else "TASK_UNRESOLVED"
            except Exception as exc:  # noqa: BLE001
                out["reason"] = f"evaluator report unreadable: {exc}"
                out["outcome"] = "EVALUATOR_INFRA_FAILURE"
        else:
            # swebench 4.1.0 writes NO report.json when the model patch does not
            # apply: it raises EvaluationError and leaves only patch.diff and
            # run_instance.log. Treating that absence as an infrastructure
            # failure would exclude a run for the reason M214 puts at the top of
            # its neverExclusions list -- "the agent made a bad patch" -- and it
            # would do so on whichever arm produced worse diffs. So the log's own
            # marker is read, and a patch that failed to apply is an ORDINARY
            # unresolved outcome.
            #
            # The M216 control that fed the real evaluator a malformed patch
            # found this. It had appeared to pass earlier only because a stale
            # log directory still held a previous evaluation's report.
            instance_log = os.path.join(log_dir, "run_instance.log")
            marker = ""
            if os.path.exists(instance_log):
                try:
                    marker = open(instance_log, errors="replace").read()
                except Exception:  # noqa: BLE001
                    marker = ""
            if PATCH_APPLY_FAILED_MARKER in marker:
                out["evaluatorRan"] = True
                out["resolved"] = False
                out["outcome"] = "TASK_UNRESOLVED"
                out["patchApplied"] = False
                out["reason"] = (
                    "the model patch did not apply; swebench writes no report for that case and it "
                    "is an ordinary unresolved outcome, never an exclusion"
                )
                out["rawResult"] = json.dumps({
                    "patchApplied": False,
                    "evaluator": "swebench run_instance reported >>>>> Patch Apply Failed",
                }, sort_keys=True)
            else:
                out["reason"] = "evaluator produced no report.json and no patch-apply failure"
        patch_path = os.path.join(log_dir, "patch.diff")
        if os.path.exists(patch_path):
            applied = open(patch_path).read()
            out["evaluatorPatchNormalizedSha256"] = sha256_text(normalize_patch(applied))
        return out

    # ── accounting ──────────────────────────────────────────────────

    def op_accounting(self, params: dict[str, Any]) -> dict[str, Any]:
        return {
            **self.counters,
            "openContainers": sorted(self.containers),
            "frozenInstancesTouched": sorted(self.frozen_instances_touched),
            "nonFrozenInstancesTouched": sorted(self.nonfrozen_instances_touched),
            "commandCount": len(self.commands),
        }


OPS = {
    "substrate.identity": "op_substrate_identity",
    "container.start": "op_container_start",
    "container.resetToBaseCommit": "op_container_reset",
    "container.head": "op_container_head",
    "container.trackedSourceDigest": "op_container_tracked_digest",
    "container.untrackedPaths": "op_container_untracked",
    "container.untrackedSourceAffectingPaths": "op_container_untracked_source_affecting",
    "container.exec": "op_container_exec",
    "container.capturePatch": "op_container_capture_patch",
    "container.stop": "op_container_stop",
    "agent.run": "op_agent_run",
    "evaluator.identity": "op_evaluator_identity",
    "evaluator.evaluate": "op_evaluator_evaluate",
    "accounting": "op_accounting",
}


def load_frozen_instance_ids(manifest_path: str) -> set[str]:
    with open(manifest_path) as fh:
        document = json.load(fh)
    return {row["instanceId"] for row in document["rows"]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="M214's frozen run manifest (§35 guard)")
    parser.add_argument("--dataset", default=DATASET)
    args = parser.parse_args()

    bridge = Bridge(load_frozen_instance_ids(args.manifest), args.dataset)

    def write(payload: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()

    write({"ready": True, "bridgeVersion": BRIDGE_VERSION,
           "frozenPopulationSize": len(bridge.frozen)})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            write({"id": None, "ok": False, "error": f"unparseable request: {exc}"})
            continue
        request_id = request.get("id")
        op = request.get("op")
        params = request.get("params") or {}
        if op == "shutdown":
            write({"id": request_id, "ok": True, "result": bridge.op_accounting({})})
            break
        handler_name = OPS.get(op)
        if handler_name is None:
            write({"id": request_id, "ok": False, "errorKind": "UNKNOWN_OP",
                   "error": f"unknown op: {op}"})
            continue
        handler = getattr(bridge, handler_name)
        try:
            if op == "agent.run":
                def emit(event: dict[str, Any]) -> None:
                    write({"id": request_id, "streaming": True, **event})

                result = handler(params, emit)
            else:
                result = handler(params)
            write({"id": request_id, "ok": True, "result": result})
        except PermissionError as exc:
            write({"id": request_id, "ok": False, "errorKind": "REFUSED", "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            write({"id": request_id, "ok": False, "errorKind": "SUBSTRATE_ERROR",
                   "error": f"{exc}", "traceback": traceback.format_exc()[-2000:]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

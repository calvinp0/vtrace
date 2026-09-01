"""M194 — the declared execution adapter (M193 execution contract §4, §8).

Two hooks, and nothing else, stand between the untreated agent and the instance
container:

  PreToolUse  on Bash          rewrite the command so it executes in the
                               container at /testbed, and record the ordered
                               pre-event
  PostToolUse on Edit|Write|   read back the command's separated streams and
              Bash             record a patch snapshot at the boundary
  Stop                         record the BEFORE_SUBMIT snapshot

Neither hook adds text to the model's context, neither changes what the model is
asked to do, and both apply identically to every arm. They are the execution
substrate, not a treatment.

Two properties are worth stating because getting either wrong silently destroys
a corpus rather than failing loudly:

*Fail closed.* The Claude Code CLI, on a hook that returns no usable
`updatedInput`, "falls back to original tool input" — which would run the
agent's `pytest` on the HOST, in an environment where the package is absent, and
report it as the agent's own failed validation. So every path through the
PreToolUse handler ends in either a routed command or an explicit `deny`, the
top level is wrapped so an unexpected exception still denies, and each routed
call is logged so the accounting step can prove that every Bash call the
transcript contains was in fact routed (§14).

*Observation does not write.* Snapshots go through M193C's read-only patch
authority. The stream capture writes only to the container's own /tmp, which is
not bind-mounted, so nothing the adapter does can enter the model patch.

Invoked from the arm's settings.json:

    python m194_adapter_hooks.py --config <arm>/adapter.json --event pre|post|stop
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shlex
import subprocess
import sys
import time
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Imported, never restated. The activation line and the checkout root are frozen
# substrate: a copy of them here that drifted by one word would hand the agent an
# interpreter that cannot import the package it is editing (§4.1).
from m193_container_adapter import (  # noqa: E402
    CHECKOUT_ROOT,
    CONDA_ACTIVATE,
    normalize_patch,
    sha256_text,
)

CAPTURE_DIR = "/tmp/m194_streams"

# Commands whose text names a test runner. Used only to decide WHERE a snapshot
# boundary falls; the authoritative "was this a validation attempt" judgement is
# made in accounting, over the command text and the observed runner banners
# together, and never over whether the task was resolved (§27).
_RUNNER_TOKENS = (
    "pytest", "py.test", "unittest", "runtests.py", "tox", "nosetests",
    "setup.py test", "sympy/testing", "bin/test", "make test", "./tests/",
    "test_", "_test.py", "sympy.test", "doctest",
)


def looks_like_validation(command: str) -> bool:
    """Structural, over the command text alone. Deliberately generous: a false
    positive costs one extra snapshot, a false negative loses an episode."""
    c = command.lower()
    return any(tok in c for tok in _RUNNER_TOKENS)


# ── the ordered event log ────────────────────────────────────────────


def _next_sequence(config: dict[str, Any]) -> int:
    """A strict total order over hook events, taken under a lock.

    Hooks are separate processes and PostToolUse of one call can overlap
    PreToolUse of the next, so the ordering the analysis depends on is
    established here, at the moment the event happens, rather than reconstructed
    afterwards from interleaved log text (§14).
    """
    path = config["sequencePath"]
    with open(path, "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        fh.seek(0)
        raw = fh.read().strip()
        n = int(raw) if raw else 0
        fh.seek(0)
        fh.truncate()
        fh.write(str(n + 1))
        fh.flush()
        os.fsync(fh.fileno())
    return n


_CURRENT: dict[str, Any] = {}


def emit(config: dict[str, Any], record: dict[str, Any]) -> None:
    for k, v in _CURRENT.items():
        record.setdefault(k, v)
    record.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time()*1000)%1000:03d}Z")
    record.setdefault("wallClock", time.time())
    with open(config["eventLogPath"], "a") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


# ── container access ─────────────────────────────────────────────────


def docker_exec(config: dict[str, Any], command: str, timeout: int = 300) -> tuple[int, str, str]:
    """One container command, for the adapter's own observation only."""
    argv = [
        "docker", "exec", "--workdir", CHECKOUT_ROOT, "--user", "root",
        config["containerName"], "/bin/bash", "-c", command,
    ]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, errors="replace")
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "adapter docker exec timed out"
    except Exception as exc:  # noqa: BLE001
        return 125, "", f"adapter docker exec failed: {exc}"


def frozen_wrapper(config: dict[str, Any], inner: str) -> str:
    """The frozen wrapper text from the execution contract §4, rebuilt here.

    The ownership trap and the conda activation are both load-bearing: without
    the activation the interpreter cannot import the package under test and
    every validation in the corpus would be a false negative (§4.1); without the
    trap a file the container creates becomes unreadable to the agent's Edit
    tool (§4.2).
    """
    activate = CONDA_ACTIVATE.format(env=config["condaEnv"])
    return (
        f"trap 'chown -R {config['hostUid']}:{config['hostGid']} {CHECKOUT_ROOT} >/dev/null 2>&1' EXIT; "
        f"{{ {activate}; }} >/dev/null 2>&1; "
        f"cd {CHECKOUT_ROOT} || exit 1; "
        f"{inner}"
    )


def instrumented(command: str, seq: int) -> str:
    """The agent's command, with its two streams captured separately.

    §20 requires stdout and stderr to be preserved independently, because M192
    found runner markers on one and results on the other. The Bash tool returns
    a single merged, length-capped string, so the separation has to happen on
    the container side.

    A FIFO pair rather than process substitution: the tee processes are explicit
    PIDs that can be waited on, so the capture is complete before the wrapper
    returns rather than complete only if the shell happened not to exit first.
    What the agent sees is unchanged — both tees write through to the real
    stdout and stderr, in their original interleaving, with no pty in the way.
    """
    out_log = f"{CAPTURE_DIR}/{seq}.out"
    err_log = f"{CAPTURE_DIR}/{seq}.err"
    op = f"{CAPTURE_DIR}/{seq}.op"
    ep = f"{CAPTURE_DIR}/{seq}.ep"
    return (
        f"mkdir -p {CAPTURE_DIR}; rm -f {op} {ep}; mkfifo {op} {ep} 2>/dev/null; "
        f"tee {out_log} <{op} & __m194_op=$!; "
        f"tee {err_log} <{ep} >&2 & __m194_ep=$!; "
        f"{{ {command}\n}} >{op} 2>{ep}; __m194_rc=$?; "
        f"wait $__m194_op $__m194_ep 2>/dev/null; rm -f {op} {ep}; "
        f"echo $__m194_rc > {CAPTURE_DIR}/{seq}.rc; "
        f"exit $__m194_rc"
    )


# ── snapshots, through M193C's read-only authority ───────────────────


def capture_snapshot(config: dict[str, Any], boundary: str, seq: int, note: str | None = None) -> dict[str, Any]:
    from m193c_patch_snapshot import parse_patch_snapshot_output, patch_snapshot_command

    rc, out, err = docker_exec(config, patch_snapshot_command(config["preexistingUntracked"]), timeout=300)
    snap = parse_patch_snapshot_output(out, CHECKOUT_ROOT)
    patch_text = snap.get("patch") or ""
    # A refusal and an empty patch are the same string and must never become the
    # same conclusion, so the hash is only meaningful alongside `status` (§15).
    diff_hash = f"sha256:{sha256_text(normalize_patch(patch_text))}" if snap.get("ok") else None
    rec = {
        "kind": "patch_snapshot",
        "sequence": seq,
        "boundary": boundary,
        "status": snap.get("status"),
        "ok": bool(snap.get("ok")),
        "diffHash": diff_hash,
        "diffBytes": len(patch_text.encode()),
        "gitState": snap.get("gitState"),
        "binaryPaths": snap.get("binaryPaths"),
        "execExit": rc,
    }
    if note:
        rec["note"] = note
    if err.strip():
        rec["execStderrTail"] = err.strip()[-400:]
    # The patch itself is written beside the ledger rather than inline: a
    # 40-arm corpus of full snapshots is large, and the hash is what the
    # accounting compares.
    patch = patch_text
    if patch:
        p = os.path.join(config["snapshotDir"], f"{seq:06d}_{boundary}.patch")
        with open(p, "w") as fh:
            fh.write(patch)
        rec["patchPath"] = os.path.relpath(p, config["armRoot"])
    return rec


def _state_hash_before(config: dict[str, Any], pre_seq: int | None) -> str | None:
    """The BEFORE_VALIDATION hash standing when the command was issued.

    Read from the log rather than remembered, because the pre and post hooks are
    different processes and nothing survives between them but the log.
    """
    if pre_seq is None:
        return None
    try:
        with open(config["eventLogPath"]) as fh:
            best = None
            for ln in fh:
                if '"patch_snapshot"' not in ln:
                    continue
                rec = json.loads(ln)
                if rec.get("boundary") == "BEFORE_VALIDATION" and rec.get("sequence", 1e18) < pre_seq:
                    best = rec.get("diffHash")
            return best
    except Exception:  # noqa: BLE001
        return None


def last_diff_hash(config: dict[str, Any]) -> str | None:
    try:
        with open(config["eventLogPath"]) as fh:
            hashes = [
                json.loads(ln).get("diffHash")
                for ln in fh
                if ln.strip() and '"patch_snapshot"' in ln
            ]
        return hashes[-1] if hashes else None
    except Exception:  # noqa: BLE001
        return None


def container_handle(config: dict[str, Any]):
    """The M193 container adapter, rebound to an already-running arm.

    Hooks are separate short-lived processes, so the handle is rebuilt rather
    than passed. Nothing here starts, checks out or mutates anything: the
    handle exists only so the frozen observation methods can be called against
    the arm's own container.
    """
    from m193_container_adapter import InstanceSpec, M193Container

    spec = InstanceSpec(
        instance_id=config["instanceId"],
        repo=config["repo"],
        base_commit=config["baseCommit"],
        image_key=config["imageKey"],
        import_name=config["importName"],
        conda_env=config["condaEnv"],
    )
    box = M193Container(spec, config["armRoot"])
    box.container = box.client.containers.get(config["containerName"])
    box.preexisting_untracked = config["preexistingUntracked"]
    return box


def capture_provenance(config: dict[str, Any], since_epoch: float | None) -> dict[str, Any]:
    """Both provenance axes, measured immediately after the agent's command.

    Path provenance answers which FILE the interpreter resolved; the
    source-version probe answers which BYTES of it ran. They are kept apart and
    both are recorded raw: the verdicts themselves are computed later, in the
    accounting step, by the frozen classifiers reading these numbers (§49).

    Neither probe imports the files it judges and neither writes to the
    checkout — the probe is installed into the container's own /tmp, which is
    not bind-mounted (§18).
    """
    out: dict[str, Any] = {"captured": False}
    try:
        box = container_handle(config)
        out["moduleFile"] = box.module_witness()
        out["probe"] = box.source_version_probe(since_epoch=since_epoch)
        out["bytecodeCacheCount"] = box.bytecode_cache_count()
        out["captured"] = True
    except Exception as exc:  # noqa: BLE001
        # §39: a measurement that failed is an instrument failure, and must not
        # be recorded as a benign absence of evidence.
        out["error"] = repr(exc)
    return out


# ── handlers ─────────────────────────────────────────────────────────


def handle_pre(config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    tool = payload.get("tool_name")
    tool_input = payload.get("tool_input") or {}
    if tool != "Bash":
        return {}
    _CURRENT.update({"toolUseId": payload.get("tool_use_id"), "hookTool": tool, "hookEvent": "PreToolUse"})

    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return deny("the adapter received a Bash call with no command text")

    is_validation = looks_like_validation(command)

    # The snapshot precedes the command, so it takes the lower sequence. Getting
    # this backwards produced a log whose write order and whose sequence order
    # disagreed, which is exactly the reconstruct-order-afterwards hazard the
    # telemetry contract forbids (§14).
    if is_validation:
        snap_seq = _next_sequence(config)
        seq = _next_sequence(config)
        emit(config, capture_snapshot(config, "BEFORE_VALIDATION", snap_seq, note=f"before sequence {seq}"))
    else:
        seq = _next_sequence(config)

    # Host absolute paths into the mount are meaningless inside the container.
    # Translating them is part of routing the command correctly, not a change to
    # it: the two prefixes name the same inodes.
    routed_command = command.replace(config["hostMount"] + "/", CHECKOUT_ROOT + "/")
    routed_command = routed_command.replace(config["hostMount"], CHECKOUT_ROOT)

    inner = instrumented(routed_command, seq)
    wrapped = frozen_wrapper(config, inner)
    host_command = (
        f"docker exec --workdir {CHECKOUT_ROOT} --user root "
        f"{shlex.quote(config['containerName'])} /bin/bash -c {shlex.quote(wrapped)}"
    )

    updated = dict(tool_input)
    updated["command"] = host_command

    emit(config, {
        "kind": "bash_pre",
        "sequence": seq,
        "toolName": "Bash",
        "originalCommand": command,
        "routedCommand": routed_command,
        "pathTranslated": routed_command != command,
        "looksLikeValidation": is_validation,
        "containerName": config["containerName"],
        "workdir": CHECKOUT_ROOT,
        "routedTo": "container",
        "toolUseId": payload.get("tool_use_id"),
        "description": tool_input.get("description"),
        "timeoutRequested": tool_input.get("timeout"),
    })

    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": updated,
        }
    }


def deny(reason: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def handle_post(config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    tool = payload.get("tool_name")
    tool_input = payload.get("tool_input") or {}
    _CURRENT.update({"toolUseId": payload.get("tool_use_id"), "hookTool": tool, "hookEvent": "PostToolUse"})
    seq = _next_sequence(config)

    if tool == "Bash":
        command = tool_input.get("command") or ""
        # The pre-event holds the ORIGINAL text; the tool_input here is the
        # rewritten one, so the capture sequence is recovered from the log.
        pre_seq = None
        original = None
        is_validation = False
        try:
            with open(config["eventLogPath"]) as fh:
                for ln in fh:
                    if '"bash_pre"' not in ln:
                        continue
                    rec = json.loads(ln)
                    if rec.get("toolUseId") and rec.get("toolUseId") == payload.get("tool_use_id"):
                        pre_seq, original, is_validation = rec["sequence"], rec["originalCommand"], rec["looksLikeValidation"]
                        break
                    pre_seq, original, is_validation = rec["sequence"], rec["originalCommand"], rec["looksLikeValidation"]
        except Exception:  # noqa: BLE001
            pass

        streams: dict[str, Any] = {"stdout": "", "stderr": "", "captured": False, "exitCode": None}
        if pre_seq is not None:
            rc, out, _ = docker_exec(
                config,
                f"for f in {CAPTURE_DIR}/{pre_seq}.out {CAPTURE_DIR}/{pre_seq}.err {CAPTURE_DIR}/{pre_seq}.rc; do "
                f"echo \"--M194-STREAM $f\"; cat \"$f\" 2>/dev/null; done",
                timeout=300,
            )
            if rc == 0 and "--M194-STREAM" in out:
                parts = out.split("--M194-STREAM ")
                for part in parts[1:]:
                    head, _, bodytext = part.partition("\n")
                    if head.strip().endswith(".out"):
                        streams["stdout"] = bodytext
                    elif head.strip().endswith(".err"):
                        streams["stderr"] = bodytext
                    elif head.strip().endswith(".rc"):
                        try:
                            streams["exitCode"] = int(bodytext.strip().splitlines()[0])
                        except Exception:  # noqa: BLE001
                            streams["exitCode"] = None
                streams["captured"] = True

        response = payload.get("tool_response")
        emit(config, {
            "kind": "bash_post",
            "sequence": seq,
            "preSequence": pre_seq,
            "toolName": "Bash",
            "originalCommand": original,
            "routedCommandRan": command[:400],
            "looksLikeValidation": is_validation,
            "stdout": streams["stdout"],
            "stderr": streams["stderr"],
            "streamsCaptured": streams["captured"],
            "exitCode": streams["exitCode"],
            "shellExitObserved": streams["exitCode"] is not None,
            "mergedStreamComplete": False,
            "toolResponse": _shrink(response),
            "toolUseId": payload.get("tool_use_id"),
        })

        if is_validation:
            started_at = None
            try:
                with open(config["eventLogPath"]) as fh:
                    for ln in fh:
                        if '"bash_pre"' in ln:
                            rec = json.loads(ln)
                            if rec.get("sequence") == pre_seq:
                                started_at = rec.get("wallClock")
                                break
            except Exception:  # noqa: BLE001
                pass
            prov = capture_provenance(config, started_at)
            after = capture_snapshot(config, "AFTER_VALIDATION", _next_sequence(config),
                                     note=f"after sequence {pre_seq}")
            emit(config, after)
            emit(config, {
                "kind": "validation_provenance",
                "sequence": _next_sequence(config),
                "preSequence": pre_seq,
                "workdir": CHECKOUT_ROOT,
                "checkoutRoot": CHECKOUT_ROOT,
                "robustness": config.get("provenanceRobustness", "UNKNOWN"),
                "moduleFileNeutralCwd": config.get("moduleFileNeutralCwd"),
                "stateHashBefore": _state_hash_before(config, pre_seq),
                "stateHashAfter": after.get("diffHash"),
                **prov,
            })

    before = last_diff_hash(config)
    snap = capture_snapshot(config, "AFTER_EDIT", _next_sequence(config), note=f"after {tool}")
    changed = snap.get("diffHash") != before if before is not None else snap.get("diffBytes", 0) > 0
    if not changed:
        # Nothing changed, so this is not an edit boundary. Recorded as an
        # observation rather than dropped, so the snapshot series is a complete
        # account of what was looked at (§14).
        snap["boundary"] = "OBSERVATION"
    emit(config, snap)
    return {}


def handle_stop(config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    _CURRENT.update({"hookTool": None, "hookEvent": "Stop"})
    emit(config, capture_snapshot(config, "BEFORE_SUBMIT", _next_sequence(config), note="stop hook"))
    return {}


def _shrink(response: Any, cap: int = 4000) -> Any:
    if isinstance(response, str):
        return response[:cap]
    if isinstance(response, dict):
        return {k: (v[:cap] if isinstance(v, str) else v) for k, v in response.items()}
    return response


# ── entry point ──────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--event", required=True, choices=["pre", "post", "stop"])
    args = ap.parse_args()

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception as exc:  # noqa: BLE001
        # A PreToolUse hook that cannot read its own input must not let the
        # command through: fail closed (§8).
        if args.event == "pre":
            print(json.dumps(deny(f"adapter could not parse hook input: {exc}")))
        return 0

    try:
        with open(args.config) as fh:
            config = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        if args.event == "pre":
            print(json.dumps(deny(f"adapter configuration unreadable: {exc}")))
        return 0

    try:
        handler = {"pre": handle_pre, "post": handle_post, "stop": handle_stop}[args.event]
        out = handler(config, payload)
    except Exception as exc:  # noqa: BLE001
        try:
            emit(config, {"kind": "adapter_error", "event": args.event, "error": repr(exc)})
        except Exception:  # noqa: BLE001
            pass
        if args.event == "pre":
            print(json.dumps(deny(f"adapter failed to route the command: {exc}")))
        return 0

    if out:
        print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

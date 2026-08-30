#!/usr/bin/env python
"""
M192 step 2 - exercise the preregistered per-instance SWE-bench environments.

Runs entirely against SWE-bench's own machinery: official prebuilt per-instance
images, swebench's `make_test_spec` for the eval script, and swebench's own log
parsers for per-test status. M192 does not fork evaluator semantics; it only
asks whether that environment can be driven *interactively*.

No coding agents. No model calls. Every command goes through the same
`exec_create/exec_start` path that swebench's own `container.exec_run` uses, so
the probe holds no privilege a future agent could not have.

    /home/calvin/code/vexp-swe-bench/.venv/bin/python \
        benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m192_probes.py

Raw output (full stdout/stderr of every command) goes to the untracked
`results/_m192_probes_raw.json`, following this repo's convention that run
artifacts are not staged. run_stage5_m192_analyze.ts reads it and emits the
bounded, committed `stage5_m192_probes.json` alongside the readiness ledger.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import tarfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import docker

from swebench.harness.grading import get_logs_eval, test_failed, test_passed
from swebench.harness.test_spec.test_spec import make_test_spec

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
MANIFEST = RESULTS / "stage5_m192_probe_manifest.json"
DATASET_DEFAULT = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl"

CHECKOUT_ROOT = "/testbed"
CONDA_PREFIX_CMD = "source /opt/miniconda3/bin/activate && conda activate testbed"
M192_PREFIX = "m192-"

# The single execution path used by every probe. Recorded in the evidence so the
# V12 "no privileged bypass" claim is checkable rather than asserted.
EXEC_PATH = "docker.APIClient.exec_create+exec_start(user=root, /bin/bash -c)"


# ── truthful command telemetry ──────────────────────────────────────


def exec_cmd(client, container_id, command, timeout, workdir=CHECKOUT_ROOT, label="", demux=True):
    """Run one command and report what actually happened, without inference.

    process_started, runner reach, exit status and timeout are separate fields.
    A command that times out does not get an invented exit code.
    """
    record = {
        "label": label,
        "command": command,
        "cwd": workdir,
        "exec_path": EXEC_PATH,
        "process_started": False,
        "exit_code": None,
        "stdout": "",
        "stderr": "",
        "timed_out": False,
        "signal": None,
        "duration_ms": 0,
        "container_id": container_id[:12],
        "error": None,
    }
    t0 = time.time()
    try:
        handle = client.api.exec_create(
            container_id,
            cmd=["/bin/bash", "-c", command],
            workdir=workdir,
            user="root",
            stdout=True,
            stderr=True,
        )
    except Exception as exc:  # container gone, daemon error, bad workdir
        record["error"] = f"exec_create: {exc}"
        record["duration_ms"] = int((time.time() - t0) * 1000)
        return record

    exec_id = handle["Id"]
    box = {}

    def _start():
        try:
            box["out"] = client.api.exec_start(exec_id, demux=demux)
        except Exception as exc:
            box["exc"] = exc

    thread = threading.Thread(target=_start, daemon=True)
    thread.start()
    thread.join(timeout)

    if thread.is_alive():
        record["timed_out"] = True
        record["process_started"] = True
        record["duration_ms"] = int((time.time() - t0) * 1000)
        return record

    record["duration_ms"] = int((time.time() - t0) * 1000)
    if "exc" in box:
        record["error"] = f"exec_start: {box['exc']}"
        return record

    raw = box.get("out")
    if demux:
        out, err = raw or (None, None)
    else:
        # swebench's own container.exec_run() captures the two streams merged and
        # in order. get_logs_eval depends on that interleaving: the START/END
        # markers are `:` no-ops that only ever surface on stderr via `set -x`,
        # while the test results go to stdout. Splitting the streams and
        # concatenating them reorders the log and moves the results outside the
        # markers, so the eval command is captured exactly the way the harness
        # captures it.
        out, err = raw, None
    record["process_started"] = True
    record["demuxed"] = demux
    record["stdout"] = (out or b"").decode("utf-8", "replace")
    record["stderr"] = (err or b"").decode("utf-8", "replace")
    try:
        info = client.api.exec_inspect(exec_id)
        record["exit_code"] = info.get("ExitCode")
    except Exception as exc:
        record["error"] = f"exec_inspect: {exc}"
    return record


def put_file(client, container_id, path, content):
    """Place a file inside the container (same mechanism as swebench's copy_to_container)."""
    data = content.encode()
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as tar:
        info = tarfile.TarInfo(name=os.path.basename(path))
        info.size = len(data)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(data))
    stream.seek(0)
    client.api.put_archive(container_id, os.path.dirname(path) or "/", stream.read())


# ── the controlled mutation (V3/V4/V9) ──────────────────────────────


def sentinel_source(nonce):
    """Appended to the module the runtime actually loads.

    It does not print: pytest and django capture stdout, and a captured marker
    is not evidence. It writes a nonce file instead, which survives any capture
    strategy the runner uses. Failure is swallowed so the probe can never turn a
    provenance question into a test failure.
    """
    return (
        "\n\n# --- M192 disposable provenance sentinel (container-only) ---\n"
        "try:\n"
        f"    open('/tmp/m192_nonce_{nonce}', 'a').write('M192_SENTINEL_{nonce}\\n')\n"
        "except Exception:\n"
        "    pass\n"
        "# --- end M192 sentinel ---\n"
    )


def status_summary(entry, status_map):
    """Summarise a parsed status map using swebench's own pass/fail predicates.

    `test_passed` requires the id to be present and PASSED/XFAIL; `test_failed`
    treats an ERROR *or an absent id* as failing. M192 reuses those predicates
    rather than inventing its own, so the substrate is never judged by a stricter
    rule than the evaluator that owns the verdict.
    """
    p, f = entry["pProbe"], entry["fProbe"]
    return {
        "parsed": len(status_map),
        "pProbeStatus": status_map.get(p) if p else None,
        "fProbeStatus": status_map.get(f) if f else None,
        "pProbePassed": bool(p) and test_passed(p, status_map),
        "fProbeFailed": bool(f) and test_failed(f, status_map),
        "fProbePassed": bool(f) and test_passed(f, status_map),
    }


# ── per-instance probe ──────────────────────────────────────────────


def probe_instance(entry, instance, args):
    iid = entry["instanceId"]
    nonce = iid.replace("__", "_").replace("-", "_").replace(".", "_")
    image = entry["instanceImageKey"]
    container_name = f"{M192_PREFIX}{nonce}"

    result = {
        "instanceId": iid,
        "repo": entry["repo"],
        "baseCommit": entry["baseCommit"],
        "instanceImageKey": image,
        "containerName": container_name,
        "containerId": None,
        "importName": entry["importName"],
        "pProbe": entry["pProbe"],
        "fProbe": entry["fProbe"],
        "checkoutRoot": CHECKOUT_ROOT,
        "execPath": EXEC_PATH,
        "image": {"present_before": None, "pulled": False, "pull_ms": 0, "size_bytes": None},
        "commands": [],
        "moduleFile": None,
        "mutationTarget": None,
        "evidence": {},
        "testStatus": {"clean": {}, "mutated": {}, "gold": {}},
        "error": None,
        "createdContainer": False,
    }

    client = docker.from_env(timeout=args.docker_timeout)
    container = None

    def run(label, command, timeout, workdir=CHECKOUT_ROOT, demux=True):
        rec = exec_cmd(client, container.id, command, timeout, workdir, label, demux=demux)
        result["commands"].append(rec)
        return rec

    def run_eval(label, log_name):
        """Run the benchmark's own eval script and parse it with swebench's parser."""
        rec = run(label, "/bin/bash /eval_m192.sh", args.eval_timeout, demux=False)
        log = RESULTS / "_m192_logs" / log_name
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(rec["stdout"])
        try:
            status_map, applied = get_logs_eval(spec, str(log))
        except Exception as exc:
            status_map, applied = {}, False
            result["evidence"].setdefault("parseErrors", []).append(f"{label}: {exc}")
        return rec, status_map, applied

    try:
        # ── image acquisition (§26) ──
        t0 = time.time()
        try:
            img = client.images.get(image)
            result["image"]["present_before"] = True
        except docker.errors.ImageNotFound:
            result["image"]["present_before"] = False
            img = client.images.pull(image)
            result["image"]["pulled"] = True
        result["image"]["pull_ms"] = int((time.time() - t0) * 1000)
        result["image"]["size_bytes"] = img.attrs.get("Size")

        # ── V1: create a persistent container, same shape as build_container ──
        for old in client.containers.list(all=True):
            if old.name.lstrip("/") == container_name and old.name.lstrip("/").startswith(M192_PREFIX):
                old.remove(force=True)
        container = client.containers.create(
            image=image,
            name=container_name,
            user="root",
            detach=True,
            command="tail -f /dev/null",
        )
        result["createdContainer"] = True
        result["containerId"] = container.id
        t_start = time.time()
        container.start()
        result["evidence"]["container_start_ms"] = int((time.time() - t_start) * 1000)

        v1 = run("v1_environment_starts", "echo M192_V1_OK", args.short_timeout, workdir="/")
        result["evidence"]["v1"] = "M192_V1_OK" in v1["stdout"] and v1["exit_code"] == 0

        # latency of a trivial repeat command (§27)
        v1b = run("latency_repeat", "echo M192_REPEAT", args.short_timeout, workdir="/")
        result["evidence"]["repeat_command_ms"] = v1b["duration_ms"]

        # ── V11: telemetry discrimination (§17) ──
        # Deterministic controls proving the channel can tell apart states that a
        # single "did it work" boolean would merge. Without these V11 would be an
        # assertion; M191's whole lesson is that assertions about environments
        # are what fail.
        t_zero = run("t11_exit_zero", "exit 0", args.short_timeout)
        t_nonzero = run("t11_exit_nonzero", "exit 42", args.short_timeout)
        t_streams = run("t11_stream_separation", "echo M192_OUT; echo M192_ERR >&2", args.short_timeout)
        t_timeout = run("t11_timeout", "sleep 30", 3)
        t_nocwd = exec_cmd(
            client, container.id, "echo unreachable", args.short_timeout,
            workdir="/m192_nonexistent_dir", label="t11_missing_cwd",
        )
        result["commands"].append(t_nocwd)
        result["evidence"]["telemetry"] = {
            "exitZeroObserved": t_zero["exit_code"] == 0,
            "exitCodePreserved": t_nonzero["exit_code"] == 42,
            "stdoutIsolated": "M192_OUT" in t_streams["stdout"] and "M192_ERR" not in t_streams["stdout"],
            "stderrIsolated": "M192_ERR" in t_streams["stderr"] and "M192_OUT" not in t_streams["stderr"],
            "timeoutDistinguishable": t_timeout["timed_out"] and t_timeout["exit_code"] is None,
            "missingCwdIsNotATestFailure": (
                t_nocwd["process_started"] is False or t_nocwd["exit_code"] not in (0,)
            ),
            "missingCwdDetail": (t_nocwd["error"] or "")[:300],
        }

        # ── V2: the instance's base commit is present as the checkout ──
        # swebench 4.x images carry one extra commit titled "SWE-bench" on top of
        # base_commit, holding its own provisioning fixups (setup.py / tox.ini
        # dependency pins). So HEAD is deliberately not base_commit. The honest
        # test of "the expected revision is present" is ancestry plus an explicit
        # record of exactly what swebench changed on top of it.
        base = entry["baseCommit"]
        v2 = run("v2_source_readable", "git rev-parse HEAD", args.short_timeout)
        head = v2["stdout"].strip()
        result["evidence"]["observedHead"] = head
        anc = run(
            "v2_base_is_ancestor",
            f"git merge-base --is-ancestor {base} HEAD && echo M192_ANCESTOR_YES || echo M192_ANCESTOR_NO",
            args.short_timeout,
        )
        delta = run("v2_base_delta", f"git diff --stat {base} HEAD", args.medium_timeout)
        result["evidence"]["baseIsAncestor"] = "M192_ANCESTOR_YES" in anc["stdout"]
        result["evidence"]["baseToHeadDelta"] = delta["stdout"].strip()[:2000]
        result["evidence"]["headEqualsBase"] = head == base
        result["evidence"]["v2"] = result["evidence"]["baseIsAncestor"]

        # ── V8 path witness, before any mutation (§32) ──
        prov_cmd = (
            f"{CONDA_PREFIX_CMD} && cd {CHECKOUT_ROOT} && python -c "
            f"\"import sys, {entry['importName']} as _m; "
            f"print('M192_MODFILE=' + str(_m.__file__)); "
            f"print('M192_EXE=' + sys.executable); "
            f"print('M192_PREFIX=' + sys.prefix); "
            f"print('M192_SYSPATH=' + repr(sys.path[:6]))\""
        )
        prov = run("v8_provenance_pre", prov_cmd, args.medium_timeout)

        # The same import from a NEUTRAL working directory. Running it from
        # /testbed puts '' -> /testbed at the head of sys.path, which biases the
        # answer toward the checkout; from / that bias is gone, so a package that
        # still resolves under /testbed is genuinely installed editable and the
        # test process cannot pick up a copy instead. The wrong-source control
        # showed a copy can carry an edit forward and fire the sentinel, so this
        # distinction has to be measured rather than assumed.
        prov_neutral = run(
            "v8_provenance_neutral_cwd",
            prov_cmd.replace(f"cd {CHECKOUT_ROOT} && ", ""),
            args.medium_timeout,
            workdir="/",
        )
        for line in prov_neutral["stdout"].splitlines():
            if line.startswith("M192_MODFILE="):
                result["evidence"]["moduleFileNeutralCwd"] = line.split("=", 1)[1].strip()
        for line in prov["stdout"].splitlines():
            if line.startswith("M192_MODFILE="):
                result["moduleFile"] = line.split("=", 1)[1].strip()
            elif line.startswith("M192_EXE="):
                result["evidence"]["sysExecutable"] = line.split("=", 1)[1].strip()
            elif line.startswith("M192_PREFIX="):
                result["evidence"]["sysPrefix"] = line.split("=", 1)[1].strip()
            elif line.startswith("M192_SYSPATH="):
                result["evidence"]["sysPath"] = line.split("=", 1)[1].strip()

        # ── V5/V6/V7: the benchmark's own eval script, clean state ──
        # State S1 = base + the benchmark's own test patch (applied by the eval
        # script itself). No model patch, no gold, no sentinel.
        spec = make_test_spec(instance, namespace="swebench")
        put_file(client, container.id, "/eval_m192.sh", spec.eval_script)
        ev_clean, clean_status, _ = run_eval("s1_eval_clean", f"{iid}.clean.log")
        result["testStatus"]["clean"] = status_summary(entry, clean_status)

        # ── V3: mutate exactly the file the runtime resolved ──
        modfile = result["moduleFile"]
        if modfile and modfile.startswith(CHECKOUT_ROOT + "/"):
            result["mutationTarget"] = modfile
            put_file(client, container.id, "/m192_sentinel.txt", sentinel_source(nonce))
            v3 = run("v3_source_writable", f"cat /m192_sentinel.txt >> {modfile}", args.short_timeout)
            result["evidence"]["v3"] = v3["exit_code"] == 0

            # ── V4: a *separate* command observes the mutation ──
            v4 = run(
                "v4_mutation_persists",
                f"grep -c 'M192_SENTINEL_{nonce}' {modfile}",
                args.short_timeout,
            )
            result["evidence"]["v4"] = v4["exit_code"] == 0 and v4["stdout"].strip() not in ("", "0")

            # ── V9: does validation execute the mutation? State S2. ──
            run("v9_clear_nonce", f"rm -f /tmp/m192_nonce_{nonce}", args.short_timeout)
            ev_mut, mut_status, _ = run_eval("s2_eval_mutated", f"{iid}.mutated.log")
            fired = run(
                "v9_nonce_check",
                f"test -f /tmp/m192_nonce_{nonce} && echo M192_FIRED || echo M192_NOT_FIRED",
                args.short_timeout,
            )
            result["evidence"]["v9"] = "M192_FIRED" in fired["stdout"]
            result["evidence"]["v9_repeat_validation_started"] = (
                ">>>>> Start Test Output" in ev_mut["stdout"]
            )
            result["testStatus"]["mutated"] = status_summary(entry, mut_status)

            # ── V8 post-mutation path witness (§32) ──
            prov2 = run("v8_provenance_post", prov_cmd, args.medium_timeout)
            post = [
                l.split("=", 1)[1].strip()
                for l in prov2["stdout"].splitlines()
                if l.startswith("M192_MODFILE=")
            ]
            result["evidence"]["moduleFilePost"] = post[0] if post else None

            # ── V10: remove M192's own mutation ──
            rel = modfile[len(CHECKOUT_ROOT) + 1 :]
            run("v10_restore", f"git checkout -- {rel} && rm -f /tmp/m192_nonce_{nonce}", args.short_timeout)
            still = run(
                "v10_verify_mutation_gone",
                f"grep -c 'M192_SENTINEL_{nonce}' {modfile} || true",
                args.short_timeout,
            )
            result["evidence"]["v10_mutation_removed"] = still["stdout"].strip() in ("", "0")
            residual = run("v10_residual_status", "git status --porcelain", args.medium_timeout)
            result["evidence"]["v10_residual"] = residual["stdout"].strip()[:2000]
        else:
            result["evidence"]["v3"] = False
            result["evidence"]["v4"] = False
            result["evidence"]["v9"] = False
            result["evidence"]["v10_mutation_removed"] = True
            result["evidence"]["mutationSkippedReason"] = (
                "module did not resolve under the checkout root; mutating it would not "
                "have tested the checkout under edit"
            )

        # ── §10 reference control: state S3 = base + test patch + gold ──
        # Applied uniformly to all twelve instances, decided before any row was
        # read, because "the P-probe passes" is only a benchmark guarantee in the
        # repaired state. This is the environment control the prompt sanctions:
        # the same test fails before the reference repair and passes after it.
        # It is infrastructure verification only and never reaches an agent arm.
        gold = instance.get("patch", "")
        if gold:
            put_file(client, container.id, "/m192_gold.patch", gold)
            applied = run(
                "s3_apply_gold",
                "git apply -v /m192_gold.patch || git apply -v --reject /m192_gold.patch",
                args.medium_timeout,
            )
            result["evidence"]["goldApplied"] = applied["exit_code"] == 0
            if applied["exit_code"] == 0:
                _ev_gold, gold_status, _ = run_eval("s3_eval_gold", f"{iid}.gold.log")
                result["testStatus"]["gold"] = status_summary(entry, gold_status)
            run("s3_restore_gold", "git checkout -- . && git reset --hard HEAD", args.medium_timeout)

    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["traceback"] = traceback.format_exc()[-4000:]
    finally:
        # §29: only ever remove what M192 created.
        if container is not None and result["createdContainer"]:
            name = container.name.lstrip("/")
            if name.startswith(M192_PREFIX):
                try:
                    container.remove(force=True)
                    result["evidence"]["containerRemoved"] = True
                except Exception as exc:
                    result["evidence"]["containerRemoved"] = False
                    result["evidence"]["containerRemoveError"] = str(exc)
            else:
                result["evidence"]["containerRemoved"] = False
                result["evidence"]["containerRemoveError"] = "refused: not an M192-owned name"

    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=DATASET_DEFAULT)
    ap.add_argument("--out", default=str(RESULTS / "_m192_probes_raw.json"))
    ap.add_argument("--instances", default="", help="comma-separated subset (debug only)")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--short-timeout", type=int, default=120)
    ap.add_argument("--medium-timeout", type=int, default=600)
    ap.add_argument("--eval-timeout", type=int, default=2400)
    ap.add_argument("--docker-timeout", type=int, default=3600)
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text())
    rows = {}
    with open(args.dataset) as fh:
        for line in fh:
            if line.strip():
                d = json.loads(line)
                rows[d["instance_id"]] = d

    entries = manifest["instances"]
    if args.instances:
        wanted = set(args.instances.split(","))
        entries = [e for e in entries if e["instanceId"] in wanted]

    def instance_for(entry):
        inst = dict(rows[entry["instanceId"]])
        for key in ("PASS_TO_PASS", "FAIL_TO_PASS"):
            if isinstance(inst[key], str):
                inst[key] = json.loads(inst[key])
        return inst

    started = time.time()
    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(probe_instance, e, instance_for(e), args): e["instanceId"] for e in entries
        }
        for fut in as_completed(futures):
            iid = futures[fut]
            try:
                res = fut.result()
            except Exception as exc:
                res = {"instanceId": iid, "error": f"probe crashed: {exc}"}
            results.append(res)
            print(f"  done {iid}  ({len(results)}/{len(entries)})", flush=True)

    results.sort(key=lambda r: r["instanceId"])
    payload = {
        "milestone": "M192",
        "manifestSha256": manifest.get("datasetSha256"),
        "harness": "swebench==4.1.0",
        "execPath": EXEC_PATH,
        "checkoutRoot": CHECKOUT_ROOT,
        "liveAgentRuns": 0,
        "liveModelSpendUsd": 0,
        "wallClockSeconds": round(time.time() - started, 1),
        "workers": args.workers,
        "instanceCount": len(results),
        "results": results,
    }
    Path(args.out).write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {args.out}  ({len(results)} instances, {payload['wallClockSeconds']}s)")


if __name__ == "__main__":
    main()

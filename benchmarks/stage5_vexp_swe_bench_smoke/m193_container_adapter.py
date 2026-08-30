"""M193 — the host-agent / container execution seam (§24, §25, §26).

Frozen before any live agent call. Nothing here invokes a model.

Architecture
------------

    agent (host)  Read/Edit/Write/Grep/Glob  ->  <host_mount>/testbed
                  Bash                       ->  PreToolUse hook
                                                    -> docker exec
                                                       -w /testbed
                                                       conda env activated
                                                    -> same inodes

`<host_mount>/testbed` is bind-mounted into the container at `/testbed`, so the
host file tools and the container's interpreter address ONE tree at ONE path.
There is no second checkout and no synchronisation step (§26).

Three things this module refuses to get wrong, each of them a finding paid for
by an earlier milestone:

* The workdir is always passed explicitly. `docker exec` otherwise inherits the
  image's WORKDIR, which is how psf/requests silently resolves an installed copy
  (M192).
* stdout, stderr and the ordered merge are all built from the SAME multiplexed
  frame sequence, so no marker can go missing to demultiplexing (§23).
* The shell's exit status and the tests' semantic result are captured as
  separate facts. swebench's own eval script exits 0 after a failing test.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import docker

CHECKOUT_ROOT = "/testbed"

# The probe travels into the container's /tmp, never into the checkout: anything
# written under /testbed would enter the model patch and every diff snapshot.
SOURCE_VERSION_PROBE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "m193a_source_version_probe.py")
CONTAINER_PROBE_PATH = "/tmp/m193a_source_version_probe.py"

# The exact activation swebench's own eval script performs. Reproduced rather
# than approximated: with the base interpreter the package is simply absent.
CONDA_ACTIVATE = "source /opt/miniconda3/bin/activate && conda activate {env}"
DEFAULT_CONDA_ENV = "testbed"

EXEC_PATH = "docker.APIClient.exec_create+exec_start(user=root, /bin/bash -c, stream+demux)"

M193_RESOURCE_PREFIX = "m193-"


def conda_env_for(eval_script: str) -> str:
    """Read the environment name out of the instance's own eval script."""
    m = re.search(r"conda activate (\S+)", eval_script or "")
    return m.group(1) if m else DEFAULT_CONDA_ENV


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogateescape")).hexdigest()


@dataclass
class CommandRecord:
    """One command, reported without inference (§17, §22)."""

    label: str
    command: str
    wrapped_command: str
    cwd: str
    routed_to: str
    exec_path: str
    process_started: bool = False
    exit_code: int | None = None
    timed_out: bool = False
    signal: str | None = None
    duration_ms: int = 0
    stdout: str = ""
    stderr: str = ""
    merged_stream: str = ""
    merged_stream_complete: bool = True
    container_id: str = ""
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class InstanceSpec:
    instance_id: str
    repo: str
    base_commit: str
    image_key: str
    import_name: str
    conda_env: str = DEFAULT_CONDA_ENV


@dataclass
class SetupReport:
    ok: bool
    container_id: str | None = None
    host_mount: str | None = None
    workdir: str = CHECKOUT_ROOT
    head_after_checkout: str | None = None
    base_commit_reachable: bool = False
    preexisting_untracked: list[str] = field(default_factory=list)
    extract_ms: int = 0
    start_ms: int = 0
    errors: list[str] = field(default_factory=list)


class M193Container:
    """One instance's authoritative mutable checkout plus its container."""

    def __init__(self, spec: InstanceSpec, host_root: str, host_uid: int | None = None, host_gid: int | None = None):
        self.spec = spec
        self.host_root = os.path.abspath(host_root)
        self.host_mount = os.path.join(self.host_root, "testbed")
        self.host_uid = os.getuid() if host_uid is None else host_uid
        self.host_gid = os.getgid() if host_gid is None else host_gid
        self.client = docker.from_env()
        self.container = None
        self.preexisting_untracked: list[str] = []
        self._probe_installed = False
        self.name = M193_RESOURCE_PREFIX + re.sub(r"[^a-zA-Z0-9_.-]", "-", spec.instance_id)

    # ── lifecycle ───────────────────────────────────────────────────

    def _rm_named(self, name: str) -> None:
        try:
            self.client.containers.get(name).remove(force=True)
        except Exception:
            pass

    def setup(self) -> SetupReport:
        rep = SetupReport(ok=False, host_mount=self.host_mount)
        try:
            self.client.images.get(self.spec.image_key)
        except docker.errors.ImageNotFound:
            rep.errors.append(f"image not available locally: {self.spec.image_key}")
            return rep
        except Exception as exc:
            rep.errors.append(f"image lookup failed: {exc}")
            return rep

        # 1. extract /testbed from the image to the host, once.
        t0 = time.time()
        staging = self.name + "-stage"
        self._rm_named(staging)
        if os.path.isdir(self.host_mount):
            shutil.rmtree(self.host_mount, ignore_errors=True)
        os.makedirs(self.host_root, exist_ok=True)
        try:
            stage = self.client.containers.create(self.spec.image_key, command="true", name=staging)
            subprocess.run(
                ["docker", "cp", f"{stage.id}:{CHECKOUT_ROOT}", self.host_mount],
                check=True,
                capture_output=True,
            )
            stage.remove(force=True)
        except subprocess.CalledProcessError as exc:
            rep.errors.append(f"docker cp failed: {exc.stderr.decode('utf-8', 'replace')[:400]}")
            self._rm_named(staging)
            return rep
        except Exception as exc:
            rep.errors.append(f"extract failed: {exc}")
            self._rm_named(staging)
            return rep
        rep.extract_ms = int((time.time() - t0) * 1000)

        # 2. start the container over the extracted tree.
        t1 = time.time()
        self._rm_named(self.name)
        try:
            self.container = self.client.containers.create(
                self.spec.image_key,
                command="tail -f /dev/null",
                name=self.name,
                volumes={self.host_mount: {"bind": CHECKOUT_ROOT, "mode": "rw"}},
                working_dir=CHECKOUT_ROOT,
                detach=True,
            )
            self.container.start()
        except Exception as exc:
            rep.errors.append(f"container start failed: {exc}")
            return rep
        rep.start_ms = int((time.time() - t1) * 1000)
        rep.container_id = self.container.id

        # 3. the bind mount gives the tree host ownership while the container is
        #    root, which git refuses to work across until told it is safe.
        self.exec_raw("git config --global --add safe.directory /testbed", timeout=60, label="setup_safe_directory")

        # 4. the image checkout is an ancestor-bearing branch tip, not the task's
        #    base commit; swebench's eval script checks out the base at run time
        #    and so must we (M192's V2 ancestry correction).
        anc = self.exec_raw(
            f"git merge-base --is-ancestor {self.spec.base_commit} HEAD && echo YES || echo NO",
            timeout=120,
            label="setup_base_ancestry",
        )
        rep.base_commit_reachable = "YES" in anc.stdout
        co = self.exec_raw(f"git checkout -f {self.spec.base_commit}", timeout=300, label="setup_checkout_base")
        head = self.exec_raw("git rev-parse HEAD", timeout=60, label="setup_head")
        rep.head_after_checkout = head.stdout.strip() or None
        if rep.head_after_checkout != self.spec.base_commit:
            rep.errors.append(
                f"checkout did not land on base_commit (head={rep.head_after_checkout}, rc={co.exit_code})"
            )

        # 5. record the environment's own untracked build output BEFORE the agent
        #    exists, so it can never enter the model patch.
        st = self.exec_raw("git status --porcelain", timeout=120, label="setup_preexisting_untracked")
        self.preexisting_untracked = sorted(
            line[3:].strip().rstrip("/") for line in st.stdout.splitlines() if line.startswith("??")
        )
        rep.preexisting_untracked = list(self.preexisting_untracked)

        self.normalize_ownership()
        rep.ok = not rep.errors
        return rep

    def teardown(self, remove_mount: bool = True) -> dict[str, Any]:
        out: dict[str, Any] = {"containerRemoved": False, "mountRemoved": False}
        try:
            if self.container is not None:
                self.container.remove(force=True)
                out["containerRemoved"] = True
        except Exception as exc:
            out["containerRemoveError"] = str(exc)
        if remove_mount:
            try:
                shutil.rmtree(self.host_mount, ignore_errors=True)
                out["mountRemoved"] = not os.path.isdir(self.host_mount)
            except Exception as exc:
                out["mountRemoveError"] = str(exc)
        return out

    # ── the single execution seam ───────────────────────────────────

    def wrap(self, command: str, pin_cwd: bool = True) -> str:
        """The frozen wrapper.

        The EXIT trap normalises ownership even when the command ends in `exec`
        or `exit`, so a file the container creates never becomes unreadable to
        the host's editing tools.

        `pin_cwd=False` exists for exactly one purpose: the robustness probe has
        to observe what happens WITHOUT the pin, and a wrapper that always cds
        into the checkout would report every repository as an editable install
        by construction. An instrument must be able to step outside the
        guarantee it is verifying. Agent commands are never run this way.
        """
        activate = CONDA_ACTIVATE.format(env=self.spec.conda_env)
        cd = f"cd {CHECKOUT_ROOT} || exit 1; " if pin_cwd else ""
        return (
            f"trap 'chown -R {self.host_uid}:{self.host_gid} {CHECKOUT_ROOT} >/dev/null 2>&1' EXIT; "
            f"{{ {activate}; }} >/dev/null 2>&1; "
            f"{cd}"
            f"{command}"
        )

    def exec_raw(
        self,
        command: str,
        timeout: int,
        label: str = "",
        workdir: str = CHECKOUT_ROOT,
        pin_cwd: bool = True,
    ) -> CommandRecord:
        """Run one command in the container with the workdir pinned explicitly.

        stdout, stderr and the ordered merge all come from one multiplexed frame
        sequence, so they cannot disagree about what happened.
        """
        wrapped = self.wrap(command, pin_cwd=pin_cwd)
        rec = CommandRecord(
            label=label,
            command=command,
            wrapped_command=wrapped,
            cwd=workdir,
            routed_to="container",
            exec_path=EXEC_PATH,
            container_id=(self.container.id[:12] if self.container else ""),
        )
        if self.container is None:
            rec.error = "no container"
            return rec

        api = self.client.api
        t0 = time.time()
        try:
            handle = api.exec_create(
                self.container.id,
                cmd=["/bin/bash", "-c", wrapped],
                workdir=workdir,
                user="root",
                stdout=True,
                stderr=True,
            )
        except Exception as exc:
            rec.error = f"exec_create: {exc}"
            rec.duration_ms = int((time.time() - t0) * 1000)
            return rec

        exec_id = handle["Id"]
        out_buf: list[str] = []
        err_buf: list[str] = []
        merged: list[str] = []
        box: dict[str, Any] = {}

        def _pump() -> None:
            try:
                for chunk in api.exec_start(exec_id, stream=True, demux=True):
                    o, e = chunk if isinstance(chunk, tuple) else (chunk, None)
                    if o:
                        s = o.decode("utf-8", "replace")
                        out_buf.append(s)
                        merged.append(s)
                    if e:
                        s = e.decode("utf-8", "replace")
                        err_buf.append(s)
                        merged.append(s)
                box["done"] = True
            except Exception as exc:  # daemon hiccup mid-stream
                box["exc"] = exc

        th = threading.Thread(target=_pump, daemon=True)
        th.start()
        th.join(timeout)

        rec.stdout = "".join(out_buf)
        rec.stderr = "".join(err_buf)
        rec.merged_stream = "".join(merged)
        rec.merged_stream_complete = True

        if th.is_alive():
            rec.process_started = True
            rec.timed_out = True
            rec.signal = "TIMEOUT"
            rec.duration_ms = int((time.time() - t0) * 1000)
            # No exit code is invented for a command that has not ended.
            return rec

        rec.duration_ms = int((time.time() - t0) * 1000)
        if "exc" in box:
            rec.error = f"exec_start: {box['exc']}"
            rec.merged_stream_complete = False
            return rec

        rec.process_started = True
        try:
            info = api.exec_inspect(exec_id)
            rec.exit_code = info.get("ExitCode")
        except Exception as exc:
            rec.error = f"exec_inspect: {exc}"
        return rec

    def normalize_ownership(self) -> None:
        self.exec_raw(
            f"chown -R {self.host_uid}:{self.host_gid} {CHECKOUT_ROOT} >/dev/null 2>&1; true",
            timeout=300,
            label="normalize_ownership",
        )

    # ── out-of-band provenance witnesses (§20) ──────────────────────

    def module_witness(self, workdir: str = CHECKOUT_ROOT, pin_cwd: bool = True) -> str | None:
        """`<pkg>.__file__` measured in the same container and workdir.

        Runs as a separate command AFTER the agent's, so nothing is injected
        into the agent's own process and no runtime instrumentation is added
        (§45). It is invisible to the agent.
        """
        cmd = (
            f"python -c \"import {self.spec.import_name} as _m; "
            f"print(getattr(_m, '__file__', '') or '')\" 2>/dev/null"
        )
        rec = self.exec_raw(cmd, timeout=120, label="module_witness", workdir=workdir, pin_cwd=pin_cwd)
        path = rec.stdout.strip().splitlines()[-1].strip() if rec.stdout.strip() else ""
        return path or None

    def provenance_robustness(self) -> tuple[str, str | None]:
        """EDITABLE_INSTALL vs CWD_DEPENDENT, measured from a neutral workdir."""
        neutral = self.module_witness(workdir="/", pin_cwd=False)
        if not neutral:
            return "UNKNOWN", neutral
        return ("EDITABLE_INSTALL" if neutral.startswith(CHECKOUT_ROOT + "/") else "CWD_DEPENDENT"), neutral

    # ── patch capture (§18, §27) ────────────────────────────────────

    def _exclusion_pathspec(self) -> str:
        return " ".join(f"':(exclude){p}'" for p in self.preexisting_untracked)

    def capture_diff(self) -> tuple[str, CommandRecord]:
        """The interactive diff, with the environment's own build output excluded.

        A naive `git add -A` would stage whatever the image left untracked in the
        checkout. psf/requests ships an untracked `build/` directory, so that
        would put environment artifacts into the model patch. Paths untracked
        *before the agent existed* are excluded; anything the agent creates is
        kept, because SWE-bench permits new source files.
        """
        excl = self._exclusion_pathspec()
        cmd = (
            f"git -c core.fileMode=false add -A -- . {excl} >/dev/null 2>&1; "
            f"git -c core.fileMode=false diff --cached; "
            f"rc=$?; git reset -q >/dev/null 2>&1; exit $rc"
        )
        rec = self.exec_raw(cmd, timeout=300, label="capture_diff")
        return rec.stdout, rec

    def capture_diff_hash(self) -> tuple[str, str]:
        patch, _ = self.capture_diff()
        return sha256_text(normalize_patch(patch)), patch


    def bytecode_cache_count(self) -> int:
        """How many compiled caches live inside the checkout.

        Not cosmetic. CPython validates a cache against the source's
        (mtime_seconds, size), so an edit that preserves size within the same
        second is invisible to the interpreter while every path witness still
        says the edited checkout is what resolved. Recorded per validation so
        the condition is measurable later; deliberately NOT suppressed, because
        suppressing it would change the environment the baseline agent faces.
        """
        rec = self.exec_raw(
            f"find {CHECKOUT_ROOT} -name '*.pyc' 2>/dev/null | wc -l", timeout=180, label="bytecode_cache_count"
        )
        try:
            return int(rec.stdout.strip().splitlines()[-1])
        except Exception:
            return -1

    # ── M193A source-version witness (§7, §10, §16) ─────────────────

    def changed_source_paths(self) -> list[str]:
        """The changed-source set whose freshness matters (§16).

        Everything the working tree currently differs by, as absolute container
        paths. A whole-repository freshness proof is neither necessary nor
        affordable; what a validation event is evidence ABOUT is the edited
        program, and the edited program is exactly this set. Read from git
        rather than from our own snapshot bookkeeping so it cannot drift from
        what the checkout really holds.
        """
        excl = self._exclusion_pathspec()
        rec = self.exec_raw(
            f"git -c core.fileMode=false add -A -- . {excl} >/dev/null 2>&1; "
            f"git -c core.fileMode=false diff --cached --name-only; "
            f"git reset -q >/dev/null 2>&1",
            timeout=300,
            label="changed_source_paths",
        )
        out: list[str] = []
        for line in rec.stdout.splitlines():
            rel = line.strip()
            if rel:
                out.append(os.path.join(CHECKOUT_ROOT, rel))
        return sorted(set(out))

    def _install_source_version_probe(self) -> bool:
        """Copy the probe into the container's own /tmp, never into the checkout.

        Writing it under /testbed would put the instrument into the model patch
        and into every diff snapshot. /tmp inside the container is not
        bind-mounted, so the checkout stays exactly what the agent made it.
        """
        if self._probe_installed:
            return True
        try:
            with open(SOURCE_VERSION_PROBE_PATH, "rb") as fh:
                blob = base64.b64encode(fh.read()).decode()
        except OSError:
            return False
        rec = self.exec_raw(
            f"printf %s {blob} | base64 -d > {CONTAINER_PROBE_PATH} && echo INSTALLED",
            timeout=120,
            label="install_source_version_probe",
        )
        self._probe_installed = "INSTALLED" in rec.stdout
        return self._probe_installed

    def source_version_probe(self, paths: list[str] | None = None, since_epoch: float | None = None) -> dict[str, Any]:
        """Ask the container's own interpreter whether the caches on disk agree
        with the bytes on disk.

        Runs AFTER the agent's command, as a separate process, and never imports
        the files it is judging — importing one would write or refresh the very
        cache whose staleness is the evidence (§6, §45).
        """
        targets = self.changed_source_paths() if paths is None else list(paths)
        out: dict[str, Any] = {"probeRan": False, "requestedPaths": targets}
        if not self._install_source_version_probe():
            out["error"] = "probe not installed"
            return out
        # base64 rather than shell quoting: a path is arbitrary bytes and the
        # command crosses two shells before it reaches the interpreter.
        payload = base64.b64encode(
            json.dumps({"paths": targets, "sinceEpoch": None if since_epoch is None else int(since_epoch)}).encode()
        ).decode()
        rec = self.exec_raw(
            f"printf %s {payload} | base64 -d | python {CONTAINER_PROBE_PATH}",
            timeout=300,
            label="source_version_probe",
        )
        out["exitCode"] = rec.exit_code
        text = (rec.stdout or "").strip()
        line = text.splitlines()[-1] if text else ""
        try:
            out.update(json.loads(line))
            out["probeRan"] = True
        except Exception as exc:  # noqa: BLE001
            out["error"] = f"probe output unparseable: {exc}"
            out["rawTail"] = text[-600:]
            out["stderrTail"] = (rec.stderr or "")[-600:]
        return out

    def source_version_evidence(
        self,
        *,
        is_validation_attempt: bool,
        runner_started: bool,
        state_hash_before: str | None,
        state_hash_after: str | None,
        paths: list[str] | None = None,
        since_epoch: float | None = None,
    ) -> dict[str, Any]:
        """The compact record the TypeScript classifier consumes.

        `stateStableAcrossValidation` is load-bearing: the probe necessarily runs
        after the command, so it only describes what the command saw if nothing
        rewrote the tree in between. When the two snapshots disagree the honest
        answer is that freshness was not established, not that it was fine.
        """
        probe = self.source_version_probe(paths, since_epoch)
        files = probe.get("files") or []
        return {
            "probeRan": bool(probe.get("probeRan")),
            "isValidationAttempt": is_validation_attempt,
            "runnerStarted": runner_started,
            "stateStableAcrossValidation": (
                state_hash_before is not None and state_hash_before == state_hash_after
            ),
            "changedSourceFileCount": len(files),
            "fileVerdicts": [f.get("verdict", "INDETERMINATE") for f in files],
            "interpreter": probe.get("interpreter"),
            "files": files,
            "error": probe.get("error"),
        }

    def bytecode_staleness_hazard(self) -> dict[str, Any]:
        """Does a same-size, same-second edit go unseen on THIS instance?"""
        witness = self.module_witness()
        out: dict[str, Any] = {"measured": False, "hazard": None, "moduleFile": witness}
        if not witness or not witness.startswith(CHECKOUT_ROOT + "/"):
            return out
        host_module = os.path.join(self.host_mount, os.path.relpath(witness, CHECKOUT_ROOT))
        try:
            with open(host_module) as fh:
                original = fh.read()
            with open(host_module, "w") as fh:
                fh.write(original + "\nM193_STALE_PROBE = 1\n")
            first = self.exec_raw(
                f"python -c \"import {self.spec.import_name} as _m; print(getattr(_m,'M193_STALE_PROBE',None))\"",
                120,
                "stale_probe_a",
            )
            with open(host_module, "w") as fh:  # same size, immediately after
                fh.write(original + "\nM193_STALE_PROBE = 2\n")
            second = self.exec_raw(
                f"python -c \"import {self.spec.import_name} as _m; print(getattr(_m,'M193_STALE_PROBE',None))\"",
                120,
                "stale_probe_b",
            )
            with open(host_module, "w") as fh:
                fh.write(original)
            out["measured"] = True
            out["firstRead"] = first.stdout.strip()
            out["secondRead"] = second.stdout.strip()
            out["hazard"] = ("1" in first.stdout) and ("2" not in second.stdout)
        except Exception as exc:
            out["error"] = str(exc)
        return out


# ── §28 patch normalisation, mirroring m193Acquisition.normalizePatch ──

_INDEX_LINE = re.compile(r"^index [0-9a-f]{4,}\.\.[0-9a-f]{4,}( \d{6})?$")


def normalize_patch(patch: str) -> str:
    lines = patch.replace("\r\n", "\n").split("\n")
    kept = [ln for ln in lines if not _INDEX_LINE.match(ln)]
    while kept and kept[-1] == "":
        kept.pop()
    return "" if not kept else "\n".join(kept) + "\n"


_HUNK_HEADER = re.compile(r"^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$")


def normalize_patch_ignoring_hunk_context(patch: str) -> str:
    """A SEPARATE, weaker normalisation used only to compare against the
    dataset's gold patch.

    git chooses the text after the second `@@` with a language-aware funcname
    heuristic, and the gold patches were generated by a different git
    configuration than ours. That trailing text is a display hint, not content.
    This relaxation is never used for the three-way patch-identity proof, where
    all three patches come from the same git and must agree strictly.
    """
    out = []
    for ln in normalize_patch(patch).split("\n"):
        m = _HUNK_HEADER.match(ln)
        out.append(m.group(1) if m else ln)
    return "\n".join(out)


def load_instances(dataset_path: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    with open(dataset_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            out[row["instance_id"]] = row
    return out

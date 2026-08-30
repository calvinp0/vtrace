#!/usr/bin/env python
"""
M192 falsification control - can the provenance instrument still say no?

M192's readiness sweep returns EDITED_CHECKOUT_CONFIRMED for every repository.
An instrument that only ever confirms is worth nothing, and five measurement
corrections were made during this milestone, so the sweep's result is only
credible if the same instrument demonstrably rejects the failure M191 found:
a test process that imports an installed copy while an agent edits the checkout.

This script manufactures exactly that condition inside a disposable container
and records both arms. Within ONE container and with ONE command text, only the
working directory and the presence of a site-packages copy differ:

    arm A (correct)  cd /testbed  -> import resolves in the checkout, sentinel fires
    arm B (poisoned) cd /         -> import resolves in site-packages, sentinel silent

Arm B is the M191 failure reproduced on purpose. The evidence is classified by
the same TypeScript classifier the sweep uses (run_stage5_m192_control_verify.ts),
so nothing here is graded by a second, friendlier rule.

    /home/calvin/code/vexp-swe-bench/.venv/bin/python \
        benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m192_wrong_source_control.py
"""

from __future__ import annotations

import json
import pathlib

import docker

from run_stage5_m192_probes import (  # reuse the exact probe primitives
    CHECKOUT_ROOT,
    CONDA_PREFIX_CMD,
    M192_PREFIX,
    exec_cmd,
    put_file,
    sentinel_source,
)

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "results" / "stage5_m192_wrong_source_control.json"

# One instance per install style present in the sweep. Chosen for coverage of
# the mechanism, not for outcome: every one of them is EDITED_CHECKOUT_CONFIRMED
# in the sweep, so each is a case the instrument currently accepts.
CASES = [
    ("psf__requests-1142", "requests"),
    ("pallets__flask-5014", "flask"),
    ("sympy__sympy-12419", "sympy"),
]


def main():
    client = docker.from_env(timeout=600)
    manifest = json.loads((HERE / "results" / "stage5_m192_probe_manifest.json").read_text())
    by_id = {i["instanceId"]: i for i in manifest["instances"]}

    arms = []
    for instance_id, pkg in CASES:
        entry = by_id[instance_id]
        nonce = instance_id.replace("__", "_").replace("-", "_")
        name = f"{M192_PREFIX}control_{nonce}"
        container = None
        record = {"instanceId": instance_id, "package": pkg, "error": None}
        try:
            for old in client.containers.list(all=True):
                if old.name.lstrip("/") == name:
                    old.remove(force=True)
            container = client.containers.create(
                image=entry["instanceImageKey"],
                name=name,
                user="root",
                detach=True,
                command="tail -f /dev/null",
            )
            container.start()

            def run(cmd, cwd, label):
                return exec_cmd(client, container.id, cmd, 300, workdir=cwd, label=label)

            # Locate the package the way the sweep does: from the runtime's own
            # __file__, never from an assumed <root>/<name> layout. flask lives at
            # /testbed/src/flask, and guessing poisons nothing while reporting
            # success -- which is the very failure mode this control exists for.
            located = run(
                f"{CONDA_PREFIX_CMD} && python -c \"import {pkg}; print('M192_MODFILE=' + {pkg}.__file__)\"",
                CHECKOUT_ROOT,
                "locate_package",
            )
            modpath = None
            for line in located["stdout"].splitlines():
                if line.startswith("M192_MODFILE="):
                    modpath = line.split("=", 1)[1].strip()
            record["locatedModule"] = modpath
            if not modpath or not modpath.startswith(CHECKOUT_ROOT + "/"):
                raise RuntimeError(f"package {pkg} did not resolve in the checkout: {modpath}")
            pkgdir = str(pathlib.PurePosixPath(modpath).parent)
            record["packageDir"] = pkgdir

            # The sentinel goes into the CHECKOUT only. If a run imports the
            # installed copy, it cannot fire.
            put_file(client, container.id, "/m192_sentinel.txt", sentinel_source(nonce))
            applied = run(f"cat /m192_sentinel.txt >> {modpath}", CHECKOUT_ROOT, "apply_sentinel")
            if applied["exit_code"] != 0:
                raise RuntimeError(f"could not write the sentinel into {modpath}")

            site = run(
                f"{CONDA_PREFIX_CMD} && python -c \"import site; print(site.getsitepackages()[0])\"",
                "/",
                "find_site_packages",
            )["stdout"].strip().splitlines()[-1]

            probe = (
                f"{CONDA_PREFIX_CMD} && rm -f /tmp/m192_nonce_{nonce} && "
                f"python -c \"import {pkg}; print('M192_MODFILE=' + {pkg}.__file__)\" && "
                f"(test -f /tmp/m192_nonce_{nonce} && echo M192_FIRED || echo M192_NOT_FIRED)"
            )

            # ── arm A: the configuration the sweep measured ──
            a = run(probe, CHECKOUT_ROOT, "armA_correct")
            record["armA"] = arm_evidence(a)

            # ── poison: an installed copy that shadows the checkout ──
            poison = run(f"cp -r {pkgdir} {site}/{pkg}", "/", "install_copy")
            record["poisonExitCode"] = poison["exit_code"]
            if poison["exit_code"] != 0:
                raise RuntimeError(f"could not install a shadowing copy: {poison['stderr'][:200]}")
            b = run(probe, "/", "armB_installed_copy")
            record["armB"] = arm_evidence(b)
            record["sitePackages"] = site

        except Exception as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            if container is not None and container.name.lstrip("/").startswith(M192_PREFIX):
                try:
                    container.remove(force=True)
                    record["containerRemoved"] = True
                except Exception as exc:
                    record["containerRemoved"] = False
                    record["containerRemoveError"] = str(exc)
        arms.append(record)
        print(f"  {instance_id}: A={record.get('armA', {}).get('moduleFile')} "
              f"B={record.get('armB', {}).get('moduleFile')}")

    payload = {
        "milestone": "M192",
        "purpose": "falsification control for the source-provenance instrument",
        "checkoutRoot": CHECKOUT_ROOT,
        "liveAgentRuns": 0,
        "liveModelSpendUsd": 0,
        "cases": arms,
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {OUT}")


def arm_evidence(rec):
    mod = None
    for line in rec["stdout"].splitlines():
        if line.startswith("M192_MODFILE="):
            mod = line.split("=", 1)[1].strip()
    return {
        "cwd": rec["cwd"],
        "moduleFile": mod,
        "sentinelFired": "M192_FIRED" in rec["stdout"],
        "exitCode": rec["exit_code"],
        "processStarted": rec["process_started"],
    }


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
M195 §3 - materialise the benchmark base state and extract repository facts.

Candidate derivation must see the repository as it stood at the decision point,
not the local VTRACE HEAD. For each M194 arm this starts the frozen SWE-bench
image read-only, checks out the arm's declared base commit, and extracts the
static facts the four candidate families are allowed to use: the tracked path
inventory, the test-file inventory, the import edges of every test file, the
package roots and the native runner inventory.

Nothing here executes the repository's code, evaluates anything, or calls a
model. The extractor runs inside the container so that each repository's own
Python parses its own source era.

  python3 run_stage5_m195_repo_facts.py --m194 <root> --out <facts dir>
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys

# The extractor, shipped to the container on stdin. Stdlib only, and written to
# parse under the oldest interpreter in the corpus.
EXTRACTOR = r'''
import json, os, re, sys

ROOT = "/testbed"
os.chdir(ROOT)

def sh(*args):
    import subprocess
    return subprocess.check_output(list(args), cwd=ROOT).decode("utf-8", "replace")

tracked = [p for p in sh("git", "ls-files").split("\n") if p]
head = sh("git", "rev-parse", "HEAD").strip()

TEST_DIR_NAMES = ("tests", "testing", "test")

def is_test_path(p):
    if not p.endswith(".py"):
        return False
    base = os.path.basename(p)
    if base in ("__init__.py", "conftest.py", "setup.py"):
        return False
    if base.startswith("test_") or base.endswith("_test.py") or base == "tests.py":
        return True
    parts = p.split("/")[:-1]
    return any(d in TEST_DIR_NAMES for d in parts)

test_files = [p for p in tracked if is_test_path(p)]
py_files = [p for p in tracked if p.endswith(".py")]

# Package roots: a directory D such that some child of D is a package. dotted()
# on the TS side strips the longest matching root.
pkg_roots = set()
for p in tracked:
    if os.path.basename(p) == "__init__.py":
        d = os.path.dirname(p)
        parent = os.path.dirname(d)
        if not os.path.exists(os.path.join(ROOT, parent, "__init__.py")):
            pkg_roots.add(parent)

FROM_RE = re.compile(r"^[ \t]*from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]+(.+)$")
IMPORT_RE = re.compile(r"^[ \t]*import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*)")

def dotted_of(path):
    stem = path[:-3] if path.endswith(".py") else path
    if stem.endswith("/__init__"):
        stem = stem[: -len("/__init__")]
    best = ""
    for r in pkg_roots:
        if r and stem.startswith(r + "/") and len(r) > len(best):
            best = r
    if best:
        stem = stem[len(best) + 1 :]
    return stem.replace("/", ".")

def parse_names(rest):
    rest = rest.split("#")[0].strip()
    rest = rest.strip("()").strip()
    out = []
    for chunk in rest.split(","):
        chunk = chunk.strip()
        if not chunk or chunk == "\\" or chunk == "*":
            continue
        out.append(chunk.split(" as ")[0].strip())
    return [n for n in out if re.match(r"^[A-Za-z_]\w*$", n)]

DEF_RE = re.compile(r"^[ \t]*(?:async[ \t]+)?def[ \t]+(test\w*)[ \t]*\(")
CLS_RE = re.compile(r"^[ \t]*class[ \t]+(\w*[Tt]est\w*)[ \t]*[\(:]")

edges = {}
defs = {}
for p in test_files:
    try:
        with open(os.path.join(ROOT, p), "rb") as fh:
            src = fh.read().decode("utf-8", "replace")
    except Exception:
        continue
    own = dotted_of(p)
    own_pkg = own.rsplit(".", 1)[0] if "." in own else ""
    mods, names = set(), set()
    for line in src.split("\n"):
        m = FROM_RE.match(line)
        if m:
            dots, mod, rest = m.group(1) or "", m.group(2) or "", m.group(3) or ""
            if dots:
                base = own_pkg.split(".")
                up = len(dots) - 1
                base = base[: len(base) - up] if up else base
                full = ".".join([x for x in base if x] + ([mod] if mod else []))
            else:
                full = mod
            if full:
                mods.add(full)
            for n in parse_names(rest):
                names.add(n)
                if full:
                    mods.add(full + "." + n)
            continue
        m = IMPORT_RE.match(line)
        if m:
            for part in m.group(1).split(","):
                part = part.strip().split(" as ")[0].strip()
                if part:
                    mods.add(part)
    edges[p] = {"modules": sorted(mods), "names": sorted(names)}
    d_funcs, d_cls = set(), set()
    for line in src.split("\n"):
        m = DEF_RE.match(line)
        if m:
            d_funcs.add(m.group(1))
            continue
        m = CLS_RE.match(line)
        if m:
            d_cls.add(m.group(1))
    defs[p] = {"functions": sorted(d_funcs), "classes": sorted(d_cls)}

runners = {}
for f in ("tests/runtests.py", "runtests.py", "bin/test", "manage.py", "tox.ini",
          "setup.cfg", "pytest.ini", "pyproject.toml", "conftest.py", "Makefile"):
    runners[f] = os.path.exists(os.path.join(ROOT, f))

central_roots = [d for d in TEST_DIR_NAMES if os.path.isdir(os.path.join(ROOT, d))]

json.dump({
    "headSha": head,
    "trackedPaths": tracked,
    "pyFiles": py_files,
    "testFiles": test_files,
    "testImports": edges,
    "testDefs": defs,
    "packageRoots": sorted(pkg_roots),
    "centralTestRoots": central_roots,
    "nativeRunners": runners,
}, sys.stdout)
'''


def image_key(instance_id: str) -> str:
    org, rest = instance_id.split("__", 1)
    return "swebench/sweb.eval.x86_64.{}_1776_{}:latest".format(org, rest)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--m194", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    runs = os.path.join(args.m194, "runs")
    os.makedirs(args.out, exist_ok=True)
    manifest = []

    arms = sorted(os.listdir(runs))
    for d in arms:
        arm_path = os.path.join(runs, d, "arm.json")
        if not os.path.exists(arm_path):
            continue
        with open(arm_path) as fh:
            arm = json.load(fh)
        if not arm.get("modelLaunched"):
            continue
        instance, base = arm["instanceId"], arm["baseCommit"]
        img = image_key(instance)
        script = (
            "cd /testbed && git checkout -q {} 2>/dev/null && "
            "cat > /tmp/x.py && python /tmp/x.py".format(base)
        )
        try:
            raw = subprocess.check_output(
                ["docker", "run", "--rm", "-i", "--entrypoint", "/bin/bash", img, "-c", script],
                input=EXTRACTOR.encode(), stderr=subprocess.PIPE,
            )
            facts = json.loads(raw.decode("utf-8", "replace"))
            status = "MATERIALISED" if facts["headSha"] == base else "BASE_COMMIT_MISMATCH"
        except Exception as exc:  # abstain loudly, never skip silently
            facts, status = None, "MATERIALISATION_FAILED: {}".format(type(exc).__name__)

        row = {
            "armId": arm["armId"], "instanceId": instance, "repo": arm["repo"],
            "baseCommit": base, "image": img, "status": status,
        }
        if facts is not None:
            body = json.dumps(facts, sort_keys=True, separators=(",", ":"))
            out_file = os.path.join(args.out, instance + ".json")
            with open(out_file, "w") as fh:
                fh.write(body)
            row.update({
                "observedHeadSha": facts["headSha"],
                "sha256": hashlib.sha256(body.encode()).hexdigest(),
                "bytes": len(body),
                "trackedPaths": len(facts["trackedPaths"]),
                "testFiles": len(facts["testFiles"]),
            })
        manifest.append(row)
        print("{:46s} {:20s} {}".format(arm["armId"], status, row.get("testFiles", "-")), file=sys.stderr)

    ok = [r for r in manifest if r["status"] == "MATERIALISED"]
    report = {
        "schemaVersion": "stage5.m195.repo-facts.v1",
        "milestone": "M195",
        "verdict": "M195_BASE_STATE_MATERIALISED" if len(ok) == len(manifest) else "M195_BASE_STATE_PARTIAL",
        "arms": len(manifest),
        "materialised": len(ok),
        "abstained": [r for r in manifest if r["status"] != "MATERIALISED"],
        "baseCommitIdentityProven": all(r.get("observedHeadSha") == r["baseCommit"] for r in ok),
        "instances": manifest,
    }
    with open(os.path.join(args.out, "_manifest.json"), "w") as fh:
        json.dump(report, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(json.dumps({k: report[k] for k in
                      ("verdict", "arms", "materialised", "baseCommitIdentityProven")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""M193A — the in-container source-version probe (§10, §11, §16).

Runs INSIDE the instance container, out-of-band, after a validation command has
finished. It answers one question per changed file:

    would the interpreter that just ran have executed the bytes now on disk?

and it answers it by *reading*, never by mutating. Nothing here deletes a cache,
sets ``PYTHONDONTWRITEBYTECODE``, touches an mtime or imports the target module
(§6). Importing the target would itself write or refresh the very cache whose
staleness is the evidence.

Why a path witness is not enough
--------------------------------

M192 established that ``__file__`` pointing into the edited checkout does not
prove the edited checkout was executed. M193 found the next layer down: CPython
validates a timestamp-based ``.pyc`` against the source's
``(mtime_seconds, size)`` only. An edit that preserves the size within the same
whole second leaves both fields unchanged, so the interpreter accepts a cache
compiled from the PREVIOUS bytes while ``__file__`` still, truthfully, names the
edited file.

So freshness is decided in two steps:

1. **Would the cache have been used at all?** Reconstructed from the same header
   fields CPython itself compares — magic, and then either
   ``(mtime, size)`` (timestamp mode, and the only mode before 3.7) or the
   8-byte source hash (PEP 552 hash mode). If the answer is no, the interpreter
   had to recompile, and what it ran is by definition the current bytes.

2. **If it would have been used, does it agree with the current bytes?** The
   cached code object is unmarshalled and compared against a fresh compile of
   the file as it stands now. Equal means the accepted cache happens to be the
   current program; unequal means stale code executed while every other witness
   said otherwise.

The comparison is done on a recursive structural fingerprint of the code object
rather than on raw marshal bytes, because marshal's reference-sharing encoding
is an implementation detail and a difference there is not evidence of a
different program. Raw marshal equality is still recorded, as a weaker second
witness.
"""

import glob
import hashlib
import importlib.util
import json
import marshal
import os
import struct
import sys

SCHEMA_VERSION = "stage5.m193a.source-version-probe.v1"

# Deliberately unannotated. This program runs under whichever interpreter the
# instance image ships, and the corpus spans CPython 3.6 through 3.11.
# `from __future__ import annotations` does not exist before 3.7 and PEP 585
# builtin generics are evaluated at definition time before 3.10, so a typed
# signature here would make the probe itself the thing that fails on the oldest
# image in the fixture — which is exactly what happened on django/django before
# this note was written.

# Changed files that carry no compiled form and are read from disk when the
# program runs. Their freshness needs no bytecode reasoning.
NON_CACHED_SUFFIXES = (
    ".txt", ".md", ".rst", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".html", ".css", ".js", ".xml", ".csv", ".po", ".pot", ".sh", ".sql",
    ".template", ".tpl", ".jinja", ".jinja2", ".mo", ".gitignore",
)

# Changed files whose runtime form is a build artifact we cannot witness from
# source alone. Never claimed fresh.
COMPILED_ARTIFACT_SUFFIXES = (".c", ".h", ".pyx", ".pxd", ".pxi", ".cpp", ".cc", ".so", ".pyd")


def code_fingerprint(code):
    """A recursive, marshal-encoding-independent identity for a code object."""
    parts = [
        getattr(code, "co_name", None),
        getattr(code, "co_argcount", None),
        getattr(code, "co_kwonlyargcount", None),
        getattr(code, "co_nlocals", None),
        getattr(code, "co_flags", None),
        getattr(code, "co_code", b"").hex(),
        list(getattr(code, "co_names", ())),
        list(getattr(code, "co_varnames", ())),
        list(getattr(code, "co_freevars", ())),
        list(getattr(code, "co_cellvars", ())),
    ]
    consts = []
    for k in getattr(code, "co_consts", ()):
        if hasattr(k, "co_code"):
            consts.append(["<code>", code_fingerprint(k)])
        else:
            consts.append(repr(k))
    parts.append(consts)
    return hashlib.sha256(json.dumps(parts, default=repr).encode()).hexdigest()


def _u32(b):
    return struct.unpack("<I", b)[0]


def parse_pyc_header(raw):
    """Split a ``.pyc`` into the fields CPython's own validator reads.

    Before 3.7 the header is 12 bytes with no flags word at all; PEP 552 added
    the flags word and the hash-based alternative. Getting this wrong would read
    an mtime out of a flags field, so the version branch is explicit rather than
    assumed.
    """
    out = {"headerBytes": len(raw)}
    if len(raw) < 12:
        out["error"] = "pyc shorter than a header"
        return out
    out["magic"] = raw[:4].hex()
    out["magicMatchesInterpreter"] = raw[:4] == importlib.util.MAGIC_NUMBER
    if sys.version_info >= (3, 7):
        if len(raw) < 16:
            out["error"] = "pyc shorter than a PEP 552 header"
            return out
        flags = _u32(raw[4:8])
        out["flags"] = flags
        hash_based = bool(flags & 0b1)
        out["invalidationMode"] = "HASH" if hash_based else "TIMESTAMP"
        out["checkSource"] = bool(flags & 0b10) if hash_based else None
        if hash_based:
            out["headerSourceHash"] = raw[8:16].hex()
        else:
            out["headerMtime"] = _u32(raw[8:12])
            out["headerSize"] = _u32(raw[12:16])
        out["bodyOffset"] = 16
    else:
        out["flags"] = None
        out["invalidationMode"] = "TIMESTAMP"
        out["checkSource"] = None
        out["headerMtime"] = _u32(raw[4:8])
        out["headerSize"] = _u32(raw[8:12])
        out["bodyOffset"] = 12
    return out


def scan_foreign_caches(path, src, st, since_epoch):
    """Caches written by something other than CPython's own import machinery.

    pytest's assertion rewriter is the one that matters here. It compiles test
    modules and plugins itself, writes the result beside the standard cache
    under its own tag (`<stem>.cpython-39-pytest-7.1.2.pyc`), and validates it
    against the same `(mtime, size)` pair — so it inherits the same collision.
    Its body is a REWRITTEN code object, deliberately not a plain compilation,
    so the fingerprint comparison that settles the standard cache cannot settle
    this one.

    Rather than pretend the file does not exist, or pretend a comparison we
    cannot make came out fine, this reports one of two things:

    * the cache was written at or after the moment the validation started, so
      the run that just executed is the run that produced it, and it read the
      source it compiled;
    * otherwise, freshness is not established, and the caller must abstain.
    """
    out = {"foreignCaches": []}
    if not path.lower().endswith(".py"):
        return out
    cache_dir = os.path.join(os.path.dirname(path), "__pycache__")
    if not os.path.isdir(cache_dir):
        return out
    stem = os.path.basename(path)[:-3]
    try:
        standard = importlib.util.cache_from_source(path)
    except Exception:
        standard = None
    worst = None
    for cand in sorted(glob.glob(os.path.join(cache_dir, stem + ".*.pyc"))):
        if standard and os.path.abspath(cand) == os.path.abspath(standard):
            continue
        entry = {"path": cand}
        try:
            with open(cand, "rb") as fh:
                raw = fh.read(16)
            hdr = parse_pyc_header(raw)
            entry["header"] = hdr
            if hdr.get("invalidationMode") == "TIMESTAMP" and "headerMtime" in hdr:
                accepted = (
                    int(hdr["headerMtime"]) == (int(st.st_mtime) & 0xFFFFFFFF)
                    and int(hdr["headerSize"]) == (st.st_size & 0xFFFFFFFF)
                )
            else:
                accepted = True
            entry["wouldBeAccepted"] = accepted
            cache_mtime = int(os.stat(cand).st_mtime)
            entry["cacheMtime"] = cache_mtime
            if not accepted:
                entry["verdict"] = "IRRELEVANT"
            elif since_epoch is not None and cache_mtime >= int(since_epoch):
                entry["verdict"] = "WRITTEN_BY_THIS_VALIDATION"
            else:
                entry["verdict"] = "UNCOMPARABLE"
                worst = "UNCOMPARABLE"
        except Exception as exc:
            entry["verdict"] = "UNCOMPARABLE"
            entry["error"] = str(exc)
            worst = "UNCOMPARABLE"
        out["foreignCaches"].append(entry)
    if worst:
        out["foreignCacheVerdict"] = worst
    return out


def classify_file(path, since_epoch=None):
    """One changed file's freshness verdict, with the evidence it rests on."""
    rec = {"path": path}

    lower = path.lower()
    if lower.endswith(COMPILED_ARTIFACT_SUFFIXES):
        rec["verdict"] = "COMPILED_ARTIFACT_REQUIRED"
        rec["reason"] = "runtime form is a build artifact; source bytes do not establish what ran"
        return rec

    if not os.path.isfile(path):
        legacy = path[:-3] + ".pyc" if lower.endswith(".py") else None
        if legacy and os.path.exists(legacy):
            rec["verdict"] = "INDETERMINATE"
            rec["reason"] = f"source deleted but a sourceless {legacy} remains importable"
            return rec
        rec["verdict"] = "COMPILED_FROM_CURRENT_SOURCE"
        rec["reason"] = "file absent and no sourceless bytecode stands in for it"
        return rec

    st = os.stat(path)
    rec["sourceSize"] = st.st_size
    rec["sourceMtime"] = int(st.st_mtime)
    rec["sourceMtimeNs"] = st.st_mtime_ns
    try:
        with open(path, "rb") as fh:
            src = fh.read()
    except OSError as exc:
        rec["verdict"] = "INDETERMINATE"
        rec["reason"] = f"source unreadable: {exc}"
        return rec
    rec["sourceSha256"] = hashlib.sha256(src).hexdigest()

    if not lower.endswith(".py"):
        rec["verdict"] = "NON_CACHED_ASSET" if lower.endswith(NON_CACHED_SUFFIXES) else "INDETERMINATE"
        if rec["verdict"] == "NON_CACHED_ASSET":
            rec["reason"] = "read from disk at run time; no compiled form can shadow it"
        else:
            rec["reason"] = "unrecognised file kind; freshness not established"
        return rec

    try:
        pyc = importlib.util.cache_from_source(path)
    except Exception as exc:  # NotImplementedError on exotic builds
        rec["verdict"] = "INDETERMINATE"
        rec["reason"] = f"cache path not derivable: {exc}"
        return rec
    rec["pycPath"] = pyc
    rec["pycExists"] = os.path.exists(pyc)
    if not rec["pycExists"]:
        rec["verdict"] = "COMPILED_FROM_CURRENT_SOURCE"
        rec["reason"] = "no cached bytecode exists, so the source must be compiled"
        return rec

    try:
        with open(pyc, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        rec["verdict"] = "INDETERMINATE"
        rec["reason"] = f"cache unreadable: {exc}"
        return rec

    hdr = parse_pyc_header(raw)
    rec["pycHeader"] = hdr
    if "error" in hdr:
        rec["verdict"] = "INDETERMINATE"
        rec["reason"] = f"cache header unparseable: {hdr['error']}"
        return rec

    if not hdr.get("magicMatchesInterpreter"):
        rec["verdict"] = "COMPILED_FROM_CURRENT_SOURCE"
        rec["reason"] = "cache magic does not match this interpreter; it cannot be used"
        return rec

    would_use: bool
    if hdr["invalidationMode"] == "TIMESTAMP":
        same_mtime = int(hdr["headerMtime"]) == (int(st.st_mtime) & 0xFFFFFFFF)
        same_size = int(hdr["headerSize"]) == (st.st_size & 0xFFFFFFFF)
        rec["headerMatchesSourceMtime"] = same_mtime
        rec["headerMatchesSourceSize"] = same_size
        would_use = same_mtime and same_size
    else:
        current_hash = importlib.util.source_hash(src).hex()  # 3.7+; hash mode cannot arise earlier
        rec["currentSourceHash"] = current_hash
        matches = current_hash == hdr.get("headerSourceHash")
        rec["headerMatchesSourceHash"] = matches
        if hdr.get("checkSource"):
            would_use = matches
            if matches:
                # PEP 552 checked-hash mode: acceptance IS a proof of identity.
                rec["verdict"] = "CACHE_MATCHES_CURRENT_SOURCE"
                rec["reason"] = "checked hash-based cache whose recorded hash equals the current source"
                return rec
        else:
            would_use = True
            rec["reason"] = "unchecked hash-based cache is accepted without consulting the source"

    rec["cacheWouldBeUsed"] = would_use
    if not would_use:
        rec["verdict"] = "COMPILED_FROM_CURRENT_SOURCE"
        rec["reason"] = rec.get("reason") or "cache is invalidated by the header check, forcing a recompile"
        return rec

    # The cache would be accepted. Only a comparison of the code itself can say
    # whether that acceptance is harmless.
    try:
        cached_code = marshal.loads(raw[int(hdr["bodyOffset"]):])
    except Exception as exc:
        rec["verdict"] = "INDETERMINATE"
        rec["reason"] = f"cached code object unreadable: {exc}"
        return rec
    try:
        fresh_code = compile(src, path, "exec", dont_inherit=True, optimize=-1)
    except SyntaxError as exc:
        rec["verdict"] = "INDETERMINATE"
        rec["reason"] = f"current source does not compile: {exc}"
        return rec

    cached_fp = code_fingerprint(cached_code)
    fresh_fp = code_fingerprint(fresh_code)
    rec["cachedCodeFingerprint"] = cached_fp
    rec["freshCodeFingerprint"] = fresh_fp
    try:
        rec["marshalBytesEqual"] = marshal.dumps(fresh_code) == raw[int(hdr["bodyOffset"]):]
    except Exception:
        rec["marshalBytesEqual"] = None

    if cached_fp == fresh_fp:
        rec["verdict"] = "CACHE_MATCHES_CURRENT_SOURCE"
        rec["reason"] = "the accepted cache compiles to the same program as the current source"
    else:
        rec["verdict"] = "CACHE_STALE_AND_ACCEPTED"
        rec["reason"] = "the interpreter would accept a cache that is NOT the current source"
    return rec


def _apply_foreign(rec, path, since_epoch):
    """A foreign cache can only ever make the answer weaker, never stronger."""
    if rec.get("verdict") == "CACHE_STALE_AND_ACCEPTED":
        return rec
    try:
        st = os.stat(path)
        with open(path, "rb") as fh:
            src = fh.read()
    except OSError:
        return rec
    foreign = scan_foreign_caches(path, src, st, since_epoch)
    if not foreign.get("foreignCaches"):
        return rec
    rec["foreignCaches"] = foreign["foreignCaches"]
    if foreign.get("foreignCacheVerdict") == "UNCOMPARABLE":
        rec["verdict"] = "INDETERMINATE"
        rec["reason"] = (
            "a third-party import cache (pytest's assertion rewriter) would be accepted, and its "
            "rewritten code cannot be compared against a plain compilation"
        )
    return rec


def probe(paths, since_epoch=None):
    files = [_apply_foreign(classify_file(p, since_epoch), p, since_epoch) for p in paths]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "interpreter": {
            "version": sys.version.split()[0],
            "cacheTag": sys.implementation.cache_tag,
            "magic": importlib.util.MAGIC_NUMBER.hex(),
            "dontWriteBytecode": bool(sys.dont_write_bytecode),
            "pycachePrefix": getattr(sys, "pycache_prefix", None),
            "optimize": sys.flags.optimize,
            "executable": sys.executable,
        },
        "sinceEpoch": since_epoch,
        "fileCount": len(files),
        "files": files,
    }


def main():
    # Input arrives on stdin as JSON so no shell quoting can mangle a path.
    try:
        payload = json.loads(sys.stdin.read() or "[]")
    except Exception as exc:
        print(json.dumps({"schemaVersion": SCHEMA_VERSION, "error": f"bad input: {exc}"}))
        return 1
    # Either a bare list of paths, or {"paths": [...], "sinceEpoch": <unix time>}.
    if isinstance(payload, dict):
        paths, since = payload.get("paths") or [], payload.get("sinceEpoch")
    else:
        paths, since = payload, None
    print(json.dumps(probe(list(paths), since)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

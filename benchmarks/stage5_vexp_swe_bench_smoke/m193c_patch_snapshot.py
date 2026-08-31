"""M193C — the patch-snapshot authority.

What did the agent change, expressed as a patch? Every diff snapshot in the
lifecycle ledger, the state hash a validation event is anchored to, and the
model patch the evaluator grades are all this one answer.

M193/M193A/M193B captured it with `git add -A` -> `git diff --cached` ->
`git reset`. That produced the right bytes and destroyed the subject to do it:
a mixed reset unstages everything, so an agent that had deliberately staged
work found its index emptied by the instrument measuring it. M193B fixed the
same idiom in the changed-source authority and recorded the patch boundary as
an unfixed residual. This module is that residual closed.

PURE. No Docker SDK, no container, no filesystem of its own. It builds one
shell string and parses one stdout, so the exact bytes production runs can be
executed against a real Git repository by any test runner (§19).
"""

from __future__ import annotations

import base64
import os
from typing import Any

# ONE exclusion policy, shared with the changed-source authority: the two must
# agree about what "the agent changed" means or a file can be in the patch and
# outside the freshness proof (§10).
from m193b_changed_source import exclusion_pathspec

# ── M193C: the read-only patch authority (§8, §9, §10, §11) ─────────────
#
# Three regions of Git state, none of them written:
#
#   tracked, current bytes   git diff --no-renames HEAD
#   untracked, current bytes git ls-files --others --exclude-standard
#                            + git diff --no-index -- /dev/null <path>
#   observational state      git status --porcelain=v2 -z
#
# `diff HEAD` is what makes the staged/unstaged distinction irrelevant to the
# ANSWER while leaving it intact in the repository: it compares the frozen base
# commit to the WORKING TREE, so a file staged as S1 and then edited to S2 is
# reported as S2 (§14) without the index being consulted as a staging area.
#
# `--no-index -- /dev/null <path>` is the untracked lane. git special-cases
# /dev/null here and emits the canonical `diff --git a/P b/P` + `new file mode`
# header, byte-for-byte what staging the file would have produced -- so the
# untracked half costs no index write and no object write (§8: the invariant is
# "no mutation", not "mutation plus rollback").
#
# `--no-renames` keeps both halves of a move. With rename detection on -- the
# default since git 2.9 -- a move collapses to a single R100 entry whose body
# is `similarity index` and no content at all, so the new file's bytes never
# appear in the patch. Delete-plus-add is explicitly permitted (§19) and is
# what the M193B changed-source authority already reports.
PATCH_SNAPSHOT_AUTHORITY_VERSION = "stage5.m193c.patch-snapshot-authority.v1"

# Statuses. §30: a state that cannot be represented truthfully is refused, never
# made representable by writing to the repository.
STATUS_OK = "PATCH_SNAPSHOT_OK"
STATUS_UNKNOWN = "PATCH_SNAPSHOT_UNKNOWN"
STATUS_UNSUPPORTED = "PATCH_SNAPSHOT_UNSUPPORTED"

_DIFF_HEADER = "diff --git "
_GIT = "git -c core.fileMode=false"


def patch_snapshot_command(preexisting_untracked: list[str]) -> str:
    """The exact shell the authority runs. Non-mutating by construction.

    Every payload is piped straight into base64: `-z` output carries NUL bytes
    and a shell variable cannot hold one, so command substitution would silently
    truncate a path list. Each section's exit status is read from
    ${PIPESTATUS[0]} immediately after its own pipeline, because "git printed
    nothing" and "git failed" are the same empty payload and must not be the
    same answer.

    `base64 | tr -d '\\n'` rather than `base64 -w0`: the wrapping flag is a GNU
    extension and the images are not contracted to provide one.
    """
    excl = exclusion_pathspec(preexisting_untracked)
    b64 = "base64 | tr -d '\\n'"
    return (
        # ordered tracked paths, binary-safe -- the sort keys and the count
        # cross-check for the tracked chunks below
        f"printf 'TN '; {_GIT} diff --no-renames --name-only -z HEAD -- . {excl} | {b64}; "
        f"printf ' %s\\n' \"${{PIPESTATUS[0]}}\"; "
        # the tracked patch itself: HEAD vs WORKING TREE, so staged-then-edited
        # reports the current bytes
        f"printf 'TP '; {_GIT} diff --no-renames HEAD -- . {excl} | {b64}; "
        f"printf ' %s\\n' \"${{PIPESTATUS[0]}}\"; "
        # observational state classification (§12), never shown to the agent
        f"printf 'ST '; {_GIT} status --porcelain=v2 -z -- . {excl} | {b64}; "
        f"printf ' %s\\n' \"${{PIPESTATUS[0]}}\"; "
        # the untracked lane, one line per file, path and patch both encoded
        f"{_GIT} ls-files --others --exclude-standard -z -- . {excl} | "
        f"while IFS= read -r -d '' f; do "
        f"printf 'U '; printf '%s' \"$f\" | {b64}; printf ' '; "
        f"{_GIT} diff --no-index --no-renames -- /dev/null \"$f\" | {b64}; "
        f"printf ' %s\\n' \"${{PIPESTATUS[0]}}\"; "
        f"done; "
        f"printf 'UL %s\\n' \"${{PIPESTATUS[0]}}\"; "
        f"printf 'END\\n'"
    )


def _b64d(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii")) if text else b""


def _decode(raw: bytes) -> str:
    return raw.decode("utf-8", "surrogateescape")


def _sort_key(path: str) -> bytes:
    """Git orders paths by bytes, not by code points (§11)."""
    return path.encode("utf-8", "surrogateescape")


def split_patch_chunks(patch: str) -> list[str]:
    """One `diff --git` block per changed path.

    Safe to split on the header at column 0: inside a hunk every content line
    carries a +/-/space prefix, so a file whose own text contains a diff header
    cannot forge a boundary.
    """
    chunks: list[str] = []
    cur: list[str] = []
    for line in patch.split("\n"):
        if line.startswith(_DIFF_HEADER):
            if cur:
                chunks.append("\n".join(cur).rstrip("\n") + "\n")
            cur = [line]
        elif cur:
            cur.append(line)
    if cur:
        chunks.append("\n".join(cur).rstrip("\n") + "\n")
    return chunks


def header_path(chunk: str) -> str | None:
    """Recover P from `diff --git a/P b/P`.

    Only used as a cross-check; the authoritative sort keys come from
    `--name-only -z`, which needs no unquoting. Returns None for git's quoted
    form rather than guessing where the path ends.
    """
    line = chunk.split("\n", 1)[0]
    rest = line[len(_DIFF_HEADER):]
    if not rest.startswith("a/"):
        return None
    body = rest[2:]
    if (len(body) - 3) % 2 != 0:
        return None
    n = (len(body) - 3) // 2
    left, sep, right = body[:n], body[n : n + 3], body[n + 3 :]
    return left if sep == " b/" and left == right else None


# git records a new file's mode from the filesystem. The tracked lane runs under
# core.fileMode=false, where git does not trust the executable bit and stages
# every new file 100644; the untracked lane reads the bit directly and would
# report 100755 for the same file. Clamping keeps ONE mode policy across both
# halves and preserves exactly the bytes the staging capture produced. Only the
# executable bit is clamped -- 120000 is a symlink, a different object type, and
# is passed through. The observed mode is recorded rather than erased (§12).
_UNTRACKED_MODE_CLAMP = ("new file mode 100755", "new file mode 100644")


def _clamp_untracked_mode(chunk: str) -> tuple[str, str | None]:
    lines = chunk.split("\n")
    for i, line in enumerate(lines[:3]):
        if line == _UNTRACKED_MODE_CLAMP[0]:
            lines[i] = _UNTRACKED_MODE_CLAMP[1]
            return "\n".join(lines), "100755"
    return chunk, None


def parse_status_v2(raw: bytes) -> dict[str, list[str]]:
    """Classify the agent's Git state (§12). Observational metadata only.

    porcelain v2 with -z: NUL-separated entries, and a rename entry carries its
    original path as a second NUL-separated field, so the record boundary is not
    the field boundary.
    """
    staged: list[str] = []
    unstaged: list[str] = []
    untracked: list[str] = []
    deleted: list[str] = []
    renamed: list[str] = []
    unmerged: list[str] = []
    fields = _decode(raw).split("\0")
    i = 0
    while i < len(fields):
        entry = fields[i]
        i += 1
        if not entry:
            continue
        kind = entry[0]
        if kind == "?":
            untracked.append(entry[2:])
        elif kind == "!":
            pass  # ignored; only emitted with --ignored
        elif kind == "u":
            parts = entry.split(" ", 10)
            unmerged.append(parts[-1] if parts else entry)
        elif kind in ("1", "2"):
            parts = entry.split(" ", 8)
            if len(parts) < 9:
                continue
            xy, path = parts[1], parts[8]
            if kind == "2":
                # `<X><score> <path>`, and the original path is the NEXT field
                sub = path.split(" ", 1)
                path = sub[1] if len(sub) == 2 else path
                orig = fields[i] if i < len(fields) else ""
                i += 1
                renamed.append(f"{orig} -> {path}")
            if xy[0] not in (".", "?"):
                staged.append(path)
            if xy[1] not in (".", "?"):
                unstaged.append(path)
            if "D" in xy:
                deleted.append(path)
    return {
        "staged": sorted(set(staged), key=_sort_key),
        "unstaged": sorted(set(unstaged), key=_sort_key),
        "untracked": sorted(set(untracked), key=_sort_key),
        "deleted": sorted(set(deleted), key=_sort_key),
        "renamed": sorted(set(renamed), key=_sort_key),
        "unmerged": sorted(set(unmerged), key=_sort_key),
    }


def parse_patch_snapshot_output(stdout: str, checkout_root: str = "") -> dict[str, Any]:
    """The canonical patch, or a truthful refusal.

    Fails closed. A snapshot that did not demonstrably complete is not a
    snapshot that found nothing: the caller must be able to tell those apart,
    because the second is a legitimate empty patch and the first is an
    instrument that did not answer (§30, §31).
    """
    sections: dict[str, Any] = {}
    untracked_rows: list[tuple[str, str, int]] = []
    errors: list[str] = []
    saw_end = False

    for line in (stdout or "").splitlines():
        if line == "END":
            saw_end = True
            continue
        if line.startswith("U "):
            parts = line.split(" ")
            if len(parts) != 4:
                errors.append("malformed untracked row")
                continue
            try:
                untracked_rows.append((_decode(_b64d(parts[1])), _decode(_b64d(parts[2])), int(parts[3])))
            except Exception:  # noqa: BLE001
                errors.append("undecodable untracked row")
            continue
        for key in ("TN ", "TP ", "ST "):
            if line.startswith(key):
                parts = line.split(" ")
                if len(parts) != 3:
                    errors.append(f"malformed {key.strip()} section")
                    break
                try:
                    sections[key.strip()] = (_b64d(parts[1]), int(parts[2]))
                except Exception:  # noqa: BLE001
                    errors.append(f"undecodable {key.strip()} section")
                break
        else:
            if line.startswith("UL "):
                try:
                    sections["UL"] = (b"", int(line.split(" ")[1]))
                except Exception:  # noqa: BLE001
                    errors.append("malformed UL section")

    if not saw_end:
        errors.append("snapshot did not run to completion")
    for key in ("TN", "TP", "ST", "UL"):
        if key not in sections:
            errors.append(f"section {key} missing")
        elif sections[key][1] != 0:
            errors.append(f"section {key} exited {sections[key][1]}")
    bad_untracked = [p for p, _, rc in untracked_rows if rc not in (0, 1)]
    if bad_untracked:
        # --no-index exits 1 when the files differ, which is the normal case.
        errors.append(f"{len(bad_untracked)} untracked diff(s) failed")

    if errors:
        return _refusal(STATUS_UNKNOWN, "; ".join(errors))

    tracked_names = [p for p in _decode(sections["TN"][0]).split("\0") if p]
    tracked_patch = _decode(sections["TP"][0])
    chunks = split_patch_chunks(tracked_patch)
    if len(chunks) != len(tracked_names):
        # The two commands disagree about how many files changed. Either the
        # tree moved between them or the patch is not what the names describe;
        # both make the snapshot unattributable.
        return _refusal(
            STATUS_UNKNOWN,
            f"tracked patch has {len(chunks)} chunk(s) for {len(tracked_names)} named path(s)",
        )
    mismatched = [n for n, c in zip(tracked_names, chunks) if header_path(c) not in (None, n)]
    if mismatched:
        return _refusal(STATUS_UNKNOWN, f"{len(mismatched)} tracked chunk(s) do not match their named path")

    keyed: list[tuple[bytes, str]] = [(_sort_key(n), c) for n, c in zip(tracked_names, chunks)]
    real_modes: dict[str, str] = {}
    untracked_paths: list[str] = []
    for path, body, _rc in untracked_rows:
        untracked_paths.append(path)
        if not body.strip():
            continue  # a file identical to /dev/null cannot occur, but do not invent a chunk
        pieces = split_patch_chunks(body)
        if len(pieces) != 1:
            return _refusal(STATUS_UNKNOWN, f"untracked lane produced {len(pieces)} chunks for one path")
        clamped, real = _clamp_untracked_mode(pieces[0])
        if real:
            real_modes[path] = real
        keyed.append((_sort_key(path), clamped))

    # One patch, in git's own path order, so the byte sequence does not depend
    # on which lane a file arrived through or on filesystem traversal (§11).
    keyed.sort(key=lambda kv: kv[0])
    patch = "".join(c for _k, c in keyed)

    state = parse_status_v2(sections["ST"][0])
    binary = [n for k, c in keyed for n in [_decode(k)] if "\nBinary files " in c or c.startswith("Binary files ")]

    return {
        "ok": True,
        "status": STATUS_OK,
        "authority": PATCH_SNAPSHOT_AUTHORITY_VERSION,
        "patch": patch,
        "trackedPaths": tracked_names,
        "untrackedPaths": sorted(set(untracked_paths), key=_sort_key),
        "trackedCount": len(tracked_names),
        "untrackedCount": len(set(untracked_paths)),
        "gitState": state,
        "binaryPaths": sorted(set(binary), key=_sort_key),
        "untrackedRealModes": real_modes,
        "absolutePaths": [
            os.path.join(checkout_root, p) for p in sorted(set(tracked_names) | set(untracked_paths), key=_sort_key)
        ]
        if checkout_root
        else [],
        "error": None,
    }


def _refusal(status: str, error: str) -> dict[str, Any]:
    return {
        "ok": False,
        "status": status,
        "authority": PATCH_SNAPSHOT_AUTHORITY_VERSION,
        "patch": "",
        "trackedPaths": [],
        "untrackedPaths": [],
        "trackedCount": 0,
        "untrackedCount": 0,
        "gitState": {},
        "binaryPaths": [],
        "untrackedRealModes": {},
        "absolutePaths": [],
        "error": error,
    }


# ── §13 the snapshot-purity instrument ──────────────────────────────────
#
# Enough state to detect an index write, a worktree write, an untracked file
# appearing or vanishing, a restored deletion and a reverted rename. Deliberately
# NOT scoped by the exclusion pathspec: purity is a claim about the whole
# repository, including the regions a snapshot is supposed to ignore.
REPOSITORY_STATE_VERSION = "stage5.m193c.repository-state.v1"


def repository_state_command() -> str:
    b64 = "base64 | tr -d '\\n'"
    return (
        f"printf 'HEAD %s\\n' \"$(git rev-parse HEAD 2>/dev/null)\"; "
        f"printf 'ST '; git status --porcelain=v2 -z | {b64}; printf ' %s\\n' \"${{PIPESTATUS[0]}}\"; "
        # the full index: mode, blob and stage for every entry, so a staged blob
        # reverting to HEAD is visible even when status still says "modified"
        f"printf 'IX '; git ls-files -s -z | {b64}; printf ' %s\\n' \"${{PIPESTATUS[0]}}\"; "
        f"git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do "
        f"printf 'UH '; printf '%s' \"$f\" | {b64}; "
        f"printf ' %s\\n' \"$(sha256sum -- \"$f\" 2>/dev/null | cut -d' ' -f1)\"; done; "
        f"git diff --no-renames --name-only -z HEAD | while IFS= read -r -d '' f; do "
        f"printf 'WH '; printf '%s' \"$f\" | {b64}; "
        f"printf ' %s\\n' \"$(sha256sum -- \"$f\" 2>/dev/null | cut -d' ' -f1 || true)\"; done; "
        f"printf 'END\\n'"
    )


def parse_repository_state_output(stdout: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "version": REPOSITORY_STATE_VERSION,
        "head": None,
        "status": None,
        "index": None,
        "untrackedHashes": {},
        "worktreeHashes": {},
        "complete": False,
    }
    for line in (stdout or "").splitlines():
        if line.startswith("HEAD "):
            out["head"] = line[5:].strip() or None
        elif line.startswith("ST "):
            parts = line.split(" ")
            if len(parts) == 3:
                out["status"] = _decode(_b64d(parts[1]))
        elif line.startswith("IX "):
            parts = line.split(" ")
            if len(parts) == 3:
                out["index"] = _decode(_b64d(parts[1]))
        elif line.startswith("UH ") or line.startswith("WH "):
            parts = line.split(" ")
            if len(parts) == 3:
                bucket = "untrackedHashes" if line.startswith("UH ") else "worktreeHashes"
                out[bucket][_decode(_b64d(parts[1]))] = parts[2].strip() or "ABSENT"
        elif line == "END":
            out["complete"] = True
    return out


def repository_state_differences(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """Every observable component that moved. Empty means the observation was pure."""
    diffs: list[str] = []
    if not before.get("complete") or not after.get("complete"):
        diffs.append("state capture incomplete")
    for field in ("head", "status", "index"):
        if before.get(field) != after.get(field):
            diffs.append(f"{field} changed")
    for bucket in ("untrackedHashes", "worktreeHashes"):
        b, a = before.get(bucket) or {}, after.get(bucket) or {}
        for path in sorted(set(b) | set(a), key=_sort_key):
            if b.get(path) != a.get(path):
                diffs.append(f"{bucket}:{path} {b.get(path)} -> {a.get(path)}")
    return diffs

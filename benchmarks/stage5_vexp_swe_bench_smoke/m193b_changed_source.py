"""M193B — the changed-source authority.

Which files did the agent change? Everything downstream of a validation event
depends on this set: it is what the source-version probe is pointed at, and
`classifySourceVersion` refuses to confirm freshness for a file it was never
handed. Getting the set wrong does not produce an error, it produces a
confident answer about the wrong program.

PURE. No Docker SDK, no container, no filesystem of its own. It builds one
shell string and parses one stdout, so the exact bytes production runs can be
executed against a real Git repository by any test runner (§19).
"""

from __future__ import annotations

import os
from typing import Any

# ── M193B: the changed-source authority (§2, §3, §7, §11) ───────────────
#
# M193A described this set as `git diff --cached --name-only`. The committed
# implementation was `git add -A` -> `git diff --cached --name-only` ->
# `git reset -q`: staging was being used as a *query*, to force unstaged and
# untracked work into the index where one command could see it. That read the
# working tree correctly, but it did two things an observation must not do.
#
# It WROTE. `git reset` is a mixed reset, so every observation destroyed
# whatever the agent had staged. A coding agent with `Bash` can stage, and an
# instrument that silently unstages its subject is contaminating the run it is
# measuring (§3: do not stage as part of observation).
#
# It LOST RENAMES. With rename detection on — the default since git 2.9 —
# `--name-only` prints one path for an `R100`, the destination. A file the agent
# moved away therefore left the changed set entirely, and the probe's
# "source gone but a sourceless .pyc still stands in for it" branch could never
# run on the path where it matters most (§11: a deletion must not disappear).
#
# The replacement reads the same three regions of Git state without writing any
# of them:
#
#   worktree+index vs base   git diff --no-renames --name-only HEAD
#   untracked                git ls-files --others --exclude-standard
#
# `--no-renames` is what keeps both halves of a move: git reports the pair as a
# separate D and A rather than collapsing it. `HEAD` is the frozen base commit,
# which `setup()` checks out with `-f` and verifies. `--exclude-standard` gives
# untracked files normal gitignore treatment (§9), and the pre-agent untracked
# snapshot is excluded by pathspec exactly as before (§10).
CHANGED_SOURCE_AUTHORITY_VERSION = "stage5.m193b.changed-source-authority.v1"

_TRACKED_RC_MARKER = "__M193B_TRACKED_RC="
_UNTRACKED_RC_MARKER = "__M193B_UNTRACKED_RC="


def exclusion_pathspec(preexisting_untracked: list[str]) -> str:
    """Paths untracked before the agent existed are not agent changes (§10)."""
    return " ".join(f"':(exclude){p}'" for p in preexisting_untracked)


def changed_source_command(preexisting_untracked: list[str]) -> str:
    """The exact shell the authority runs. Non-mutating by construction.

    Each half reports its own exit status, because "git printed nothing" and
    "git failed" are the same empty stdout and must not be the same answer.
    """
    excl = exclusion_pathspec(preexisting_untracked)
    return (
        f"git -c core.fileMode=false diff --no-renames --name-only HEAD -- . {excl}; "
        f'echo "{_TRACKED_RC_MARKER}$?"; '
        f"git -c core.fileMode=false ls-files --others --exclude-standard -- . {excl}; "
        f'echo "{_UNTRACKED_RC_MARKER}$?"'
    )


def parse_changed_source_output(stdout: str, checkout_root: str) -> dict[str, Any]:
    """Absolute container paths for everything the agent changed, or a refusal.

    Fails closed. An enumeration that did not demonstrably complete is not an
    enumeration that found nothing: the caller must be able to tell those apart,
    because the second is a legitimate `changedSourceFileCount == 0` and the
    first is an instrument that did not answer.
    """
    tracked: list[str] = []
    untracked: list[str] = []
    rcs: dict[str, int | None] = {"tracked": None, "untracked": None}
    bucket = tracked
    for raw in (stdout or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(_TRACKED_RC_MARKER):
            rcs["tracked"] = _int_or_none(line[len(_TRACKED_RC_MARKER):])
            bucket = untracked
            continue
        if line.startswith(_UNTRACKED_RC_MARKER):
            rcs["untracked"] = _int_or_none(line[len(_UNTRACKED_RC_MARKER):])
            continue
        bucket.append(line)

    errors: list[str] = []
    if rcs["tracked"] is None or rcs["untracked"] is None:
        errors.append("enumeration did not report both exit statuses")
    if rcs["tracked"] not in (None, 0):
        errors.append(f"tracked enumeration exited {rcs['tracked']}")
    if rcs["untracked"] not in (None, 0):
        errors.append(f"untracked enumeration exited {rcs['untracked']}")
    # git quotes a path containing a newline, a quote or a control byte. Such a
    # path cannot be recovered from line-split stdout, so it is refused rather
    # than silently mis-attributed.
    quoted = [p for p in tracked + untracked if p.startswith('"')]
    if quoted:
        errors.append(f"{len(quoted)} path(s) returned in git's quoted form and cannot be split safely")

    rels = sorted(set(tracked) | set(untracked))
    return {
        "ok": not errors,
        "authority": CHANGED_SOURCE_AUTHORITY_VERSION,
        "paths": [] if errors else [os.path.join(checkout_root, r) for r in rels],
        "relativePaths": [] if errors else rels,
        "trackedCount": len(set(tracked)),
        "untrackedCount": len(set(untracked)),
        "exitCodes": rcs,
        "error": "; ".join(errors) if errors else None,
    }


def _int_or_none(text: str) -> int | None:
    try:
        return int(text.strip())
    except ValueError:
        return None


def build_source_version_evidence(
    probe: dict[str, Any],
    *,
    is_validation_attempt: bool,
    runner_started: bool,
    state_hash_before: str | None,
    state_hash_after: str | None,
) -> dict[str, Any]:
    """The compact record the TypeScript classifier consumes.

    `changedSourceFileCount` is the size of the ENUMERATED set, read from the
    probe's `requestedPaths`. M193A took it from `len(probe["files"])`, the same
    array `fileVerdicts` is built from, which made `classifySourceVersion`'s
    "did the probe answer for every changed file" guard compare a list against
    itself. It could not fail, so it was not a check.

    `stateStableAcrossValidation` is load-bearing for the other direction: the
    probe necessarily runs after the command, so it only describes what the
    command saw if nothing rewrote the tree in between. When the two snapshots
    disagree the honest answer is that freshness was not established.
    """
    files = probe.get("files") or []
    return {
        "probeRan": bool(probe.get("probeRan")),
        "isValidationAttempt": is_validation_attempt,
        "runnerStarted": runner_started,
        "stateStableAcrossValidation": (
            state_hash_before is not None and state_hash_before == state_hash_after
        ),
        "changedSourceFileCount": len(probe.get("requestedPaths") or []),
        "fileVerdicts": [f.get("verdict", "INDETERMINATE") for f in files],
        "changedSourceState": probe.get("changedSourceState"),
        "interpreter": probe.get("interpreter"),
        "files": files,
        "error": probe.get("error"),
    }

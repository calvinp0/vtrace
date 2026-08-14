# M145 — Path Membership Contract

## The question

Given a path that arrived as **text** — a traceback frame, a reporter's absolute
path, a Windows-shaped installed path — which registered worktree, if any, owns
the file it names?

M144 answered this for one repository with a boolean. In a workspace the same
question has answers a boolean cannot express, so M145 makes the answer typed.

## Statuses

| Status | Meaning |
|---|---|
| `exact` | The hint is an absolute path **inside** one worktree and names an indexed file there. Filesystem identity; no heuristic was used. |
| `unique_resolved` | The hint matches indexed files in exactly one worktree, on a path-segment boundary. A **resolution**, not an identity claim. |
| `ambiguous` | Two or more worktrees could own it. Never resolved. |
| `external` | Nothing in the workspace could own it, and the hint named an absolute location. |
| `unresolved` | Nothing matched and the hint was too weak to call external. |

And, relative to the one worktree a request routed to:

| Selected status | Meaning |
|---|---|
| `member` | The selected worktree owns it. |
| `external_to_selected_repository` | Another registered member owns it. Reported, never retrieved from (§100). |
| `ambiguous` / `external` / `unresolved` | As above. |

## Rules

1. **Segment boundaries, never substrings.** `foo/bar.py` does not match
   `myfoo/bar.py`, `prefixfoo/bar.py`, or `foo/bar.py.bak`. The rule is anchored
   on `/` in both directions.
2. **Exact outranks suffix.** If any worktree contains the named absolute
   location, only exact matches are decisive. Without this, adding an unrelated
   repository that happens to index the same relative path would make an
   unambiguous absolute path ambiguous — the invariance §92 protects. Measured
   as a defect and fixed during the milestone.
3. **Ambiguity is never broken.** Not by registration order, not by alias, not by
   lexical repository name, not by path length. Ambiguity is a status and fails
   closed.
4. **`site-packages` decides nothing.** M144 measured why: `django-12774`'s
   frames run through an installed copy of the very repository under test, while
   `requests-1724` ends in CPython. Only the indexed file list decides.
5. **A match is existence, not intent.** `/Users/hwkns/test_requests.py` never
   existed on this machine; it resolves because the repository's own
   `test_requests.py` shares a segment suffix. The right use is **rejecting**
   foreign frames, not treating a match as the author's meaning. M144's note,
   carried forward unchanged.
6. **No evidence costs nothing.** Path lists are read on first use. A task with no
   path evidence — 44 of the frozen 50 — never triggers a read.

## Collapse to M144

The single-repository predicate is this resolver with one scope, and the collapse
is exact rather than approximate:

- with one scope, `ambiguous` cannot arise;
- `exact` implies a suffix match, so it is a subset of what M144 called true;
- therefore `exact | unique_resolved` is **precisely** M144's `true`.

Verified by re-running M144's own control suites: byte-identical output.

## Cost

Each scope indexes its paths by final segment on first use. Final-segment
equality is a *necessary* condition for a segment-boundary match in either
direction, so the bucket cannot miss a match a linear scan would find. This is
what keeps §118's "for every path, for every repository, scan every indexed file"
from happening as workspaces grow.

Measured on the frozen 50: resolve time is sub-millisecond per hint and within
run-to-run noise of M144 on the same machine (M144 predecessor 1.79 ms mean over
tasks with frames, M145 1.99–2.17 ms; the untouched parse stage varies by a
comparable margin across the same runs).

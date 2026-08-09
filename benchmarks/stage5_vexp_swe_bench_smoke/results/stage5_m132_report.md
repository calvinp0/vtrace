# M132 — Worktree Routing and Repository-Identity Integrity

**Verdict: PASS.** Starting commit `238000b` (M131), ending commit `3d0a66c`. Branch `main`,
committed locally, nothing pushed. No live agents, no Docker, no VEXP, no paid APIs.
Acceptance: 21/21 rows. Verification: 3877 tests (3828 pass, 49 skip) / 0 fail, both typechecks clean,
`git diff --check` clean.

## Root causes

**Nested worktrees.** `scanRepo` walks child directories and skips them only by
name (`IGNORED_DIRECTORIES`). A Git linked worktree nested under a checkout is an
ordinary directory, so a complete second copy of the same repository was
enumerated as source. A name list could never have fixed this: worktree
directories are named by their creator — ARC's five are `feature_docker_ux` plus
four under `.claude/worktrees/<agent-id>`, and `.claude` was not even on the
ignore list. Downstream, one logical symbol under two paths read as two modules,
which is where "2 pivots were selected across separate modules — a fix that
crosses file boundaries" came from. The conclusion was fabricated from an
indexing artifact.

**Worktree routing.** Only `get_code_context`, `index_repo`, `index_status` and
`check_capsule_staleness` accepted `repo_root`. `get_context_capsule`,
`run_pipeline`, `get_impact_graph`, `search_logic_flow` and `get_skeleton` had no
way to name a worktree at all, so they always used the server-bound root, and no
response said which checkout had answered. M114 had already built worktree
identity (`inspectWorktreeIndexFreshness`) — it was simply wired into one tool.

**Project-name ranking.** `extractLiteralAnchors` classifies `ARC` as an ALL-CAPS
acronym anchor. `resolveAnchor`'s acronym branch matches exact-case symbols
(the `ARC` class in `arc/main.py`) **and path segments** — and `arc` is a path
segment of every file in the package. The repository's own name was acting as a
pointer into the repository.

**`search_symbols`.** The tool exists but is registered in `hiddenTools`, and
`listMetadata()` — which backs `tools/list` — is built from the visible list
only. The agent's report was correct for everything it could observe; the
generated guidance was the stale part.

## How MCP determines the requested worktree

Precedence, in `src/mcp/worktreeRouting.ts`: **`explicit_root` > `client_context`
> `process_default`**. The server's own `process.cwd()` is not a candidate.

Audited (§13): the stdio JSON-RPC surface handles `initialize`,
`notifications/initialized`, `ping`, `tools/list`, `tools/call`. `initialize`
returns protocol version, a `tools` capability and `serverInfo`; vtrace neither
declares nor consumes the client `roots` capability and never issues
`roots/list`. **There is no per-call caller working directory in the protocol**,
and `roots` would describe client workspace roots rather than a subagent's cwd.
So automatic caller context is unavailable today. Rather than guess, the contract
is explicit `repo_root` with actionable diagnostics;
`McpServerContext.clientContextRoot` is the seam for a runtime that can supply
one, and is null in practice. Recorded as a limitation, not worked around.

## Same worktree vs wrong worktree

| Situation | Behaviour |
|---|---|
| Request root == index root, HEAD differs | Stale. With `auto_refresh: if_stale`, **that worktree** is refreshed. |
| Request root != indexed root recorded in the manifest | `worktree_mismatch`, fail-closed. Never served. |
| Requested worktree has no index | `missing_index` / `worktree_index_missing`. Never falls back to the parent. |
| Requested worktree path is gone | `worktree_missing`, with the active index named for an actionable retry. |
| No root available anywhere | `worktree_context_required` with `retry_with_worktree_root`. |

The fail-closed check (`detectIndexWorktreeMismatch`) compares the manifest's
recorded worktree root against the routed root: an O(1) string comparison with no
subprocess, cheap enough to run on **every** product call. It is deliberately
silent when the manifest records no worktree root — a pre-identity index makes no
claim to contradict, and treating "no claim" as "wrong worktree" would fail
closed on indexes that are merely old. `get_code_context` still runs the full
M114 identity comparison on top of it.

Auto-refresh targets the **routed** worktree only. Measured: refreshing B leaves
A's index fingerprint byte-identical, and refreshing A leaves B's unchanged.

## Nested-worktree exclusion mechanism

`git worktree list --porcelain` is run **once per scan/index** at the requested
root. Any registered worktree root that is a strict descendant of that root is
excluded; the requested root itself never is. Matching is segment-aware, so
`/code/ARC.worktrees/x` is not treated as inside `/code/ARC`. Paths are
canonicalised through `realpath`, so two spellings of one worktree cannot produce
two exclusion entries. A non-Git root, a missing `git`, or any Git failure yields
an empty exclusion set — enumeration degrades to previous behaviour, never fails.

Submodules and unregistered nested Git repositories are **unchanged**: neither
appears in `git worktree list`, so this rule never sees them. Both are covered by
fixtures so the non-change is asserted, not assumed.

## Contaminated-index cleanup

`src/fs/scanRepo.ts` and the new `src/fs/worktreeExclusions.ts` are hashed into
the index `config_hash`, so every pre-M132 index reports `configuration_changed`
— a reason already in the auto-refresh allow-list. On refresh the excluded files
are simply absent from the current file set, `planIncrementalRefresh` classifies
them as deletions (`deletedFiles=1` in the fixture), and the ordinary delete path
removes their symbol, edge, document and FTS rows. Measured: nested files 1 → 0,
nested symbols 1 → 0. Removing symbols changes the semantic context hash, so the
**pre-existing** `closure_uncertain` rule escalates to a full graph rebuild —
an existing safety mechanism for unprovable reverse closure, not something M132
introduced.

**No new freshness reason** (§44). `configuration_changed` describes an
enumeration-rule change accurately, and once exclusion is in force, adding or
removing a nested worktree no longer changes the parent's source fingerprint at
all — there is no residual topology event left to report. `head_mismatch` was
never involved. **No schema or manifest version bump** (§45).

## Repository-name suppression policy

A term equal to the repository basename is dropped **before anchor resolution**,
so it reaches neither the exact-case-symbol branch nor the path-segment branch.
It yields to explicit symbol evidence: `class ARC`, `ARC.<member>`, `ARC(`,
`path::ARC`, a backticked/quoted `ARC`, or `ARC`/`class` adjacency
(`the ARC class`, `symbol ARC`, `ARC constructor`). Deterministic string
analysis; no model.

The alias source is the repository basename only, normalised (case-folded,
separator-folded, ≥3 characters, identifier-ish shape). Package-metadata parsing
was **not** introduced for this fix (§26). No token is globally blacklisted: a
repository whose basename is not `arc` keeps full anchoring on the symbol `ARC`,
covered by a fixture.

**Exactly one ranking component changed** — capsule v2 literal anchoring. No
score weight was retuned, and no other generator, reranker or packing rule was
touched.

## `search_symbols` decision

**Keep hidden; fix the guidance.** `docs/product_truth_audit_rc.md` had already
recorded "keep hidden; avoid promoting in RC docs" for the whole legacy block;
M132 makes the generator agree with a decision that was already made rather than
reversing it by accident. Exact symbol lookup is not a product gap —
`get_code_context` resolves a named symbol and returns its source with context,
and `get_skeleton` covers the known-file case — so §34's bar for adding a surface
is not met. Full classification in `stage5_m132_tool_guidance_audit.md`.

`src/runtime/toolGuidanceConsistency.test.ts` now requires every tool named in
generated guidance to be present in the **visible** tool list, and pins the
decision itself, so reversing it must be deliberate.

## Results

### ARC (read-only, isolated index in a temp directory)

```
branch arcbench   HEAD 1202705b   37 registered worktrees, 5 nested

                        before        after
files                      615          324   (291 excluded)
symbols                 15,188        8,635
edges                   18,862       19,404
index duration          25,694 ms    19,265 ms
worktree discovery           —        8.65 ms (once per index)
```

The edge count going **up** is correct: two copies of a package make module
resolution ambiguous and ambiguous targets are dropped, so the duplicates were
suppressing 542 real edges. **M131's ARC figure of 18,862 was measured on a
contaminated index; 19,404 supersedes it.**

Geometry query (verbatim: *"How does ARC handle linear segments and dummy atoms
in Z-matrices?"*):

```
before: arc/job/adapters/ts/linear.py
        feature_docker_ux/arc/job/adapters/ts/linear.py     <-- duplicate checkout
        arc/main.py                                         <-- the ARC class
        feature_docker_ux/arc/main.py                       <-- duplicate checkout
        arc/reaction/reaction.py                            <-- ARCReaction
        arc/job/adapters/ts/linear_utils/postprocess.py

after:  arc/job/adapters/ts/linear.py
        arc/job/adapters/ts/linear_utils/addition.py
        arc/job/adapters/ts/linear_utils/math_zmat.py
        arc/job/adapters/ts/linear_utils/postprocess.py
```

Both defects resolve at once: no duplicate-checkout path, and no project-class
skeleton consuming budget. `excludedPathsInResults = 0`. The neutral-phrasing
control ("How does *this project* handle…") now selects a near-identical set,
which is the point — the project name stopped changing the answer. The explicit
query *"How does the ARC class initialize project-level state?"* still leads
`arc/main.py`.

### Impact hydration

`discoverImpactSymbols` collected each frontier level's dependent ids and
hydrated them with one `getSymbolsByIds`, replacing one `getSymbolById` per
dependent. **112 → 73 queries** for the same 40 dependents, byte-identical
output across repeated calls. Traversal was not redesigned.

### M131 flow regression, run from the correct worktree

```
arc/mapping/engine.py::reorder_p_label_map -> map_two_species
included true, 1 calls edge, exact endpoints, locationKind edge_site
11 of 19,404 edges fetched, warm median 3.384 ms
```

Correct and frontier-bounded. The edge denominator differs from M131's 18,862
because the index is now clean; the fetched count is what matters and it remains
a tiny local subset.

### Preservation

| Gate | Result |
|---|---|
| Frozen 50 | **0/50 differences** — selected files, lead, roles, content modes, rendered context, digest, token accounting |
| Frozen-50 project-name interaction audit (§30) | **0 of 50** tasks contain an anchor-shaped token equal to their own repository basename, so the rule cannot fire on this set. 0 differences is structural, not lucky. |
| Retrieval evals | **byte-identical** pre vs post (stash A/B). See the baseline note below. |
| TCKDB (read-only) | lead `clients/python/tests/test_computed_reaction_upload_builder.py` preserved; M131-code parity `true`. Its basename `TCKDB_v2` is not an anchor term in that task, so the repository-name rule is inert there. |
| Response envelope | 1,844 est. tokens / 7,375 chars at `max_tokens: 6000` (ceilings 7,000 / 32,000). Worktree diagnostics are serialized once, at request level. |

**Retrieval baseline note.** The committed baselines had been stale since
`199769f` (M103) — 108 `src/` files changed across M104–M131 without a refresh,
so the cheap byte-diff proof had been meaningless for eight milestones, the same
failure M99 recorded. M132 proved its own no-change with the stash A/B protocol
(byte-identical) and refreshed the baselines so the proof is valid again for
M133. The refreshed numbers move (`cross_repo_30` top-1 0.733 → 0.700, pivot
0.800 → 0.767); **those deltas accumulated over M104–M131 and are not caused by
M132**, which is recorded in the meta file's `attribution_note`.

## Performance

Worktree discovery is one `git worktree list --porcelain` per scan/index —
8.65 ms on ARC's 37-worktree registry, never per directory. Routing adds one
canonicalisation plus one small JSON read per product call; the fail-closed
identity check is an O(1) string comparison with no subprocess. Exclusion makes
ARC indexing 25.7 s → 19.3 s, which is a side effect of correctness, not the
goal. No persistent query-result caching was introduced.

## Type safety

Three new typed modules, none with `@ts-nocheck`: `src/fs/worktreeExclusions.ts`,
`src/mcp/worktreeRouting.ts`, `src/capsuleV2/projectNameSignals.ts`. The
`tools.ts` touch is a thin wrapper — precedence, diagnostics and provenance all
live in the typed module. Historical `tools.ts` typing was not broadened into
scope.

## Safety

ARC and TCKDB source were not modified. Every ARC index was built in a temp
directory; TCKDB's index was opened read-only. The correct claim is: **M132 itself
did not write ARC's or TCKDB's in-place `.vtrace` state.** No claim is made about
byte-level immutability, since another session may independently change them.

## Known limitations

- **Automatic caller cwd is unavailable.** MCP does not transmit it; a subagent
  in a linked worktree must pass `repo_root`. The guidance now says so.
  `clientContextRoot` is the seam if a runtime can ever supply one.
- **Fail-closed identity compares recorded roots, not re-derived Git identity.**
  This is what makes it cheap enough to run on every call. A worktree that is
  physically moved reads as a mismatch until reindexed — consistent with
  `inspectWorktreeIndexFreshness`, which already reported `worktree_mismatch`
  for that case.
- **Project-name aliases come from the repository basename only.** A project
  whose package name differs from its directory name is not covered.
- **Unregistered nested Git repositories and submodules are still indexed.**
  Deliberate and documented; changing it needs its own evidence.
- **`AGENTS.md` at the vtrace repo root is untracked pre-existing dirt** and still
  contains a generated block naming `search_symbols`. Not modified. Re-running
  `writeVtraceAgentGuidanceBlock` regenerates it correctly.
- **ARC's own `CLAUDE.md` was not touched** (§60/§61). If it carries stale vtrace
  guidance, that is a user-maintained file and is reported rather than edited.
- **`presentation-outline.md` / `slides/slides.md`** list a whole pre-
  `get_code_context` tool set under "Exposed tools". Stale for the entire legacy
  block, not for `search_symbols` specifically; out of scope, recorded in the
  tool-guidance audit.

## What M132 does not claim

- M132 makes single-repository / multi-worktree operation trustworthy.
- M132 does **not** yet aggregate unrelated repositories into one workspace query.
- M132 does **not** infer cross-repository dependencies.
- M132 does **not** implement OpenAPI / shared-type / environment-contract linking.
- M132 does **not** claim workspace parity with VEXP.

## Recommended next milestone

**M133 — Workspace and repository identity foundation.** Canonical repository
identity, worktree identity, request → worktree routing, per-worktree freshness
and nested-worktree exclusion are now trustworthy, so `workspace_id` / `repo_id`,
explicit unrelated-repository registration, deterministic multi-repository
aggregation, one global context budget and repository-qualified selected context
can be built on them. Two constraints carry forward: workspace operations must
not load unrelated repository graphs (M130/M131), and the complete-response
envelope must hold after aggregation (M130). Item-level `repo_id` becomes
meaningful there; M132 is still single-worktree scoped and keeps provenance at
request level.

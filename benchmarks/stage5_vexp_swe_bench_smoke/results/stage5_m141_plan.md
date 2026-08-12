# M141 — Index readiness and indexing-path hygiene: plan

M140 is closed as PASS and is frozen preservation scope. M141 changes no
retrieval, ranking, graph, import-attribution, upstream-rescue,
orchestration-scoring, or path-completion behavior. Its subject is the
**lifecycle and evaluation infrastructure around** that behavior: whether
VTRACE can tell the truth about the data its answers rest on.

Starting point (resolved, not assumed):

```text
M140-C functional commits  4172a26378b41734dc7f3176997f527619a93d60
                           c267816999ce73664ccceba5bcc71892681c05dc
M140 close (evidence)      249f61feabf26ee183d500a8ffb761e2c3ac09e6
branch                     main
ahead / behind             15 / 0 at start, nothing pushed
pre-existing dirt          stage5_outcome_ledger.{json,md}
```

The functional predecessor for every paired measurement is `249f61f`: it is
`c267816` plus evidence-only files, and it is the earliest commit that contains
the M140-C acceptance runner used to measure both sides.

## Ordering

Product correctness first, then the infrastructure that validates it.

1. **A — readiness truthfulness.** The `index_status` says fresh /
   `get_code_context` says `index_schema_changed` contradiction.
2. **B — `index_repo` response boundedness.** ~290 `indexed` entries in a
   normal successful response.
3. **C — `memoryRulesMs`.** ~40% of a real ARC request; profile before
   optimizing.
4. **D — benchmark output/workspace hygiene.** Runners mutating the tracked
   evidence they validate; `/tmp` tmpfs exhaustion.
5. **E — preservation provenance.** A historical-improvement assertion re-run
   against a baseline that already contains the improvement.

A and C both need repository/worktree/index identity, so C reuses A's
evaluation rather than growing a second one. D and E come last so the
infrastructure is fixed against already-stable product behavior.

## Workstream A — one readiness evaluation

Decompose readiness into `sourceFresh`, `schemaCompatible`,
`capabilityCompatible`, `repositoryCompatible`, `worktreeCompatible`, and
evaluate every one — the pre-M141 code returned at the first failure, which is
why `sourceFresh=true, schemaCompatible=false` could not be expressed. Emit a
machine-readable state, a bounded reason code, and a recommended action kept
separate from `ready`.

Derive the existing `inspectWorktreeIndexFreshness` contract from the same
evaluation so product behavior does not move, then route `index_status`, the
product-shell status, workspace repo status, `run_pipeline`,
`get_code_context`, and `index_repo` through it. M132's lesson governs the
acceptance: prove **routing**, not the existence of a helper.

No index schema bump unless genuinely required. Audit existing metadata first.

## Workstream B — bounded indexing responses

Summary-first: exact counts per status, planner change counts, aggregate skip
reasons, and a bounded notable-outcome list. Failures are never displaced by
warnings and neither is displaced by ordinary successes; withheld detail is
reported with an exact count. Debug mode raises the cap without removing it.
Indexing data itself must be byte-identical — only presentation moves.

## Workstream C — profile, then decide

Instrument before optimizing, and report honestly if the cost turns out to be
an unavoidable one-time operation. The target is shape, not a percentage:
expensive external discovery approximately O(1) per request, pure classification
free to stay O(N), and M138 freshness semantics unchanged. No process-global
cache — request-local only, or M114/M138 freshness breaks.

## Workstream D — output and workspace contract

Audit every runner, not the three observed misbehaving. Ordinary runs default
to an untracked directory; reaching tracked evidence requires `--out` or an
explicit `--evidence`. Large scratch state resolves through `--workspace-root`,
then an environment variable, then a caller-provided `TMPDIR`, with no machine
path committed. Prove it with a hash snapshot of tracked evidence across a
representative run, not by reading `git status`.

## Workstream E — assertion kinds and baseline provenance

A preservation check must know whether it asserts absolute correctness, a
historical improvement, non-regression, equivalence, boundedness, or capability
presence. A historical-improvement claim is only meaningful against a
pre-change baseline; against a successor the same measurement is non-regression
and must be evaluated as one. Establish which by git ancestry against the
commit that introduced the change, and fail closed when ancestry is unknown.

No product flow code may be changed to satisfy a stale benchmark assertion.

## Validation

Deterministic and offline throughout: no live agents, no paid APIs, no Docker,
no VEXP, no network-dependent evaluation.

- Readiness state matrix and cross-tool parity matrix over ten index states.
- `index_status` contradiction measured on predecessor and candidate.
- `index_repo` response before/after, and scaling from 10 to 30,000 files.
- `memoryRulesMs` before/after on the real ARC index, with query counts.
- M140-C acceptance on both sides, artifact-by-artifact.
- M132/M137 preservation smokes; memory-verdict equivalence against the
  predecessor.
- Provenance-safe paired retrieval comparison over the frozen 50.
- `bun run typecheck`, `bun run typecheck:benchmarks`, `bun test`,
  `git diff --check`.

## Out of scope

No M142 work (workspace aggregation, multi-repository merging, cross-repo
traversal, workspace-level ranking or identity UX). No parser scope expansion.
No release or product polish.

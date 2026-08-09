# M134 provenance and reconstruction protocol

Status: frozen before authoritative historical replay.

## Scope

M134 measures provenance; it does not tune candidate generation, task derivation,
ranking, graph expansion, document retrieval, Capsule packing, or product response
semantics. No live agents, paid APIs, Docker, VEXP, or live SWE-bench arms are used.

## Deterministic protocol

- Suites: `retrieval_eval.django.expanded.json` (20) and
  `retrieval_eval.cross_repo.30.json` (30), in fixture order. Together these are
  the frozen 50.
- Targets: each fixture instance is bound to its SWE-bench `base_commit` by
  `retrieval_eval.target_corpus.json`.
- Intent and budget: the fixture's declared intent and token budget.
- Indexing: full index generated independently by each VTRACE implementation;
  index, manifest, parse cache, and temporary state are not shared.
- Source: both sides receive byte-identical copies of the same prepared target.
- Scoring: the current fixed evaluator scores both sides. Historical runner drift
  is audited separately so evaluator changes cannot masquerade as retrieval
  changes.
- Semantic version: `stage5.retrieval.semantic.v1`; selected files, lead, roles,
  content modes, rendered model-visible context, per-item and aggregate token
  accounting, and quality fields are included. Timings, timestamps, absolute
  temporary paths, request IDs, and diagnostic counters are excluded.
- Protocol version: `stage5.retrieval.protocol.v1`.
- Timing: latency is non-authoritative. Provenance collection reports wall time;
  cold first-run and warm process-cache observations are never pooled.

## Authority

An artifact is authoritative only when the VTRACE implementation is clean and
committed, the complete fixture ran, target identities resolve, and fixture,
runner, protocol, corpus, semantic version, raw semantic hash, and metric-summary
hash are present. Dirty runs are exploratory. Any mismatch refuses comparison;
the explicit exploratory override remains non-authoritative.

## Historical reconstruction

Start at the M103 implementation and replay retrieval-relevant product trees.
Skip report-only commits and conservatively deduplicate identical retrieval
behavior. Use bisection first, then run adjacent implementations around every
movement. Historical VTRACE worktrees are isolated from the user's main tree and
use their own package metadata and lockfile. Failure classes are structured:
`historical_run_success`, `dependency_unavailable`, `compile_failure`,
`benchmark_runner_missing`, `schema_incompatible`, `fixture_unsupported`, and
`environment_unrecoverable`.

# M138 observation and memory provenance plan

Starting point: `main` at `44f58d7f98b883f86ceec8187e7d65eda06fa23e` (M137 evidence), with functional predecessor `68514687df2056d1c3551ea3285503dc6449023f`; 12 commits ahead of `origin/main`, 0 behind. Existing ledger edits and untracked benchmark data were preserved.

Scope is deliberately single-repository/single-request-context memory correctness. Candidate generation, retrieval ranking, query semantics, Capsule packing, flow, impact, worktree routing, and delivery budgets are frozen. Workspace aggregation is not extended.

Implementation sequence:

1. Audit the persistent schema and every write/replay path: explicit save/search/session tools, structural auto-capture, compression/consolidation, Capsule memory, product context, and run-pipeline digest injection.
2. Add an additive, versioned provenance record plus typed scope/origin fields; retain legacy rows and classify missing provenance conservatively.
3. Resolve repository/worktree/HEAD/dirty/index/VTRACE identity once per request and feed one pure compatibility evaluator to every model-facing replay path.
4. Default current-mode searches to current-compatible evidence; expose bounded `includeStale` historical access with reason codes and compact suppression accounting.
5. Hash structured tool results and semantic request options, deduplicate identical results, and surface conflicting current-compatible hashes.
6. Reproduce the ARC incident through an isolated database copy, prove current 3/3 delivery remains authoritative, and run deterministic preservation/paired comparisons before local commits.

Permanent test principle: **stored evidence must be tested across source-context changes, not only write/read round-trips.** The missing dimension was context freshness.

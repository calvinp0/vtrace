# M134 historical deterministic retrieval reconstruction

## Verdict

The cumulative `cross_repo_30` Top-1 movement is exactly attributable to
**M122 → M123**. `psf__requests-1724` moved from a gold lead in
`requests/sessions.py` to an API-facade lead in `requests/api.py`, changing
Top-1 from 22/30 (`0.7333`) to 21/30 (`0.7000`).
`sphinx-doc__sphinx-7462` changed support composition in the same transition but
retained its gold lead and did not affect headline metrics.

The last trustworthy historical golden was M103: implementation `199769f`,
promoted fixture/baseline head `f14aab8`. The fixtures then stayed byte-stable
through M133. The deterministic scorer also stayed unchanged. The movement was
therefore a product-output change, not fixture or evaluator drift.

## Adjacent retrieval transitions

| Transition | Cases changed | Top-1 delta | Any-gold delta | Lead delta | Cause | Classification |
|---|---:|---:|---:|---:|---|---|
| M103→M119 endpoint | 0/2 implicated cases | 0 | 0 | 0 | report/response/index work | semantic preservation |
| M119→M120 | 0/2 | 0 | 0 | 0 | graph/flow only | semantic preservation |
| M120→M121 | 0/2 | 0 | 0 | 0 | compound-task recovery, no effect here | intentional retrieval change |
| M121→M122 | 0/2 | 0 | 0 | 0 | product-path hardening, no effect here | intentional retrieval change |
| **M122→M123** | **2/30** | **-1/30** | **0** | **1** | shared Capsule-v2 ranking and compound rescue convergence | intentional tradeoff; one unexpected regression |
| M123→M124 | 0/50 | 0 | 0 | 0 | index handling | semantic preservation |
| M124→M125 | 0/50 | 0 | 0 | 0 | product optimization | semantic preservation |
| M125→M126 | 0/50 | 0 | 0 | 0 | hybrid retrieval optimization | semantic preservation |
| M126→M128 endpoint | 0/50 | 0 | 0 | 0 | legacy wrapper removal + mixed documents | frozen-suite preservation |
| M128→M129 | 0/50 | 0 | 0 | 0 | document retrieval optimization | semantic preservation |
| M129→M133 endpoint | 0/50 | 0 | 0 | 0 | response, flow, routing and impact work | semantic preservation |

M123's own report had already shown the legacy `0.733` versus product-v2
`0.700` aggregate. M134 connects that aggregate to the exact adjacent commits,
same target checkouts, independently generated indexes, and the two exact cases.

## Fixture and runner drift

Both fixture files changed once at M103's `f14aab8` promotion because structured
task text was adopted (15 cross-repo and 8 Django tasks). Ordering and gold labels
did not change. There were no further fixture-byte changes through M133. The
deterministic runner/scorer did not change anywhere in M103–M133.

## ARC caveat

Pre-M132 ARC indexes contained nested linked worktrees (615 files, 15,188 symbols,
18,862 edges). The clean M132 index has 324 files, 8,635 symbols, and 19,404 edges.
Those old totals are classified `worktree_contaminated_index`, not as a current
graph or performance regression.

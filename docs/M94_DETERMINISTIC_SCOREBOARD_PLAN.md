# M94 Deterministic Retrieval/Capsule Scoreboard Plan

_Status: **implemented** (M94). The scoreboard runner
(`benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m94_deterministic_scoreboard.ts`,
pure metrics in `stage5_m94_lib.ts`) scores all 100 frozen instances deterministically
— no live agents, no Docker, no API spend. Headline (99/100 scored): gold-file
recall@1 **0.44**, recall@5 **0.64**, MRR **0.55**, any-gold-in-capsule **69.7%**,
lead-pivot-is-source-gold **45.5%**; deterministic excellent/good cases resolved live
at **61.9%** vs **21.7%** for weak cases (M92 clean-core join, n=49). Verdict **PASS**.
Report: `results/stage5_m94_deterministic_scoreboard.md`. This section supersedes the
original "planned" status below (the design intent is unchanged)._

## Purpose

Score VTRACE's retrieval and capsule quality **before the agent acts** — a purely
deterministic, offline measurement of "did the core put the gold code in front of
the model?" This isolates the deterministic core (`index → retrieval → capsule`)
from the noisy, expensive, live-agent Stage 5 signal, so retrieval/pivot/capsule
changes can be evaluated cheaply and reproducibly.

Why it comes next: M92 confirmed the core reduces tokens without hurting live
resolution, but every current quality signal is entangled with a live agent turn
loop (variance, cost, API spend). A deterministic scoreboard gives a fast,
byte-stable target function to drive M95+ retrieval/pivot/capsule work.

## Inputs

- **Frozen Stage 5 100-task pool** — the existing committed instance set
  (`$DATASET` gold patches + `FAIL_TO_PASS`), pinned so scores are comparable
  across runs.
- **Issue text** — the task/problem statement per instance.
- **Base repo** — the indexed repository at the instance's base commit.
- **Gold patch files** — the set of files the gold patch touches (the recall
  target).
- **Optional gold symbols** — gold-edited symbol FQNs when extractable from the
  patch hunks (best-effort; absent when hunks don't map cleanly to indexed
  symbols).

## Metrics

Retrieval / capsule containment (per instance, then aggregated):

- `gold_file_recall@1`, `@3`, `@5`, `@10` — is a gold file in the top-K retrieved.
- `any_gold_in_capsule` — capsule contains ≥ 1 gold file.
- `all_gold_in_capsule` — capsule contains every gold file.
- `lead_pivot_is_gold` — the lead pivot's file is a gold file.
- `hidden_coedit_recall` — recall of gold files that must co-edit but are not the
  lead pivot (the "hidden co-edit" case).

Budget / packing (deterministic, character-based, with `chars/4` token estimate):

- `capsule_est_tokens` — estimated tokens in the emitted capsule.
- `digest_est_tokens` — estimated tokens in the compact digest.
- `overpacking_ratio` — emitted context size ÷ minimal gold-covering context size.

Failure attribution:

- `missing_gold_reason` — per instance where gold was missed: one of
  `retrieval_miss` (never retrieved), `ranked_out` (retrieved but below cutoff),
  `budget_evicted` (in pool but dropped by budget), `pivot_demoted`
  (retrieved/kept but not a pivot), `unparseable_language` (gold file in a
  language with no parser).

## Outputs

- **Markdown report** — headline aggregates + the top deterministic failure modes,
  committed under `benchmarks/stage5_vexp_swe_bench_smoke/results/`.
- **JSON detail** — per-instance metric rows for downstream diffing.
- **Per-repo / cohort breakdown** — recall and packing split by repo (django,
  sympy, astropy, …) and by cohort (single-file vs multi-file gold; Python vs
  non-Python gold).
- **Top deterministic failure modes** — ranked `missing_gold_reason` buckets so
  the next milestone has a concrete work-list.

## Non-goals

- **No live agents** — the scoreboard never spawns an agent turn loop.
- **No Docker** — no SWE-bench resolution / test execution.
- **No pass@1 claim** — the scoreboard measures *context quality*, not task
  resolution, and produces no public SWE-bench score.
- No change to retrieval/scoring/ranking/Capsule behavior as part of building the
  scoreboard itself (it is a read-only measurement harness).

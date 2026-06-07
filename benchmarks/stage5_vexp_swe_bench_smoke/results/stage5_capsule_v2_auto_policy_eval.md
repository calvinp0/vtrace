# Stage 5 — Capsule v2 Auto-Policy Evaluation

## Scope

Deterministic comparison of three Stage 5 result sets recorded on the SAME
five Django SWE-bench smoke instances: a no-context **baseline**, a Capsule v2
**force-inject** run (context always injected), and a Capsule v2 **auto-policy**
run (the cost-aware gate chooses inject vs no_context per instance).
Reduces already-recorded artifacts only — no Claude, no Docker, no agent run.

## Protocol

For each instance the generator reads the recorded JSONL row and recomputes
total tokens (`inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens`),
cost (`costUsd`), and wall-clock (`durationMs`), then the reduction of each
treatment relative to baseline. Reductions are fractions: positive means the
treatment used **less** than baseline; negative means **more**. Pooled metrics
are the reduction of the summed totals (large instances weigh proportionally).
Resolved is taken from the row's `resolved` flag. The auto decision is read from
the vtrace `_run.meta.json` (`vtraceContextPolicyAction`).

## Label mapping

| instance | baseline | force-inject | auto-policy |
| --- | --- | --- | --- |
| django__django-10880 | eval-10880 | eval-capsulev2-risk5-10880 | eval-capsulev2-auto-10880 |
| django__django-11095 | eval-11095 | eval-capsulev2-risk5-11095 | eval-capsulev2-auto-11095 |
| django__django-11490 | eval-11490 | eval-capsulev2-risk5-11490 | eval-capsulev2-auto-11490 |
| django__django-11728 | eval-11728 | eval-capsulev2-risk5-11728 | eval-capsulev2-auto-11728 |
| django__django-11740 | eval-11740 | eval-capsulev2-risk5-11740 | eval-capsulev2-auto-11740 |

## Policy decisions

| instance | auto action | expected value | overhead risk | reason |
| --- | --- | --- | --- | --- |
| django__django-10880 | no_context | low | high | Small/local task with an obvious narrow target (micro capsule, not an internal … |
| django__django-11095 | no_context | low | high | Small/local task with an obvious narrow target (micro capsule, not an internal … |
| django__django-11490 | inject | high | low | High-value context: edit-risk directive + line-anchor resolution + SQL-renderin… |
| django__django-11728 | inject | high | low | High-value context: internal-subsystem navigation with a focused pivot source; … |
| django__django-11740 | inject | high | low | High-value context: internal-subsystem navigation with a focused pivot source; … |

## Baseline vs force vs auto

| instance | auto action | baseline tok | force tok | auto tok | force red | auto red | resolved auto |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| django__django-10880 | no_context | 432600 | 385653 | 753097 | 10.85% | -74.09% | True |
| django__django-11095 | no_context | 535997 | 646809 | 665993 | -20.67% | -24.25% | True |
| django__django-11490 | inject | 4661640 | 1088993 | 1610878 | 76.64% | 65.44% | True |
| django__django-11728 | inject | 1716132 | 909044 | 1373090 | 47.03% | 19.99% | True |
| django__django-11740 | inject | 2387415 | 697287 | 2074004 | 70.79% | 13.13% | True |

## Aggregate metrics

| metric | force | auto |
| --- | ---: | ---: |
| resolved | 5/5 | 5/5 |
| mean token reduction | 36.93% | 0.04% |
| pooled token reduction | 61.70% | 33.46% |
| pooled cost reduction | 54.62% | 28.33% |
| pooled duration reduction | 44.52% | 22.12% |

- Auto decisions: 3 inject, 2 no_context.
- Auto vs force (tokens): 0 better, 5 worse.
- Auto worse than baseline (tokens): 2.

## Interpretation

- Auto-policy preserved correctness: 5/5 resolved.
- Auto-policy did not outperform force-inject on this smoke set.
- Force-inject achieved stronger pooled token/cost/duration reduction.
- The no_context assumption did not hold for 10880/11095; no_context did not reproduce cheap baseline behavior.
- The next decision is whether to:
  - A. make auto more aggressive,
  - B. collect repeated-run estimates,
  - C. keep force-inject as the preferred experimental mode,
  - D. expand to more instances before tuning further.

## Recommendation

Keep **force-inject** as the preferred experimental mode for now: it reduced
more (pooled tokens/cost/duration) while auto-policy held correctness but did
not improve efficiency on this set. Tune the gate or widen the instance set
before switching the default to auto.

## Caveats / non-claims

- Five instances is a SMOKE set: this is an engineering signal, not a SWE-bench
  score or a statistically powered comparison.
- Single run per label: token/cost/duration carry cache and load variance; no
  repeated-run confidence interval is computed here.
- Reductions are relative to a no-context baseline on the same instances, not to
  any external leaderboard or published number.
- `resolved` reflects the recorded harness verdict for these runs only.

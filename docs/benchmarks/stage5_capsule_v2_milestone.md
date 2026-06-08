# Stage 5 — Capsule v2 Milestone

A consolidated record of what Capsule v2 achieved on the Django SWE-bench smoke
set: live agent runs (force-inject and auto-policy), deterministic retrieval
quality, and the capabilities that got it there. Each section links to the
generator/report it summarizes; this doc adds no new numbers of its own.

The headline: **Capsule v2 context measurably reduces agent cost without losing
correctness on this set, and deterministic retrieval recovers the correct edit
target on 20/20 expanded fixtures.**

---

## 1. Five-task live force-inject result

Live `vtrace-indexed` runs with Capsule v2 always injected (`--context-policy
force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget 8000`),
each against the identical baseline (`run --no-vexp`, no context). Source:
[`stage5_capsule_v2_validation.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_capsule_v2_validation.md).

```
resolved:                5/5
pooled token reduction:  61.70%
pooled cost reduction:   54.61%
pooled duration reduction: 44.52%
```

Pooled = reduction of the summed totals vs. baseline (large instances weigh
proportionally; positive means the treatment used **less** than baseline).

## 2. Auto-policy result

The same five instances, but the cost-aware gate chooses inject vs. no_context
per instance instead of always injecting. Source:
[`stage5_capsule_v2_auto_policy_eval.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_capsule_v2_auto_policy_eval.md).

```
resolved:               5/5
pooled token reduction: 33.46%
```

**Conclusion: correctness-safe but weaker than force-inject.** The auto gate held
correctness (5/5) while declining injection on small/local tasks with an obvious
narrow target, trading some of force-inject's token savings for fewer
speculative injections. On this set, force-inject was the stronger efficiency
play; auto-policy is the conservative default that never spends context where it
judged the overhead risk high.

## 3. Expanded Stage 5R retrieval result

Deterministic retrieval over the expanded 20-instance Django fixture — can the
capsule recover the correct edit target from the index + task text alone? No
Claude, no Docker, no API in the loop. Source:
[`stage5r_expanded_retrieval_eval.md`](./stage5r_expanded_retrieval_eval.md).

```
evaluated: 20/20
top-1:     75%
top-3:     90%
missing:    0%
```

No instance regressed when reaching these numbers.

---

## 4. Key capabilities added

The retrieval and patch-planning quality above rests on these additions:

- **Capsule v2 pivot/support rendering** — the assembled capsule's text output:
  ranked pivots (focused source) and support (signatures/skeletons) under a
  budget, rendered deterministically.
- **Line-anchor symbol resolution** — resolves bug-report file:line references to
  the concrete enclosing symbol.
- **Body/literal search** — extracts distinctive literals (diagnostic/error
  codes, quoted messages) from symbol bodies at index time so a symbol named only
  by the diagnostic it emits (e.g. `models.E015 → _check_ordering`) is
  recoverable. This drove the expanded retrieval `missing 10% → 0%`.
- **Generic lexical-noise filtering** — down-weights generic lexical tokens so
  high-frequency boilerplate does not dominate ranking.
- **Guarded mutation edit-risk directive** (`guarded_shared_state_mutation`) —
  warns when a pivot mutates shared/query state under a guard, so the agent
  clones before mutating rather than relaxing the guard.
- **Chained lookup alias traversal directive** (`chained_lookup_alias_traversal`)
  — warns when a pivot validates a chained lookup/path traversal, so the agent
  resolves alias segments to concrete targets instead of skipping them.
- **Traversal state-machine invariant directive**
  (`traversal_state_machine_invariant`) — the structural companion: every path
  segment must update the traversal cursor for the next segment and terminate it
  when traversal cannot continue. Adding this closed the remaining gap on
  `django__django-11820` (a live run produced the full two-part fix and Docker
  resolved the instance).
- **Index fingerprinting / auto reindex policy** — detects a stale index and
  reindexes before retrieval, so runs never query stale or leftover state.

All three edit-risk directives are deterministic and generic: they fire on the
*shape* of the pivot source plus task prose, never on a framework, file, symbol,
or instance id.

---

## 5. Non-claims

These results are scoped, and the following are explicitly **not** claimed:

- **Not public SWE-bench.** This is an internal smoke harness, not an official
  SWE-bench leaderboard run.
- **Not a vexp comparison.** The comparison is baseline agent vs. same agent with
  vtrace context. vexp is disabled throughout; no vexp-vs-vtrace claim is made.
- **Small Django smoke set.** Five live instances and a 20-instance retrieval
  fixture, all Django. Not a broad or multi-repo benchmark.
- **Live runs are still stochastic.** Agent patch synthesis is probabilistic;
  individual runs vary (e.g. 11820 resolved on the 2nd of two allowed live runs).
  The directives shift behavior but do not deterministically guarantee a passing
  patch on any single run.

# Capsule v2 — Stage 5 State

A single, current snapshot of where Capsule v2 stands on the Stage 5 work:
deterministic retrieval quality (Django and cross-repo), the live Django agent
runs (force-inject and auto-policy), the capabilities behind those numbers, and
an honest list of what is still open. Each section links to the generator/report
it summarizes; the numbers here are copied from those reports, not re-derived.

Scope in one line: **on this set, Capsule v2 context reduces agent cost without
losing correctness, deterministic retrieval recovers the edit target on 20/20
Django and 14/16 cross-repo top-3, and the remaining misses are understood and
catalogued rather than hidden.**

---

## 1. Django expanded retrieval

Deterministic retrieval over the expanded 20-instance Django fixture — can the
capsule recover the correct edit target from the index + task text alone? No
Claude, no Docker, no API in the loop. Source:
[`stage5_retrieval_eval_expanded.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_retrieval_eval_expanded.md)
· narrative: [`stage5r_expanded_retrieval_eval.md`](./stage5r_expanded_retrieval_eval.md).

```
evaluated: 20/20
top-1:     75.0%
top-3:     90.0%
pivot:     80.0%
missing:    0.0%
```

Unchanged by the G1/G2 cross-repo hardening (the exception-symptom de-anchoring
changed no Django ranking) — confirming no regression.

## 2. Cross-repo retrieval

The same deterministic retrieval eval over the first **non-Django** fixture: 16
instances across 8 repos (sympy, scikit-learn, matplotlib, astropy, pytest,
sphinx, requests, flask), a deterministic first-N-per-repo slice of
`swe-bench-100`. Gold-patch labels; tasks derived from problem statements;
expected labels are evaluation-only and never fed to retrieval. Source:
[`stage5_retrieval_eval_cross_repo.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_retrieval_eval_cross_repo.md)
· miss audit:
[`stage5_retrieval_eval_cross_repo_miss_audit.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_retrieval_eval_cross_repo_miss_audit.md).

```
evaluated:        16/16
repos:            8
workspace errors: 0
top-1:            62.5%
top-3:            87.5%
pivot:            81.3%
missing:           6.3%
```

Per-repo (top-1 / top-3): scikit-learn, pytest, flask 100%/100%; sympy
66.7%/100%; matplotlib 0%/100%; sphinx 50%/100%; astropy 50%/50%; requests
50%/50%. After the G1/G2 fixes the miss taxonomy is `wrong_subsystem` ×1
(astropy-14369) and `present_but_discarded` ×1 (requests-1724); the previous
`body_literal_not_resolved` misattribution is gone and sphinx-7462 lifted into
top-3.

## 3. Five-task live force-inject result

Live `vtrace-indexed` runs with Capsule v2 always injected (`--context-policy
force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget 8000`),
each against the identical baseline (`run --no-vexp`, no context). Source:
[`stage5_capsule_v2_validation.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_capsule_v2_validation.md).

```
resolved:                  5/5
pooled token reduction:    61.70%
pooled cost reduction:     54.61%
pooled duration reduction: 44.52%
```

Pooled = reduction of the summed totals vs. baseline (large instances weigh
proportionally; positive means the treatment used **less** than baseline).

## 4. Auto-policy result

The same five instances, but the cost-aware gate chooses inject vs. no_context
per instance instead of always injecting. Source:
[`stage5_capsule_v2_auto_policy_eval.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_capsule_v2_auto_policy_eval.md).

```
resolved:               5/5
pooled token reduction: 33.46%
```

Correctness-safe (5/5) but weaker than force-inject on this set: the gate
declined injection on small/local tasks with an obvious narrow target, trading
some of force-inject's savings for fewer speculative injections.

## 5. Context-to-action conversion (PIVOT_CHECK)

Retrieval surfacing a pivot is not the same as the agent _using_ it. On
`sphinx-7462` Capsule v2 surfaced the hidden, non-traceback pivot
`sphinx/pycode/ast.py::unparse`, but render-only guidance did not convert it —
the agent only Grep-discovered the file and edited the traceback-named file. After
ordered tool-call telemetry was made to work (commit `6dfbc1b`), a compact
benchmark-only `PIVOT_CHECK` enforcement block (commit `13c7a25`) converted it:

```
hidden pivot sphinx/pycode/ast.py::unparse
  before (eval-pivot-telemetry-vtrace-sphinx-7462-r2): discovered-only / ignored
  after  (eval-pivot-check-vtrace-sphinx-7462):         inspected (directly Read twice)
  agent still edited: sphinx/domains/python.py only
  vtracePivotChecklistEmitted: false   (behavioral compliance, no checklist echo)
```

Lesson: **ordered tool evidence is the authoritative compliance signal; checklist
text is a prompt lever, not the source of truth.** Reports keep four signals
separate — prompt injected, checklist emitted, ordered tool-call evidence, final
patch files. Full write-up:
[`capsule_v2_context_to_action_gap.md`](./capsule_v2_context_to_action_gap.md)
(see the "Follow-up — `PIVOT_CHECK` enforcement" section). This is the first
_measured_ context-to-action conversion; it is **not** a Docker-resolution claim —
resolution is reported separately.

## 6. Key features added

The retrieval and patch-planning quality above rests on these additions:

- **Capsule v2 pivot/support rendering** — ranked pivots (focused source) and
  support (signatures/skeletons) assembled under a token budget, rendered
  deterministically.
- **Line-anchor symbol resolution** — resolves bug-report `file:line` references
  to the concrete enclosing symbol.
- **Body/literal search** — extracts distinctive literals (diagnostic/error
  codes, quoted messages) from symbol bodies at index time, so a symbol named
  only by what it emits (e.g. `models.E015 → _check_ordering`) is recoverable.
  Drove Django expanded `missing 10% → 0%`.
- **Generic lexical-noise filtering** — down-weights generic bug-report tokens
  (`error`, `multiple`) so boilerplate cannot ride one word to a pivot.
- **Exception-symptom de-anchoring (G1)** — a CamelCase exception named in the
  task (`IndexError`, `UnicodeDecodeError`) tokenises into symptom nouns
  (`index`, `decode`); when a noun occurs only inside the exception name it is
  de-anchored so it cannot anchor ranking onto symptom-named code, while a noun
  that also appears standalone stays meaningful and the full exception name stays
  in the query for recall. Diagnostic: `deanchored_exception_tokens`.
- **Edit-risk directives** (`guarded_shared_state_mutation`,
  `chained_lookup_alias_traversal`, `traversal_state_machine_invariant`) —
  deterministic, generic warnings that fire on the _shape_ of the pivot source
  plus task prose, never on a framework, file, symbol, or instance id.
- **Index fingerprinting / auto reindex** — detects a stale index (content-hashed
  parser/indexer/schema fingerprints) and reindexes before retrieval.
- **Cross-repo eval tooling** — `--cross-repo` workspace prep (lazy per-repo
  shallow bench clones), fixture builder, per-repo aggregation + report, and a
  miss taxonomy with `body_literal_not_resolved` / `language_parser_gap`
  categories (G2 precedence: structural candidate-gap causes are attributed
  before a body-literal explanation, and module/format identifiers no longer
  count as body literals).
- **Indexer performance fix** — a run-level, content-keyed Python export-index
  cache eliminated O(n²) re-parsing during cross-file resolution, making
  large-repo indexing feasible (sympy ~1h → ~1m), which unblocked the cross-repo
  set.

## 7. Known remaining gaps

- **Cross-repo top-1 is still only 62.5%.** Top-3 (87.5%) is strong, but the
  correct file is the single best pivot only ~5/8 of the time on non-Django
  repos; first-pivot precision off Django is not yet where Django is (75%).
- **requests-1724 remains a support-budget/ranking issue.** After de-anchoring
  `decode`, `requests/sessions.py` is recovered but still falls beyond the
  support budget (discarded), so it is not in top-3. Raising the support budget
  is a global ranking lever and is deliberately not changed here.
- **astropy-14369 remains a wrong-subsystem/candidate-gap issue.** The task is
  framed in the I/O reader subsystem (`io/ascii`, `format='ascii.cds'`) while the
  fix lives in the units parser (`units/format/cds.py`); there is no lexical or
  graph bridge, so the expected file never enters candidates. Correctly labelled
  `wrong_subsystem` now, but not recovered.
- **Auto-policy is correctness-safe but not better than force-inject.** On this
  set the cost-aware gate held 5/5 correctness while saving less (33.46% vs
  61.70% tokens); it is the conservative default, not a win over always-inject.
- **Live results are still small and stochastic.** Five live instances; agent
  patch synthesis is probabilistic and individual runs vary. The directives shift
  behavior but do not deterministically guarantee a passing patch on any one run.

## 8. Non-claims

- **Not public SWE-bench.** Internal smoke harness, not an official SWE-bench
  leaderboard run.
- **Not a vexp comparison.** The comparison is baseline agent vs. the same agent
  with vtrace context; vexp is disabled throughout. No vexp-vs-vtrace claim.
- **Not a broad benchmark.** Five live Django instances, a 20-instance Django
  retrieval fixture, and a 16-instance / 8-repo cross-repo retrieval fixture —
  small, deterministic slices, not a leaderboard or a statistically powered study.
- **Cross-repo numbers are retrieval-quality only.** They measure whether the
  capsule surfaces the known edit target; they do **not** measure live token /
  cost / duration or agent resolution on non-Django repos (no live cross-repo
  runs have been done).
- **No repo-specific tuning.** No instance ids or per-repo rules anywhere in
  retrieval; all heuristics fire on shape/prose only.
- **PIVOT_CHECK conversion is context-use, not resolution.** Section 5 measures
  whether the agent _inspected_ a surfaced pivot, on one `sphinx-7462` smoke. It is
  not a claim that PIVOT_CHECK improves Docker resolution, guarantees correct
  edits, or generalizes beyond this case; checklist emission is not required for
  compliance.

# Stage 5 M55X Capsule v2 Digest Live A/B

Targeted 4-case live A/B for the M55 Capsule v2 product digest (commit `14bb847`),
wired into Stage 5 injection by M55W (`cbe57f3`) behind `--inject-capsule-digest`.
This is a **measurability + behavior validation gate**, not a benchmark: 1 digest run
per case vs reused baseline replicate sets, model `claude-opus-4-5-20251101`.

## Summary

- **Cases:** 4 (`sphinx-doc__sphinx-7462`, `matplotlib__matplotlib-22719`,
  `matplotlib__matplotlib-24627`, `mwaskom__seaborn-3187`). `seaborn-3187` uses the
  dataset id `mwaskom__seaborn-3187`. No replacements needed — all four are in the
  dataset.
- **New live agent runs:** 4 (all condition B, digest). **0 fresh baselines** (well
  under the 8-run hard cap).
- **Reused prior runs:** 12 baseline replicates (3 per case), all Docker-evaluated
  except `eval-bounded-baseline-sphinx-7462-r3` (no `_eval.meta.json`).
- **Valid / invalid digest runs:** **4 valid / 0 invalid.** Every digest run's
  per-run `_vtrace_instructions.snapshot.md` contains both
  `<VTRACE_CAPSULE_V2_DIGEST_START>` and `<VTRACE_CAPSULE_V2_DIGEST_END>` (2 pivots,
  4 skeletons, 3 untreated-seam warnings each). An offline pre-flight through the real
  `prepareIndexedContext` path confirmed the sentinel before any live run was spent.
- **Headline resolution:** digest **4/4 resolved** vs baseline **1/4 cases** resolved
  by any replicate (only `mpl-22719`). Resolution was **not hurt**. ⚠️ See caveats —
  this is a single digest run per case against noisy baselines; only `sphinx-7462` has
  a digest-attributable resolution mechanism.
- **Headline token/cost/tool-turn:** **mixed, leaning positive.** Efficiency reduced
  or held on **3/4** cases; `repeated_file_reads` never increased and dropped 36–60%
  on the two heavy-navigation cases. The one regression (`sphinx-7462`, +35–68% across
  metrics) bought a resolution the baseline structurally could not reach.
- **Did the digest move behavior in the right direction?** Partially yes: clearer
  localization on the multi-pivot hidden-pivot case (`sphinx-7462`) and large
  tool/turn reduction on `mpl-22719`, with no resolution loss anywhere — but the
  per-tool-call/cache-read reduction is **not uniform**, and on 2/4 cases the digest's
  own pivots pointed at the wrong file and the agent succeeded by ignoring them.

## Run Matrix

| instance_id | baseline_run_label | baseline_source | digest_run_label | digest_valid | evaluated |
|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | eval-bounded-baseline-sphinx-7462-r{1,2,3} | reused | m55x_vtrace_digest_sphinx_7462 | yes | yes (docker) |
| matplotlib__matplotlib-22719 | eval-m4r1-baseline-matplotlib-22719-r{1,2,3} | reused | m55x_vtrace_digest_matplotlib_22719 | yes | yes (docker) |
| matplotlib__matplotlib-24627 | eval-bounded-baseline-mpl-24627-r{1,2,3} | reused | m55x_vtrace_digest_matplotlib_24627 | yes | yes (docker) |
| mwaskom__seaborn-3187 | eval-bounded20-baseline-seaborn-3187-r{1,2,3} | reused | m55x_vtrace_digest_seaborn_3187 | yes | yes (docker) |

Reused baselines are comparable: same instance, same external `vexp-swe-bench` harness
family, same model/scaffold (`claude-opus-4-5-20251101` / `claude-code` — the runner
does not override the vexp default model), full token/cost/tool/patch/eval telemetry,
all from 2026-06-14…06-17.

## Results Table

Baseline columns show the **median across replicates** (range in the Paired Deltas
section). `resolved` for baseline is "any replicate resolved".

| instance | condition | resolved | patch | total_tokens | cache_read | cost | tool_calls | reads | searches | repeated_reads | digest | lead_insp | lead_edit | hidden_insp | hidden_edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | baseline (med) | 0/2 eval | yes | 597,031 | 583,416 | 0.27 | 6 | 2 | 0 | 1 | – | – | – | – | – |
| sphinx-7462 | **digest** | **yes** | yes | 862,521 | 787,639 | 0.45 | 9 | 3 | 0 | 1 | yes | yes | yes | yes | yes |
| mpl-22719 | baseline (med) | 3/3 | yes | 1,075,347 | 1,055,271 | 0.37 | 11 | 1 | 0 | 0 | – | – | – | – | – |
| mpl-22719 | **digest** | **yes** | yes | 492,247 | 430,312 | 0.35 | 4 | 1 | 0 | 0 | yes | no | no | n/a | n/a |
| mpl-24627 | baseline (med) | 0/3 | yes | 4,981,149 | 4,887,750 | 3.03 | 45 | 14 | 16 | 11 | – | – | – | – | – |
| mpl-24627 | **digest** | **yes** | yes | 4,650,246 | 4,530,377 | 3.02 | 42 | 10 | 17 | 7 | yes | no | no | n/a | n/a |
| seaborn-3187 | baseline (med) | 0/3 | yes | 3,383,032 | 3,305,811 | 1.28 | 31 | 12 | 4 | 10 | – | – | – | – | – |
| seaborn-3187 | **digest** | **yes** | yes | 3,398,949 | 3,300,965 | 1.27 | 31 | 6 | 4 | 4 | yes | yes | yes | no | no |

`hidden_*` is `n/a` where the two digest pivots are in the same file (no distinct
non-lead hidden pivot): `mpl-22719` (both pivots `axis.py`), `mpl-24627` (both
`pyplot.py`).

## Paired Deltas

digest − baseline_median (negative = digest reduced). Baseline range across the 3
replicates in brackets to show live-run variance.

### sphinx-doc__sphinx-7462  (resolution_delta: **+1**, digest resolved, baseline 0/2)
| metric | baseline_median [range] | digest | delta | % |
|---|---|---|---|---|
| total_tokens | 597,031 [351,461..689,639] | 862,521 | +265,490 | +44% |
| cache_read_tokens | 583,416 [312,111..665,233] | 787,639 | +204,223 | +35% |
| cost | 0.267 [0.214..0.300] | 0.448 | +0.18 | +68% |
| tool_calls | 6 [4..7] | 9 | +3 | +50% |
| reads | 2 [2..3] | 3 | +1 | +50% |
| searches | 0 [0..0] | 0 | 0 | – |
| turns | 20 [12..22] | 24 | +4 | +20% |
| repeated_reads | 1 [1..2] | 1 | 0 | 0% |

### matplotlib__matplotlib-22719  (resolution_delta: 0, both resolved)
| metric | baseline_median [range] | digest | delta | % |
|---|---|---|---|---|
| total_tokens | 1,075,347 [782,082..1,677,907] | 492,247 | −583,100 | −54% |
| cache_read_tokens | 1,055,271 [764,704..1,603,582] | 430,312 | −624,959 | −59% |
| cost | 0.373 [0.289..0.711] | 0.354 | −0.02 | −5% |
| tool_calls | 11 [8..17] | 4 | −7 | −64% |
| reads | 1 [1..4] | 1 | 0 | 0% |
| searches | 0 [0..2] | 0 | 0 | – |
| turns | 31 [23..45] | 13 | −18 | −58% |
| repeated_reads | 0 [0..1] | 0 | 0 | – |

### matplotlib__matplotlib-24627  (resolution_delta: **+1**, digest resolved, baseline 0/3)
| metric | baseline_median [range] | digest | delta | % |
|---|---|---|---|---|
| total_tokens | 4,981,149 [4,504,460..5,157,813] | 4,650,246 | −330,903 | −7% |
| cache_read_tokens | 4,887,750 [4,369,253..5,080,043] | 4,530,377 | −357,373 | −7% |
| cost | 3.032 [3.030..3.032] | 3.019 | −0.01 | −0% |
| tool_calls | 45 [41..51] | 42 | −3 | −7% |
| reads | 14 [14..19] | 10 | −4 | −29% |
| searches | 16 [16..24] | 17 | +1 | +6% |
| turns | 107 [92..117] | 101 | −6 | −6% |
| repeated_reads | 11 [10..16] | 7 | −4 | −36% |

### mwaskom__seaborn-3187  (resolution_delta: **+1**, digest resolved, baseline 0/3)
| metric | baseline_median [range] | digest | delta | % |
|---|---|---|---|---|
| total_tokens | 3,383,032 [2,415,673..4,795,320] | 3,398,949 | +15,917 | +0% |
| cache_read_tokens | 3,305,811 [2,352,876..4,683,015] | 3,300,965 | −4,846 | −0% |
| cost | 1.278 [0.908..3.047] | 1.272 | −0.01 | −0% |
| tool_calls | 31 [22..43] | 31 | 0 | 0% |
| reads | 12 [10..16] | 6 | −6 | −50% |
| searches | 4 [3..8] | 4 | 0 | 0% |
| turns | 80 [59..103] | 79 | −1 | −1% |
| repeated_reads | 10 [8..14] | 4 | −6 | −60% |

**Cross-case reduction tally (digest vs baseline median):** cache_read reduced 3/4
(↑ sphinx); tool_calls reduced 2/4, flat 1, ↑ sphinx; reads reduced 2/4, flat 1,
↑ sphinx; turns reduced 3/4 (↑ sphinx); repeated_reads reduced 2/4, flat 2, **never
increased**; resolution improved 3/4, flat 1 (both resolve).

## Context-to-Action Notes

Gold files used for scoring/reporting only — never agent input.

### sphinx-doc__sphinx-7462 — gold: `python.py` + `pycode/ast.py` (2 FAIL_TO_PASS)
- **Digest showed:** `python.py::_parse_annotation` (●), `pycode/ast.py::unparse` (●)
  — exactly the two gold files.
- **Agent inspected:** both pivots. **Edited:** both `python.py` and `ast.py`.
- **Ignored:** nothing material.
- **Behavior vs baseline:** the baseline (and all its replicates) edited `python.py`
  **only** — a single-file patch that, per the gold span, can never satisfy both
  FAIL_TO_PASS. The digest surfaced `ast.py::unparse` as a co-pivot; the agent
  inspected and edited it, producing the two-file patch and **resolving**. This is the
  one case where digest → resolution is **mechanistically evidence-supported.** Cost
  was the price: +44–68% tokens/cost/turns for the extra (correct) second edit.

### matplotlib__matplotlib-22719 — gold: `category.py` (1 FAIL_TO_PASS)
- **Digest showed:** `axis.py::convert_units`, `axis.py::update_units` — **not** the
  gold file.
- **Agent inspected:** lead pivot **not** read. **Edited:** `category.py` (gold) —
  found independently, ignoring the digest's pivots.
- **Behavior vs baseline:** both resolve. Digest run was far leaner (tools −64%, tokens
  −54%, turns −58%). The reduction is **not attributable to the (misleading) pivots**;
  most plausibly the shared tool-use/token-discipline plus a lucky-fast trajectory.
  Reported as efficiency-positive, causation-uncertain.

### matplotlib__matplotlib-24627 — gold: `axes/_base.py` (1 FAIL_TO_PASS)
- **Digest showed:** `pyplot.py::plot`, `pyplot.py::subplots` — weak/generic, **not**
  the gold file.
- **Agent inspected:** lead pivot **not** read. **Edited:** `axes/_base.py` (gold) +
  `figure.py` (extra) — same file set the baseline edited.
- **Behavior vs baseline:** both at the $3 cost cap; digest modestly leaner (reads
  −29%, repeated_reads −36%). Digest **resolved**, baseline 0/3 — but the edits match
  the baseline's, so this pass is **within baseline variance, not digest-attributable.**

### mwaskom__seaborn-3187 — gold: `_core/scales.py` + `utils.py` (2 FAIL_TO_PASS)
- **Digest showed:** `_core/scales.py::ContinuousBase._setup` (● gold),
  `relational.py::scatterplot` (● **not** gold).
- **Agent inspected:** lead pivot (`scales.py`) read + edited; hidden pivot
  (`relational.py`) **ignored**. **Edited:** `scales.py` (gold) + `utils.py` (gold) —
  found `utils.py` itself.
- **Behavior vs baseline:** baseline edited `scales.py` + `plot.py` (wrong second
  file) and never resolved; digest edited both gold files and resolved, with far fewer
  redundant reads (reads −50%, repeated_reads −60%) at the same overall budget. The
  correct second file (`utils.py`) was **not** the digest's second pivot
  (`relational.py`), so the localization win is **not directly from digest content.**

## Verdict

**MIXED.**

The digest is fully measurable and valid (sentinel present in all 4 runs), and it did
not hurt resolution — 4/4 digest resolved vs 1/4 baseline cases, with one
evidence-supported digest→resolution mechanism (`sphinx-7462`'s hidden `ast.py`
pivot). Efficiency moved the right way on 3/4 cases (notably `mpl-22719` tools −64%,
and redundant-read cuts of 36–60% on the two heavy cases), and `repeated_file_reads`
never rose. But the primary stated thesis — *reduces follow-up tool use / cache reads*
— is **not uniform**: `sphinx-7462` regressed +35–68% across every efficiency metric
(to gain correctness), and on 2/4 cases the digest's own pivots pointed at the wrong
file and the agent won by ignoring them. With one digest run per case against noisy
baselines, that is not a clean PASS, but well clear of FAIL or INVALID.

## Recommendation

**Proceed to a 20–30 task breadth run** — but treat it as confirming the **resolution
/ hidden-pivot localization** signal (the `sphinx-7462`-style mechanism), with
replicates to absorb the high single-run variance, **not** as confirming a uniform
tool/cache-read reduction (which this set does not support).

Parallel, well-motivated by the data: the digest currently carries only pivots +
skeletons, and every run flagged `impact_not_threaded_into_digest`,
`memory_not_threaded_into_digest`, `rules_not_threaded_into_digest`. On the two cases
where the pivots were misleading (`mpl-22719`, `mpl-24627`) the agent had to recover on
its own — **folding impact/memory/rules into the digest** is the most likely lever to
turn "agent ignored a wrong pivot" into "agent acted on a richer, correct signal," and
should be considered before or alongside the breadth run.

## Method / provenance

- **Conditions.** A = `--protocol baseline` (no vtrace context, reused). B =
  `--protocol vtrace-indexed --context-policy force-inject --capsule-engine v2
  --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest`.
- **Digest validity.** Checked the per-run `_vtrace_instructions.snapshot.md` (run-dir
  root) for both sentinels — not glyphs. The shared `results/_vtrace_instructions.md`
  is overwritten per run and was not used for per-run validation.
- **Truncation note.** The injected context truncated to the 12,000-char budget on
  `sphinx-7462` (14,838→12,027), but the prepended digest block (both sentinels, both
  pivots, skeletons, budget, warnings) survived intact — verified in the snapshot.
- **No retrieval/scoring/ranking change.** This milestone touched no retrieval, Capsule
  ranking, scoring, or candidate generation; observed differences come from the
  injected product output and live agent behavior. Retrieval no-change proof not
  required (no such code touched).
- **Caveats.** 1 digest run/case vs up to 3 baseline replicates; live-run variance is
  large (e.g. seaborn baseline cost 0.91–3.05). Resolution causation is claimed only
  for `sphinx-7462`. No hidden/oracle information influenced any agent run; gold labels
  were read only afterward for scoring.

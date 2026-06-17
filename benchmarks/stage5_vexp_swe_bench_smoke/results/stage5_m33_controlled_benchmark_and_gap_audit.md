# Stage 5 — M33: Controlled Benchmark Design + M32 Context-to-Action Gap Audit

**Report-only milestone.** No live agents, no Docker, no SWE-bench canonical evaluation, no
diagnostic verifier, no `--allow-docker-verify`, no pivot revision, no pivot-inspection
enforcement, no retrieval/ranking/scoring change were run or enabled. Every figure below is
recomputed read-only from M32's captured artifacts (`results/runs/eval-m32-product-*/raw/…`,
`stage5_m32_product_benchmark.{md,csv,json}`) and from prior committed Stage 5 reports. Companion
files: `stage5_m33_controlled_benchmark_instances.json`, `stage5_m33_m32_failure_audit.csv`.

---

## 1. Executive verdict

**VTRACE is promising but not product-ready. M32 supports further development, not packaging.**

- M32 shows VTRACE reduces tool/search/token burden while preserving or slightly improving
  resolution on a small paired set — directionally positive, but at n=3 per cell.
- The deeper audit finds we **cannot yet trust our own measurements**: the reported capsule token
  size under-counts the real injected prompt by **2–3×**, and **38% of the M32 "context-to-action
  gaps" (xarray-3677 ×3) are gold-file-proxy artifacts**, not failures.
- The one **genuine, VTRACE-attributable functional failure mode is partial multi-pivot editing**
  (the agent edits the lead pivot and skips a required co-edit). It is real but small-n.
- Therefore the next step is **not** packaging and **not** (yet) an actionability feature behind a
  default-off flag — it is making the benchmark/accounting trustworthy enough to act on the
  actionability signal cleanly. See §7–8.

---

## 2. M32 result recap

Core deltas (6 instances × 2 conditions × 3 replicates = 36 protocol runs, 36 Docker evals):

| metric (median) | baseline | vtrace | Δ |
| --- | ---: | ---: | ---: |
| tool calls | 9.5 | 8.0 | −16% |
| grep/search | 1.5 | 1.0 | −33% |
| file reads | 3.0 | 2.0 | −33% |
| input tokens | 202 | 174 | −14% |
| resolved | 9/18 (50%) | 10/18 (56%) | +1 |

M32 VTRACE classification tally: `actionability_success` 7, `context_to_action_gap` 8,
`safe_no_context` 3, `retrieval_success`/`overhead_without_benefit`/`unknown` 0.

Caveats (carried forward verbatim from the milestone brief, all confirmed by the audit):

- only 6 instances × 3 replicates; single-instance swings dominated by agent stochasticity;
- benefits concentrated in search-heavy instances (seaborn-3187: tools 20→7, tokens 405→167);
- already-localized tasks are flat (django-11728, django-10880);
- sphinx-7462 still **worsens** tool usage (6→8) and remains a context-to-action hard case;
- structural gold-file editing does not guarantee functional correctness (django-13195: edits all
  3 gold files, resolves 0/3);
- no capsule-attributable token accounting yet (§6).

---

## 3. Proposed 10-instance controlled benchmark

Six M32 instances retained as the paired anchor; four added to cover failure shapes M32 missed.
Full per-instance documentation (why selected, expected difficulty, gold files, historical
surfacing/resolution) is in `stage5_m33_controlled_benchmark_instances.json`.

| # | instance | source | shape | gold files | F2P | hist. baseline | hist. vtrace | surfaced gold? |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| 1 | `sphinx-doc__sphinx-7462` | M32 | multi-pivot | 2 | 2 | 0/3 | 0/3 | yes (edits 1 of 2) |
| 2 | `django__django-13195` | M32 | multi-file co-edit | 3 | 5 | 0/3 | 0/3 | yes (edits all 3) |
| 3 | `mwaskom__seaborn-3187` | M32 | multi-file / search-heavy | 2 | 2 | 0/3 | 1/3 | yes |
| 4 | `django__django-11728` | M32 | localized single-pivot | 1 | 2 | 3/3 | 3/3 | yes |
| 5 | `django__django-10880` | M32 | localized / no-context | 1 | 1 | 3/3 | 3/3 | no (policy skip) |
| 6 | `pydata__xarray-3677` | M32 | no-context / oracle-hard | 1 | 1 | 3/3 | 3/3 | yes (edits non-gold) |
| 7 | `astropy__astropy-14369` | **new** | **generated-artifact / parser** | 2 | 3 | unknown | useful-inject (M8) | cds.py yes; parsetab hard |
| 8 | `pylint-dev__pylint-8898` | **new** | multi-file co-edit (regression) | 3 | 1 | 2/3 | 0/3 | partial (wrong sibling) |
| 9 | `sympy__sympy-13372` | **new** | no-context / traceback-localized | 1 | 1 | 3/3 | 3/3 | yes |
| 10 | `sympy__sympy-12419` | **new** | search-heavy / synthesis-bound | 1 | 1 | 3/3 | 2/3 | no (harmless self-localizes) |

**Why the 4 additions (each fills a shape absent or thin in M32):**

- **astropy-14369 — generated-artifact/parser/serialization (entirely missing from M32).** Gold
  edits a hand source (`cds.py`) **and** a PLY-generated parser table (`cds_parsetab.py`). This is
  the canonical "context surfaced but the required co-edit is a generated artifact" shape that drove
  the whole `stage5_generated_parser_astropy_*` repair line. Directly tests whether VTRACE can
  surface a generated co-edit obligation.
- **pylint-8898 — multi-file co-edit + confirmed genuine regression (2/3→0/3).** 3-file gold;
  historically the line-anchor resolved to the **wrong sibling** (`_regexp_paths_csv_transfomer`) and
  `utils/utils.py`+`utils/__init__.py` were never surfaced. Exercises retrieval-wrong-target,
  multi-file follow-through, and synthesis lottery simultaneously. (Note: the inline single-file
  route is viable — baseline resolves 2/3 — so it is `patch_synthesis_bound`, not a pure co-edit gap.)
- **sympy-13372 — traceback-localized / no-context policy probe.** `UnboundLocalError in evalf`
  self-localizes from the traceback; the (default-OFF) M7 conservative-localization downgrade fires
  exactly here. Under clean Docker, injection preserves 3/3 at −23% tokens — so this case tests that
  the no-context policy does **not** wrongly suppress a useful injection.
- **sympy-12419 — search-heavy hard-localization + synthesis-bound regression (3/3→2/3).** Math
  semantics ("sum of identity-matrix elements") are hard to grep. Gold symbol is **not** surfaced
  (anchor resolves to `adjoint.py`/`blockmatrix.py` siblings) yet the issue text self-localizes; the
  one failing run hand-wrote Python `==` instead of gold's `Eq(...) is S.true`. Pure synthesis miss.

Combined shape coverage: localized (4) · multi-file co-edit (4) · multi-pivot (3) ·
generated/parser (1) · no-context/traceback (3) · search-heavy (2). **Do not run yet** — this is a
design; execution needs the §8 accounting/oracle instrumentation first.

---

## 4. M32 failure / gap audit

Per-run rows in `stage5_m33_m32_failure_audit.csv`. Grouped by instance:

- **sphinx-7462 (×3) — `partial_edit_gap` [VTRACE-attributable, genuine failure].** Both gold files
  (`sphinx/domains/python.py`, `sphinx/pycode/ast.py`) are surfaced as pivots and inspected, but the
  final patch edits **only `python.py`** in all 3 replicates. Tool usage *worsens* (6→8). This is the
  cleanest evidence of the multi-pivot follow-through gap. Evidence: `_tool_calls_with_outputs.json`
  shows Edit only on `python.py`; `modelPatch` touches 1 file vs `goldFileCount=2`.
- **seaborn-3187 (r1, r3) — `partial_edit_gap` [VTRACE-attributable].** Edits 1 of 2 gold
  (`scales.py`/`utils.py`), misses the co-edit, unresolved. r2 edits both → resolved
  (`actionability_success`). Same shape as sphinx-7462; n shows it is stochastic, not deterministic.
- **django-13195 (×3) — `patch_synthesis_gap` [NOT VTRACE-attributable].** Edits **all 3** gold
  files (`goldEditedComplete=true`) yet resolves 0/3. The patch sha (`e98d15c2a8c9`) is **identical
  across all 3 vtrace runs and one baseline run** → a deterministic content miss against the 5
  FAIL_TO_PASS tests, not an actionability or retrieval problem. Baseline is also 0/3. VTRACE did its
  job (surfaced + drove all 3 edits); the model's patch content is wrong.
- **xarray-3677 (×3) — `benchmark_oracle_mismatch` [NOT a failure].** Gold `dataset.py` is surfaced
  and inspected but the agent fixes the bug in `xarray/core/merge.py` (confirmed: Edit calls + patch
  both touch only `merge.py`) and **resolves 3/3**. The "gap" is an artifact of scoring against the
  gold file list; the fix is functionally correct via a valid alternative site.
- **django-10880 (×3) — `no_context_correct` [not a failure].** Policy declined to inject
  (`safe_no_context`); resolved 3/3. The no-context policy was correct here. (Accounting flag: vtrace
  r1 first-turn `cache_creation_input_tokens=557`, an order of magnitude below its siblings →
  cross-run prompt-cache reuse contaminated the counter; see §6.)
- **django-11728 (×3) — `actionability_success`, resolved 3/3.** Positive control; no gap.

---

## 5. Root-cause distribution

Across the 18 M32 VTRACE runs, classifying every failed/gap run (the 4 successes and 3
safe-no-context runs are listed for completeness):

| root cause | count | VTRACE-attributable? | genuine functional failure? |
| --- | ---: | --- | --- |
| `partial_edit_gap` (multi-pivot follow-through) | **5** | **yes** | **yes** |
| `patch_synthesis_gap` (right files, wrong code) | 3 | no (baseline also fails) | yes |
| `benchmark_oracle_mismatch` (resolves via non-gold) | 3 | no | **no** (artifact) |
| `retrieval_miss` | 0 | — | — |
| `ranking_miss` | 0 | — | — |
| `capsule_too_verbose` / `overhead_gap` | 0 | — | — |
| `no_context_policy_gap` | 0 | — | — |
| `actionability_success` (no gap) | 4 | — | — |
| `no_context_correct` (safe skip) | 3 | — | — |

**Read-out:** of the 8 M32 `context_to_action_gap` runs, **5 are genuine VTRACE-attributable
failures (partial_edit_gap)** and **3 are oracle artifacts (xarray)**. The 3 `actionability_success`
django-13195 runs that resolve 0/3 are a **synthesis** failure, shared with baseline and not
fixable by VTRACE. **So the failures are actionability-dominated among the VTRACE-attributable
ones, but the dominant *category by count* in the raw gap tally is inflated by a measurement
artifact** — which is itself the headline finding (§7).

Cross-check against history (M6→M8 clean-Docker re-baseline): the only persistent genuine
regressions repo-wide are `sympy-12419`, `astropy-14539`, `pylint-8898` — all **synthesis-bound or
multi-file co-edit**, none a retrieval miss. This corroborates: retrieval is not the bottleneck;
actionability follow-through and synthesis are.

---

## 6. Token / accounting availability audit

What can be measured today from captured artifacts, and how reliably. Sources: per-run
`_run.meta.json`, `_product_v2_probe.*.json`, `_capsule_v2_manifest.json`,
`_tool_calls_with_outputs.json`, per-turn `usage` in `_agent_stream.first_pass.jsonl`, and the CSV.

| quantity | status | basis / problem |
| --- | --- | --- |
| capsule prompt tokens | **incorrect/ambiguous** | Three inconsistent numbers exist: `vtraceCapsuleEstimatedTokens` (881–2560), `vtraceContextChars`/4 (≈2.3k), probe `estimatedOutputTokens` (8007). The **measured** first-turn `cache_creation` delta (vtrace−baseline) is **2845–4359**, i.e. **2–3× the reported estimate** — the injected prompt also carries the instructions wrapper + neighborhood excerpts, which the "capsule" estimate omits. All are chars/4 heuristics, none is a tokenizer count. |
| capsule manifest token size | **available** | `_capsule_v2_manifest.json` persisted; per-pivot `estimatedTokens` present. Measurable (still chars/4, not tokenizer). |
| tool-output tokens | **partially available** | `_tool_calls_with_outputs.json` carries the `output` text (chars/4 computable) but it is **not** a recorded numeric field, and a `truncated` flag means some outputs are cut → undercount. |
| cache-read tokens | **available** | Per-turn `cache_read_input_tokens` in stream; aggregate `cacheReadTokens` in CSV. Reliable. |
| agent text output tokens | **partially available / ambiguous** | `outputTokens` (CSV) and per-turn `output_tokens` (stream) exist but **conflate** assistant prose with tool-call JSON; prose-only is not separated. |
| Read/Grep/Bash output tokens | **partially available** | Derivable per-category from `_tool_calls_with_outputs.json` (chars/4), subject to truncation; not currently computed into any field. |
| tokens before first patch | **partially available** | Per-turn `usage` (stream) + index of first Edit/Write (`_tool_calls.json`) → computable by **correlating two artifacts**; not aggregated anywhere today. |
| tokens after first patch | **partially available** | Complement of the above; same correlation requirement. |

**Two structural problems beneath the table:**

1. **Prompt caching hides marginal cost.** With caching, per-turn `input_tokens` is tiny (≈9); the
   real cost is first-turn `cache_creation` + per-turn `cache_read`. The capsule's *marginal* cost is
   only isolable via the **paired baseline counterfactual** (cross-run first-turn `cache_creation`
   delta), not from any single run. And that counterfactual is itself noisy: django-10880 vtrace r1
   showed `cache_creation=557` (vs ~8.5k siblings) from cross-run cache reuse.
2. **The gold-file oracle confounds the gap metric.** xarray-3677 inflates the gap count by 3 with a
   functionally-correct fix. Token "savings" on such runs (xarray −17% to −48%) are real but the
   "gap" label is wrong, so any token-ROI-per-gap analysis is currently miscounted.

**Minimum instrumentation needed next** (all computable offline from existing artifacts — no live
runs required to build/validate):

1. **`vtraceInjectedPromptTokens`** — actual tokenizer count of the injected instructions+capsule
   block (the thing the agent actually pays for), replacing the chars/4 capsule estimate.
2. **`firstTurnCacheCreationTokens`** recorded for **both** arms + the emitted paired delta as the
   attributable injection cost; flag cache-reuse anomalies (`cache_creation` ≪ paired sibling).
3. **`firstPatchToolIndex`** + cumulative stream-usage split into **before/after first Edit/Write**.
4. Per-tool **output-token estimate + truncated-byte count** so Read/Grep/Bash output tokens are
   computable without re-parsing and without silent truncation error.
5. A **functional actionability oracle**: a `resolvedWithoutGold` flag so xarray-style cases are
   counted as oracle-mismatch, not context-to-action gaps.

---

## 7. Recommended next core improvement

**Choice: E — benchmark harness / accounting improvement.** (Runner-up: C — actionability /
pivot-inspection improvement.)

**Why E, on the evidence:**

- The single most important M32 finding is that **our instruments are not trustworthy enough to act
  on the other findings.** The capsule token estimate is off by 2–3× (§6), and 38% of the
  context-to-action gaps are oracle artifacts (§4–5). Until both are fixed we cannot (a) quantify
  VTRACE's true token ROI, nor (b) cleanly separate genuine actionability failures from measurement
  noise.
- E is **fully in-scope under this milestone's constraints.** The real actionability levers
  (pivot-revision, pivot-inspection enforcement) are explicitly forbidden by default, so a "C"
  milestone could only ship a subtle, hard-to-evaluate capsule-shape tweak — and we'd evaluate it
  with the same broken instruments. Fixing the instruments first is the higher-leverage move.
- E is **low-risk and offline-verifiable.** Every proposed field (§6) is computable from artifacts we
  already capture; no live agents, no Docker, no retrieval/ranking change. It cannot regress quality.
- The actionability gap (C) is **real and is the right *next-after-E* target** — it is the dominant
  VTRACE-attributable functional failure (`partial_edit_gap`, 5 runs). But acting on it now, blind to
  trustworthy per-capsule token accounting and with a confounded gap oracle, risks optimizing the
  wrong metric. E unblocks a clean C.

**What E explicitly is NOT:** not retrieval/ranking/scoring tuning, not productization, not enabling
any default-off feature.

---

## 8. Exact next milestone proposal (not implemented)

> **M34: Capsule-attributable token/tool accounting + functional actionability oracle**
>
> **Scope (report + offline instrumentation only; no live agents, no Docker, no SWE-bench eval):**
> 1. Add the §6 accounting fields to the Stage 5 capture/report path: `vtraceInjectedPromptTokens`
>    (tokenizer-based, not chars/4); paired `firstTurnCacheCreationTokens` + emitted injection-cost
>    delta with a cache-reuse anomaly flag; `firstPatchToolIndex` + before/after cumulative
>    stream-usage; per-tool output-token + truncated-byte fields.
> 2. Add a **functional actionability oracle** (`resolvedWithoutGold`) so resolves-via-non-gold
>    (xarray-3677 shape) are scored as `benchmark_oracle_mismatch`, not `context_to_action_gap`.
> 3. **Backfill** all M32 runs from captured artifacts and re-issue the M32 deltas with
>    capsule-attributable token accounting and a corrected gap tally (validate against this audit:
>    expect 5 genuine `partial_edit_gap`, 3 oracle artifacts reclassified).
> 4. Verify per CLAUDE.md: `bun run typecheck`, `bun run typecheck:benchmarks`, `bun test`,
>    `git diff --check`; run the deterministic retrieval no-change proof **only if** source changes.
>
> **Deferred to M35 (gated on M34's clean accounting):** *strengthen multi-pivot actionability
> without revision* — make co-edit obligations more salient in the capsule (rank required co-edit
> pivots adjacently / surface them as an explicit obligation list), targeting the `partial_edit_gap`
> on sphinx-7462 and seaborn-3187. Not before M34 produces trustworthy per-capsule numbers.

---

## Final note on method

This report ran no agents, no Docker, no canonical evaluation, and changed no source, scoring,
candidate generation, ranking, or retrieval. All numbers were recomputed read-only from artifacts
captured by the M32 run (executed previously by the Stage 5 runner) and from prior committed
reports. The deterministic retrieval no-change proof was **not** run because no source code changed.

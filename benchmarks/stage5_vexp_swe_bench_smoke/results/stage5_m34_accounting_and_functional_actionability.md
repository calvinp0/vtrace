# Stage 5 — M34: Capsule-Attributable Accounting + Functional Actionability

Read-only recomputation over the captured M32 vtrace runs. **This script executes nothing** — no live agents, no Docker, no SWE-bench evaluation, no command, no artifact mutation. It only reads captured artifacts (`_vtrace_instructions.snapshot.md`, `_tool_calls_with_outputs.json`, `_run.meta.json`, `swebench-*.jsonl`) and writes the three M34 report files. Token figures use the same `chars/4` estimator that sizes Capsule v2 — an approximation, never a tokenizer count.

## 1. Executive verdict

- **Was the token undercount real? Yes.** Across 15 injected vtrace runs the legacy `capsuleEstimatedTokens` (median 1217) under-counts the full rendered injected block `injectedContextTokens` (median 2693) by a median **2.12×** (range 1.33–3.06×). This reproduces M33's 2–3× estimate from first principles (the rendered snapshot), independent of the agent-stream cache_creation measurement.
- **What caused it?** `capsuleEstimatedTokens` measures only the capsule *body* (pivot/support source excerpts). The text actually injected on turn 1 is the whole `_vtrace_instructions.md` block: capsule body **plus** the inspect-first scaffold, the pivot-inspection contract, the actionability hints, the multi-edit (co-edit) hint, and the Stage-5 benchmark wrapper. Those uncounted sections are the bulk of the gap (see §3).
- **What fields now measure it?** `injectedContextTokens` / `injectedContextChars` (the full block) and a per-component split (`capsuleBodyTokens`, `instructionScaffoldTokens`, `pivotContractTokens`, `actionabilityHintsTokens`, `coeditHintTokens`, `benchmarkWrapperTokens`) whose char partition is exact; plus `accountingMethod` and an undercount ratio. Legacy `capsuleEstimatedTokens` is preserved.
- **How do functional labels change M32?** They split the structural counts cleanly: 6 runs are gold-proxy mismatches (resolved≠gold-edited). xarray-3677 ×3 move to `functional_success_gold_proxy_mismatch` (NOT failures); django-13195 ×3 to `retrieval_success_synthesis_failure` (right files, wrong code); the genuine VTRACE-attributable failures (`retrieval_success_action_failure`) are sphinx-7462 ×3 + seaborn-3187 ×2. See §5.

## 2. Accounting model

| | legacy (`capsuleEstimatedTokens`) | new (`injectedContextTokens`) |
| --- | --- | --- |
| what it counts | capsule pivot/support source excerpts only | the full rendered injected instructions block |
| source | `vtraceCapsuleEstimatedTokens` (build-time) | `chars/4` of the captured `_vtrace_instructions.snapshot.md` |
| method | build-time component estimate | `exact_rendered_block` (the text the agent saw) |
| estimator | `chars/4` | `chars/4` (same unit) |
| relationship | a *subset* of the injected block | the whole block; legacy is one component of it |

Both are `chars/4` approximations (vtrace ships no tokenizer, by design). The new field is labelled `exact_rendered_block` because it measures the *exact rendered text* that was injected, not because it is a tokenizer count. `productAccountingTokens` and `manifestReferenceTokens` are recorded as **0**: that data lives in side-car artifacts (`_product_v2_probe`, `_capsule_v2_manifest`) and is not injected into the prompt.

## 3. Token undercount audit

Representative replicate (r1) per instance; full per-run rows in the CSV/JSON.

| instance (r1) | capsuleEstimatedTokens | injectedContextTokens | difference | ratio | main uncounted components |
| --- | ---: | ---: | ---: | ---: | --- |
| sphinx-7462 | 1578 | 3136 | 1558 | 1.99× | actionabilityHints 1839, benchmarkWrapper 336, scaffold 294 |
| django-13195 | 881 | 2693 | 1812 | 3.06× | actionabilityHints 1218, pivotContract 430, benchmarkWrapper 334 |
| seaborn-3187 | 1079 | 2602 | 1523 | 2.41× | actionabilityHints 1338, benchmarkWrapper 335, scaffold 286 |
| django-11728 | 1217 | 2577 | 1360 | 2.12× | pivotContract 1503, benchmarkWrapper 334, scaffold 286 |
| django-10880 | — (no inject) | — | — | — | policy declined to inject |
| xarray-3677 | 2560 | 3407 | 847 | 1.33× | pivotContract 2654, benchmarkWrapper 334, scaffold 290 |

_Component attribution is best-effort: a few capsule templates render pivot source under the contract/hints heading rather than the neighborhood heading, so `capsuleBodyTokens` can land low while `pivotContractTokens` absorbs it. The trustworthy, template-independent figure is `injectedContextTokens` (the whole block); the char partition is exact regardless._

## 4. Post-capsule wandering audit

The capsule is injected in the turn-1 prompt, so every first-pass tool call is "after context"; `beforeFirstPatch*` isolates the localization phase before the first edit. Tool-output tokens are approximate (`chars/4`, captured outputs may be truncated).

| instance (r1) | tools after ctx | reads | grep/search | bash | uniq read | uniq touched | before-patch calls | first-patch idx | tool-out tok |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sphinx-7462 | 10 | 4 | 1 | 3 | 2 | 2 | 2 | 2 | 3031 |
| django-13195 | 11 | 3 | 3 | 0 | 3 | 3 | 1 | 1 | 1225 |
| seaborn-3187 | 5 | 1 | 3 | 0 | 1 | 1 | 3 | 3 | 1660 |
| django-11728 | 18 | 4 | 3 | 8 | 2 | 2 | 1 | 1 | 3997 |
| django-10880 | 10 | 1 | 2 | 6 | 1 | 1 | 3 | 3 | 3162 |
| xarray-3677 | 6 | 1 | 1 | 2 | 1 | 1 | 1 | 1 | 1627 |

_Tool-output token sums include 1 truncated captured output(s) across all rows; where a captured output was truncated the figure is a lower bound, otherwise it is a full `chars/4` estimate._

## 5. Functional actionability relabeling

Structural label kept beside the new functional label; `resolved` is the functional truth.

| instance | runs | structural label(s) | functional label(s) | resolved |
| --- | ---: | --- | --- | ---: |
| sphinx-7462 | 3 | context_to_action_gap ×3 | retrieval_success_action_failure ×3 | 0/3 |
| django-13195 | 3 | actionability_success ×3 | retrieval_success_synthesis_failure ×3 | 0/3 |
| seaborn-3187 | 3 | context_to_action_gap ×2; actionability_success | retrieval_success_action_failure ×2; functional_actionability_success | 1/3 |
| django-11728 | 3 | actionability_success ×3 | functional_actionability_success ×3 | 3/3 |
| django-10880 | 3 | safe_no_context ×3 | safe_no_context_success ×3 | 3/3 |
| xarray-3677 | 3 | context_to_action_gap ×3 | functional_success_gold_proxy_mismatch ×3 | 3/3 |

**Functional label tally (18 vtrace runs):**

| functional label | count |
| --- | ---: |
| `retrieval_success_action_failure` | 5 |
| `functional_actionability_success` | 4 |
| `retrieval_success_synthesis_failure` | 3 |
| `safe_no_context_success` | 3 |
| `functional_success_gold_proxy_mismatch` | 3 |

- **sphinx-7462 ×3** — structural `context_to_action_gap` → functional `retrieval_success_action_failure`. Gold surfaced, lead pivot edited, co-edit skipped, unresolved. **Genuine VTRACE-attributable failure.**
- **seaborn-3187** — r1/r3 `retrieval_success_action_failure` (partial edit, unresolved); r2 `functional_actionability_success` (both gold edited, resolved). The actionability gap is stochastic.
- **django-13195 ×3** — structural `actionability_success` → functional `retrieval_success_synthesis_failure`. Edits all 3 gold files but the patch content fails; baseline fails identically. **Not** VTRACE-attributable (model synthesis).
- **xarray-3677 ×3** — structural `context_to_action_gap` → functional `functional_success_gold_proxy_mismatch`. Resolves 3/3 via a non-gold file. **Not a failure** — the structural proxy was wrong, and the functional label now says so.
- **django-10880 ×3 (safe no-context)** — `safe_no_context_success`: policy declined to inject and the run resolved. The functional label confirms the skip was correct.

## 6. Impact on the M33 conclusion

M33 recommended **E (accounting first)**, deferring **C (multi-pivot actionability)** to a gated M35. M34 delivers that accounting: the undercount is now measured and explained, and functional labels separate genuine failures from measurement artifacts. The recommendation does not reverse — it **advances**: the instruments are now trustworthy enough to act on the actionability signal.

Crucially, the functional relabel **rules out retrieval as the bottleneck**: in every genuine failure the gold was surfaced (`retrieval_success_*`). The remaining VTRACE-attributable failures are all `retrieval_success_action_failure` (partial multi-pivot edits), not retrieval or ranking misses. django-13195's failures are synthesis, and xarray's "gaps" were never failures.

## 7. Next milestone recommendation

**A — accounting is now trustworthy → M35: strengthen multi-pivot actionability without revision.** The undercount is measured and component-attributed; functional labels cleanly isolate the genuine failure mode (`retrieval_success_action_failure` on sphinx-7462 ×3 + seaborn-3187 ×2 — the agent edits the lead pivot and skips a required co-edit). With retrieval ruled out and synthesis/oracle artifacts factored away, multi-pivot co-edit follow-through is the highest-leverage next target.

> **M35: strengthen multi-pivot actionability without revision.** Make required co-edit obligations more salient in the capsule (e.g. rank co-edit pivots adjacently / surface an explicit co-edit obligation list) and re-measure on the M33 10-instance design. Scope guard: no pivot-revision and no pivot-inspection enforcement enabled by default; report-only validation first; prove retrieval/ranking unchanged with the deterministic eval.

---

_Provenance: every figure recomputed read-only from captured M32 artifacts. This script ran no agents, no Docker, no evaluation, and mutated no run artifact._

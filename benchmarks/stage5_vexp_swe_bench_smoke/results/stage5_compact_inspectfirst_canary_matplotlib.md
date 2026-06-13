# Stage 5 — Compact Capsule v2 inspect-first canary: matplotlib-22719

Generated: 2026-06-13. A single targeted **live** canary, not a 4-case aggregate
and not a VEXP comparison. It measures whether the new compact Capsule v2 injected
context (inspect-first guidance + compacted pivot-neighborhood) on the **normal
single-shot path** preserves resolution while reducing tokens and turns, against
the one instance that had a matched verbose-neighborhood prior.

**Protocol note (important):** this canary used **no hard gate and no two-phase
preflight** — `--pivot-check-gate hard` was *not* passed. It is the ordinary
single-shot `run-protocol --protocol vtrace-indexed` solve (same tools, same
patch/evaluate flow), with Capsule v2 selected explicitly so the comparison is
clean. The hard-gate / two-phase path remains diagnostic-only and default-off; it
is not exercised or benchmarked here.

## Conditions

| | Prior (baseline) | Product (this canary) |
| --- | --- | --- |
| Run label | `eval-product-v2-neighborhood-matplotlib-22719` | `eval-product-v2-compact-inspectfirst-matplotlib-22719` |
| Injected v2 context | human capsule + **verbose** pivot-neighborhood (excerpt bodies inlined) | **inspect-first** block + human capsule + **compact** pivot-neighborhood (reference lines) |
| Engine / intent / budget | Capsule v2 / auto / 8,000 | Capsule v2 / auto / 8,000 |
| Solve protocol | normal single-shot, no hard gate | normal single-shot, no hard gate |
| Resolution (Docker) | resolved | resolved |

Both arms produced a model patch and were Docker-evaluated (`dockerUsed=true`,
`evaluationError=null`).

## Verdict: STRICT PASS (n=1, live)

Per-case strict AND = resolution preserved && total tokens down && cache-read down
&& Read+Grep+Bash ≤ prior. All four hold:

| Signal | Prior | Product | Delta | Pass |
| --- | ---: | ---: | ---: | :---: |
| Resolved (Docker) | yes | yes | preserved | ✅ |
| Total tokens | 872,800 | 646,055 | **−226,745** | ✅ |
| Cache-read tokens | — | — | **−167,547** | ✅ |
| Read calls | 1 | 1 | 0 | ✅ |
| Grep/search calls | 0 | 0 | 0 | ✅ |
| Bash calls | 7 | 4 | **−3** | ✅ |
| Read+Grep+Bash | 8 | 5 | −3 | ✅ |
| Cost (USD) | ~0.633 | 0.370 | −0.263 | — |

Prior-arm totals are derived from the measured deltas (`total = product − delta`).

### Resolved a historically-lost case

matplotlib-22719 is the canonical worst-overhead case from the Stage 5 token-path
audit, where VTRACE historically **lost** a task the baseline resolved
(`eval-controlled-vtrace-matplotlib-22719`: 2,718,398 tokens, 30 tool calls, a
16-deep Bash loop, **unresolved**). The compact inspect-first run **resolves** it
at 646,055 tokens / $0.37 — though that long arc spans many changes, not this
rendering alone; the controlled claim here is only the prior→product delta above.

## Inspect-first pointed at the gold file — and the agent edited it

The compact inspect-first block led the injected context (snapshot line 13,
`confidence: high`) and named the gold file as the likely-first target:

```
## VTRACE inspect-first (guidance, not enforcement; confidence: high)
Likely first file:
- lib/matplotlib/category.py::convert
  Why: task diagnostic literal appears in this symbol's body — explicit edit site
Related context:
- lib/matplotlib/axis.py::convert_units
  Why: where the failure surfaces / re-raises — likely reachability context, not the edit site (…)
- lib/matplotlib/_api/deprecation.py::warn_deprecated
```

- **`category.py::convert` is the gold edit site** (the deprecation-warning origin),
  surfaced from *support* — not from the pivots, which are both in the traceback
  file `axis.py`. The re-raise/propagation heuristic correctly demoted
  `axis.py::convert_units` and labeled it as the surface, not the edit site. No
  matplotlib- or path-specific rule was used.
- **The agent edited exactly `lib/matplotlib/category.py`** (the resolving patch),
  matching the likely-first target. Pivot accounting: inspected=1, edited=1,
  hidden-ignored=2.

## The compact rendering was actually delivered to the agent

Verified against the immutable injected-context snapshot
(`runs/eval-product-v2-compact-inspectfirst-matplotlib-22719/_vtrace_instructions.snapshot.md`):

- inspect-first block present at the **top** of the vtrace context (line 13), ahead
  of the `intent:`/budget/pivots render.
- pivot-neighborhood present and **compact** (line 128: "Pivot neighborhood (nearby
  symbols, compact)") — `pivotNeighborhoodPresent=yes`, `excerpts=8`,
  `pivotsEnriched=2`, with excerpt **bodies not inlined** (they remain in the
  structured data for reporting).

So the change under test genuinely reached the agent; the result is not a no-op
render that fell back to the old shape. Notably the run's context-to-action probe
shows the agent did **not** verbally cite the neighborhood, yet still localized to
`category.py` and ran fewer Bash calls — consistent with the hypothesis that the
*scannable* inspect-first pointer, not a verbose neighborhood dump or any
enforcement, is what carries the signal.

## Caveat — n=1, live, stochastic

This is a single live instance. Live patch synthesis is stochastic; one PASS — even
a strong one on the worst historical case — is **not** sufficient to make Capsule
v2 the default injected shape, and it says nothing about the hard gate (which was
not used). It is evidence the compact rendering is *not worse* and is plausibly
better on this case; it is not a population result.

---

## Offline first-call evidence (separate from live performance)

Deterministic offline replay of all four shaped gate instances through the same
Capsule v2 build (no agents, no Docker — `stage5_inspect_first_offline_validation.md`).
This measures only the **first-call injected text size and target plausibility**,
not live solve behavior, and is kept strictly separate from the live numbers above.

| Instance | inspect-first | confidence | likely first | first-call tok before→after | Δ |
| --- | --- | --- | --- | ---: | ---: |
| matplotlib-22719 | yes | high | `category.py::convert` (axis.py → surface) | 1867→1400 | **−467** |
| astropy-14369 | yes | medium | `cds.py::to_string` | 3844→3560 | **−284** |
| django-10880 | yes | medium | `query.py::count` | 1700→1294 | **−406** |
| django-11095 | yes | medium | `options.py::get_inline_formsets` | 1949→1610 | **−339** |

Across all four, the compact rendering **reduced first-call injected tokens** (the
inspect-first block more than pays for itself via neighborhood compaction), the
verbose neighborhood was reduced, and the full structured `pivotNeighborhood` was
preserved for JSON/reporting. This is first-response evidence only; it does not
claim any live turn or total-token effect for the three non-matplotlib cases.

## Recommended next step

Run the remaining three (astropy-14369, django-10880, django-11095) only as a
**separately budgeted matched live validation** — not folded into this canary.
Because the verbose renderer has already been replaced on the mainline, that future
validation must choose its baseline deliberately, and **must not** silently compare
the new compact runs against pre-neighborhood product-v2 as a headline (that mixes
baseline types). Two clean options:

1. **Product-level "current best vs old product-v2"** — compare compact
   inspect-first against the existing `eval-product-v2-turn-reduction-<inst>`
   (pre-neighborhood) runs, explicitly labeled as a *product-progress* comparison,
   not a verbose-vs-compact isolation.
2. **Strict isolation** — temporarily restore the old verbose renderer, run matched
   verbose+compact priors per instance, then restore compact. Cleanest
   apples-to-apples, at ~2× live+Docker cost.

Only after a clean 4-case live result should making Capsule v2 the default injected
shape be considered. Until then v2 stays opt-in (this canary used explicit
`--capsule-engine v2`), keeping "new rendering effect" separate from "engine default
migration."

## Non-claims

- One live instance; no population or pass@k claim; live results are stochastic.
- No hard gate / two-phase preflight was used; this says nothing about that path,
  which stays diagnostic-only and default-off.
- Prior-arm absolute totals are derived from measured deltas, not re-extracted.
- The offline 4-case figures are `chars/4` first-call estimates, not tokenizer
  truth and not live-run totals; they are kept separate from the live measurement.
- No retrieval, ranking, scoring, candidate generation, or solve protocol changed;
  Capsule v2 remains opt-in.

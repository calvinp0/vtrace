# Stage 5 — Compact inspect-first product-v2: current-best validation

Generated: 2026-06-13. A **product-level improvement validation**, not an isolated
renderer ablation. It answers the product question — *does the current compact
inspect-first product-v2 path reduce turns/tokens without hurting resolution
versus the older product-v2 path?* — and deliberately does **not** try to isolate
how much of any win came from compaction vs inspect-first ordering vs neighborhood
reshaping. Users care whether the current product path is better, not which
sub-change carried it.

## What is compared

- **Baseline = old product-v2** (`eval-product-v2-turn-reduction-<inst>`): Capsule
  v2 product path **before** pivot-neighborhood and compact inspect-first.
- **Current = compact inspect-first product-v2**
  (`eval-product-v2-compact-inspectfirst-<inst>`): today's mainline v2 injected
  shape (inspect-first guidance + compacted pivot-neighborhood).

Both arms: normal single-shot `run-protocol --protocol vtrace-indexed`,
`--capsule-engine v2 --capsule-intent auto`, **no hard gate / no two-phase
preflight**, identical model/harness, real Docker evaluation. This is a labeled
*current-best vs old product-v2* comparison — **not** a strict verbose→compact
ablation (that isolation exists only for matplotlib, see below).

matplotlib-22719 is kept **separate** as the only matched verbose→compact live
comparison (`stage5_compact_inspectfirst_canary_matplotlib.md`); it is not folded
into this product-level table.

## Result

| Instance | context in both arms? | resolved (old→current) | total tokens | cache-read tokens | Read+Grep+Bash | verdict |
| --- | --- | --- | ---: | ---: | ---: | --- |
| astropy-14369 | **yes** (both inject) | false→false (preserved) | **−1,366,099** | **−1,314,092** | 17→9 (**−8**) | **improved** |
| django-10880 | no (both `no_context`) | true→true (preserved) | ~flat | +28,923 | n/a | gate-skipped (not a context test) |
| django-11095 | no (both `no_context`) | true→true (preserved) | ~flat | −25,210 | n/a | gate-skipped (not a context test) |

No resolution regressions anywhere. The two cases that actually inject context
(astropy here, matplotlib in the matched report) both show large token and turn
reductions with resolution preserved.

### astropy-14369 — injected in both arms, clear improvement

The only instance in this set where the cost-aware policy injects context in both
the old and current product paths, so it is the real product comparison.

- **Total tokens: −1,366,099** (≈2.44M → 1.07M).
- **Cache-read tokens: −1,314,092** (2,308,980 → 994,888, −57%) — the per-turn
  cached-context effort proxy.
- **Fewer follow-up turns:** Read 4→2, Grep 5→2, Bash 8→5 (Read+Grep+Bash 17→9).
- **Resolution preserved:** unresolved → unresolved. The agent edited the **gold
  file** `astropy/units/format/cds.py`, which the compact inspect-first block named
  as the likely-first target (`cds.py::to_string`, confidence medium); the patch
  shape still did not pass (astropy-14369 is edit-shape sensitive — both arms reach
  the gold file but neither resolves), so this is **no regression**, not a win on
  resolution.
- First-call neighborhood investment +980 tokens; total reduction far exceeds it
  (investment paid off). Pivots inspected=2, edited=2.

### django-10880 / django-11095 — auto-policy skipped injection in both arms

For both small/local django tasks the cost-aware policy returns **`no_context`** in
**both** the old and current product paths — it judges a baseline agent solves them
cheaply and injected context is net overhead. So:

- The compact inspect-first rendering was **not delivered** in either arm; this is
  **not a rendering test** for these two instances. (Offline, the renderer does
  build a block for them — see the offline evidence — but the live product path
  correctly declines to inject it.)
- **Resolution preserved:** both resolved → resolved.
- Token movement is small and stochastic (cache-read +28,923 and −25,210), not a
  context effect, since neither arm injected context.

This is a consistency finding: the product gate behaves identically on these small
tasks before and after the rendering change, and the rendering change did not
perturb the un-injected path.

## Combined read across all four live cases

| Case | context injected? | comparison type | resolution | turns/tokens |
| --- | --- | --- | --- | --- |
| matplotlib-22719 | yes | matched verbose→compact | preserved (resolved historically-lost case) | total −226,745, cache-read −167,547, Bash 7→4 |
| astropy-14369 | yes | current-best vs old product-v2 | preserved (unresolved both) | total −1,366,099, cache-read −1,314,092, R+G+B 17→9 |
| django-10880 | no (gate skip) | n/a (no context either arm) | preserved (resolved both) | flat/stochastic |
| django-11095 | no (gate skip) | n/a (no context either arm) | preserved (resolved both) | flat/stochastic |

Where the product path **injects** context (matplotlib, astropy), the current
compact inspect-first shape shows **large token and turn reductions with no
resolution loss**. Where it **skips** (the two small django tasks), behavior is
unchanged and resolution is preserved.

## Offline first-call evidence (separate, deterministic)

Independent of the live runs, `stage5_inspect_first_offline_validation.md` shows
the compact rendering **reduced first-call injected tokens on all four** instances
(matplotlib −467, astropy −284, django-10880 −406, django-11095 −339), with the
verbose neighborhood reduced and the full structured `pivotNeighborhood` preserved
for reporting. This is first-response size only; it does not claim a live effect for
the gate-skipped django cases.

## Caveats

- Each instance is a single live run; live patch synthesis is stochastic. Two
  injected PASSes (matplotlib matched, astropy product-level) are encouraging but
  are not a population result.
- This is explicitly **not** a verbose→compact isolation for astropy/django; it is a
  *current product path vs old product-v2* comparison. The only matched
  verbose→compact isolation is matplotlib.
- The two django cases test nothing about the rendering live (gate skipped
  injection in both arms); they only confirm no regression on the un-injected path.
- No hard gate / two-phase preflight was used anywhere; that path stays
  diagnostic-only and default-off.

## Recommendation

Across the cases where context is actually injected, the current compact
inspect-first product-v2 path reduces tokens and turns substantially without
hurting resolution, and it leaves the gate-skipped small-task path unchanged. This
is sufficient product-level evidence to consider **making Capsule v2 the default
injected engine (with v1 retained as legacy fallback)** as the next step — a change
that should be made and measured on its own, separately from this rendering work, so
"engine default migration" is not mixed with "new rendering effect." Until that
decision is taken and validated, v2 remains opt-in (these runs used explicit
`--capsule-engine v2`).

## Non-claims

- No population or pass@k claim; per-instance n=1 live, stochastic.
- Baseline = pre-neighborhood product-v2, not a no-context baseline and not a
  verbose-neighborhood baseline (except matplotlib, reported separately).
- astropy "preserved" means unresolved→unresolved (no loss), not a resolution win.
- The django rows are not a rendering measurement; the policy skipped injection in
  both arms.
- No retrieval, ranking, scoring, candidate generation, or solve protocol changed;
  Capsule v2 stays opt-in pending a separate default-migration decision.

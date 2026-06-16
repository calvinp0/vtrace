# Stage 5 M11.1 — Pivot inspection contract: focused live validation

Focused live A/B validation of the M11 pivot inspection contract (commit `964679c`,
render-only). Primary question: **does the agent now inspect / edit-or-rule-out the
non-lead pivots it ignored in M10.1?**

- **A (baseline, reused):** `eval-m10-coedit-current-{sphinx-7462,seaborn-3187,django-13195}-r{1,2,3}` — pre-M11, not rerun.
- **B (M11, new):** `eval-m11-pivot-contract-current-{sphinx-7462,seaborn-3187,django-13195}-r{1,2,3}` — n=3 each.

Same clean VTRACE setup as M10.1: `--protocol vtrace-indexed --capsule-intent auto
--capture-product-v2-accounting --disable-pivot-check`. Docker evaluation. No retrieval/
scoring/ranking change (M11 is render-only). True gold file sets taken from
`data/swe-bench-100.jsonl`.

## 1. Executive verdict

**Verdict: `pivot_contract_live_partial` (positive-leaning).**

M11 **did change behavior on ignored non-lead pivots.** The contract reliably drove
the agent to inspect the non-lead pivot it previously skipped:

- **sphinx-7462**: non-lead gold file `sphinx/pycode/ast.py` was read **1/3 → 3/3**.
- **seaborn-3187**: non-lead pivot `seaborn/relational.py` was read **2/3 → 3/3**, and
  the broader inspection led the agent to the real co-edit `seaborn/utils.py` —
  **all-gold-edited 0/3 → 3/3** and **resolved 0/3 → 2/3**.

It is *partial*, not a clean success, because:

- **sphinx** still does not *edit* the non-lead file: the agent reads `ast.py` (which
  is genuinely a gold file) in all 3 runs but rules it out and patches only
  `python.py` → resolved stays 0/3. Inspection improved; conversion to the correct
  edit did not.
- **seaborn** resolution improved but **cost rose** (avg $0.60 → $1.41) with one
  over-edit run (r1: 4 files, 104 turns, $3.01, did *not* resolve).

No regressions: the **django-13195 control is unchanged** (all-gold 3/3 → 3/3, cost flat).

## 2. Run validity

| group | labels | valid runs | invalid | Docker | infra errors |
|---|---|---|---|---|---|
| sphinx-7462 M11 | `eval-m11-pivot-contract-current-sphinx-7462-r{1,2,3}` | 3/3 | 0 | healthy | none |
| seaborn-3187 M11 | `eval-m11-pivot-contract-current-seaborn-3187-r{1,2,3}` | 3/3 | 0 | healthy | none |
| django-13195 M11 (control) | `eval-m11-pivot-contract-current-django-13195-r{1,2,3}` | 3/3 | 0 | healthy | none |
| baselines (reused) | `eval-m10-coedit-current-*-r{1,2,3}` | 9/9 | 0 | healthy | none |

All 9 M11 runs produced a model patch, ran Docker evaluation with `evaluationError=null`,
exit code 0. No runs excluded; no r4/r5 needed.

## 3. Snapshot validation

For every M11 run: `effectiveCapsuleEngine=v2`, `fallbackReason=null`, context
injected (`policyAction=inject`), **no** `PIVOT_CHECK` / `EDIT_GUARD` / `PATCH_VERIFY`
(none injected, none in text), ordered telemetry present, `pivotChecklistEmitted=false`.

M11-specific rendering (verified on the injected `_capsule_v2_context.md`):

| check | sphinx-7462 | seaborn-3187 | django-13195 |
|---|---|---|---|
| `## Pivot inspection contract` present | yes | yes | yes |
| contract before pivot bodies | yes (char ~1430 < first body ~3160) | yes (char ~1400 < first body ~3120) | yes |
| contract before 12k truncation | yes | yes | yes (context ≤ ~10k, untruncated) |
| lead pivot listed | `python.py::_parse_annotation` | `scales.py::_setup` | `response.py::*` |
| non-lead pivot listed | `pycode/ast.py::unparse` | `relational.py::scatterplot` | co-edit candidates (middleware/cookie) |
| inspect / edit-or-rule-out language | yes | yes | yes |
| final-diff obligation (co-edit fired) | yes (Path A) | yes (Path A) | yes (Path B) |
| co-edit hint still visible | yes | yes | yes |

Expected non-lead pivots rendered exactly as required: `sphinx/pycode/ast.py::unparse`
and `seaborn/relational.py::scatterplot`. **No rendering/wiring bug — no M11 code change.**

## 4. Per-case comparison

Gold files (from dataset): sphinx `{python.py, pycode/ast.py}`; seaborn `{_core/scales.py,
utils.py}`; django `{http/response.py, sessions/middleware.py, messages/storage/cookie.py}`.
"non-lead read" = the contract-named non-lead pivot was opened (Read/Grep of that file).
Token figures are cumulative cache-read tokens (the dominant volume); cost is USD.

| instance | M10.1 resolved | M11 resolved | M10.1 non-lead read | M11 non-lead read | M10.1 non-lead edited | M11 non-lead edited | M10.1 all-gold | M11 all-gold | cost Δ (avg) | R+G+B Δ (avg) | classification |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **sphinx-7462** | 0/3 | 0/3 | 1/3 | **3/3** | 0/3 | 0/3 | 0/3 | 0/3 | $0.306 → $0.328 (+7%) | 4.7 → 5.7 | `pivot_contract_partial` |
| **seaborn-3187** | 0/3 | **2/3** | 2/3 | **3/3** | 0/3 | 1/3 | 0/3 | **3/3** | $0.599 → $1.414 (+136%) | 10.7 → 17.0 | `pivot_contract_resolution_success` |
| **django-13195** (control) | 0/3 | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | $0.347 → $0.372 (+7%) | 7.0 → 7.3 | no regression |

Per-run detail:

**sphinx-7462** — M11 patches `python.py` only in all 3 runs; reads the gold `ast.py`
in all 3 (vs 1/3 baseline). r1 cost $0.395/20t, r2 $0.325/24t, r3 $0.265/20t.
Baseline read `ast.py` only in r2 (a post-edit grep); the other baseline runs *simulated*
`unparse` inline in Bash and never opened the file.

**seaborn-3187** — M11: r1 resolved=F, patched `{plot.py, scales.py, relational.py,
utils.py}` (over-edit, $3.014/104t); r2 resolved=T, patched `{scales.py, utils.py}`
($0.714/40t); r3 resolved=T, patched `{scales.py, utils.py}` ($0.514/37t). Baseline
all 3 patched only `scales.py`, resolved=F.

**django-13195** (control) — M11: all 3 patched the full gold set
`{cookie.py, middleware.py, response.py}`, resolved=F, cost $0.343/$0.484/$0.288.
Identical edit shape to baseline; no over-editing, no regression.

## 5. Behavior analysis

**Did the agent follow the inspect / edit-or-rule-out contract?** Yes for *inspect*.
In both primary cases the contract-named non-lead pivot was opened in 3/3 M11 runs (up
from 1/3 sphinx, 2/3 seaborn). The contract converts a previously-passive pivot into an
inspected one.

**Did it inspect the non-lead pivot?** Yes — sphinx read `ast.py` 3/3; seaborn read
`relational.py` 3/3.

**Did it edit the non-lead pivot?** Mixed:
- sphinx: **no** — it reads `ast.py`, judges it not the edit site, and patches only
  `python.py`. Because `ast.py` *is* a gold file, this "rule-out" is wrong, and the case
  stays unresolved. The contract surfaced the file; the agent's localization judgment is
  the remaining gap, not visibility.
- seaborn: the contract pointed at `relational.py` (NOT a gold file). The agent did not
  need to edit it — instead the "don't stop at the lead pivot" framing pushed broader
  exploration that found the true co-edit `utils.py`. r2/r3 edited `{scales.py, utils.py}`
  and resolved; r1 also edited `relational.py` (the named-but-non-gold pivot) plus extras
  and failed.

**Did it still stop at the lead pivot?** sphinx yes (lead-only patch, despite inspecting
the non-lead). seaborn no (it expanded beyond the lead in all 3).

**Did it over-edit?** seaborn r1 is the one clear over-edit: 4 files / 104 turns / $3.01,
all-gold edited but the extra edits left it unresolved. django (control) showed no
over-editing — the contract did not inflate its already-correct 3-file patch. Net cost
impact is small on sphinx/django (+7%) and large on seaborn (+136%), dominated by r1.

## 6. Next recommendation

**B — strengthen from advisory contract to harder Stage 5 pivot-check enforcement.**

The contract reliably wins *inspection* but not *conversion to the correct edit*
(sphinx reads the gold `ast.py` 3/3 yet never edits it). A harder, structured
pivot-check — e.g. requiring an explicit, source-grounded written rule-out *per non-lead
pivot* before finalize — targets exactly this gap. Guardrail: gate the hardening against
over-editing (the seaborn r1 failure mode: editing every surfaced file, including the
non-gold `relational.py`, at 4–5× cost). Do **not** scale to 30/100 cases yet; iterate on
enforcement on this same focused set first.

## Non-claims / caveats

- n=3 per case; small sample. seaborn resolution (2/3) and the cost spike (r1) are both
  high-variance signals.
- The contract is injected-context guidance only — no runtime gate, no tool restriction,
  no phase split.
- Baselines were reused (not rerun); A/B differ only in the M11 render-time contract
  (retrieval/selection byte-identical by construction).
- Token deltas use cumulative cache-read tokens; the jsonl per-row `inputTokens`/
  `outputTokens` are final-turn deltas and are not used here.

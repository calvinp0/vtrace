# Stage 5 M12.1 — Pivot inspection enforcement: focused live validation

Focused live A/B validation of the M12 pivot-check **enforcement** mode (commit
`65beded`, `--pivot-inspection-enforcement`, render-only injection). Primary question:
**does opt-in pivot inspection enforcement improve behavior on the M11.1 partial cases?**

- **A (M11 advisory contract, reused):** `eval-m11-pivot-contract-current-{sphinx-7462,seaborn-3187,django-13195}-r{1,2,3}` — not rerun.
- **B (M12 enforcement, new):** `eval-m12-pivot-enforcement-current-{sphinx-7462,seaborn-3187,django-13195}-r{1,2,3}` — n=3 each.

Setup for B: `--protocol vtrace-indexed --capsule-intent auto
--capture-product-v2-accounting --disable-pivot-check --pivot-inspection-enforcement`.
`--disable-pivot-check` keeps legacy `PIVOT_CHECK` / `EDIT_GUARD` / `PATCH_VERIFY` off so
the new `## Required pivot check before final patch` block is the only enforcement
injected. Docker evaluation. No retrieval / scoring / ranking change (M12 is render-only).
Both arms scored with one extractor for apples-to-apples metrics (definitions in §4).

## 1. Executive verdict

**Verdict: `pivot_enforcement_live_partial`.**

The enforcement block renders exactly as designed (no wiring bug — no M12 code change),
and it **does** change behavior on the over-edit-prone case — but it **does not improve
resolution on either M11.1 partial case**, and on one case it traded resolution for
diff-tightness.

- **sphinx-7462 → `enforcement_no_effect`.** The agent still reads the genuinely-gold
  `sphinx/pycode/ast.py`, **rules it out**, and patches `sphinx/domains/python.py` only.
  Resolution stays **0/3**, non-lead edits stay **0/3**. If anything inspection dropped
  slightly (non-lead read **3/3 → 2/3**; one run went terse, RGB 1). Cost flat
  ($0.328 → $0.336, +2%). Hardening advisory → enforcement did not move this case.
- **seaborn-3187 → `enforcement_partial` (over-edit/cost win, resolution regression).**
  The M12 anti-over-edit guardrail **worked**: the M11 r1 over-edit failure (4 files,
  104 turns, **$3.01**) did **not** recur — **over-edit 1/3 → 0/3** and avg cost roughly
  **halved ($1.41 → $0.71)**. But the M11 resolution gain was **not** preserved:
  **resolved 2/3 → 1/3**, **all-gold 3/3 → 2/3**. Under the "prefer the minimal final
  diff" rule, r2 under-edited (patched `scales.py` only, missed the `utils.py` co-edit →
  unresolved); r1 got both gold files but with edit content that didn't pass.
- **django-13195 (control) → no regression.** All-gold **3/3 → 3/3**, over-edit **0/3**,
  resolved **0/3** (unchanged), cost $0.372 → $0.331. Identical edit shape; enforcement
  rendered; the guardrail did not shrink its already-correct 3-file co-edit patch.

Net: enforcement reliably shapes **inspection and diff-tightness** but does **not**
convert inspection into the **correct edit** (sphinx never edits the gold `ast.py`;
seaborn resolution did not improve). More/stronger injected text was not the lever.

## 2. Run validity

| group | labels | valid | invalid | Docker | infra errors |
|---|---|---|---|---|---|
| sphinx-7462 M12 | `eval-m12-pivot-enforcement-current-sphinx-7462-r{1,2,3}` | 3/3 | 0 | healthy | none |
| seaborn-3187 M12 | `eval-m12-pivot-enforcement-current-seaborn-3187-r{1,2,3}` | 3/3 | 0 | healthy | none |
| django-13195 M12 (control) | `eval-m12-pivot-enforcement-current-django-13195-r{1,2,3}` | 3/3 | 0 | healthy | none |
| M11 advisory (reused) | `eval-m11-pivot-contract-current-*-r{1,2,3}` | 9/9 | 0 | healthy | none |

All 9 M12 runs produced a model patch, ran Docker evaluation with `evaluationError=null`,
exit code 0. No runs excluded; no r4/r5 needed. No Docker infra failures.

## 3. Snapshot validation

For every M12 run: `effectiveCapsuleEngine=v2`, `fallbackReason=null`, context injected
(`policyAction=inject`), ordered telemetry present, **no** legacy `PIVOT_CHECK` /
`EDIT_GUARD` / `PATCH_VERIFY` (none injected, none in text). M12-specific rendering,
verified on the injected `_vtrace_instructions.snapshot.md`:

| check | sphinx-7462 | seaborn-3187 | django-13195 |
|---|---|---|---|
| `## Required pivot check before final patch` present | yes (char 253) | yes (char 249) | yes (char 246) |
| block before pivot bodies | yes | yes | yes |
| block before 12k truncation | yes (≪ 12000) | yes (≪ 12000) | yes (≪ 12000) |
| lead pivot listed | `domains/python.py::_parse_annotation` | `_core/scales.py::_setup` | `http/response.py` |
| non-lead pivot listed | `pycode/ast.py::unparse` | `relational.py::scatterplot` | co-edit candidates (middleware/cookie) |
| EDITED / RULED OUT language | yes | yes | yes |
| anti-over-edit / minimal-diff wording | yes | yes | yes |
| co-edit hint still visible | yes | yes | yes |
| M11 advisory contract still present | yes (char ~2745) | yes (char ~2702) | yes |
| legacy pivot-check absent | yes | yes | yes |

Expected non-lead pivots rendered exactly as required: `sphinx/pycode/ast.py::unparse`
and `seaborn/relational.py::scatterplot`. **No rendering/wiring bug — no M12 code change.**

## 4. Per-case comparison

Gold files (dataset): sphinx `{domains/python.py, pycode/ast.py}`; seaborn
`{_core/scales.py, utils.py}`; django `{http/response.py, sessions/middleware.py,
messages/storage/cookie.py}`. "non-lead read" = the contract-named non-lead pivot was
opened (Read/Grep). "over-edit" = final patch includes a file outside the gold/co-edit
set. Tokens = cumulative cache-read tokens. Cost is USD. Same extractor for both arms.

| instance | M11 resolved | M12 resolved | M11 non-lead read | M12 non-lead read | M11 non-lead edited | M12 non-lead edited | M11 all-gold | M12 all-gold | M11 over-edit | M12 over-edit | token Δ (avg) | cost Δ (avg) | classification |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **sphinx-7462** | 0/3 | 0/3 | 3/3 | **2/3** | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 710k → 743k (+5%) | $0.328 → $0.336 (+2%) | `enforcement_no_effect` |
| **seaborn-3187** | 2/3 | **1/3** | 3/3 | 3/3 | 1/3 | 0/3 | 3/3 | **2/3** | 1/3 | **0/3** | 2.51M → 1.62M (−35%) | $1.414 → $0.714 (**−49%**) | `enforcement_partial` |
| **django-13195** (control) | 0/3 | 0/3 | — | — | — | — | 3/3 | 3/3 | 0/3 | 0/3 | — | $0.372 → $0.331 (−11%) | no regression |

Per-run detail:

**sphinx-7462** — M12 patches `domains/python.py` only in all 3 runs (same as M11).
- r1: unresolved, `{python.py}`, read `ast.py`, ruled it out, RGB 3, 20t, $0.357.
- r2: unresolved, `{python.py}`, read `ast.py`, ruled it out, RGB 4, 28t, $0.382.
- r3: unresolved, `{python.py}`, did **not** open `ast.py` (terse: RGB 1, 18t), $0.269.

**seaborn-3187** — M12 never over-edits; M11's 4-file blow-up is gone.
- r1: unresolved, `{scales.py, utils.py}` (all gold, no over-edit), RGB 4, 41t, $0.730 —
  right files, edit content didn't pass.
- r2: unresolved, `{scales.py}` only — **under-edit**, missed the `utils.py` co-edit
  despite the "include all required co-edits" rule, RGB 21, 56t, $0.845.
- r3: **resolved**, `{scales.py, utils.py}`, RGB 8, 34t, $0.566.
- (M11 for contrast: r1 over-edit `{plot.py, scales.py, relational.py, utils.py}` 104t
  $3.014 unresolved; r2 resolved `{scales,utils}` $0.714; r3 resolved `{scales,utils}`
  $0.514.)

**django-13195** (control) — M12: all 3 patched the full gold set
`{cookie.py, middleware.py, response.py}`, no over-edit, resolved 0/3 (unchanged),
$0.328 / $0.304 / $0.360. Identical edit shape to M11; no regression.

## 5. Behavior analysis

**Did the agent comply with EDITED / RULED OUT?** Yes, behaviorally. In both primary
cases it either edited or ruled out the non-lead pivot rather than ignoring it: sphinx
read+ruled-out `ast.py`; seaborn read+ruled-out `relational.py` (correctly — it is not a
gold file). The block is honored as guidance.

**Did it inspect the non-lead pivot?** Mostly. seaborn 3/3; sphinx 2/3 (M12 r3 skipped
`ast.py` entirely and patched the lead in one terse pass — slightly *less* inspection
than M11's 3/3).

**Did it edit the non-lead pivot when appropriate?** No improvement. sphinx still never
edits the genuinely-gold `ast.py` (0/3 both milestones) — it reads it and judges it not
the edit site. This is a **localization-judgment** gap, not a visibility/wording gap: the
file is surfaced, named, and the agent is explicitly told to inspect-or-edit it, and it
still rules it out. seaborn's relevant edit is the `utils.py` co-edit, not the named
non-lead pivot; M12 got it in 2/3 (r1, r3) but missed it in r2.

**Did it rule out with concrete source evidence?** Yes in the runs that ruled out — the
rule-outs were source-grounded (sphinx judged `ast.py::unparse` not the signature-render
site; seaborn judged `relational.py` not the tick-format site). The problem is sphinx's
rule-out of `ast.py` is *wrong*, and enforcement did not catch a wrong-but-grounded
rule-out.

**Did it still stop at the lead pivot?** sphinx yes (lead-only patch in all 3). seaborn
no (expanded to the `utils.py` co-edit in 2/3).

**Did it over-edit?** No — **the M12 anti-over-edit guardrail is the clear win.** Zero
over-edit across all 9 runs; the M11 seaborn r1 4-file / $3.01 failure mode did not recur,
and cost dropped sharply on seaborn (−49%) and the django control (−11%) with no diff
inflation. The cost of that tightness: seaborn r2 **under-edited** (minimal-diff framing
pushed it to a single-file patch that missed the required co-edit), which is the main
driver of the resolution dip 2/3 → 1/3.

## 6. Next recommendation

**C — the injected text (advisory *or* hardened enforcement) is insufficient to convert
inspection into the correct edit; the next real lever is a structured / hard
pivot-inspection loop, not more guidance text. Keep enforcement strictly opt-in.**

Rationale, and why C over the others:

- **Why not A (broader validation):** there is no clean success to scale. Resolution did
  not improve on either partial case (sphinx 0/3 → 0/3; seaborn 2/3 → 1/3).
- **Why not B (refine wording / rerun failed shape):** M12 *already ran the "stronger
  text" experiment* — it escalated the M11 advisory contract to a "Required decision"
  enforcement block — and resolution still did not move. sphinx reads, is explicitly told
  to inspect-or-edit, and still rules out the genuinely-gold `ast.py`. That is direct
  evidence that further wording refinement is low-yield for the conversion gap; the gap is
  localization judgment (and, for seaborn r2, an over-corrected minimal-diff instinct),
  neither of which a stronger sentence fixes.
- **Why not D (disable for broad use):** enforcement is not net-harmful — it eliminated
  the over-edit failure mode, halved seaborn cost, and left the django control unchanged.
  The seaborn resolution dip (2/3 → 1/3) is a single-run swing at n=3 and is balanced by
  the removed $3.01 over-edit. It does **not** warrant disabling; it warrants **keeping
  the flag opt-in and never defaulting it**, since it can trade resolution for
  diff-tightness.
- **Why C:** the consistent M11 → M12 finding is that injected guidance shapes inspection
  and diff shape but not the correct edit. Closing that needs a structured mechanism, e.g.
  (a) feeding failing-test output back so the agent must revisit a rule-out that still
  leaves a test red, or (b) a gated finalize that records a per-pivot decision and forces
  re-inspection when the gold behavior is unmet — i.e. an actual loop, not a paragraph.

Do **not** scale to 30/100 cases yet.

## Non-claims / caveats

- n=3 per case; small sample. seaborn resolution (1/3 vs 2/3) and the cost figures are
  high-variance; the over-edit elimination (1/3 → 0/3) and the absence of any over-edit
  across all 9 runs are the more robust signals.
- M12 is injected-context guidance only — no runtime gate, no tool restriction, no phase
  split. "Enforcement" here means a required-response *block*, not a hard gate.
- A-arm baselines were reused (not rerun); A/B differ only by the M12 render-time
  enforcement block (retrieval/selection byte-identical by construction).
- Token deltas use cumulative cache-read tokens. RGB and some figures are recomputed with
  one consistent extractor across both arms, so absolute tool-call counts may differ from
  the M11.1 report's narrative numbers; the resolution / all-gold / over-edit / cost
  conclusions match.

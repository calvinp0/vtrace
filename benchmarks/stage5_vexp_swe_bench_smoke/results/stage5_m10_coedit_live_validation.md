# Stage 5 M10.1 — multi-file co-edit hint: focused live validation

Live validation of the M10 multi-file co-edit actionability hint (commit `6a66070`)
on the three M9 multi-file/actionability-gap cases, plus three controls. The question
is **behavioral**, not benchmark-scale: *does the explicit co-edit obligation make the
agent inspect/edit more of the surfaced co-edit set than before?*

VTRACE current-clean condition, identical to M6/M9:
`--protocol vtrace-indexed --capsule-intent auto --capture-product-v2-accounting --disable-pivot-check`.
Agent `claude-code` / model `claude-opus-4-5-20251101`, 250-turn / $3-per-task caps.
M10 hints enabled by default (current Capsule v2 path). Pre-M10 (condition A) is the
existing M6/M9 `*-current-clean-*` set — not re-run.

## 1. Executive verdict

**`coedit_live_partial`.** The hint renders correctly in every live injected snapshot
and provably changes agent behavior on the case where the co-edit candidates are
concrete support callers (**django-13195**: the agent went from editing one file to
editing **all three gold files in 3/3 runs**, reading and editing both named co-edit
files). It had **no editing effect** on the two cases where the co-edit candidate was
an already-in-context second pivot (sphinx-7462, seaborn-3187). **Resolution did not
improve on any case (0/9, same as pre-M10)** — on django the agent now performs the
full multi-file edit but the patch content is still wrong, i.e. the localization gap
closed and the case is revealed to be synthesis-bound, not actionability-bound.

## 2. Run validity

| | labels | valid | invalid |
|---|---|---|---|
| primary | `eval-m10-coedit-current-{sphinx-7462,seaborn-3187,django-13195}-r{1,2,3}` | 9/9 | 0 |
| controls | `eval-m10-coedit-control-{astropy-14369,sympy-16766,requests-5414}-r1` | 3/3 | 0 |

Docker healthy (server 29.5.2). Every primary evaluate ran tests cleanly
(`evaluationError=null`, `resolvedCount=0` are genuine test failures, **not** infra
errors). No run aborted, produced no JSONL, or hit a snapshot/build infra fault. All
run-protocol + evaluate steps exited 0.

## 3. Snapshot validation

Every run: `effectiveCapsuleEngine=v2`, `fallbackReason=null`, context injected,
**no PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY injected** (pivot-check disabled by flag),
ordered telemetry present.

Primary co-edit hints (all rendered before pivot bodies and within the 12 000-char
Stage 5 cutoff — checklist + obligation + relatedFiles present):

| case | hint | confidence | related files rendered | byte offset (< first pivot, < 12k) |
|---|---|---|---|---|
| sphinx-7462 | multi_file_coedit | high | `sphinx/pycode/ast.py` | 1430 < 2227 ✓ |
| seaborn-3187 | multi_file_coedit | high | `seaborn/relational.py` | 1397 < 2187 ✓ |
| django-13195 | multi_file_coedit | medium | `…/sessions/middleware.py`, `…/messages/storage/cookie.py` | 1440 < 2293 ✓ |

Controls (live):

| control | engine | multi_file_coedit | generated-artifact hint |
|---|---|---|---|
| astropy-14369 | v2 | **none** (correct) | **present** — `cds_parsetab.py` + `cds_lextab.py` (high) |
| sympy-16766 | v2 | **none** (correct) | none |
| requests-5414 | v2 | **none** (correct) | none |

All six live snapshots match the M10 offline audit exactly.

## 4. Per-case comparison (medians over n=3)

| instance | pre resolved | M10 resolved | pre all-gold-edited | M10 all-gold-edited | pre related co-edited | M10 related co-edited | token Δ (med) | R+G+B Δ (med) | classification |
|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 791k → 728k (−8%) | 6 → 5 | `coedit_no_effect` |
| seaborn-3187 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 3.11M → 1.68M (−46%) | 24 → 12 | `coedit_no_effect` (more consistent/cheaper) |
| django-13195 | 0/3 | 0/3 | **0/3** | **3/3** | **0/3** | **3/3 (both files)** | 444k → 931k (+110%) | 3 → 7 | **`coedit_behavior_success`** |

Edited-files detail:
- **sphinx**: pre = `python.py` ×3 (one run also `ext/autodoc/__init__.py`); M10 = `python.py` ×3. `ast.py` never read or edited in either condition.
- **seaborn**: pre = `scales.py` (r1,r3) / `utils.py` (r2) — scattered, never both; M10 = `scales.py` ×3 — consistent on the lead, never `relational.py` or `utils.py`.
- **django**: pre = `response.py` ×3 only; M10 = `response.py` + `middleware.py` + `cookie.py` ×3 (both related files read **and** edited every run).

## 5. Behavior analysis

**Did the agent follow the co-edit obligation? Case-dependent, and the split is
informative.**

- **django-13195 — yes, decisively.** The obligation named two concrete *support*
  files (`middleware.py`, `cookie.py`) that were NOT otherwise full-source pivots. In
  all three runs the agent opened both (2 reads), edited both, and produced an
  all-gold three-file patch — behavior it never exhibited pre-M10 (one-file patches,
  0/3). The +110% tokens / +133% R+G+B is the *cost of doing the multi-file work* the
  hint asked for. The fix still failed the tests, so django is now shown to be
  **synthesis-bound**: M10 closed its actionability/localization gap, leaving patch
  correctness as the remaining barrier.

- **sphinx-7462 / seaborn-3187 — no editing change.** In both, the co-edit candidate
  was a *second pivot already inlined as full source* in the capsule (`ast.py`,
  `relational.py`). The agent had that source in front of it, the obligation pointed
  at it, and the agent still edited only the lead pivot — never opening or amending the
  related file (and in seaborn never reaching the true gold co-edit `utils.py`, which
  the detector surfaced only as support, not in the hint). So the agent "stopped at the
  lead pivot" exactly as pre-M10. No over-editing was observed anywhere (no spurious
  files; seaborn actually got *more* focused and ~46% cheaper).

**Why django worked and the pivot cases did not:** the obligation adds the most signal
when it promotes a *passive support caller* into an explicit edit target. When the
co-edit candidate is already a prominent full-source pivot, an advisory line does not
overcome the agent's judgment that its single-file edit suffices.

## 6. Next recommendation

**B — strengthen the checklist / pivot-inspection enforcement, not retrieval.**

The mechanism is proven where it has teeth (django): naming concrete co-edit files
drives inspection and editing. The gap is the Path-A case (cross-module *pivots*),
where an advisory does not make the agent act on a hidden pivot it can already see.
The targeted next step is to make the hidden-pivot co-edit obligation more forceful —
e.g. a per-pivot "edit or explicitly rule out" line attached to each non-lead pivot
block, or escalate it from advisory to a mandatory pivot-inspection acknowledgement —
**without touching retrieval, scoring, ranking, or candidate generation.** Separately,
django’s result reframes that case as synthesis-bound; a co-edit win there will require
patch-correctness help, not more localization. Do **not** expand to a 6–8 case sweep
yet (that is the `coedit_live_success` path, not met) and not to 30/100.

## Appendix — verification

Report-only change. No code modified. `git diff --check` clean. Raw run artifacts
(`runs/eval-m10-coedit-*`) are **not** staged.

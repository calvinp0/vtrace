# Stage 5 — M4.6 post-obligation astropy-14369 live validation

Generated: 2026-06-14. Live `n=3` clean-VTRACE repeats on current `main` after the M4.5 `ensure-in-diff` patch obligation (commit `ed20163`). Decisions use medians/counts of `n=3`. No retrieval/scoring/candidate/auto-policy changes. No code changed in this task (the obligation rendered correctly live — gate passed). Raw artifacts not committed.

Conditions (A/B reused from M4.2, C from M4.4, D new):
- **A** baseline / no-context — `eval-m4r2-baseline-*-r{1,2,3}`
- **B** pre-hint clean VTRACE — `eval-m4r2-current-clean-*-r{1,4,5}`
- **C** awareness-only post-hint VTRACE (M4.3 hint) — `eval-m4r4-current-clean-hints-*-r{1,2,3}`
- **D** post-obligation clean VTRACE (M4.5 `ensure-in-diff`) — `eval-m4r6-current-clean-obligation-*-r{1,2,3}`; default v2 compact inspect-first, `--disable-pivot-check`, hard gate off, hints + patchObligation enabled.

**Gold fix (post-hoc only, never injected):** `cds.py::p_division_of_units` reorder to left-associative (`combined_units DIVISION unit_expression`) **plus** a regenerated `cds_parsetab.py`. `goldDir` below = the patch contains that exact production.

> **Baseline correction (important):** the M4.4 report scored condition **C** as "parsetab edit 0/3" by inspecting only `+++ b/` diff headers, which **misses file deletions** (`+++ /dev/null`). Re-scored counting deletions, **C already shipped the parser table in the submitted diff 3/3** (C-r1 deleted parsetab+lextab; C-r2/r3 deleted parsetab). Deleting the stale table is a valid follow-through (PLY regenerates from the edited grammar at import). So the artifact **follow-through to the diff was already 3/3 at C** — the decisive thing D changes is **resolution**, via grammar-direction correctness. All counts below use the corrected (deletion-aware) definition.

---

## 1. Executive verdict

**Did the `ensure-in-diff` patch obligation improve astropy-14369 live behavior?**

### `actionability_success` — D resolved **2/3** (first non-zero across all conditions), with the generated artifact correctly in the submitted diff 3/3.

Docker-verified: r2 and r3 resolved (`resolvedCount=1`, `dockerUsed=true`, no error); r1 did not. Both resolved runs contain the **exact gold grammar reorder** (`combined_units DIVISION unit_expression`) and handle the parser table (r2 deletes it, r3 regenerates it). r1 followed through on the table (regenerated parsetab + parser.out) but used a *different* grammar reformulation (`division_of_units DIVISION product_of_units`, left-recursive) → unresolved.

**Honest causal caveat.** The follow-through itself (table in diff) was already 3/3 at corrected C. The resolution jump 0/3 → 2/3 rides on **grammar-direction correctness** (`goldDir` 0/3 → 2/3), a grammar-synthesis property the obligation does not target directly. The plausible mechanism: the obligation pushes the agent to *regenerate* (not just delete) the table (D regenerated 2/3 vs C mostly deleted), and regenerating forces grammar↔table reconciliation that surfaces the correct reorder — but at `n=3` this cannot be cleanly separated from variance. The verdict is `actionability_success` by the task's definition (resolution improves + artifacts included correctly); the mechanism warrants `n=5` confirmation (see §6).

---

## 2. Four-condition comparison (medians / counts, n=3)

| metric | A baseline | B pre-hint | C awareness-only† | D post-obligation |
|---|:--:|:--:|:--:|:--:|
| resolved / n | 0/3 | 0/3 | 0/3 | **2/3** |
| median total tokens | 2,414,739 | 2,117,288 | 2,210,460 | 3,327,998 |
| median cache-read | 2,320,986 | 2,041,301 | 2,134,451 | 3,216,559 |
| median Read+Grep+Bash | 18 | 15 | 16 | 20 |
| median cost | $1.323 | $1.134 | $0.994 | $1.482 |
| gold-file (cds.py) edits | 3/3 | 3/3 | 3/3 | 3/3 |
| parsetab read | 0/3 | 0/3 | 2/3 | 2/3 |
| parsetab edit (Edit/Write tool) | 0/3 | 0/3 | 0/3 | **2/3** |
| **parsetab in final diff** | 0/3 | 0/3 | 3/3 | 3/3 |
| lextab read | 0/3 | 0/3 | 0/3 | 0/3 |
| lextab edit | 0/3 | 0/3 | 0/3 | 0/3 |
| lextab in final diff | 0/3 | 0/3 | 1/3 | 0/3 |
| generated-artifact awareness | 0/3 | 0/3 | 3/3 | 3/3 |
| final-diff obligation in snapshot | 0/3 | 0/3 | 0/3 (n/a) | **3/3** |
| **gold grammar direction** | 0/3 | 0/3 | 0/3 | **2/3** |

† C re-scored deletion-aware (see correction note). The M4.4 report's C "parsetab edit 0/3" should read "parsetab in final diff 3/3 (via deletion)".

**Reading:** follow-through to the diff jumps at **C** (0/3 → 3/3, driven by the M4.3 awareness hint via deletion). Resolution jumps at **D** (0/3 → 2/3), tracking grammar-direction correctness. D is the most expensive condition (the obligation drives full table regeneration, e.g. r1 wrote the entire regenerated `cds_parsetab.py` + `parser.out` into the patch): +50.6% median tokens and +49% cost vs C — a real efficiency cost traded for resolution.

---

## 3. Per-run table — condition D (all 3 valid)

| label | resolved | total tok | cache-read | R/G/B | cost | 1st-edit turn | gold cds.py | parsetab r/e/diff | lextab r/e/diff | regen attempted | final-diff obligation followed | failure category |
|---|:--:|--:|--:|--:|--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| `…-r1` | no | 3,414,729 | 3,216,559 | 22 (4/1/17) | $1.9146 | 1 | yes | yes/yes/**yes** | no/no/no | yes (regen+parser.out) | yes (table in diff) | patch_synthesis (wrong grammar reformulation) |
| `…-r2` | **yes** | 3,327,998 | 3,227,065 | 20 (2/1/17) | $1.4820 | 1 | yes | no/no/**yes(del)** | no/no/no | yes (delete) | yes (table deleted in diff) | resolved |
| `…-r3` | **yes** | 2,120,681 | 2,028,269 | 13 (4/0/9) | $1.0827 | 1 | yes | yes/yes/**yes** | no/no/no | yes (regen) | yes (table in diff) | resolved |

Per-run input/output/cache-creation: r1 447/141/197,582; r2 433/112/100,388; r3 314/64/92,034. Durations: 369.7s / 340.7s / 259.3s. numTurns 63/61/44. first read = first edit = `cds.py` (edit turn 1) all 3. Model `claude-opus-4-5`. Ordered telemetry present all 3. Patch files: r1 `cds.py`+`cds_parsetab.py`+`parser.out`; r2 `cds.py` (+ parsetab deletion); r3 `cds.py`+`cds_parsetab.py`.

### Required snapshot checks (all 3 runs identical — injected context is deterministic)

| check | r1 | r2 | r3 |
|---|:--:|:--:|:--:|
| no PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY | ✓ | ✓ | ✓ |
| effectiveCapsuleEngine = v2 · compactInspectFirst = true | ✓ | ✓ | ✓ |
| policyAction = inject · fallbackReason = null | ✓ | ✓ | ✓ |
| `## Actionability hints` + `cds.py → cds_parsetab.py` + `cds.py → cds_lextab.py` | ✓ | ✓ | ✓ |
| regenerate/update wording | ✓ | ✓ | ✓ |
| `ensure-in-diff` line + final/submitted/tracked reminder | ✓ | ✓ | ✓ |
| hint before 12,000-char cutoff (hint @1750, ensure-in-diff @2123) | ✓ | ✓ | ✓ |
| treatmentValid / Docker eval ran | ✓ | ✓ | ✓ |

`--disable-pivot-check` worked (pivotCheckInjected=false). No runs aborted; no r4/r5 substitution needed.

---

## 4. Follow-through diagnosis

- **r2, r3 → `fixed_by_followthrough_hint`**: resolution improves and the generated artifact is included correctly (r2 deletes the stale table, r3 regenerates it; both with the gold grammar reorder).
- **r1 → `followthrough_improved_but_patch_still_wrong`**: the generated artifact enters the submitted diff (regenerated parsetab + parser.out), but the grammar reformulation is wrong (`division_of_units DIVISION product_of_units` instead of `combined_units DIVISION unit_expression`).
- **Dominant outcome: `fixed_by_followthrough_hint` (2/3).**

The residual failure mode is no longer follow-through (the artifact reaches the diff 3/3) — it is **grammar synthesis** (`goldDir` 2/3). astropy-14369 has shifted from a follow-through-bound case to a (mostly-solved) synthesis case.

---

## 5. Gate consequence

**Keep astropy-14369 in the M4 gate** (this reverses M4.4's "remove from token-reduction gate"). With the obligation it resolves **2/3** under clean VTRACE — it is now a *resolving* case, not a permanent 0/3 blocker. Caveats: (a) `n=3` and the resolution rides on grammar-direction correctness whose causal link to the obligation is not fully separable from variance; (b) D is the most token/cost-expensive condition (the obligation drives full table regeneration). It remains a strong actionability-regression fixture (3/3 generated-artifact awareness + obligation-in-snapshot guards the M4.3/M4.5 pipeline).

---

## 6. Next recommendation

### A (primary) — keep astropy and run the final clean 4-case `n=3` headline gate.

D meets the `≥2/3` bar. Before/with the headline gate, recommend a single hardening step: **run `n=5` for D** (recommendation E applied narrowly) to confirm the 2/3 is not a favorable draw and to firm up the obligation→grammar-correctness causal claim, since the resolution gain is mediated by grammar synthesis (not the follow-through, which was already 3/3 at C). Do not chase further actionability rendering changes — the obligation is satisfied 3/3; the remaining variance is grammar synthesis, not context.

---

## Non-claims

- Single instance, `n=3`/condition; medians/counts reduce but do not remove noise. Resolution causality (obligation vs variance) is not established at `n=3`.
- Gold patch used only for post-hoc classification; never injected into any live run.
- No VEXP parity, no 100-task run, no retrieval/scoring/candidate/auto-policy changes. A/B/C reused; only D run live. Raw artifacts not committed.
- C re-scored deletion-aware here; the M4.4 report's `+++ b/`-only "parsetab edit 0/3" undercounted (true: parsetab in final diff 3/3 via deletion).
- No code changed this task; the `ensure-in-diff` obligation rendered correctly in every live snapshot (char 2123, within the 12,000-char cutoff).

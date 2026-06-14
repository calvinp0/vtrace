# Stage 5 — M4.4 post-hint astropy-14369 live validation

Generated: 2026-06-14. Live `n=3` clean-VTRACE repeats on current `main` after the M4.3 generated/co-edit actionability hints (commit `6ad9b25`) **plus** a Stage-5 hint-rendering fix found and applied during this task (commit `e823462`, see §0). Decisions use medians of `n=3`. No retrieval/scoring/candidate/auto-policy changes. Raw artifacts not committed.

Conditions:
- **A** = baseline / no-context (reused from M4.2, `{r1,r2,r3}`).
- **B** = pre-hint clean VTRACE (reused from M4.2, valid `{r1,r4,r5}`).
- **C** = post-hint clean VTRACE (new M4.4, `{r1,r2,r3}`): default Capsule v2 compact inspect-first, `--disable-pivot-check`, hard gate off, generated/co-edit hints enabled.

**Gold fix (post-hoc only — never injected):** `cds.py::p_division_of_units` grammar reorder to left-associative (`combined_units DIVISION unit_expression`) **plus a regenerated `cds_parsetab.py`** (PLY LALR table). FAIL_TO_PASS includes `test_cds_grammar[strings4/6]` and `test_cds_grammar_fail[km/s.Mpc-1]`.

---

## 0. Rendering bug found and fixed (gating check)

The task's required snapshot check failed on the **first** C run: the live injected `_vtrace_instructions.snapshot.md` did **not** contain the `## Actionability hints` section, despite the M4.3 offline probe proving it should. Diagnosis:

- The hints **were** detected and rendered — the full (untruncated) capsule context (`raw/vtrace/_capsule_v2_context.md`, 15,030 chars) contained `## Actionability hints` → `cds_parsetab.py` / `cds_lextab.py` at char ~13,000.
- But Stage 5 truncates the injected context to **`vtraceContextMaxChars = 12000`**, and M4.3 rendered the hints **after** the pivot source bodies. On this instance the capsule selects a ~240-line `VOUnit` pivot (intent resolved to `test-failure`), pushing the hints past the 12 KB cut — so they never reached the agent. The pre-fix r1 agent edited only `cds.py` and ignored the parser tables.

This is the exact patchable case the task authorizes (“actionabilityHints exist in product JSON but are not rendered into Stage 5 injected text”). **Fix (`e823462`):** render the compact `## Actionability hints` block **before** the bulky pivot/support source bodies in `renderCapsuleV2Human`, so a downstream char-budget truncation cannot strand it. Verified offline against the real astropy workspace: hint moves from char ~13,000 → **char 685** (before the first pivot at 1,449), well within the 12 KB budget. Full suite green (2,573 pass); typecheck + typecheck:benchmarks clean. All three C runs below use the fixed renderer and show the hint live.

---

## 1. Executive verdict

**Did generated/co-edit actionability hints improve astropy-14369 live behavior?**

### `partial_actionability_improvement`

The hint measurably changed agent behavior without changing resolution:

- **Generated-artifact awareness: 0/3 (B) → 3/3 (C).** Every post-hint run engaged the parser tables: r1 `rm -f cds_parsetab.py cds_lextab.py`; r2 rebuilt the CDS parser via `import ply.yacc` to test grammar changes, then deleted/restored/deleted the tables; r3 `rm cds_parsetab.py`. Pre-hint, the agent never touched them.
- **Read `cds_parsetab.py`: 0/3 (B) → 2/3 (C).**
- **Parser-table regeneration attempted (delete-to-force-PLY-regen or PLY rebuild): 0/3 → 3/3.**
- **Resolution: 0/3 (unchanged vs A and B).**
- **Submitted patch still `cds.py`-only (0/3 include the table); gold grammar direction 0/3.**

So the hint did what it was designed to do — surface the generated co-edit dependency and get the agent to act on it — but the task remains a grammar-synthesis + patch-encoding problem the hint alone does not solve.

---

## 2. Comparison table (medians, n=3)

| metric | A baseline | B pre-hint VTRACE | C post-hint VTRACE |
|---|:--:|:--:|:--:|
| resolved / n | 0/3 | 0/3 | **0/3** |
| total tokens | 2,414,739 | 2,117,288 | 2,210,460 |
| cache-read | 2,320,986 | 2,041,301 | 2,134,451 |
| Read+Grep+Bash | 18 | 15 | 16 |
| cost | $1.3230 | $1.1337 | **$0.9943** |
| gold-file (cds.py) edits | 3/3 | 3/3 | 3/3 |
| parsetab read | 0/3 | 0/3 | **2/3** |
| parsetab edit (in patch) | 0/3 | 0/3 | 0/3 |
| lextab read | 0/3 | 0/3 | 0/3 |
| lextab edit (in patch) | 0/3 | 0/3 | 0/3 |
| generated-artifact awareness | 0/3 | 0/3 | **3/3** |

**C vs B:** resolution unchanged (0/3); median tokens +4.4% and R+G+B +1 (the agent now does extra parser-table investigation); median cost −12.3% (noise/variance — C is not an efficiency regression). **The decisive change is awareness 0/3 → 3/3 and parsetab reads 0/3 → 2/3.** A/B reused verbatim from the M4.2 report (`stage5_m4r2_astropy_repeated_validation.md`); not re-run.

---

## 3. Per-run table — condition C (all 3 valid)

| label | resolved | total tok | cache-read | R/G/B | cost | 1st-edit turn | post-edit Bash | numTurns | gold cds.py | parsetab read/edit | lextab read/edit | parser regen attempted | failure category |
|---|:--:|--:|--:|--:|--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| `…-r1` | no | 1,142,291 | 1,058,597 | 9 (2/2/5) | $0.7847 | 1 | 5 | 27 | yes | no / no | no / no | yes (`rm` parsetab+lextab) | patch_synthesis (wrong grammar; regen not in patch) |
| `…-r2` | no | 2,392,417 | 2,310,273 | 16 (3/1/12) | $1.3750 | 1 | 12 | 45 | yes | **yes** / no | no / no | yes (PLY rebuild + `rm`) | patch_synthesis (wrong grammar; regen not in patch) |
| `…-r3` | no | 2,210,460 | 2,134,451 | 16 (6/2/8) | $0.9943 | 1 | 8 | 47 | yes | **yes** / no | no / no | yes (`rm` parsetab) | patch_synthesis (wrong grammar; regen not in patch) |

Per-run input/output/cache-creation tokens: r1 195/75/83,424; r2 321/93/81,730; r3 335/91/75,583. Model `claude-opus-4-5-20251101`. Ordered telemetry present in all 3. Patch files: `astropy/units/format/cds.py` only, all 3.

### Required snapshot checks (all 3 runs)

| check | r1 | r2 | r3 |
|---|:--:|:--:|:--:|
| no PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY | ✓ | ✓ | ✓ |
| effectiveCapsuleEngine = v2 | ✓ | ✓ | ✓ |
| compactInspectFirst = true | ✓ | ✓ | ✓ |
| policyAction = inject | ✓ | ✓ | ✓ |
| fallbackReason = null | ✓ | ✓ | ✓ |
| `## Actionability hints` present | ✓ | ✓ | ✓ |
| `cds.py → cds_parsetab.py` present | ✓ | ✓ | ✓ |
| `cds.py → cds_lextab.py` present | ✓ | ✓ | ✓ |
| hint says regenerate/update parser table | ✓ | ✓ | ✓ |
| treatmentValid / Docker eval ran | ✓ | ✓ | ✓ |

`--disable-pivot-check` worked (pivotCheckInjected=false, disabledByFlag=true). No runs aborted; no r4/r5 substitution needed.

---

## 4. Actionability diagnosis

### `awareness_improved_but_patch_still_wrong`

The agent now reads/regenerates the parser table and explicitly reasons about table regeneration (3/3), but still fails because:

1. **Grammar synthesis is wrong (gold direction 0/3).** The required fix is the exact left-associative reorder of the `division_of_units` production; the agents produce different reformulations that still mis-parse (e.g. `km/s.Mpc-1` does not fail as the gold `test_cds_grammar_fail` requires).
2. **The regeneration never reaches the submitted patch (parsetab in patch 0/3).** The agent deletes `cds_parsetab.py` *in the workspace* to force PLY to rebuild it, but SWE-bench evaluates the **diff**, which contains only `cds.py`. At eval time the committed stale `cds_parsetab.py` is restored, so the old table wins regardless of the local regeneration. The hint raised awareness but did not get the agent to encode the table change (delete or regenerate) into the patch itself.

This is squarely a patch-synthesis blocker, not a context/localization one — consistent with M4.2.

---

## 5. Gate consequence

**Remove astropy-14369 from the strict M4 token-reduction gate; keep it as an actionability-development / regression case.**

- It remains 0/3 resolved across A/B/C — it cannot serve as a resolution or token-reduction gate case (its difficulty is grammar synthesis + patch encoding, not context richness).
- It is now a valuable **actionability regression** fixture: the hint reproducibly drives generated-artifact awareness (0/3 → 3/3) and parsetab reads (0/3 → 2/3), so it guards against the hint silently disappearing (exactly the truncation bug caught in §0).

---

## 6. Next recommendation

### B — keep astropy as an actionability-development case, but remove it from the strict M4 token-reduction gate.

Rationale: post-hint shows clear artifact awareness (3/3) but still 0/3 resolved. Do not chase resolution on this single hard-synthesis instance via richer context; the remaining gap is LALR grammar synthesis plus getting the table change into the patch.

**Follow-up insight (not acted on here):** the dominant remaining failure mode is mechanical, not awareness — the agent regenerates the table locally but omits it from the diff. A future compact actionability experiment could nudge the agent to *include* the generated-artifact change in the patch (regenerate-and-stage, or delete-in-patch), which is a rendering/enforcement change, not retrieval tuning. Separately, run the 4-case `n=3` headline gate with a replacement localization-bound overhead case (matplotlib on-par per M4.1), since astropy leaves the token-reduction gate.

---

## Non-claims

- Single instance, `n=3`/condition; medians reduce but do not remove noise.
- Gold patch used only for post-hoc classification; never injected into any live run.
- No VEXP parity, no 100-task run, no retrieval/scoring/candidate/auto-policy changes.
- A/B reused from M4.2; only C was run live. Raw artifacts not committed.
- One code change this task: `e823462` (Stage-5 hint render ordering fix, §0) — a rendering bug that blocked the validation, not a retrieval/scoring change.

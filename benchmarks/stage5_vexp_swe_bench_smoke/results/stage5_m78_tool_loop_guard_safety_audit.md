# Stage 5 M78 Tool Loop Guard Safety Audit

Offline safety + calibration audit of the runtime tool-loop guard after M77.
**Audit/preregistration only — no guard behavior changed, no live agents, no Docker, no API spend.**

## Summary

- **M77 verdict recap:** MIXED. The runtime injection hook is validated end-to-end (10/10 valid runs,
  `<VTRACE_TOOL_LOOP_GUARD>` markers + metadata consistent, caps/cooldown respected). Resolution is net
  flat **5→5** (+1 win `sympy-12419`, −1 regression `pytest-6197`); the slice cost win is only partly
  guard-attributable; one coverage gap (`django-16263`).
- **Key mechanism findings:** 3 live fires, not "all repeated_read" as the M77 prose says. Corrected
  composition = **2× `repeated_read`** (`astropy-14598`@13, `pytest-6197`@2) **+ 1× `repeated_failed_command`**
  (`sympy-12419`@5). The two *helpful* fires (`astropy`, `sympy`) and the one *harmful* fire (`pytest`)
  are cleanly separable by fire timing and trigger family. Protected wins (C) and controls (D) untouched (4/4).
- **`pytest-6197` conclusion:** **guard_plausibly_contributed (low confidence).** Fired at the earliest
  possible point (event idx 2) after 3 opening reads of `python.py` with no prior search/edit. It nudged
  *toward* the correct gold file (`python.py` edited next); the patch failed on quality. Live variance is a
  strong co-explanation. A minimum-turn floor **or** a "require a prior search/edit" gate would suppress it.
- **`django-16263` conclusion:** **not a read-detector gap.** The raw stream is **single-file edit-verify
  churn** — 9 `Edit`s to `query.py` interleaved with reads and *successful* bash verifies — not multi-file
  read-twice thrash (the M77 prose mischaracterized it). The guard correctly did not fire (edits reset the
  read streak by design). This is cost/no-convergence (candidate **C7**) territory, not a threshold/event-shape fix.
- **Calibration recommendation:** **V4 — read/search/window triggers fire only after ≥1 search-or-edit event.**
  It suppresses the `pytest` early-read fire and 2 of 3 control false-positives, while preserving **both**
  helpful fires and **full** cap/thrash recall (5/9). A multi-file (distinct-file) read-window detector
  **does not** catch `django-16263` and adds a false-positive — not worth it.
- **M79 recommendation:** **M79 implement calibrated guard variant (V4), default-off**, re-verify offline,
  then a small guarded live re-validation. No default promotion, no C7 yet, no multi-file detector, no broad benchmark.

## Method

- **Inputs inspected (tracked):** `stage5_m77_*` (live validation `.md`/`.json`/`.detail.json`, preflight,
  split), `stage5_m76_tool_loop_guard_runtime_hook.json`, `stage5_m75_tool_loop_guard_replay.json`,
  `stage5_m74_self_harness_lite_audit.json`; guard source `toolLoopGuard.ts`, `toolLoopGuardHook.ts`,
  and the patch-status / fail-closed seam in `run_stage5_vexp_swe_bench_smoke.ts`.
- **Raw artifacts inspected (targeted, not staged):** the M77 `_tool_calls(.with_outputs).json` streams for
  `pytest-6197`, `astropy-14598`, `sympy-12419`, `django-16263`; the M71/M72/M73 unguarded treatment streams
  (99-case cohort) via the calibration helper.
- **Gold / offline evidence:** gold labels are used **only** for interpretation (resolved / paired-outcome
  group provenance via the M74 audit). **No gold label feeds any detector decision** in the sweep.
- **Calibration sweep:** re-runs the **shipped, unchanged** pure detector (`runToolLoopGuard`) and applies
  the variant rules as **post-hoc transforms** (min-turn = firing filter; V4 = read-family gate; V5 = a
  separate distinct-file window add-on). Named-case fire/suppress is computed on the **live M77 streams**
  (the trajectories that actually ran); cohort recall/false-positives on the **unguarded** M71/M72/M73 streams.
- **Limitations:** (1) one live sample per case — `pytest` vs live variance cannot be fully separated;
  (2) min-turn variants are modelled as post-hoc firing filters, not a re-entrant detector (cap/cooldown
  interactions are approximated; effect on first-fire is exact); (3) named-case results use live guarded
  streams whereas cohort uses unguarded streams (the guard would change live trajectories — as M77 showed).

## M77 Case Reconstruction

| instance | grp | prior | M77 | fired? | turn | trigger | mechanism | conf |
|---|---|---|---|---|---|---|---|---|
| astropy-14598 | A | F (cap $3.00) | F | yes | 13 | repeated_read `read:card.py` ×3 | **helped** | high |
| django-15503 | A | F (cap $3.04) | F | no | – | – | no_fire_control (variance) | high |
| django-16263 | A | F (cap $3.02) | F | no | – | – | **coverage_gap** (edit churn) | high |
| pytest-6197 | A | **P** ($1.75) | **F** | yes | 2 | repeated_read `read:python.py` ×3 | **possible_harm** | low |
| pylint-4551 | B | F (cap $3.01) | F | no | – | – | no_fire_control (variance) | high |
| sympy-12419 | B | F (cap $3.00) | **P** | yes | 5 | **repeated_failed_command** ×2 | **helped** | medium |
| django-11815 | C | P ($0.44) | P | no | – | – | no_fire_control (win kept) | high |
| django-12273 | C | P ($0.54) | P | no | – | – | no_fire_control (win kept) | high |
| astropy-7166 | D | P ($0.40) | P | no | – | – | no_fire_control | high |
| django-10880 | D | P ($0.35) | P | no | – | – | no_fire_control | high |

> **Data-integrity correction:** the M77 `.md` says "all three live fires were `repeated_read`." The
> authoritative `detail.json` shows `sympy-12419` fired on `repeated_failed_command` (turn 5, ×2). The M77
> *result* is not modified here (non-goal); this is an interpretation fix that materially helps calibration:
> the `sympy` win is robust to **any** read-detector tuning.

## Deep Dives

### pytest-6197 — early-fire regression (`possible_harm`, low confidence)

Live tool sequence (basenames): read `python.py` (×3 at idx 0,1,2) → **guard fires @idx2** → edit `python.py`
(idx3, the correct gold `_pytest/python.py`) → write `/tmp` test files → bash → reads/edits of `python.py`.

- **Signature:** `repeated_read read:python.py ×3` at the 3rd opening call. With no intervening search/edit,
  this is the **earliest possible** fire.
- **Unproductive re-read, or normal orientation?** Ambiguous — 3 consecutive reads of one large file at the
  very start is plausibly section-by-section orientation, not a dead loop.
- **Injected message:** stop re-reading unchanged; state hypothesis and inspect a different file / edit the
  likely target / run a focused verification.
- **Immediate action after:** edited `python.py` — the **correct** gold file. The guard pushed *toward* the
  right file, not away.
- **Why the patch failed:** patch-quality failure, not file selection. M77 went **edit-led** (5 edits, 0
  searches); the winning M73 run was **search-led** (1 edit, 4 searches). The early "edit the likely target"
  nudge is consistent with the edit-led shift — but a single live sample cannot rule out variance.
- **Would gating suppress it?** Minimum-turn floor (≥4 or ≥6): **yes**. Require ≥1 prior search/edit (V4):
  **yes**. Both preserve `astropy`@13; V4 and the ≥4 floor also preserve `sympy`@5.
- **Classification: guard_plausibly_contributed.** Conservative: not exonerated, not proven causal.

### astropy-14598 — helpful fire (clean cost win)

6 reads of `card.py` across the run with no edit; the streak reached 3 at idx13 → fire → **edit gold
`card.py`** at idx14 → finished **$1.62** (no $3 cap). Cost 3.00→1.62, tool calls 32→19. A min-turn floor
(fires at 13) and V4 (many searches precede idx13) both **preserve** it. Genuinely unproductive loop, broken
before cap danger — the cleanest guard-attributable benefit in the slice.

### sympy-12419 — helpful fire (new win, command-loop)

11 opening Bash calls re-running the **same failing** `python3 -c` probe; `repeated_failed_command ×2` fires
@idx5 → loop broken → inspect + edit → **newly resolved**, $3.00 cap → $1.54. **Not** a read fire, so V4 (which
only gates read-family triggers) leaves it intact; the ≥4 floor preserves it, but a ≥6 floor would **kill**
it — which is why V2/V7 are too aggressive.

### django-16263 — coverage "gap" that isn't a read gap

Raw stream: `query.py` read repeatedly but interleaved with **9 `Edit`s to `query.py`** and **successful**
bash verifies (only `expressions.py` read once besides). This is **single-file edit-verify churn**, not
multi-file read thrash.

- **Why no fire:** each `Edit` resets the read streak (edits = progress, by design) so `query.py` never hits 3
  consecutive reads; the bash verifies succeeded so no `repeated_failed_command`.
- **Would a window detector catch it?** No. The existing `repeated_read_window` (4/6) and the proposed
  distinct-file window both need ≥2 distinct re-read files; here only `query.py` is re-read. A raw
  read-density window that ignored edit resets *could* fire — but it would also fire on legitimate
  edit-verify cycles (false positives).
- **Problem class:** cost / no-convergence (many edit-verify cycles) → candidate **C7** cost-guard territory,
  explicitly out of scope this milestone. **Detector threshold/event-shape changes will not fix this case.**

## Calibration Sweep

Named cases on live M77 streams; cohort recall/FP on the 99-case unguarded M71/M72/M73 cohort
(cap_hit=6, thrashing_signal=3 → recall denom 9; controls = normal_resolved 54 + treatment_only_win 10 +
baseline_only_loss 7 = 71). No gold in detector logic.

| variant | supp pytest? | preserve astropy? | preserve sympy? | catch django-16263? | cap/thrash recall | control FP | early(<4) |
|---|---|---|---|---|---|---|---|
| V0 current | no (FIRE@2) | yes @13 | yes @5 | no | 5/9 | 3/71 | 5 |
| V1 min-turn ≥4 | **yes** | yes @13 | yes @5 | no | 4/9 | 2/71 | 0 |
| V2 min-turn ≥6 | yes | yes @13 | **no (win lost)** | no | 4/9 | 0/71 | 0 |
| V3 read≥3 | no (FIRE@2) | yes @13 | yes @5 | no | 5/9 | 3/71 | 5 |
| **V4 require prior search/edit** | **yes** | **yes @13** | **yes @5** | no | **5/9** | **1/71** | 1 |
| V5 +multi-file window | no (FIRE@2) | yes @13 | yes @5 | **no** | 6/9 | 4/71 | 6 |
| V6 V1+window | yes | yes @13 | yes @5 | no | 5/9 | 2/71 | 0 |
| V7 V2+window | yes | yes @13 | no (win lost) | no | 5/9 | 0/71 | 0 |

- **V3 is a no-op:** the current `repeatedReadThreshold` is already 3, so V3 ≡ V0.
- **V4 wins:** it removes the `pytest` early-read fire **and** 2 of 3 control false-positives
  (`astropy-14539`, `xarray-3677` — both resolved anyway), while preserving **both** helpful fires and
  **full** cap/thrash recall. The only control FP left under V4 is `sphinx-9698`, where a real search/edit
  (idx1) preceded the re-read fire (idx5) — and it resolved anyway.
- **V1** also suppresses `pytest` but costs one unit of recall (it also drops an offline early cap/thrash fire).
- **V2 / V7** are too aggressive — they suppress the `sympy` command-loop win.
- **Multi-file window (V5/C) does not catch `django-16263`** and adds a control FP; it does not address the
  observed failure.

## External Hook Patch Status

- **Installed?** Yes — `STAGE5_TOOL_LOOP_GUARD_HOOK_PATCH` present (×2) in
  `…/vexp-swe-bench/dist/agents/claude-code.js` (11737 B).
- **Backup?** Yes — `…claude-code.js.stage5-vtrace-backup` present, **clean** (6348 B, no guard marker),
  restorable.
- **Default-off safety:** the patch only registers a `--settings` hook **seam**; injection requires
  `--tool-loop-guard-mode inject`. Without inject mode the harness passes no hook settings, so the seam is
  inert. The runner also **fail-closes**: if the marker is absent it records
  `tool_loop_guard_runtime_hook_unavailable_reason` and runs without the hook; the M77 preflight gate requires
  `runtime_hook_available = true` before guarded runs, and `verify-vtrace-patch` reports per-patch + backup state.
- **Recommendation:** **leave installed** (default-off, reversible); keep `verify-vtrace-patch` as a pre-run
  gate. Residual risk is low (a vexp-swe-bench reinstall could clobber the patched dist → re-run
  `install-vtrace-patch`; or dist drift from source). A restore command exists but cleanup is not required now.

## Candidate Next Steps

| option | benefit | risk | recommendation |
|---|---|---|---|
| A larger live validation unchanged | more resolution signal | re-incurs known early-fire pattern; spends money on an un-fixed guard | **no** |
| **B early-fire calibration (V1/V4)** | removes the only regression pattern + control FPs; preserves both helpful fires; offline-measurable | V1 costs 1 recall; V4 minimal | **yes (V4)** |
| C multi-file read-window detector | catches some multi-file thrash | does **not** catch django-16263; +1 control FP | no |
| D B + C | combines | inherits C's FP without solving django-16263 | no |
| E pair with cost guard C7 | targets the true django-16263 failure | C7 out of scope this milestone; larger design | defer (next-next) |
| F keep injection diagnostic-only | zero regression risk | forgoes demonstrated astropy/sympy cap-avoidance | fallback |
| G revert runtime hook | removes external patch | discards a validated, safe, reversible seam with real benefit | no |

## Recommended M79

- **Chosen next step: M79 implement calibrated guard variant (V4), default-off.**
- **Why:** V4 is the only variant that removes the single observed regression pattern (`pytest` early-read
  fire) and reduces control false-positives **without** harming either helpful fire (`astropy` read@13,
  `sympy` command-failure@5) or cap/thrash recall (5/9). It is fully offline-measurable on the M75/M76 replays
  + this sweep before any live spend. The `django-16263` coverage gap is **not** a read-detector problem and
  must wait for a cost/no-convergence guard (C7).
- **Non-goals (unchanged):** no default promotion; no C7 / no-patch-recovery C2 now; no multi-file detector
  (proven not to help here); no broad benchmark; no retrieval/scoring/ranking/Capsule-v2/decision-contract/
  pivot-gate change; do not modify the M77 result; do not revert the (safe, default-off) external patch.
- **Validation gate for M79:** offline re-run must show (a) `pytest`-style early-read fire suppressed,
  (b) `astropy` read@13 + `sympy` command-failure@5 preserved, (c) control FP ≤ V0, (d) cap/thrash recall
  ≥ V0 − 0; then a *small* guarded live re-validation (≤ approval cap), not a broad sweep.

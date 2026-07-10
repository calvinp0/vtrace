# Stage 5 M111 Hard-Stratum Transcript Study

_2026-07-10. Captured-artifact analysis only: no live agents, no Docker, no
API spend, no VEXP, no baseline arms, no V4/C7_D, no revision arms, no
reruns of M105–M108. Plan: `stage5_m111_transcript_study_plan.md` (written
before this report). Machine-readable outputs:
`stage5_m111_hard_stratum_transcript_study.json`,
`stage5_m111_case_classifications.{json,csv}`,
`stage5_m111_next_action_queue.json`._

## Summary

- **Cases analyzed: 21** — all 13 strict live losses from
  `stage5_m109_hard_stratum_analysis.json` (`flip_type=live_loss_vs_M73`),
  both required tool-loop cases (django-16263, pylint-4551), and 6 contrast
  wins (django-10973, astropy-14539, sympy-12419, pylint-8898,
  astropy-14365, sympy-24562).
- **Artifact coverage: 21/21 full** — every case has its captured transcript
  (`_agent_stream.first_pass.jsonl`), ordered tool calls with outputs,
  canonical patch row, eval meta, and capsule manifest. No case fell back to
  summary-only.
- **Main finding:** every strict live loss produced a patch and **edited at
  least one gold file** (13/13; zero wrong-file patches, zero no-patch
  cases). The hard stratum fails on **wrong logic at the gold site** (11/13)
  or **missing the second gold file** (2/13) — never on failing to find the
  code. The shared mechanism is a **verification blackout**: in no loss did a
  repo test suite run (numpy/mpmath/distutils/asgiref missing; pip absent;
  host-pip firewalled by design), so subtle logic choices shipped as one-shot
  bets. Both M109 "deterministic context gap" losses are **non-binding**:
  their transcripts show the agent ruling out the noise pivots and editing
  the gold file anyway.
- **Verdict: PASS.**
- **Recommendation: improve digest/context-action wording** (require an
  explicit EDIT/RULE_OUT decision for every capsule file, especially optional
  co-edit targets), with the verification-oracle prompt-policy audit as the
  next no-spend step.

## Method

- **Artifacts used** (canonical mapping is in the plan, §3): committed
  `stage5_m10{5,6,7,8}_live_runs.detail.json` (validity, resolution,
  changed files), `stage5_m103_deterministic_scoreboard.detail.json` (gold
  files, capsule contents, outcomes — the only gold source, per the schema),
  `stage5_m109_hard_stratum_analysis.json` (flip labels + prior reason
  heuristic), `stage5_m73_final_100_paired_summary.json` /
  `stage5_m92_core_reduction50_validation.json` via the `historical` blocks,
  and the read-only run folders `results/runs/<label>/raw/vtrace/`
  (transcripts, ordered tool calls with outputs, patch rows, capsule
  manifests). One captured M73-era run
  (`runs/m73_stage_c_baseline_astropy_7166`) was read for the
  environment-control comparison. Nothing raw was staged.
- **No-spend/no-rerun confirmation:** the study executed only `bun` over
  local JSON/JSONL plus `bun test`/`tsc`. No agent was spawned, no Docker
  evaluation ran, no API call was made, no M105–M108 case was rerun, no
  V4/C7_D or revision arm was enabled.
- **Classification schema:** the M111 schema, verbatim (plan §7). Machine
  fields (edited-gold sets, patch shape, tool-loop signatures, test behavior)
  are computed by `m111_case_classifier.ts` from the artifacts; judgment
  fields (`context_action_failure_type`, `primary_cause`, `confidence`,
  `evidence_summary`) are analyst transcript readings recorded as an explicit
  per-case table in `run_stage5_m111_hard_stratum_transcript_study.ts`, so
  the machine/judgment boundary is auditable and the outputs reproduce
  byte-identically from the same artifacts.
- **Gold-leakage discipline** (plan §8): behavior narratives are
  transcript-only; gold FILE lists (scoring artifact) were used only for
  post-hoc set comparisons; gold PATCH hunks were not used to judge agent
  logic — "wrong logic" verdicts rest on `resolved=false` with all gold files
  edited plus transcript-visible evidence.
- **Limitations:** exact wrong-logic *mechanisms* are hypotheses where the
  fix never executed (confidence is marked per case; sympy-16766 is `low`);
  the `cost_cap` signature is a proxy (cost ≥ $2.50 or ≥ 90 turns); the
  environment-control comparison rests on one captured M73-era run plus the
  M89/M90A design record.

## Loss Anatomy

Aggregate over the 13 strict losses (per-case rows in
`stage5_m111_case_classifications.json`):

| # | question | count |
|---|---|---|
| 1 | all gold files in capsule | **10 / 13** |
| 2 | lead pivot = source gold | 7 / 13 |
| 3 | edited ≥ 1 gold file | **13 / 13** |
| 4 | edited no gold despite gold in capsule | **0** |
| 5 | produced no patch | **0** |
| 6 | single-file patch on multi-file gold | 2 (xarray-6938, django-12325) |
| 7 | ran the repo's own test suite | **0**; agent-built verification executed in 2 (astropy-7166 standalone metaclass, sympy-15875 /tmp-venv repro) — both passed the agent's oracle and failed eval |
| 8 | any tool-loop/cost signature | 9 (8 × `command_failure_loop` on env failures, 1 × `repeated_read`) |
| 9 | best explained by agent variance | **13 / 13** (11 wrong-logic-at-gold-site + 2 multi-file propagation) |
| 10 | best explained by a binding deterministic context gap | **0 / 13** |

Patch-shape distribution across the losses: 10 × `correct_file_wrong_logic`
(changed = gold, all gold covered, eval failed), 2 × `single_file_patch` on
multi-file gold, 1 × `multi_file_patch` (mpl-24627: gold + one extra
non-gold file). `test_behavior`: 11 × `test_command_failed_infra`, 2 ×
`relevant_tests_passed_but_eval_failed` (the two agent-oracle cases).

**Revision of the M109 split.** M109's summary-level heuristic said
10 agent-variance / 1 single-file-on-multifile / 2 deterministic context
gaps. From transcripts: **13 agent-side / 0 binding context gaps** —
pytest-6197 and sympy-15875 (both M103 `miss`) each explicitly called the
capsule pivots unrelated, searched, and edited the gold file; django-12325
(gold base.py absent from capsule) grepped the error message and found
base.py itself. The context gaps cost search turns, not outcomes. M109's
single-file-on-multifile count also missed django-12325 (its patch was
single-file on a 2-file gold).

## Agent-Variance Cases

The 11 wrong-logic-at-gold-site losses, by what the agent did wrong
(M111 question set §2):

- **Edited the correct location, wrong logic — 11 cases.** astropy-7166
  (inherited docstring onto `fget.__doc__`), django-12273 (inverted the
  pk/ptr sync direction in `_save_parents`), django-12774 (rewrote the
  `in_bulk` uniqueness check so `get_field('pk')` is evaluated on the default
  path — a crash any repo-test run would catch), matplotlib-25960
  (`get_position(parent)` routes through figure margins), pytest-6197
  (removed `+ ["__init__.py"]` from collection patterns), sympy-15875
  (returned `is_zero=None` where the eval expects the provable answer),
  matplotlib-24627 (unset `.axes`/`.figure` across the wrong set of
  collections), django-11490 (dropped the `values_select` guard wholesale),
  django-13551 (hard-coded the `email` attribute name into the token hash),
  sympy-16766 (deviated from the issue's own `str(base)` snippet to
  `self._print(base)`; low confidence), sympy-23413 (bolted a post-loop
  column rescue onto `_hermite_normal_form` instead of fixing pivot
  bookkeeping).
- **Ignored the correct capsule file / never formed a patch / looped on
  tests — 0 cases each.**
- **Failed to propagate a multi-file change — 2 cases** (next section).
- **Stopped after partial validation — the norm, not the exception:** 11/13
  shipped with an explicit "CHECK RUN: could not run" (or syntax-check-only)
  PATCH_VERIFY entry; the other two validated against self-invented oracles
  encoding the wrong expected semantics.

**Common behavior.** The loss profile is remarkably uniform: rule out the
noise pivots correctly (the M12-style decision contracts in the transcripts
are consistently sensible), localize to the gold file, make one plausible
minimal edit, attempt a repro, hit `ModuleNotFoundError`/missing `pip`, note
the failure honestly, and ship. The decisive variable versus the wins is
whether the one-shot logic choice happened to match the expected semantics.

**The environment control.** The captured M73-era run for astropy-7166 hit
the SAME import wall (astropy unimportable under the host Python), built a
standalone metaclass check like the M106 loss did — but asserted
`B.x.__doc__` (the property object's doc, the issue's semantics) instead of
`fget.__doc__`, and resolved. The verification blackout is a standing
property of the live protocol (host Python never had repo deps; M90A only
fenced host-pip mutation), NOT a guard regression — so it does not by itself
explain the M73 delta; it explains why hard-stratum outcomes are
coin-flip-like across arms: they are unverified one-shot logic bets.
Confidence: high for the blackout being standing; medium for the delta
interpretation (single control case).

## Deterministic Context-Gap Cases

**None binding among the strict losses.** Per-case:

- **pytest-6197** (M103 `miss`; capsule led with `assertion/__init__.py` +
  `mark/__init__.py`): transcript shows both pivots inspected and correctly
  ruled out, then targeted search (`git log`, grep for `__init__.py`
  handling) reaching gold `src/_pytest/python.py::pytest_collect_file`.
  Reclassified deterministic_context_gap → agent-side wrong logic.
- **sympy-15875** (M103 `miss`; integrals/agca noise pivots): ruled out in
  the first thinking block; gold `sympy/core/add.py` reached directly from
  the issue text. Reclassified likewise.
- **django-12325** (gold base.py absent; gold options.py present as a
  REQUIRED target): the agent grepped the error string and found base.py
  itself. The absence did not block discovery — but see multi-file below.

Future retrieval/capsule recall work is **not justified by this stratum**:
the M100/M103 mined-out findings stand, and the strict losses never failed
on discovery. (The frozen `no_context` class — 3/100 pool cases — is a
separate, already-tracked question and appears nowhere in this loss set.)

## Multi-File Failures

- **xarray-6938** (gold: dataset.py + variable.py; M103 `excellent`; M73
  treatment resolved): the capsule contained BOTH gold files (variable.py as
  an optional target). The agent's first thinking correctly identified that
  BOTH mutation branches share state (`to_index_variable()` and
  `to_base_variable()` both feed `var.dims = dims`), and it grepped both
  methods in variable.py — then patched only the index branch call-site in
  dataset.py (`.copy()`), leaving its own second suspect untouched. Its
  decision contract enumerated only pivot targets (the DataArray wrapper got
  INSPECT_ONLY_NO_EDIT); **the optional co-edit target variable.py never
  received any explicit decision**. Repro was blocked (numpy). Docker eval
  failed. This is agent-side under-application of context the capsule
  delivered — with a concrete deterministic lever: the contract wording never
  forced a per-file decision on optional targets.
- **django-12325** (gold: base.py + options.py): single-file patch on
  base.py (self-discovered); options.py — gold, in the capsule as REQUIRED —
  got neither an edit nor an explicit co-edit rule-out.
- **Contrast, multi-file golds that did fine:** pylint-8898 (3-file gold)
  RESOLVED with a single-file patch — FAIL_TO_PASS only needed argument.py —
  showing single-file-on-multifile is not automatically fatal; and
  matplotlib-24870 / xarray-6992 (M106, `agreement` losses, not in the
  strict set) carry the same single-file-on-multifile signature with M73
  agreement, i.e. both arms fail there.
- **Did tests reveal the missing second file?** Never — no test execution
  was possible in any of these runs.
- **Would stronger digest wording have helped?** For 6938: plausibly yes —
  the agent had already done the analysis pointing at variable.py; a contract
  slot forcing "EDIT or RULE_OUT variable.py (historical co-edit)" targets
  exactly the omission. For 12325: possibly (options.py was a required
  target with no decision). This is the top-ranked next action. It cannot be
  claimed as a fix without a future guarded confirmation; no live spend now.

## Tool-Loop / High-Cost Cases

- **django-16263** ($3.01, 93 turns, 38 tool calls; 4-file gold, capsule
  carried 1 of 4 — M103 `partial`; M73 also failed): 17 methodical
  exploration calls before the first edit, then 4 edits to sql/query.py
  (`edit_churn`) building a bespoke `get_annotation_refs` stripping pass,
  plus an asgiref/pip env-failure loop, ending at the spend ceiling
  (`cost_cap`) with zero verification. The agent had ONE right file (it
  edited the gold sql/query.py); the other three gold files were absent and
  never reached. Repeated behavior = env-install retries + edit churn, not
  read-thrash or test loops.
- **pylint-4551** ($1.38, 69 turns, 27 calls; 4-file gold, M103 `miss`):
  discovery was instant (recognized the "None"-lexical noise pivots, globbed
  pyreverse, read 2 of 4 gold files), then a feature-scale change (type-hint
  UML support) was attempted as a bolt-on to inspector.py alone amid an
  astroid/pip env-failure loop. Stopped naturally after a syntax check.
- **Would V4/C7_D have fired?** V4 (read-fire) — no: neither case
  read-thrashes (M78 standing: 16263 is edit-churn, not repeated_read; the
  M111 `repeated_read` hit on 16263 is interleaved with edits and below V4's
  calibrated fire condition). C7_D — yes on 16263 (it DID fire at tool-call
  24 in the M85 live trial of this exact case) but demonstrably
  **neutral-late**; the binding loop is env-install retries, which neither
  guard models.
- **Should default-off change?** **No.** M85/M88 evidence stands: the guards
  are safe but do not convert outcomes. The loop class actually observed
  (consecutive `ModuleNotFoundError`/`pip: command not found` failures)
  suggests a different, cheaper diagnostic — ranked #3 in the next-action
  queue as a design-only study.

## Contrast Wins

All six wins operated under the same verification blackout; what differed:

- **django-10973** (excellent capsule, gold lead): fix fully specified by
  the issue (subprocess.run + PGPASSWORD); read gold once, rewrote, 5 tool
  calls, resolved. Deterministic chain delivered the file first.
- **astropy-14539** (gold lead; M7.x recovery): traced `identical` →
  `TableDataDiff._diff`, one-token fix (`"P"` → `"P" or "Q"`),
  grep-verified parity with column.py's VLA detection. Structurally
  determined by code reading.
- **sympy-12419** (overpacked capsule, noise lead; M7.x recovery): ignored
  the noise lead, gold matexpr.py was a required target; `KroneckerDelta`
  fix. Overpacking cost nothing.
- **pylint-8898** (M103 `miss`, multi-file gold; M7.x recovery): the M103 V5
  derived task carried the issue traceback naming
  `argument.py::_regexp_csv_transfomer`; the agent followed it and — key
  contrast — validated with a **faithful standalone oracle** (reimplemented
  the parser, fed it the issue's exact `(foo{1,3})` input). Task-derivation
  structured evidence directly produced a win on a retrieval miss.
- **astropy-14365** (excellent, single-file capsule): grepped the error
  literal, `re.IGNORECASE` + `v.upper()`, standalone-tested `_line_type`
  with the issue's exact lowercase line. Faithful oracle again.
- **sympy-24562** (overpacked, gold lead): derived the string-repetition bug
  from first principles and simulated the exact logic standalone.

Pattern: wins are **one-shot-correct** — either the fix is structurally
determined by issue/traceback/code, or the agent builds an oracle that
mirrors the issue's visible expected behavior verbatim. Losses' oracles,
where they existed, were self-invented and encoded the wrong semantics. The
M95–M104 deterministic improvements explain the *setup* of most wins (gold
lead or gold-in-capsule; the V5 traceback lane explicitly enabled 8898) but
not the win/loss split inside the hard stratum, which is decided at the
logic/oracle level.

## Next-Action Queue

Ranked, no-spend-first (full detail in `stage5_m111_next_action_queue.json`):

1. **Digest/context-action wording** — require an explicit EDIT/RULE_OUT
   decision for EVERY capsule file, optional co-edit targets included.
   Evidence: 6938 (variable.py undecided despite the agent's own analysis),
   12325 (options.py undecided). Expected impact: 1–2 strict losses.
   No-spend first step: change injected text offline + re-audit captured
   M106–M108 contract tables for per-file coverage.
2. **Verification-oracle prompt policy** — when repo tests cannot run
   (standing env property), CHECK RUN must be a standalone oracle mirroring
   the ISSUE's expected output verbatim; a self-invented oracle does not
   count as verification. Evidence: 11/13 shipped unverified or
   wrong-oracle; wins 8898/14365/24562 built faithful oracles. No-spend
   first step: offline audit of PATCH_VERIFY "CHECK RUN" text vs resolution
   across all 97 captured runs.
3. **Env-failure-loop diagnostic (design only, default-off)** — detect ≥3
   consecutive `ModuleNotFoundError`/pip-absent Bash failures and advise
   stopping install retries. Cost lever for the 16263/4551 class; V4/C7_D
   stay default-off.
4. **No retrieval/capsule action for the hard stratum** — 0/13 binding
   context gaps; record and keep the M100/M103 mined-out findings standing.
5. **Defer env provisioning** — changing the agent environment would alter
   the frozen protocol and needs a new preregistered paired arm (live
   spend); explicitly deferred.

**Is live spend justified now? No.** Items 1–3 are all offline; only after
the wording/policy changes exist and pass offline audits would a small
guarded confirmation (the M105 pattern) be worth proposing, separately.

## Claim Boundary

- Internal captured-artifact analysis. **No public SWE-bench pass@1 claim, no
  SWE-bench Verified claim, no VEXP parity/superiority claim, no new live
  result claims** — resolution numbers cited are the already-committed
  M105–M108 results under the M110 denominator rule (100 frozen pool cases /
  97 valid guarded live runs / 3 pre-registered no-context exclusions).
- Wrong-logic mechanisms are evidence-bounded hypotheses where noted; gold
  patch hunks were not used to judge agent behavior.
- "Digest wording would have helped 6938" is a lever hypothesis, not a
  measured effect.

## Success Criteria Check

1. No live agents / Docker / API / baselines / VEXP / V4-C7_D / revision arms run — **PASS** (only bun over local files).
2. M105–M108 committed artifacts reused, not rerun — **PASS**.
3. All strict live-loss cases from M109 included — **PASS** (13/13; the runner fails closed if its loss set diverges from the M109 JSON).
4. Required named cases discussed — **PASS** (all named losses in the loss set; django-10973 / astropy-14539 / sympy-12419 / pylint-8898 are not M109 losses and are covered in the contrast set; mapping documented).
5. Case classifications written to JSON and CSV — **PASS**.
6. Loss anatomy counts reported — **PASS** (10 questions answered).
7. Variance-vs-gap split revisited from transcript evidence — **PASS** (10/1/2 → 13 agent-side / 0 binding gaps, with per-case reclassification records).
8. Multi-file and tool-loop cases specifically analyzed — **PASS**.
9. Contrast wins analyzed — **PASS** (6/6).
10. Next-action queue explicit and no-spend-first — **PASS**.
11. Tests/typechecks pass — **PASS** (`bun test` full suite, `bun run typecheck`, `bun run typecheck:benchmarks`, `git diff --check`).

## Verdict

**PASS**

## Recommendation

**improve digest/context-action wording** — per-file EDIT/RULE_OUT coverage
(optional co-edit targets included) is the one deterministic lever with
direct transcript evidence; pair it with the no-spend verification-oracle
audit (queue #2) before any future live proposal.

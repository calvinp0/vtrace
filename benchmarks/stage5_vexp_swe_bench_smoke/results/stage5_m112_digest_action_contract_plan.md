# Stage 5 M112 — Digest Per-File Action Contract: Pre-Change Plan

_2026-07-10. Written BEFORE implementation, per the M112 protocol. Deterministic
product-wording milestone: no live agents, no Docker, no API spend, no VEXP, no
baseline arms, no V4/C7_D, no revision arms, no retrieval/ranking/capsule-selection
changes. Motivation: the M111 hard-stratum transcript study
(`stage5_m111_hard_stratum_transcript_study.md`), specifically the xarray-6938 /
django-12325 multi-file under-action mechanism and next-action #1 ("Digest per-file
EDIT/RULE_OUT wording")._

## 1. Where is the current digest rendered?

Two layers, both deterministic:

- **Digest text** — `renderCapsuleV2Digest` inside
  `src/capsuleV2/productAdapter.ts` (glyph lines `●`/`○` + `why:` + budget line),
  reached via `toCapsuleV2ProductResponse(result).digest`. The Stage 5 harness wraps
  it in `<VTRACE_CAPSULE_V2_DIGEST_START/END>` sentinels in
  `buildInjectedCapsuleV2DigestBlock`
  (`benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts`,
  ~line 4685).
- **Assembly** — `classifyCapsuleV2Output` (same file, ~line 5028) joins
  `[digestBlock, decisionContractBlock, inspectFirstPart, rendered, neighborhoodText]`.
  Under the frozen default path (M110 manifest) the flags are:
  `--inject-capsule-digest --digest-decision-contract --compact-digest-injection
  --bounded-digest-decisions --pivot-confidence-gate` (compact drops
  `inspectFirstPart`). `rendered` = `renderCapsuleV2Human`
  (`src/capsuleV2/renderHuman.ts`).

## 2. Where is the current decision contract rendered?

`src/capsuleV2/digestDecisionContract.ts`:

- `selectBoundedDigestDecisionTargets` (M58/M65/M68) — required targets = **lead
  pivot + the first hidden/non-traceback co-pivot only**, post-M68 confidence gate;
  impact representatives are optional/FYI (M65 demotion).
- `renderBoundedDigestDecisionContractText` (M59 field grammar) — the
  `<VTRACE_DIGEST_DECISION_CONTRACT_START/END>` block with `target_id: T1…`,
  `decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT`, reason rules, anti-over-edit
  rules, and the O-namespaced optional/FYI list.
- Wired harness-side in `classifyCapsuleV2Output` via `buildDigestDecisionContract`
  (runner ~line 5100); options threaded at ~line 6877–6903.

## 3. What wording does the agent currently see?

- **Lead pivot** — a `T1` required target (`required because: lead pivot`) with an
  explicit three-way decision slot; also `## Recommended first inspection` info in
  the human render and the top digest `●` line.
- **Required files (all pivots)** — ONLY the lead + the first hidden co-pivot get
  decision slots. A second **anchored** pivot (not "hidden") and any third/fourth
  pivot get NO decision slot — only the soft `## Multiple edit targets` prose
  ("Inspect every pivot listed below") and the pivot-inspection-contract checklist
  in the human render.
- **Optional/support files** — rendered as `○ skel` digest lines + signature
  blocks; the contract's optional/FYI section covers only impact representatives
  ("NOT required decision targets; do not edit unless the fix needs it").
- **Co-edit files (M97/M98/M99/M100 lanes)** — enter the capsule as SUPPORT items
  with evidence lines ending in `(co-edit lane)`, `(import-relation lane)`, or
  `(file-evidence rescue)`. They get **no decision slot and no per-file action
  wording at all** — at most a generic `multi_file_coedit` actionability hint when
  that separate detector fires.
- **Digest decisions** — "Close EVERY required target below with exactly one
  decision …" applies only to the T-listed targets.

## 4. Which wording failed to force action in xarray-6938?

Capsule (M103 detail row): pivots = `dataset.py` (lead, gold) + `dataarray.py`
(non-gold); support = `alignment.py` + **`variable.py` (gold, co-edit lane)**. The
bounded contract listed only the two pivots; the agent EDITed dataset.py, gave
dataarray.py INSPECT_ONLY_NO_EDIT — and `variable.py`, a support item whose role
the agent's own analysis implicated, **had no slot anywhere that demanded a
decision**, so it was silently dropped from the patch. django-12325 is the pivot
variant of the same hole: gold `options.py` was a pivot, but with lead + first
hidden co-pivot bounding, a required-file pivot can still end up slotless (and in
the live transcript it received no explicit decision).

## 5. Which file groups receive EDIT/RULE_OUT action wording?

1. **Lead pivot file** (reason label `lead pivot`).
2. **All remaining pivot files** — hidden co-pivots (`hidden pivot`) and anchored/
   other pivots (`required target`), each subject to the SAME M68 confidence gate
   already used for required-target selection when the gate is on (a
   weak-evidence/lexical-only pivot gets no hard action slot — preserving the M68
   anti-over-anchor decision). This covers the M101 anchored-target pivot guard
   files (they are pivots by construction).
3. **High-confidence co-edit / rescue SUPPORT files**, detected from their own
   model-visible evidence markers (exact strings the lanes emit):
   - `(co-edit lane)` → label `co-edit candidate`
   - `(import-relation lane)` → label `import/re-export rescue`
   - `(file-evidence rescue)` → label `file evidence`
   These lanes are already precision-gated at selection time (M98 tiers prune
   low-confidence; M99/M100 are audit-gated) and hard-capped (co-edit ≤ 2 files,
   import rescue ≤ 1 inside that cap, file-evidence rescue bounded), so the action
   list stays small.

Total per-file action entries are capped (6) with a deterministic priority
(pivots first, then lane files in support order); anything dropped by the cap is
counted in the smoke report (no silent truncation).

## 6. Which file groups do NOT receive it (bloat control)?

- Plain support/skeleton files (graph neighbours, weak-direct, lexical support) —
  they keep only a soft one-line note ("Support-only files are context: consult if
  needed; do not treat them as required edits.").
- Impact representatives — remain optional/FYI (M65/M64 evidence: 0/24 edited,
  over-anchor pressure).
- Gate-demoted low-confidence pivots — remain optional/FYI (M68 decision).
- `no_context` capsules — no action list at all (nothing to act on).
- The zero-required gate-demoted-everything contract
  (`NO_HIGH_CONFIDENCE_REQUIRED` marker) — no action list (the gate deliberately
  declared no high-confidence target; a hard action list would contradict it).

## 7. What exact wording will be added?

A new block INSIDE the existing sentinel-wrapped bounded decision contract,
after the required-target field-grammar list and before the anti-over-edit rules
(so the M45 section-priority truncation keeps it atomic with the contract):

```
Per-file action contract (Required / Pivot / Co-edit files):
- EDIT the file if the issue requires a change there.
- Otherwise RULE_OUT the file with one concrete repository-grounded reason
  (code you inspected, a caller/callee relationship, or behavior you verified).
- Do not silently ignore any file listed here.
- If several files are listed, make an explicit EDIT / RULE_OUT decision for
  EACH before finalizing the patch — especially co-edit candidates your own
  analysis touches.

Action required (decide EDIT or RULE_OUT for each file):
- A1: xarray/core/dataset.py — lead pivot
- A2: xarray/core/dataarray.py — hidden pivot
- A3: xarray/core/variable.py — co-edit candidate

Support-only files are context: consult if needed; do not treat them as required edits.
If tests cannot run, that is not evidence of correctness: verify against a
repository-grounded oracle (existing code paths, docstrings, issue reproduction)
or state the uncertainty explicitly.
```

`A#` is a new id namespace, disjoint from required `T#` and optional `O#`, and the
line shape deliberately does NOT match the contract parser's required-target
grammar (`\d+.` / `target:` + `PIVOT|IMPACT`), so `parseDigestDecisionContract`
and the M59 closure-scoring stay byte-compatible. The verification sentence is the
single small generic reminder allowed by the M112 spec (the full oracle policy
audit is M113).

## 8. How does the wording avoid gold leakage?

The action list is a projection of ALREADY-SELECTED capsule items (pivot paths +
support paths with lane evidence markers) plus fixed instruction strings. No gold
patch, FAIL_TO_PASS/PASS_TO_PASS, hints, or scoring diagnostics are inputs to the
selection or the render. The no-agent smoke re-runs the M104-style leak scan
(FAIL_TO_PASS / PASS_TO_PASS ids, forbidden markers, gold-patch text, gold added
lines, with base-commit provenance annotation) over the FULL post-change
model-visible context for every smoke case.

## 9. How will no-agent smoke prove the rendered context changed as intended?

New script `run_stage5_m112_render_smoke.ts` (M104-smoke pattern: local capsule
CLI over the committed clean indexed workspaces; NO agent, NO Docker, NO network):

- builds the frozen-default-path model-visible context per case with the M110
  flag set (digest + contract + bounded + compact + confidence gate + DB-backed
  enrichment provider), via the SAME `classifyCapsuleOutput` +
  `buildVtraceContextMarkdown` the live runner uses;
- runs twice: `--tag pre` at the unmodified HEAD (saved before any src edit) and
  `--tag post` after implementation; full context texts go to an UNTRACKED
  `results/_m112_render/` dir; the committed detail JSON carries hashes, chars,
  flags, and parsed action-list fields only;
- a compare step emits per-case: `pre_digest_chars` / `post_digest_chars` /
  `added_chars`, `action_contract_present`, `per_file_action_count`,
  `required_files_with_action`, `coedit_files_with_action`,
  `support_files_not_overconstrained`, `lead_pivot_action_present`,
  `gold_leakage_status`, `fallback_status`, plus the invariants (§10 of the spec):
  capsule stdout hash equality pre/post (proves the capsule CLI — selection,
  ranking, lead pivot, mode — is untouched), task hash equality and M103
  task-text parity, same capsule files / lead pivot / required T-target list /
  optional list / capsule mode, `no_context` behavior.

## 10. Which cases will be used for smoke checks?

12 cases (all with committed clean indexed workspaces; canonical dataset ids):

| case | why |
|---|---|
| pydata__xarray-6938 | REQUIRED — the motivating co-edit under-action loss |
| django__django-12325 | REQUIRED — multi-file pivot with no decision |
| pytest-dev__pytest-6197 | REQUIRED — M111 recovered miss |
| sympy__sympy-15875 | REQUIRED — M111 recovered miss |
| django__django-16263 | REQUIRED — tool-loop / partial capsule |
| pylint-dev__pylint-4551 | REQUIRED — tool-loop / miss |
| pylint-dev__pylint-8898 | contrast win (miss, task-derivation carried) |
| astropy__astropy-14365 | contrast win + normal excellent single-file case |
| sympy__sympy-12419 | contrast win (overpacked capsule) |
| django__django-10973 | normal excellent/good case |
| django__django-16256 | wrong_pivot case (M103 outcome `wrong_pivot`) |
| django__django-11740 | no_context exclusion (frozen M110 list) — safe render |

## 11. How will token/char impact be measured?

Per-case `added_chars = post_context_chars − pre_context_chars` (and the same
delta restricted to the decision-contract block), reported as full table +
median + p90 in `stage5_m112_digest_action_contract.{md,json}`, with a ~4 chars/
token estimate. Target: small median (≲1 kchar), bounded p90. No live token/cost
measurement.

## 12. What must remain unchanged?

- Retrieval, ranking, candidate generation, capsule file selection, budget
  allocation — proven by pre/post capsule-CLI stdout hash equality per smoke case.
- Structured task derivation (M103/M104 parity) — task text/hash byte-identical.
- Required T-target selection, optional/FYI selection, confidence-gate verdicts,
  contract sentinels, `T#`/`O#` grammar, `parseDigestDecisionContract` +
  `classifyDigestDecisionContract` behavior on existing inputs.
- `no_context` handling (no contract, no action list).
- Non-bounded (M57 legacy) contract render — untouched.
- Live-run guards, protocol flags, ledger conventions.
- Implementation knob: the new block is default-ON for the bounded contract render
  (`perFileActionContract?: boolean` defaults true; `false` reproduces the
  pre-M112 bytes exactly — used by tests and the pre/post diff).

## Success criteria

The M112 prompt's PASS list, verbatim (notably: no live spend of any kind; action
wording present on required cases; xarray-6938 gets explicit per-file action
wording covering variable.py; selection/task-hash/mode invariants hold; leak-clean;
char impact measured; tests + typechecks pass).

## Addendum (pre-capture findings, before any src change)

The PRE render capture (12/12 cases, frozen-path flags, zero unexplained leak
hits, full M103 task parity) exposed two facts that refine §5 — recorded here
BEFORE implementation:

1. **xarray-6938's `variable.py` is NOT a co-edit-lane file in the live render.**
   It enters support via the pivot cap: its `role_reason` is
   `strong target beyond the pivot budget — actionable method — strong lexical
   match; 5 dependents` (the `debugRoles.ts` pivot-cap demotion marker). The
   lane-marker-only selection of §5.3 would miss it. Therefore §5 gains a group:
   **support items whose `role_reason` carries the pivot-cap demotion marker**
   (`strong target beyond the pivot budget`) — pivot-strength candidates the
   budget displaced. Bounded: at most 2 distinct non-pivot files, in support
   (rank) order; measured across the smoke set this adds 0–2 files per case.
2. **The confidence gate demotes xarray-6938's LEAD pivot** (its evidence phrase
   "task names this symbol directly" is not in the M68 strong-clause
   vocabulary), so the T-required set has one target and the lead has no hard
   slot. The action list therefore includes **all pivot files regardless of the
   gate verdict** (labels: `lead pivot` / `hidden pivot` / `required target`).
   Rationale: the gate protects the CLOSURE-SCORED required-target set (M68's
   over-anchor concern); the per-file action list is a lighter decision-hygiene
   obligation where a one-line RULE_OUT is explicitly valid — M111 transcripts
   show agents rule out noise pivots correctly and cheaply. The gate's T/O
   selection itself is NOT touched.

Bloat accounting stays bounded: pivots (≤4 by capsule design, deduped by file) +
lane files (≤2, lanes are selection-capped) + ≤2 pivot-cap-evicted files, all
under a total cap of 6 entries with a `(+N more not listed)` honesty line if the
cap ever binds.

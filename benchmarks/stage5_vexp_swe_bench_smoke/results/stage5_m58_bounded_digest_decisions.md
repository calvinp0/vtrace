# Stage 5 M58 Bounded Digest Decisions

Offline implementation milestone. Revises the M57 digest decision contract so it still
forces an explicit decision per required target, but discourages unbounded exploration
and over-editing — the dominant M57B cost failure (django-13195: 65 turns, 3 files
edited, +32 % tokens). **No live agents, no Docker, no API spend.**

## Summary

- **Flags added/changed:** new `--bounded-digest-decisions` (default off). Requires
  `--inject-capsule-digest` + `--digest-decision-contract`; composes with
  `--compact-digest-injection`. The existing M57 flags are unchanged.
- **Default behavior changed?** No. With the flag absent the contract is byte-identical to
  M57 (verified by test). All new behavior is opt-in.
- **New decision choices:** the contract is now three-way — **EDIT / RULE_OUT /
  INSPECT_ONLY_NO_EDIT** — with explicit meanings and a `files_touched:` line per target.
- **Target selection tightening:** ONE required impact representative by default; a second
  only when it is a distinct `dependent` co-edit candidate (never a mere
  caller/importer/reference). Demoted reps become a non-required OPTIONAL CONTEXT list.
  Hard cap of 4 required targets retained. Each required target carries a `required
  because:` reason (lead pivot / hidden pivot / cross-file co-edit candidate).
- **Compact mode changes:** none to the existing `--compact-digest-injection` (still drops
  the `## VTRACE inspect-first` block, preserves safety blocks). Aggressive compaction was
  evaluated and **deferred** (see below) — implementing it would risk *more* reads, the
  opposite of the cost goal.
- **Classifier changes:** `classifyDigestDecisionContract` now recognizes
  `INSPECT_ONLY_NO_EDIT` (distinct from `RULED_OUT`, `INSPECTED_ONLY`, `IGNORED`) and emits
  `requiredTargetInspectOnlyNoEditCount`, `requiredTargetClosedCount`,
  `requiredTargetOpenCount`.

## M57B Failure Analysis

**What happened on django-13195.** The M57 contract surfaced 4 required targets for the
samesite-cookie issue and told the agent every one must be `EDIT | RULE_OUT`. The captured
trace shows 24 tool calls (8 reads, 7 greps, 6 bash, 3 edits; `repeatedSearch=true`):

- **Over-edit:** the agent edited 3 files — `django/http/response.py` (the two required
  pivots) plus `django/contrib/messages/storage/cookie.py` and
  `django/contrib/sessions/middleware.py`, **neither of which was a required target**. It
  expanded from caller/dependent context into unrelated modules.
- **Repeated reads:** `response.py` was read 3×, `sessions/middleware.py` and
  `tests/sessions_tests/tests.py` 2× each — re-reading the same files after editing.
- **Unbounded exploration:** greps fanned out into `sessions`, `messages`, `global_settings`,
  and the test tree after the initial edits (a long post-edit verification/iteration loop).

**Likely cost drivers.** (1) The two-way contract reads as "edit or justify-not-editing,"
which biases toward editing every surfaced caller. (2) Up to 2 impact representatives were
promoted to *required*, even when they were mere callers — turning blast-radius context into
edit obligations. (3) No explicit "relevant but patch belongs elsewhere" decision, so the
agent had no cheap way to *close* a caller without either editing it or arguing a rule-out.
(4) No guidance against re-reading or expanding from an impact rep.

**Why M58 should reduce them.** The three-way decision gives a first-class way to close a
relevant caller without editing (`INSPECT_ONLY_NO_EDIT`). Tighter selection stops promoting
mere callers to required targets (the 2nd caller becomes optional context). Anti-over-edit
rules explicitly forbid expanding from an impact rep into unrelated callers and discourage
repeated reads. On the exact django-13195 impact shape this drops the required set from 4 to
3 and moves `sessions/middleware.py` out of the required list entirely.

## Contract Format

### Before (M57, two-way) — django-13195 shape

```
Required targets:
1. PIVOT django/http/response.py::delete_cookie
   decision: EDIT | RULE_OUT
   reason: samesite handling for cookies
2. PIVOT django/http/response.py::set_cookie
   decision: EDIT | RULE_OUT
   ...
3. IMPACT django/contrib/admin/options.py::response_action
   decision: EDIT | RULE_OUT
4. IMPACT django/contrib/sessions/middleware.py::process_response   ← mere caller, still required
   decision: EDIT | RULE_OUT
```

### After (M58, bounded three-way) — same shape

```
Close EVERY required target below with exactly one decision: EDIT, RULE_OUT, or INSPECT_ONLY_NO_EDIT.
A required target does NOT mean a required edit.

Decision meanings:
- EDIT: I changed this target because it is necessary for the fix.
- RULE_OUT: I inspected or reasoned about this target and it does not need changes because <reason>.
- INSPECT_ONLY_NO_EDIT: I inspected this target, confirmed it is relevant context, but the correct patch belongs elsewhere.

Required target decisions:
1. PIVOT django/http/response.py::delete_cookie
   required because: lead pivot
   decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT
   reason: samesite handling for cookies
   files_touched: <paths or none>
2. PIVOT django/http/response.py::set_cookie
   required because: hidden pivot
   ...
3. IMPACT django/contrib/admin/options.py::response_action
   required because: cross-file co-edit candidate
   decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT
   ...

Anti-over-edit rules:
- Required target does not mean required edit.
- Prefer RULE_OUT or INSPECT_ONLY_NO_EDIT when the target is only a caller/dependent.
- Do not edit impact representatives unless the issue behavior requires a co-edit.
- Do not expand from an impact representative into unrelated callers.
- Avoid repeated reads of the same file unless new evidence changes the hypothesis.
- Stop after each required target has EDIT / RULE_OUT / INSPECT_ONLY_NO_EDIT.

Optional context (NOT required to decide; do not edit unless the fix needs it):
- IMPACT django/contrib/sessions/middleware.py::process_response — optional context only: additional dependent/caller
```

The required set shrinks from **4 → 3**; `sessions/middleware.py` (a mere caller) moves to
optional context; the bounded decision table adds `required because:` and `files_touched:`.

## Target Selection

| | Old rule (M57) | New rule (M58 bounded) |
|---|---|---|
| lead pivot | required | required (`required because: lead pivot`) |
| hidden/non-traceback pivot | required if distinct | required if distinct (`required because: hidden pivot`) |
| impact representatives | up to **2**, any role | **1** by default (`cross-file co-edit candidate`); a 2nd only if it is a distinct `dependent` |
| mere caller/importer/reference (extra) | could become a 2nd required target | demoted to **OPTIONAL CONTEXT** (not a required decision) |
| hard cap | 4 | 4 (unchanged) |

Required vs optional: required targets are numbered (`N. KIND target …`) and parsed as
required by `parseDigestDecisionContract`; optional context is a separate non-numbered
bullet list and is **never** counted as a required target (test-enforced).

## Classifier

Statuses (per required target):

| status | meaning |
|---|---|
| `EDITED` | target path modified (read before edit) |
| `EDITED_WITHOUT_INSPECTION` | modified but never read first |
| `RULED_OUT` | explicit "does not need changes because <behavioral reason>" |
| `INSPECT_ONLY_NO_EDIT` | **new** — explicit "inspected, relevant, but the patch belongs elsewhere" |
| `INSPECTED_ONLY` | read/opened, no explicit decision text |
| `IGNORED` | not read, edited, or decided |
| `INVALID_RULE_OUT` | decision text exists but no behavioral reason / doesn't refer to the target |

Aggregate counts:

- `requiredTargetClosedCount = EDITED (incl. without-inspection) + RULED_OUT + INSPECT_ONLY_NO_EDIT`
- `requiredTargetOpenCount = IGNORED + INSPECTED_ONLY + INVALID_RULE_OUT`
- closed + open = `requiredTargetCount` (test-enforced partition).

`INSPECT_ONLY_NO_EDIT` takes precedence over a generic rule-out when both patterns match
(it is the more specific decision). The detector scans per sentence-unit so the
marker/prose and the target name stay scoped together.

**Limitations.** Decision detection is pattern-based over the agent's final text (no second
model call). A genuinely inspect-only decision phrased without any of the recognized cues
falls back to `INSPECTED_ONLY` (counted as *open*, conservatively). The classifier reads the
final patch + tool trace, so an edit that is later reverted in the same patch is not tracked.

## Compact Injection

- **What changed:** nothing in the existing `--compact-digest-injection`. It still removes
  only the `## VTRACE inspect-first` block (a re-ranked restatement of the digest's pivots)
  and preserves the digest, decision contract, focused source bodies, neighborhood, and all
  safety blocks.
- **What remains preserved for safety:** PIVOT_CHECK, EDIT_GUARD, PATCH_VERIFY, and the
  token-discipline / tool-use-discipline guidance — under both compact and bounded modes
  (test-enforced: `bounded + compact keeps digest and decision sentinels and drops
  inspect-first`).
- **Aggressive compaction — DEFERRED (not implemented).** After the inspect-first block, the
  only remaining injected sections are the focused source render (`renderCapsuleV2Human`,
  which carries the actual pivot source bodies) and the pivot-neighborhood excerpts. Neither
  is duplicated by the digest — the digest carries identities + `why:`, **not** full source.
  Dropping them would force the agent to re-read those files, increasing reads/turns/cost —
  the exact regression M58 is trying to bound. The M58 levers (three-way decision, tighter
  selection, anti-over-edit wording) address cost without risking that, so an
  `--compact-digest-injection-aggressive` level is deliberately deferred rather than shipped
  as a risky default-off knob with no safe content to remove.

## Tests

Added/updated (offline only; no live agents, no Docker):

- `src/capsuleV2/digestDecisionContract.test.ts` (+11 M58 tests): default contract is the
  unchanged M57 two-way render; bounded contract is opt-in and renders the three-way
  decision; all three decision meanings present; anti-over-edit wording present; required cap
  ≤ 4; second impact rep conditional (caller → 1 required + 1 optional; dependent → 2
  required); optional reps not parsed as required; empty render with no targets; classifier
  detects `INSPECT_ONLY_NO_EDIT` and separates it from `RULED_OUT`; closed/open counts
  partition the targets.
- `benchmarks/stage5_vexp_swe_bench_smoke/digest_decision_contract_injection.test.ts` (+3
  assembly tests through the real `classifyCapsuleOutput` path): bounded off by default;
  `--bounded-digest-decisions` renders the three-way contract + anti-over-edit guidance;
  bounded + compact preserves digest/decision sentinels and still drops inspect-first.
- Updated the existing "counts partition" M57 test to include the new
  `INSPECT_ONLY_NO_EDIT` term in the partition sum.

Verification results:

- `bun test` → **3088 pass / 0 fail** (was 3074; +14 net new).
- `bun run typecheck` → clean.
- `bun run typecheck:benchmarks` → clean.
- `git diff --check` → clean.
- CLI guard verified: `--bounded-digest-decisions` without its prerequisites errors with
  *"--bounded-digest-decisions requires --inject-capsule-digest and --digest-decision-contract."*

## Next Recommended Validation

A small, ≤ 6-live-run A/B **after this commit**, comparing the **M57 contract** vs the
**M58 bounded contract** on the same 3 A+D cases (sphinx-7462, django-11820, django-13195),
reusing the M57B `m57b_vtrace_digest_contract_*` runs as the M57 arm:

- 3 new M58 runs: `--inject-capsule-digest --digest-decision-contract
  --compact-digest-injection --bounded-digest-decisions` (force-inject, v2, debug, 8000).
- Primary metrics: required-target **closed/open** counts, tokens/turns/repeated-reads, and
  edited-files-outside-required-targets (the over-edit signal). Hypotheses:
  django-13195 turns/tokens fall and the off-target edits disappear; required-target closure
  holds or improves via `INSPECT_ONLY_NO_EDIT`.

Do **not** run it as part of this milestone (offline only).

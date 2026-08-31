# M193C — non-invasive patch snapshot authority

**Verdict: M193C — PASS.** Intermediate patch observation is now truly
non-invasive, and so is the final extraction: both run the same read-only
authority, and the final patch it produces is byte-identical to the one the
invasive capture produced in M193, M193A and M193B.

**Authorisation: `M194_PATCH_OBSERVATION_READY`.**

Zero live model calls. Zero live model spend. No VTRACE product code changed.

---

## 1. What was wrong

`M193Container.capture_diff()` ran:

```bash
git -c core.fileMode=false add -A -- . <exclusions> >/dev/null 2>&1
git -c core.fileMode=false diff --cached
rc=$?; git reset -q >/dev/null 2>&1; exit $rc
```

Staging was being used as a *query* — the idiom for "show me everything
including untracked files in one command". It read the working tree correctly
and wrote to the subject to do it. `git reset` is a mixed reset, so **every diff
snapshot emptied the agent's index**.

M193B fixed exactly this idiom in the changed-source authority and recorded the
patch boundary as an unfixed residual, on the grounds that it must stage to get
untracked files into a unified diff. That premise turned out to be false; §4
below is the read-only construction it was thought to lack.

### The mutation, reproduced (G1)

On a fixture holding `A.py` staged as S1 with worktree S2, a staged deletion and
a staged rename, measured either side of one capture:

| | before | after |
|---|---|---|
| `A.py` index blob | `0555510…` (S1) | `d4c0a80…` (HEAD) |
| `A.py` status | `MM` | `.M` |
| `D.py` | staged deletion | unstaged deletion |
| `E_old.py → E_new.py` | staged rename (`2 R.`) | unstaged delete **+ untracked `E_new.py`** |

The purity instrument reports `["status changed", "index changed", …]`. On the
two real SWE-bench containers it reports **6 mutations** for the superseded
command and **0** for the replacement, on the identical tree.

`m193cPatchSnapshot.test.ts` runs the superseded command deliberately, as its
first control. A purity assertion that has never seen an impure observation has
not been shown to be able to fail.

---

## 2. Starting state

| | |
|---|---|
| branch | `main` |
| starting SHA | `858b93027ddb3441306f9c09f67dd42fbef363c6` (matches the expected M193B SHA) |
| ahead / behind `origin/main` | 159 ahead, 0 behind |
| pre-existing tracked dirt | `results/stage5_outcome_ledger.{json,md}` — predates this work, preserved untouched |
| pre-existing untracked dirt | 203 paths — preserved |
| `git diff --check` | clean |

---

## 3. The read-only patch authority

`m193c_patch_snapshot.py`, `stage5.m193c.patch-snapshot-authority.v1`. PURE: it
builds one shell string and parses one stdout, so the exact bytes production
runs are executed against real Git by the test suite.

**Tracked changes, staged and unstaged, as current bytes.**
`git diff --no-renames HEAD` compares the frozen base commit to the *working
tree*. That is what makes the staged/unstaged distinction irrelevant to the
answer while leaving it intact in the repository: a file staged as S1 and then
edited to S2 is reported as S2, and the index is never consulted as a staging
area.

**Untracked files.** `git ls-files --others --exclude-standard` enumerates them
under normal gitignore rules and the pre-agent exclusion pathspec; each one is
then rendered by `git diff --no-index -- /dev/null <path>`. Git special-cases
`/dev/null` here and emits the canonical `diff --git a/P b/P` plus
`new file mode` header — byte-for-byte what staging the file would have
produced. This is the fact M193B's residual note was missing: the untracked lane
costs no index write and no object write.

**Deletions and renames.** Deletions come out of the tracked lane directly.
`--no-renames` keeps both halves of a move: rename detection has been on by
default since git 2.9 and collapses a move to a single `R100` whose body is
`similarity index` and *none of the new file's content*. Delete-plus-add is the
representation §19 permits, and is what the M193B changed-source authority
already reports.

**Why it mutates nothing.** Every verb is a reader. The test asserts the
complete verb set of both command builders is exactly
`["diff", "ls-files", "rev-parse", "status"]`, so a mutating verb cannot be
added without failing. Nothing is staged and restored, so there is no rollback
window, no clean-filter invocation, and no corruption if the process dies
mid-capture.

**Canonicalisation.** The two lanes are chunked per path and merged in git's own
path order (bytewise), so the byte sequence does not depend on which lane a file
arrived through or on filesystem traversal order. The tracked chunk count is
cross-checked against an independently enumerated `--name-only -z` list.

**File mode.** The tracked lane runs under `core.fileMode=false`, where git does
not trust the executable bit and `add -A` recorded every new file `100644`. The
untracked lane reads the bit from the filesystem and would say `100755`. The
clamp keeps one mode policy across both halves and preserves exactly the bytes
the staging capture produced; the observed mode is recorded in
`untrackedRealModes` rather than erased. Symlinks (`120000`) are a different
object type and pass through.

**Binaries.** Classified in `binaryPaths` and left as git's own truthful
`Binary files … differ` line. Such a patch was not appliable before M193C
either — measured: both the old and the new capture fail `git apply` on the same
binary, identically. The classification makes a pre-existing limitation visible
instead of silent.

**Failure semantics (§30).** Each section reports its own exit status. A
snapshot that did not demonstrably complete returns `PATCH_SNAPSHOT_UNKNOWN`
with an empty patch **flagged as a refusal**, never an empty patch that reads as
"no changes". A state that cannot be represented truthfully is refused; the
repository is never written to in order to make it representable.

---

## 4. Behavioural difference from the superseded capture

Measured by running both against two identical pristine fixtures containing
every state class:

| difference | disposition |
|---|---|
| untracked files interleaved in path order rather than appended | canonicalisation; matches git's own `diff --cached` ordering |
| rename as delete+add rather than `R100` | §19 permits it; it also carries the new file's content, which `R100` does not |
| `X.sh` mode | **no difference** — the clamp reproduces the old `100644` |
| everything else | **byte-identical** |

Applying both patches to the same base commit produces byte-identical trees with
identical file modes. Grader semantics are unchanged.

---

## 5. Git-state purity matrix (§20)

`m193cPatchSnapshot.test.ts` — 23 tests, 119 assertions, all passing. Each case
is built in a fresh repository, fingerprinted, observed, fingerprinted again.

| case | patch correct | index | worktree | untracked | status |
|---|---|---|---|---|---|
| P1 staged only | PASS | PASS | PASS | PASS | PASS |
| P2 unstaged only | PASS | PASS | PASS | PASS | PASS |
| P3 staged S1 + unstaged S2 | PASS (`+S2`, no `+S1`) | PASS | PASS | PASS | PASS |
| P4 untracked only | PASS | PASS | PASS | PASS | PASS |
| P5 deletion | PASS | PASS | PASS | PASS | PASS |
| P6 rename | PASS (both halves, no `similarity index`) | PASS | PASS | PASS | PASS |
| P7 mixed all classes | PASS | PASS | PASS | PASS | PASS |

Also covered: pre-agent untracked exclusion, path-order determinism, repeat
determinism, empty untracked file, untracked binary, executable bit, Git-state
classification, and four §30 refusal cases including a clean tree that must be
`OK` and empty rather than a refusal.

### §14 — the primary falsification

| | |
|---|---|
| staged blob | `git rev-parse :A.py` |
| worktree blob | `git hash-object A.py` (different) |
| captured patch | contains `+S2`, does not contain `+S1` |
| index after | staged blob unchanged |
| worktree after | worktree blob unchanged |
| status after | `MM A.py` |
| mutations | none |

---

## 6. Real-container proof (§21)

`run_stage5_m193c_container_control.py`, both instances `CONTROL_PASSED`.

| | `psf__requests-1142` | `pallets__flask-5014` |
|---|---|---|
| pre-agent untracked | `['build']` | `[]` |
| clean tree answers empty, 0 moved | PASS | PASS |
| all 7 state classes represented | PASS | PASS |
| **mutations attributable to observation** | **0** | **0** |
| status / index / staged blob unchanged | PASS | PASS |
| captured worktree bytes, not staged bytes | PASS | PASS |
| pre-agent `build/` excluded from patch | PASS | PASS |
| superseded command, same tree | **6 mutations**, staging destroyed | **6 mutations**, staging destroyed |

The last row is the point: the fingerprint is shown to report a real mutation on
the same tree where it reported none, so `0` is a measurement and not an
instrument that cannot fail.

---

## 7. Fake-agent staged-state proof (§22)

Every earlier fake agent left the index empty, which is why M193A and M193B both
shipped an instrument that silently wiped it — the synthetic subject could not
do the thing that would have exposed the defect. The dry-run lifecycle now
stages deliberately:

1. edit the package `__init__` to value 1 and create the test file
2. **`git add`** both — the index now holds the first edit
3. validation 1 (fails, as designed)
4. edit to value 222, *unstaged* — the §14 state now arises from the lifecycle
   rather than from a fixture
5. the agent reads back `git status --porcelain=v2` and `git ls-files -s`
6. validation 2 (passes, so the interpreter read the worktree)

All five instances:

| instance | observations | all pure | all answered | index identical | patch holds S2 | patch omits S1 | index still holds S1 |
|---|---|---|---|---|---|---|---|
| `django__django-10880` | 6 | yes | yes | yes | yes | yes | yes |
| `pallets__flask-5014` | 6 | yes | yes | yes | yes | yes | yes |
| `psf__requests-1142` | 6 | yes | yes | yes | yes | yes | yes |
| `pytest-dev__pytest-10051` | 6 | yes | yes | yes | yes | yes | yes |
| `sympy__sympy-12419` | 6 | yes | yes | yes | yes | yes | yes |

**30 observations, 0 impure, 0 refusals.**

The comparison operand is the **index**, not the whole status. The agent makes
an unstaged edit of its own between the two reads, so `git status` is *supposed*
to differ; comparing it whole would be a check that can never pass, which is no
more useful than one that can never fail. Nothing touched the index after
`git add`, so the index must be byte-identical — and is. The status change is
separately recorded and attributed to the agent's own edit.

---

## 8. Observation-mutation inventory (§28)

`run_stage5_m193c_inventory.ts` scans nine acquisition sources for
`add|reset|restore|checkout|stash|commit|mv|rm|apply|update-index` and classifies
every occurrence by the label it executes under. 26 occurrences:

| category | count |
|---|---|
| documentation (comment / docstring) | 8 |
| report text (a string describing a command, not running one) | 5 |
| setup (before the agent exists — `git checkout -f <base>`) | 1 |
| agent action (the subject's own staging, rename, gold apply) | 8 |
| falsification control (the superseded command, run to prove impurity is detectable) | 4 |
| **observation** | **0** |
| unclassified | 0 |

Verdict `NO_INTERMEDIATE_OBSERVATION_MUTATES`. All three pure command builders
(`patch_snapshot_command`, `repository_state_command`, `changed_source_command`)
contain zero mutating verbs.

The zero is a measurement, not an artefact: the classifier has explicit rules
mapping observation labels to `observation`, and a **synthetic impure
observation** — `git add … git reset` under `label="capture_diff"` — is pushed
through the same classifier and confirmed to land in that category
(`gateCanFail: true`). Without that, nothing could ever be classified
`observation` and the count would be zero by construction, which is the M193B
"guard whose two operands come from the same array" failure.

---

## 9. Regression controls

| control | result |
|---|---|
| synthetic lifecycle fixtures | 16/16 agree, frozen corpus expectation holds |
| source-version stale-cache control | `CACHE_STALE_AND_ACCEPTED` 5/5 |
| source-version healthy control | `CACHE_MATCHES_CURRENT_SOURCE` 5/5 |
| poisoned-copy control | agrees 5/5 |
| changed-source authority | unchanged; M193B controls re-run and pass |
| treatment isolation | `TREATMENT_ISOLATION_GUARANTEED_BY_CONSTRUCTION`, unchanged |
| evaluator | resolved all 5 |

`results/stage5_m193c_analysis.json` is **byte-identical to
`stage5_m193b_analysis.json`** on every field — `dryRun`, `fixtures`, `gates`,
`allGatesPass`. Per-instance source-version verdicts are preserved exactly,
including the three `SOURCE_VERSION_AMBIGUOUS` v2 events.

---

## 10. Patch identity (§26)

Five repositories, `IDENTICAL_STRICT` 5/5 — interactive final diff ==
extracted prediction == evaluator-applied patch, under frozen normalisation.

| instance | final patch hash | vs M193 / M193A / M193B |
|---|---|---|
| `django__django-10880` | `sha256:228e2c04b809343c14f0d2…` | identical |
| `pallets__flask-5014` | `sha256:f0e6d1dad1b3574ecfe8d4…` | identical |
| `psf__requests-1142` | `sha256:7fee122fc360bf1db26a28…` | identical |
| `pytest-dev__pytest-10051` | `sha256:5027a6ff0cd247be24d02c…` | identical |
| `sympy__sympy-12419` | `sha256:18794d75ba41397df2db6f…` | identical |

`matchesGoldNormalized` is `false` on four and `true` on sympy, and
`matchesGoldIgnoringHunkContext` is `true` on all five — the same pattern as
M193, M193A and M193B. That is the documented `@@`-funcname relaxation, not an
M193C effect.

### Final extraction (§27)

Converged onto the same read-only authority rather than left with the weaker
constraint that would have been permissible after the agent stops. Nothing
argued for keeping a second mechanism: the final patch is index-independent, and
the dry run now proves it — the fake agent leaves a staged blob and a staged
add-of-a-since-deleted file in the index all the way to submission, and the
final patch is unaffected.

| | |
|---|---|
| intermediate observation | strictly read-only; enforced by construction, measured at every boundary |
| final post-agent extraction | same authority, same guarantees |

---

## 11. Frozen experiment integrity

| | |
|---|---|
| task fixture | `e79843d3b93d4c77551911a92eed9b316c57b5045ff7e7ef75018efb2e9aaca4` — unchanged, verified mechanically |
| 40 instances / 12 repositories | unchanged |
| model | `claude-opus-4-5-20251101` |
| CLI | `2.1.251` |
| turns | 250 |
| per-run / total cap | $3.50 / $90 |
| arm bounds / concurrency | 20..40 / 3 |
| adequacy | unchanged |
| stopping rule | unchanged |
| I6 usability rule | unchanged |
| source-version authority | unchanged |
| changed-source enumeration fail-closed rule | unchanged (§31) |

**Expected semantic changes: none.**

---

## 12. Manifest

| | |
|---|---|
| M193B manifest hash | `c544fba670e4466fc3e6034c7bf518328c1f736c52c6d83c1e053345592de8ca` (verified before deriving) |
| M193C manifest hash | `f735786bf7d3437a095abdcc7e8704cb6769fd32eb46b37ad8fc373850282204` |
| added leaves | 25 (`patchSnapshotAuthority.*`, `observationPurity.*`) |
| changed leaves | 7 (`schemaVersion`, `milestone`, `derivedFrom.*`, `frozenSources`) |
| removed leaves | 0 |
| **leaves outside M193C integrity scope** | **0** |
| frozen-experiment invariants | 21/21 hold |

---

## 13. Integrity gates

| gate | result |
|---|---|
| G1 current invasive behaviour reproduced | PASS |
| G2 intermediate snapshot performs no `add`/`reset`/`restore`/`checkout` | PASS |
| G3 staged state preserved | PASS |
| G4 unstaged state preserved | PASS |
| G5 untracked state preserved | PASS |
| G6 deletion / rename state preserved | PASS |
| G7 staged S1 + unstaged S2 captures S2, preserves S1 | PASS |
| G8 mixed P1–P7 matrix | PASS |
| G9 real SWE-bench container controls | PASS (2/2) |
| G10 fake agent stages and later observes unchanged index | PASS (5/5) |
| G11 changed-source authority regression controls | PASS |
| G12 source-version stale / healthy / poisoned controls | PASS (5/5 each) |
| G13 treatment isolation unchanged | PASS |
| G14 synthetic lifecycle fixtures | PASS (16/16) |
| G15 patch identity `IDENTICAL_STRICT` | PASS (5/5) |
| G16 frozen experiment parameters unchanged | PASS (21/21) |
| G17 manifest changes only integrity leaves | PASS (0 outside scope) |
| G18 zero live model calls | PASS |

---

## 14. Remaining acquisition-integrity limitations

These are genuine and recorded rather than fixed. None of them blocks M194.

- **A binary file cannot be carried in the model patch.** Neither the old nor
  the new capture passes `--binary`, so an agent that adds a binary produces a
  patch `git apply` refuses. M193C makes the condition *visible*
  (`binaryPaths`), which it was not before, but does not change what the patch
  can express. No SWE-bench instance in the frozen fixture is expected to need
  one.
- **A path git has to quote is refused, not mis-split.** Inherited from M193B
  and deliberate: the tracked lane's sort keys come from `--name-only -z`, so a
  quoted path no longer breaks the ordering, but the changed-source authority
  still fails closed on one.
- **Submodules are not modelled.** `diff HEAD` reports a gitlink change, which
  is truthful but is not a patch the evaluator can apply.
- **A snapshot is not atomic with respect to a concurrently running agent.** All
  sections run inside one shell invocation, which is as close as a
  non-locking observation can get; a tree that moves mid-capture is caught by
  the chunk/name cross-check and refused rather than mis-reported.

---

## 15. Verification

```
bun run typecheck                       PASS
bun run typecheck:benchmarks            PASS
bun test                                see §16 of the session report
git diff --check                        clean

synthetic Git-state matrix              23 pass / 0 fail / 119 assertions
real container purity controls          2/2 CONTROL_PASSED
fake-agent staged-state dry run         5/5 DRY_RUN_LIFECYCLE_OK, 30 pure observations
source-version regressions              stale 5/5, healthy 5/5, poisoned 5/5
changed-source regressions              32 pass / 0 fail
treatment-isolation regressions         GUARANTEED_BY_CONSTRUCTION
lifecycle fixtures                      16/16
patch-identity dry run                  IDENTICAL_STRICT 5/5
manifest integrity analysis             0 leaves outside scope, 21/21 invariants

live-agent runs: 0
live model spend: $0
```

---

## 16. Authorisation

```
M194_PATCH_OBSERVATION_READY

SOURCE-VERSION AUTHORITY        READY
TREATMENT ISOLATION             READY
CHANGED-SOURCE AUTHORITY        READY
PATCH OBSERVATION               READY

NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
```

M194 still requires explicit user approval of the frozen live spend.

# M193B — Changed-source authority closure

**Verdict: M193B — PASS.** The `--cached` concern was **both**: the M193A report's
prose was inaccurate *and* the implementation it under-described carried two real
defects. Both are repaired, and the frozen experiment is untouched.

- live-agent runs: 0
- live model spend: $0

---

## 1. What the report said, and what the code did

M193A's report and design both named the changed-source set as:

```
git diff --cached --name-only
```

The committed implementation — `M193Container.changed_source_paths()` in
`m193_container_adapter.py` — was three lines, not one:

```
git -c core.fileMode=false add -A -- . <pre-agent exclusions>   >/dev/null 2>&1
git -c core.fileMode=false diff --cached --name-only
git reset -q                                                    >/dev/null 2>&1
```

Staging was being used as a **query**: `add -A` forces unstaged and untracked
work into the index so that one `--cached` command can see it. That is why the
report's quote was of the middle line only, and it is why the enumeration was
*mostly* right — it did see unstaged edits, untracked files and deletions.

It was wrong in two ways that only appear when you ask what the command *writes*
and what rename detection *does*.

**It wrote.** `git reset` is a mixed reset. Every observation unstaged whatever
the agent had staged. A Claude Code arm has `Bash`; an arm that runs `git add`
and then hits a validation boundary would have found its index silently emptied
by the instrument measuring it. §3 forbids exactly this.

**It lost renames.** `diff.renames` has defaulted to true since git 2.9, so a
move is reported as `R100 old new` and `--name-only` prints only `new`. The
vacated path left the changed set entirely — which means the probe's
"source is gone but a sourceless `.pyc` still stands in for it" branch
(`m193a_source_version_probe.py`, the `not os.path.isfile(path)` case) could
never run on the one class of path where it matters. §11 requires that a
deletion cannot disappear, and a rename is a deletion of the old path.

A third defect fell out of reading the evidence record it feeds:
`source_version_evidence()` set `changedSourceFileCount` to `len(probe["files"])`
— the same array `fileVerdicts` is built from. `classifySourceVersion`'s guard

```ts
if (ev.fileVerdicts.length !== ev.changedSourceFileCount) return "SOURCE_VERSION_AMBIGUOUS";
```

was therefore comparing a list against itself. It could not fail, so it was not
a check.

## 2. The repaired authority

`benchmarks/stage5_vexp_swe_bench_smoke/m193b_changed_source.py` — pure, no
Docker SDK, so the exact bytes production runs are executable by `bun test`:

```
git -c core.fileMode=false diff --no-renames --name-only HEAD -- . <excl>; echo "__M193B_TRACKED_RC=$?"
git -c core.fileMode=false ls-files --others --exclude-standard  -- . <excl>; echo "__M193B_UNTRACKED_RC=$?"
```

| region of Git state | read by |
| --- | --- |
| index vs base | `diff … HEAD` (HEAD is the base commit `setup()` checks out with `-f` and verifies) |
| worktree vs index | same command — `diff HEAD` spans both |
| untracked | `ls-files --others --exclude-standard` |
| deletions | `diff … HEAD`, as a plain path |
| renames | `--no-renames` forces the pair back into a separate D and A |

Nothing is staged, so an arm's own index survives. `--exclude-standard` gives
untracked files normal gitignore treatment (§9), and pre-agent untracked output
is excluded by the pathspec built from `setup()`'s frozen snapshot (§10) —
unchanged from M193A.

Each half reports its own exit status, because "git printed nothing" and "git
failed" are the same empty stdout and must not be the same answer. An
enumeration that did not demonstrably complete yields `probeRan=false`, hence
`UNKNOWN` — never an empty changed set that would read as nothing-to-check.

`changedSourceFileCount` now comes from the enumerated set (`requestedPaths`),
which makes the completeness guard falsifiable for the first time.

## 3. Cached-only anti-control

Run against the fixture repository, which carries every change class at once:

| class | `git diff --cached --name-only` alone | repaired authority |
| --- | --- | --- |
| C1 unstaged modification | **missed** | found |
| C2 staged modification | found | found |
| C3 staged + further unstaged | listed (via the staged S1) | found |
| C4 new untracked source | **missed** | found |
| C5 deleted tracked file | **missed** | found |
| C6 rename — new path | found | found |
| C6 rename — vacated path | **missed** | found |
| C7 mixed multi-file | 3 of 7 paths | 7 of 7, each once |

The superseded three-line implementation was also replayed, on a throwaway copy
of the fixture and on both real containers. It recovered C1/C4/C5 — and still
missed the vacated rename path, and still emptied the agent's index.

## 4. Change-class matrix (real containers, §14)

`run_stage5_m193b_container_control.py`, no LLM, results in
`stage5_m193b_container_control.json`.

| | psf__requests-1142 | pallets__flask-5014 |
| --- | --- | --- |
| clean tree enumerates to nothing | yes | yes |
| C1 unstaged tracked edit | found | found |
| C2 staged modification | found | found |
| C3 staged S1 + unstaged S2 | found | found |
| C4 untracked new source (`Write`) | found | found |
| C5 deletion | found | found |
| C6 rename — both sides | found | found |
| C7 union, exactly once | 7 paths | 7 paths |
| pre-agent untracked excluded | `build/` excluded | (none present) |
| `git status` unchanged by observation | yes | yes |
| agent's staged paths survive | 3 of 3 | 3 of 3 |
| `changedSourceFileCount` == verdict count | 7 == 7 | 7 == 7 |
| superseded command on the same tree | 6 paths, lost the rename, emptied the index | same |

`psf/requests` is the mandated regression control because its image is the one
that ships an untracked `build/` in the checkout — the only place §10's
pre-agent exclusion can be tested against something real.

## 5. Current-byte proof (§8)

`requests/__init__.py` was staged as S1 and then edited to S2 without staging:

```
staged blob sha256   bc3ff6050c8c441491452a29bcf808bba7756d66a9c46bab61114ee5f07335be
worktree    sha256   0488746608058640a79bc5aa4f47b960510ce81fc20f2aa1662b20a077bb744b
probe read  sha256   0488746608058640a79bc5aa4f47b960510ce81fc20f2aa1662b20a077bb744b   ← S2
```

Same result on `pallets__flask-5014` (`…df71e19c` worktree, `…4d4f03e3` staged).
The probe stats and reads the filesystem path; it never opens the staged blob.

## 6. Regression controls

The frozen M193A fake-agent lifecycle was re-run in full against the repaired
authority (`stage5_m193b_dry_run_ledger.json`), and analysed by the same
analyser (`--ledger m193b`).

| control | M193A | M193B |
| --- | --- | --- |
| stale cache | `CACHE_STALE_AND_ACCEPTED` ×5 | same ×5 |
| healthy cache | `CACHE_MATCHES_CURRENT_SOURCE` ×5 | same ×5 |
| poisoned copy | agrees | agrees |
| patch identity | `IDENTICAL_STRICT` ×5 | same ×5 |
| evaluator resolved | all | all |
| per-instance source-version verdicts | — | identical, including the three `SOURCE_VERSION_AMBIGUOUS` v2 events and their reasons |
| synthetic fixtures | 16/16 | 16/16 |
| all gates | pass | pass |

§15: the fake agent writes through the host mount and never calls `git add`, so
its lifecycle is *already* an unstaged control. The enumeration proves it
mechanically — on all five instances the changed set is `trackedCount: 1,
untrackedCount: 1`, the untracked half being the test file the fake agent
creates, which `--cached` alone would not have seen at all. The staged and
staged-plus-unstaged classes are covered explicitly by §14's container control.

§16: `m193aArmEnvironment.test.ts` re-run unchanged —
`TREATMENT_ISOLATION_GUARANTEED_BY_CONSTRUCTION` holds. Nothing in the isolation
construction was touched.

## 7. Manifest

| | hash |
| --- | --- |
| M193A | `b356e2114eb6b79698b9999e7c94eb734142760d6203ec8fc4bff933c30b4796` (verified before deriving) |
| M193B | `c544fba670e4466fc3e6034c7bf518328c1f736c52c6d83c1e053345592de8ca` |

Production semantics changed, so §18 requires a new derived manifest.
`run_stage5_m193b_manifest.ts` verifies M193A's own hash, deep-copies it, applies
only the changed-source fields, and diffs every leaf: 11 added, 10 changed, 0
removed, **0 outside the changed-source scope**. All 19 frozen-experiment
invariants hold, including explicit re-assertions that the I6 usability rule
(§13), the treatment-isolation construction (§16) and the source-version verdict
enums (§12) are byte-identical.

The semantic diff, in full: `schemaVersion`, `milestone` and the four
`derivedFrom.*` leaves; `sourceVersionAuthority.implementation` and
`…changedSourceScope.{rule, derivedFrom}` rewritten; eleven new
`…changedSourceScope.*` leaves recording the non-mutating property, the
current-bytes property, the untracked bound, the fail-closed rule, the
`changedSourceFileCount` correction, the controls, and what was superseded and
why; and `frozenSources`, which gains the four new M193B files and re-hashes
`m193_container_adapter.py` and `run_stage5_m193a_analyze.ts` (the analyser
gained a `--ledger` argument so the M193B rerun is scored by the same code as
M193A rather than a fork of it).

## 8. Residual, stated plainly

`capture_diff()` still uses `git add -A … ; git diff --cached ; git reset -q`.
That is the *patch* boundary, not the changed-source authority: it must stage to
get untracked files into a unified diff, and changing it would change what the
model patch is. It is out of M193B's scope (§18 forbids churn beyond the
enumeration authority) — but it means the "observation never stages" property
holds for the changed-source authority, not for every instrument in the arm. If
M194 wants that property arm-wide, the patch boundary is where the remaining
work is.

Two smaller bounds worth recording: a path git has to quote (newline, quote or
control byte in the name) is refused rather than mis-split, and submodules are
not modelled.

## 9. Authorization

```
M194_CHANGED_SOURCE_AUTHORITY_READY
```

All agent-visible changed-source forms observable; current filesystem bytes
authoritative; untracked agent files observable; pre-existing untracked files
excluded correctly; source-version controls still pass; treatment isolation
still passes; frozen experiment unchanged; zero live model calls.

M194 still requires explicit user approval of the frozen live spend.

# M149 plan (as executed)

Recorded at closure, describing the plan that was actually followed rather than
one written in advance and revised. M149 is an audit-first milestone, so the
sequencing constraint was the whole design: **no behaviour changes until the
audit had traced real call paths and reproduced real defects.**

## Order of work

1. **Ground the starting state.** Resolve full SHAs, confirm which M148 commit is
   functional (`cc06012`) versus evidence-only (`f6d36fc`), verify branch and
   ahead/behind, read the milestone ledger.

2. **A — inventory consumers by tracing, not guessing.** Start from the M146–M148
   producers and follow actual calls outward. Read every consuming function
   rather than inferring from filenames. Record what each consumer receives, what
   scope and completeness that evidence carries, and what claim it emits.

3. **A — reproduce before fixing.** Write throwaway probes that execute the
   suspected upgrades against the current tree. Anything that does not reproduce
   is recorded as not reproduced, with the structural reason, and left alone.

4. **A — define the claim model only once the defects are known.** Scope and
   strength lattices sized to the defects actually found, not a general
   taxonomy. Reuse the existing provenance/coverage vocabulary wherever it
   already exists.

5. **B/C/D — implement the smallest generic corrections.** One shared module
   (`evidenceClaims`) rather than scattered guards; no repository-specific
   conditions; no change to scoring, candidate generation, ranking or selection.
   C turned out to need no code change at all.

6. **E — measure both sides.** Run the truthfulness corpus against the M148
   predecessor imported from a detached worktree, so every before/after row is
   executed rather than remembered. Then the preservation gates, the derivation
   control, the real read-only ARC/TCKDB acceptance, and the paired benchmark.

7. **Commit in coherent units**, then the evidence commit with the ledger row.

## Constraints held throughout

- No live agents, Docker, VEXP, network or paid APIs.
- `main` only; no feature branch; nothing pushed; no co-author trailer.
- Pre-existing dirt (`stage5_outcome_ledger.*`) left untouched and unstaged.
- Real ARC/TCKDB indexes read-only; timestamps stamped before and after.
- M148's four recorded limitations deliberately not optimised.

## What changed against the plan

Two things, both recorded rather than quietly absorbed:

- **The 11-member real control could not be reconstructed.** Only three real
  indexed repositories remain on this machine, so member-scale bounding is
  measured synthetically at 11/100/1000 (§103 permits this for response size)
  and the real acceptance runs over the three that exist.
- **Workstream C required no implementation.** Cross-repository provenance and
  dedupe identity were already truthful on all five collision shapes, so it was
  covered by hard controls and left alone (§129).

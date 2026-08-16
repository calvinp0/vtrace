# M154 — plan of record

**Agent Workflow Safety and Search-Contract Hardening.** Not a retrieval
milestone. Its job is to make vtrace safe and truthful enough to put in front of a
coding agent before the broad SWE-bench qualification in M155.

## Starting state

| | |
| --- | --- |
| Predecessor functional | `e3761ab989a14aea4e233844070491084f33b2ce` (M153-C5) |
| Predecessor evidence | `318f2c7b02437dd1efd0abeef83dca996990c2f8` |
| M152 functional | `72ce221c7006dc9e477dcbfa2d7e7372c136fa8c` |
| Branch | `main`, 13 unpushed, nothing pushed |
| Pre-existing worktrees | 14, preserved untouched |

M153 chain from M152: `bcdd962e` · `5900528b` · `8b10e944` · `f700d5b6` ·
`84dba95d` · `a443a227` · `8d8b4195` · `a0000b69` · `588d55d8` · `1c02df9f` ·
`4b02ea04` · `616cda0b` · `e3761ab9` · `318f2c7b`.

M153 is CLOSED INCOMPLETE and is not reopened. Its holdouts are not consumed.
Behavioural routing stays default-off.

## The failure mode being prevented

```
vtrace gives plausible but incomplete/wrong context
  → agent reads it as exhaustive/authoritative
  → agent skips ordinary enumeration
  → agent duplicates existing code or edits the wrong place
```

The safest answer is sometimes *"useful context, but this does not establish
completeness"* rather than a more confident wrong pivot.

## Workstreams

**A — agent-facing surface audit.** Read every registered MCP tool's description,
input/output schema, confidence and coverage fields, and identity exposure from
the registry itself. Locate the exact producer of any "start here, do not grep"
guidance and establish whether it is vtrace's or the model's.

**B — generated-state PR leakage.** Reproduce `.vtrace/` staging generically in a
plain checkout and a linked worktree. Measure which Git exclude location actually
applies to a linked worktree rather than assuming. Establish a local, untracked
exclusion in the index lifecycle: idempotent, preserving user content, never
touching a tracked file or global config, refusing loudly where it cannot act
safely.

**C — project-reference poisoning.** Trace the project token through query
parsing, task shaping, identifier extraction, routing, lexical scoring, anchoring,
candidate generation and delivery. Do not assume routing. Build a frozen non-ARC
paired corpus (named vs plain phrasing) over project-named repository roots. Fix
only at the real seam; no project stopwords; explicit same-name identifiers and
path references must survive.

**D — selective vs complete semantics.** Make `get_code_context` state that it is
selective. Ensure a miss never reads as absence, that genuine exact absence stays
available, that coverage axes are not conflated, that confidence does not
masquerade as completeness, and that unsupported anti-search advice is removed.
Additive schema only; compact; no completeness-by-token-bloat.

**E — reuse-before-write safety and preservation.** Freeze a source-grounded
non-ARC corpus covering the required categories before changing contract
behaviour. Measure false authority, false absence implication and unsupported
anti-search advice on both implementations. Run the deterministic suites paired
with valid provenance and a clean `src`.

## Constraints held throughout

- One authoritative interface, evolved in place. No `…V2` product paths.
- `index.sqlite` repository-derived and immutable under product reads;
  `session.sqlite` for mutable product state.
- M151 workspace routing not redesigned.
- No mechanism/lexical/domain/ranking/role-scoring changes. Every changed
  retrieval case attributed.
- No live agents, Docker, VEXP, network or paid APIs.
- ARC supplies hypotheses only; acceptance comes from non-ARC evidence.
- Commit on `main`, locally, no push, no co-author trailers, pre-existing dirt
  preserved.

## Artifacts

Plan · agent surface audit · search contract · confidence/coverage audit ·
worktree state safety + exclusion matrix · project-name corpus/baseline/trace/final
· reuse-before-write corpus/baseline/final · false-authority analysis ·
cross-revision controls · M153 and full preservation · paired comparison ·
changed-case ledger · final report.

## Outcome

A PASS · B PASS · C MIXED · D PASS · E PASS → **M154 MIXED**. See
`stage5_m154_final_report.md`.

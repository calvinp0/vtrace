# Stage 5 — M37: seaborn-3187 co-edit evidence/ranking audit

Offline, evidence-driven audit (no live agents, no Docker, no SWE-bench eval) of why
VTRACE surfaces the seaborn-3187 gold co-edit only as support and never as a pivot or a
correctly-targeted co-edit hint. Reads captured M32/M36 run artifacts and the persisted
deterministic `.vtrace` index; recomputes nothing live.

## 1. Executive verdict

- **Why was the gold co-edit not surfaced as a pivot/co-edit hint?** Because the gold
  co-edit *symbol* — `seaborn/utils.py::locator_to_legend_entries` — is **never a retrieval
  candidate at all** (not a pivot, not support, not a deferred ref, not even discarded). It
  is indexed correctly, but it has **no lexical signal** (the issue text never names it)
  and is **out of reference reach**: its only production caller is
  `seaborn/relational.py::add_legend_data`, which is itself never surfaced, while the pivot
  VTRACE *does* surface from the same file — `relational.py::scatterplot` — is a thin
  wrapper with **no edge** to it. Graph expansion is depth-1, so it cannot bridge the
  ≥2-hop gap. The one `utils.py` symbol that *is* surfaced — `load_dataset` — wins purely
  because it appears verbatim in the issue's reproduction (`sns.load_dataset("Penguins")`).
- **Surfacing-vs-resolution caveat (important):** this surfacing gap does **not** cause the
  task to fail. In M36, seaborn resolved **3/3 in control** — the agent finds and edits
  `utils.py::locator_to_legend_entries` through its own exploration regardless of VTRACE
  surfacing. So the audited "miss" has near-zero resolution value to close.
- **Did we fix it?** **No code change.** Every candidate fix is either ineffective (it
  would surface the wrong symbol) or a broad, high-blast-radius retrieval-reach change
  disallowed without a precise low-risk bug — and none of them would move resolution on a
  case that already resolves. Documented as a known architectural limitation.
- **Did we avoid broad ranking risk?** Yes — no retrieval/ranking/candidate/scoring/parser/
  hint code was touched; report-only.

## 2. Artifact evidence (M32 + M36 seaborn-3187)

What VTRACE surfaced (identical across M32 r1/r2 and all six M36 runs):

| role | item | note |
| --- | --- | --- |
| pivot | `seaborn/_core/scales.py::_setup` | gold lead (gold edit's `spacer` is nested in `_setup`) ✓ |
| pivot | `seaborn/relational.py::scatterplot` | **non-gold**; thin wrapper named in the issue |
| support | `seaborn/utils.py::load_dataset` | **wrong symbol**; verbatim issue-text match |
| support | `seaborn/_core/plot.py::Plot` | non-gold |
| support | `examples/grouped_barplot.py::penguins` | example data |
| support | `examples/joint_kde.py::penguins` | example data |

- `seaborn/utils.py` **is** present — but only via the symbol `load_dataset`. The gold
  co-edit symbol `locator_to_legend_entries` is **absent from every bucket**: not in the 2
  pivots, not in the 4 `deferredRefs`, not in the 27 `discarded` candidates. (Verified on
  `eval-m36-control-seaborn-3187-r1` and the M32 vtrace manifests.)
- Evidence that brought `load_dataset` in: lexical/body-literal match to the issue text,
  which contains `penguins = sns.load_dataset("Penguins")`. The gold fix has nothing to do
  with `load_dataset`.
- The existing `multi_file_coedit` hint **did fire** (high confidence, Path A: two
  cross-module pivots `scales.py` + `relational.py`) and rendered
  `Related edit candidate(s): seaborn/relational.py` — i.e. it actively points the agent at
  the **non-gold** `relational.py`, never at `utils.py`. This is a mis-direction, not just a
  silent miss.
- The two M36 gold files are `scales.py` (lead, correctly a pivot) and `utils.py` (co-edit,
  mis-surfaced). FAIL_TO_PASS: `test_plot.py::TestLegend::test_legend_has_no_offset`,
  `test_relational.py::TestRelationalPlotter::test_legend_has_no_offset`.

## 3. Index/parser evidence

Queried the persisted deterministic index
(`workspaces/eval-m36-control-seaborn-3187-r1/mwaskom__seaborn-3187/.vtrace/index.sqlite`):

- **`locator_to_legend_entries` is indexed** — `symbols` row: `seaborn/utils.py`, line 687,
  `kind=function`. So this is **not** a parser/index miss.
- The task brief's "expected symbols" `get_view_interval` / `spacer` are **git hunk-header
  artifacts, not the real edit symbols**: in `utils.py`, `get_view_interval` is a method of
  a *nested* `dummy_axis` class inside `locator_to_legend_entries`; the gold lines actually
  edited (`formatter.set_useOffset(False)` / `set_scientific(False)`, ~line 702) belong to
  the top-level function **`locator_to_legend_entries`**. In `scales.py`, `spacer` is a
  nested function inside the surfaced pivot `_setup`. The real top-level co-edit symbol is
  `utils.py::locator_to_legend_entries`.
- **Reference edges are captured correctly.** `edges` table: two `calls` edges into
  `locator_to_legend_entries`, from `tests/test_utils.py::test_locator_to_legend_entries`
  and **`seaborn/relational.py::add_legend_data`** (method, line 193). The connectivity the
  fix would need exists in the graph.
- **The reach gap, precisely:** the surfaced pivot `relational.py::scatterplot` (function,
  line 732) has **zero** 1-hop edges to `locator_to_legend_entries` (verified empty). The
  real caller `add_legend_data` is never a candidate/seed. Graph expansion runs at
  `maxDepth: 1` (`src/retrieval/graphExpansion.ts:60-65`), and capsule-layer neighbour
  anchoring is also one hop from high-confidence seeds
  (`src/capsuleV2/graphNeighborAnchoring.ts`). Neither can traverse
  pivot → … → `add_legend_data` → `locator_to_legend_entries` (≥2 hops).
- `utils.py` is not a "likely edit file" (the issue names `scales.py`), so the
  `symbolPathCandidates` route (`src/retrieval/hybridRetrieval.ts:240`, which would
  enumerate *every* symbol in a likely file, including `locator_to_legend_entries`) never
  fires for `utils.py`.

## 4. Root cause

**Classification: candidate-generation reference-edge-REACH miss** (with a contributing
no-lexical-signal factor). Explicitly *not* the other categories:

| candidate cause | verdict | why |
| --- | --- | --- |
| parser/index miss | **ruled out** | `locator_to_legend_entries` is indexed (utils.py:687, function) |
| reference edge miss | **ruled out** | `calls` edge `add_legend_data → locator_to_legend_entries` exists in `edges` |
| ranking miss | **ruled out** | it is never a candidate, so there is nothing to rank up |
| symbol-selection miss | **ruled out** | there is no per-file "representative symbol" selector — retrieval is per-symbol; `locator_to_legend_entries` simply never enters the per-symbol pool |
| co-edit hint synthesis miss | **ruled out (as cause)** | the hint *did* fire; it can only reference items already in the candidate set, and the gold symbol is not in it. The hint targeting `relational.py` is a *symptom*, not the cause |
| **insufficient evidence to surface it cheaply** | **ROOT** | indexed + edge-connected, but the edge source (`add_legend_data`) is unsurfaced, the surfaced pivot (`scatterplot`) has no direct edge, depth-1 expansion can't bridge ≥2 hops, and it has no issue-text lexical signal of its own |

In one line: **the gold co-edit symbol is correctly indexed and graph-connected, but only
reachable via a 2-hop reference chain through an unsurfaced intermediary, and it carries no
lexical signal — so depth-1 candidate generation never proposes it, and no downstream
ranking or hint step can recover a symbol that was never a candidate.**

## 5. Change made

**None.** Rationale, mapped to the candidate directions in the milestone brief:

- **A/B (promote a support item / synthesize a co-edit hint from support):** would surface
  `utils.py::load_dataset` — the **wrong symbol**. It points the agent at dataset-loading,
  not the legend-formatter fix. Net negative (noise), and still misses the real site.
- **C (parser/reference-edge fix):** there is no edge bug to fix — the edge exists and is
  correct. "Fixing" reach means raising `maxDepth` 1→2 or seeding intermediary callers like
  `add_legend_data`. That changes the candidate pool for **every** SWE-bench instance
  (depth-2 BFS over `imports/calls/references` from every seed, capped but far wider),
  i.e. a broad retrieval change — disallowed here without a precise, low-risk bug, and it
  would near-certainly perturb the deterministic retrieval-eval fixtures.
- **D (within-file symbol selection so the useful symbol outranks `load_dataset`):** not
  applicable — `locator_to_legend_entries` is not a candidate, so there is nothing to
  re-rank against `load_dataset`.
- **E (no code change; document; propose narrow follow-up):** chosen for the *evidence*,
  but see §8 — the resolution payoff is ~zero (seaborn already resolves 3/3 unaided), so the
  honest recommendation is to deprioritize seaborn rather than spend reach-engineering risk.

No tests added (no code change). Retrieval evals not run (nothing touched retrieval/ranking/
parser/hint generation).

## 6. Offline validation — before/after for seaborn-3187

| question | before (this audit) | after | 
| --- | --- | --- |
| is `utils.py` surfaced? | yes, as support | unchanged |
| is the **gold symbol** `utils.py::locator_to_legend_entries` surfaced? | **no** (absent from all buckets) | **still no** |
| surfaced `utils.py` symbol | `load_dataset` (wrong) | unchanged |
| co-edit hint target | `relational.py` (non-gold) | unchanged |
| promoted to co-edit hint? | n/a (would be wrong symbol) | not done |
| promoted to pivot? | n/a (not a candidate) | not done |
| **justifiable with current evidence?** | — | **No.** The gold symbol is impossible to surface without a broad retrieval-reach change, and doing so has no resolution value on a case that already resolves 3/3 unaided. |

Outcome: `seaborn/utils.py` remains **support-only (wrong symbol)**, by deliberate decision,
documented as a known limitation.

## 7. Retrieval/ranking safety

No source code changed. No retrieval/ranking/parser/candidate/hint files were modified, so no
deterministic retrieval-eval run is required and the committed retrieval CSVs are unaffected
(byte-identical by construction). Verification is `git diff --check` only.

## 8. Next recommendation

**D — evidence is insufficient to justify a low-risk fix; leave seaborn-3187 as a documented
known limitation and return to the sphinx edit-sufficiency bottleneck.**

Reasoning: (1) surfacing `utils.py::locator_to_legend_entries` requires a broad retrieval-
reach change (depth-2 expansion or intermediary seeding) with repo-wide blast radius and no
precise low-risk bug to point to; (2) it has near-zero payoff — M36 already resolves seaborn
**3/3 in control** without it; (3) the genuinely failing case is **sphinx-doc__sphinx-7462**
(0/3 both arms in M36), where the secondary pivot `ast.py::unparse` *is* surfaced and *is*
inspected but the agent still declines to edit it — an edit-sufficiency / obligation-follow-
through problem, which is both higher-value and more tractable than re-engineering co-edit
reference reach. If co-edit reach is revisited later, the right framing is a separate,
explicitly-scoped retrieval milestone with a full deterministic retrieval audit (not a
"low-risk hint tweak"), since the only honest levers are depth-2 expansion or concept-level
(non-lexical) matching on the fix domain (e.g. `ScalarFormatter`/offset/legend).

---

### Methodology / reproducibility
- Artifacts read (read-only): `_capsule_v2_manifest.json` (items/deferredRefs/discarded),
  `_capsule_v2_ranking.json`, `_run.meta.json` for `eval-m36-*-seaborn-3187-*` and
  `eval-m32-product-vtrace-seaborn-3187-*`; the persisted snapshot
  `_vtrace_instructions.snapshot.md`.
- Index queried (read-only): `.vtrace/index.sqlite` `symbols` and `edges` tables in the
  retained M36 control-r1 workspace.
- Source inspected at base commit `22cdfb0` in `.bench-repos/mwaskom__seaborn` (read-only).
- Code-path map: `src/retrieval/hybridRetrieval.ts`, `src/retrieval/graphExpansion.ts`,
  `src/capsuleV2/graphNeighborAnchoring.ts`, `src/capsule/assignCandidateRoles.ts`,
  `src/capsuleV2/buildCapsuleV2.ts`, `src/capsuleV2/multiFileCoeditHints.ts`.
- No live agents, no Docker, no SWE-bench evaluation, no diagnostic verifier. No code change.

# M145 — Workspace and Repository Identity Foundation

**Verdict: PASS.**

Every M145 PASS criterion is met and measured. The milestone found one real
defect in the existing identity model — a repository replaced at the same
filesystem path was indistinguishable from the one that left — and closed it,
while leaving single-repository retrieval byte-identical.

| Workstream | Verdict |
|---|---|
| A — identity audit | **PASS** |
| B — canonical repository / worktree identity | **PASS** |
| C — path membership | **PASS** |
| D — workspace membership and routing | **PASS** |
| E — result provenance | **PASS** |
| F — readiness across a workspace | **PASS** |
| G — index lock ownership | **PASS** |
| H — MCP / CLI routing | **MIXED** — one seam integrated, the rest audited and left unchanged |
| I — cross-repository collision safety | **PASS** |
| J — no-semantic-movement | **PASS** |

| | |
|---|---|
| M144 predecessor | `e7c45bdc397338c59fc0b8933dce46d6a5a9221d` |
| M145 final functional commit | `88de1061c23dfbb7da112861278eec730a5e848d` |
| Branch / ahead / pushed | `main` / ahead of `origin/main` / **nothing pushed** |

---

## 1. The defect the audit found (§194, §109)

M145's brief assumed identity barely existed. It did: M114 built repository and
worktree identities, M132 routing, M141 decomposed readiness, M144 path
membership. So the audit's real job was to ask what the existing values are
*evidence of*.

Every identity value turned out to be a function of a **path**. `repositoryId` is
`sha256(gitCommonDir)`; `worktreeId` is `sha256(gitCommonDir + worktreeRoot)`.
Measured across the §125 scenarios, that is correct for seven cases and wrong for
the eighth:

| Scenario | same repository? | same worktree? | same authority? |
|---|---|---|---|
| same root repeated | yes | yes | yes |
| symlink same root | yes | yes | yes |
| sibling Git worktree | yes | no | no |
| independent clone, same HEAD | no | no | no |
| same basename, different repo | no | no | no |
| copied repo directory | no | no | no |
| **replaced repo at same path** | **yes** | **yes** | **no** |

Deleting a checkout and putting an unrelated repository at the same path produced
byte-identical ids, and readiness reported `repositoryCompatible: true,
worktreeCompatible: true` across the swap. The replacement was still caught
downstream — two repositories cannot share a commit SHA — but as
`source_stale / head_changed / incremental_refresh`, a true statement about the
wrong question.

**Instance evidence** closes it: `stat` on the git dir, giving device, inode and
creation time, at **0.007 ms**. It discriminates every case (replacement
distinct, move preserved, `cp -r` distinct, clone distinct, sibling common dir
shared) and it can only ever *refute* — a `null` means the artifact predates the
field or the root is not Git, and M132 already settled that silence must not be
read as a failing claim.

Root-commit lineage was the alternative and was rejected on cost: 3 ms on ARC
only because ARC has a commit-graph, and unbounded on a large repository without
one. Remote URL was rejected outright per §13.

The last column above is the answer to §185: **same authority** means one index
may answer for both, which requires the same worktree *and* the same worktree
instance behind it.

## 2. Path membership became a status (§26-§36)

M144 asked one repository "could this path name a file here?" and a boolean
sufficed. Two repositories that both index `src/foo/bar.py` both answer yes, and
any tiebreak the caller then invents is a semantic decision wearing a lookup's
clothes.

| Case | Result |
|---|---|
| exact absolute inside the worktree | `exact` / member |
| repo-relative | `unique_resolved` / member |
| reporter absolute, unique suffix | `unique_resolved` / member |
| site-packages copy matching the repo | `unique_resolved` / member |
| external stdlib | `external` / external |
| owned by another registered member | `unique_resolved` / **`external_to_selected_repository`** |
| missing path | `unresolved` |
| same relative path in two members | **`ambiguous`**, both reported, never resolved |
| reporter absolute over a colliding suffix | **`ambiguous`** |
| exact absolute while a sibling collides | `exact` — the named location wins |

The last row was a **defect the acceptance run caught**: an absolute path inside
one member became ambiguous the moment a second member happened to index the same
relative path. `/w/a/src/foo/bar.py` names a location, and a repository that
merely contains `src/foo/bar.py` does not contain that location. Exact matches
now decide alone when any exist — which is precisely what makes §92's
"adding an unrelated repository changes nothing" hold for absolute evidence.

`site-packages` still decides nothing in either direction. M144 measured why, and
that finding is carried forward unchanged.

## 3. M144 preserved exactly (§98, §144, §157)

The collapse is exact rather than approximate: with one scope `ambiguous` cannot
arise and `exact` implies a suffix match, so `exact | unique_resolved` is
*precisely* M144's `true`. Verified rather than argued:

- M144's own control suites re-run under M145: `stage5_m144_failure_localization_generic_controls.json`
  and `stage5_m144_failure_parser_controls.json` **byte-identical** to the
  committed artifacts.
- M144's localization evidence over the frozen 50, run under both the M144
  predecessor and the M145 candidate on this machine: **identical** once
  wall-clock timings are excluded. `requests-1724` still flips `_send_output` →
  `send`, lead `requests/sessions.py::send`, `leadIsGold` true.
- 26/26 path shapes agree between the legacy boolean and the new resolver
  (`stage5_m145_m144_membership_parity.json`).
- The ordering — membership filtering → frame selection → completeness → dunder
  guard — is untouched; only the predicate's implementation moved.
- `django-11740` unchanged: still no supplied failure evidence, still
  `not_addressable`, still the inherited M142 debt M143 root-caused.

## 4. Workspace identity, routing and collisions (§37-§46, §79-§96)

A workspace is an **explicitly registered** collection of identities. Nothing
walks a directory tree looking for `.git`; M132 already showed what implicit
duplicate worktrees do.

Before M145 a workspace entry was keyed on an alias and a path string — both
display metadata — so no reuse of that metadata could ever be validated. Entries
now resolve to canonical identity once at registry load (§117: never per
candidate, never per path) and may record the identity they vouched for.

| Routing case | Expected | Actual |
|---|---|---|
| one repo, implicit | routes | routes (`sole_member`) |
| two repos, explicit alias A / B | A / B | A / B |
| two repos, explicit worktree id | exact | exact |
| two repos, explicit path | exact | exact |
| two repos, ambiguous display name | rejected | `workspace_repository_ambiguous`, 2 candidates |
| unknown selector | rejected | `workspace_repository_unknown` |
| cwd inside a member | that member | that member |
| cwd inside a sibling worktree | that worktree | that worktree |
| cwd at workspace root, no named default | rejected | `workspace_repository_required` |
| cwd at workspace root, named default | the default | the default |
| repository id registered as two worktrees | rejected | `workspace_repository_ambiguous` |
| registration order reversed | no change | no change (4/4 selectors) |
| deleted registration | fails closed | `workspace_registration_stale` |
| replaced repository | fails closed | `workspace_registration_stale`, `repositoryInstance` |

Collision controls, all measured:

| Control | Result |
|---|---|
| same relative path in A and B, A routed | A's worktree id, alone and beside B — identical |
| same symbol FQN in A and B | distinct keys (worktree id is part of the key) |
| same basename (`x/requests`, `y/requests`) | distinct identities; the *name* is ambiguous, the identities are not |
| byte-identical content at one commit | same HEAD, distinct worktrees, distinct authority |
| sibling worktree with a local edit | same repository, distinct worktrees, distinct source state |
| unrelated repo added | no change to A's readiness or routing |

**Real repositories (§130-§133).** ARC and TCKDB registered side by side, each
queried under explicit routing and compared against the same query with no
workspace present: **6/6 byte-identical**. Membership isolation over the real
corpora — 325 ARC files, 1024 TCKDB files, 2 genuinely shared relative paths —
gives 25/25 ARC-only paths resolving to ARC, 25/25 TCKDB-only paths not resolving
to ARC, and 2/2 shared paths reported ambiguous. ARC and TCKDB were opened
read-only and the workspace config was written outside both source trees (§136,
§175); both checkouts ended in their pre-existing state.

The structural reason this holds is worth stating plainly: **retrieval takes
`(db, repoRoot)` and no workspace input reaches it.** Registering a second
repository has no channel through which to move an A-routed answer. The run turns
that from an argument into a measurement.

## 5. Readiness and locking (§55-§70)

Readiness stays **per member**, and the workspace answer is a count:

| repo | ready | registration | state |
|---|---|---|---|
| a | true | verified | ready |
| b | false | verified | source_stale |
| c | false | verified | index_missing |

Summary `total 3 / ready 1 / stale 1 / missing 1`. A stale B does not block an
A-routed request; a stale A fails closed while B is healthy. A **replaced**
repository is refused *before* its index is consulted — that index may be
entirely valid, for the repository that left.

Locking is bounded by construction. A contended index refuses in **9.1 ms** with
the blocking pid and worktree named; unrelated repositories index in parallel; a
sibling worktree is not blocked by the main worktree's lock. Recovery is on
ownership and never on age: `dead_owner`, `unreadable_owner`, `foreign_worktree`,
each attributed. No case hangs.

The `foreign_worktree` ground is new and is the fix for §69: a claim naming
another worktree arrives by copying a `.vtrace` directory and never owned this
index. M114 wrote that `worktreeId` into the owner record and nothing had ever
read it.

## 6. Provenance and bounds (§47-§52, §102-§106)

One envelope per response — `workspaceId`, `repositoryId`, `worktreeId` — at
**168–171 bytes**, with zero per-candidate repetition. Measured constant across
workspaces of 1, 10, 100 and 1000 members. Routing is a map lookup at
**0.001–0.010 ms** per lookup at every size.

Identity is what makes a candidate unique: `src/utils.py` in A and in B are
distinct keys, and so are two `utils.parse`.

**Limitation:** workspace *load* is linear in members (≈3.5 ms each, dominated by
identity resolution), so 1000 members costs ≈3.5 s. §105 asks for bounded
routing, which holds; it says nothing about load. Recorded rather than optimised.

## 7. The cost this milestone accepted (§111-§113)

`indexer_fingerprint` content-hashes `src/indexer`, which M145 edits. Every index
written before M145 is therefore **`schema_incompatible / schema_changed /
full_rebuild`**. Measured, same machine, same checkouts:

| Repository | under M144 | under M145 |
|---|---|---|
| ARC | `source_stale / head_changed / incremental_refresh` | `schema_incompatible / schema_changed / full_rebuild` |
| TCKDB | `schema_incompatible` (already) | `schema_incompatible` |

§111's decision, made rather than reflexed: **no format bump, no schema bump, no
capability bump.** The fingerprint already forces the rebuild; a version bump
would add a second mechanism for one consequence. And it is §113's required
explicit answer — an M144-era index is *rejected with a clear compatibility
reason*, never silently reinterpreted. Critically, `repositoryCompatible` and
`worktreeCompatible` remain **true** against those indexes: identity is not what
refuses them, because a manifest with no fingerprint makes no claim.

## 8. Final benchmark (§138-§140, §181)

`e7c45bd` → `88de106`, M134 provenance-safe protocol, django 20 + cross_repo 30,
each side with its own independently prepared corpus.

```
provenanceValid = true
sameFixtureHash = true, sameTargetCorpusHash = true, isolatedIndexes = true
changed cases   = 0 / 50
```

| Metric | M144 | M145 |
|---|---:|---:|
| Top-1 gold file | 39 | 39 |
| Top-3 | 44 | 44 |
| gold file anywhere | 48 | 48 |
| gold symbol anywhere | 31 | 31 |
| missing | 2 | 2 |
| mean tokens | 1850.14 | 1850.14 |

Zero semantic movements, zero regressions, zero unexplained changes. Every
difference M145 produces is infrastructure metadata, logged separately in
`stage5_m145_changed_case_ledger.json`.

## 9. Preservation

Every gate compared byte-for-byte against the M144 run of the same gate on this
machine, so an inherited failure cannot be mistaken for a new one.

| Gate | rc | vs M144 |
|---|---|---|
| M141 readiness matrix | 0 | identical |
| M136 budget | 0 | identical (reports the same inherited `FAIL; ARC 3000=undefined`) |
| M137 direct | 1 | identical (the preservation script omits `--baseline-root`; inherited verbatim) |
| M140-C orchestration | 0 | one timing line (0.0545 → 0.0442 ms), both PASS |
| M138 memory provenance | 1 | identical (same inherited TypeError) |
| M140-B TCKDB | 0 | `0/4 changed, pass=true`; only TCKDB's HEAD advanced, outside this milestone |

M132 worktree routing, nested-worktree exclusion and wrong-worktree fail-closed
are covered by the full suite: **4308 pass, 0 fail, 49 skip** across 264 files.
`bun run typecheck`, `bun run typecheck:benchmarks` and `git diff --check` clean.

## 10. What M145 did not do

- **Workstream H is MIXED.** Every user-facing tool was audited (§71). The
  `repo_root` family already routes through M132's identity-aware, fail-closed
  primitive, and the alias family now validates registration. The tools were
  **not** re-plumbed onto the new registry selector: single-repository invocation
  stays valid (§73), and re-plumbing every tool carried M132/M141 regression risk
  with no measurable gain. The registry is the seam a future milestone extends.
- **`inspectWorkspaceRepoStatus` still exists twice**, in `src/workspace/status.ts`
  and privately in `src/mcp/tools.ts`. Consolidation deferred and recorded.
- **Identity is not move-stable.** `worktreeId` contains the root path, so moving
  a worktree changes it while the instance fingerprint is preserved. Making it
  move-stable means dropping the path, and routing, locking and index location
  all need the path.
- **Non-Git roots have path-only identity.** No object store exists to
  fingerprint, so replacement of a plain directory is undetectable.
- **No lineage.** Two clones of one upstream are distinct identities and nothing
  records that they share history.
- **The small-delta parse-reuse limitation is untouched** (§19), as instructed.

## 11. Recommended M146 scope

The foundation M146 needs is in place: every file, symbol and candidate is
resolvable to a worktree identity, ambiguity fails closed rather than resolving,
and a path that is external to the selected repository but internal to another is
already a reportable fact rather than an invisible one.

The first genuinely new question is **repository relevance** — which registered
member a task is about — and the honest starting point is that M145 deliberately
refuses to answer it. Suggested order: measure how often a real multi-repository
workspace can be disambiguated by explicit evidence alone (path membership
already resolves 25/25 unique paths correctly) before adding any semantic
signal, so that fan-out is introduced only where explicit provenance genuinely
runs out.

# M149 — Evidence Consumer Truthfulness and Cross-Repository Claim Boundaries

**Verdict: PASS.**

| workstream | verdict |
| --- | --- |
| A — audit evidence consumers and define claim boundaries | PASS |
| B — enforce truth-preserving scope/strength composition | PASS |
| C — preserve repository provenance through composition/dedupe | PASS (no change required) |
| D — bound coverage/product presentation | PASS |
| E — preservation + paired benchmark + evidence | PASS |

This is the shape §136 calls a good PASS: several real consumer overclaims were
corrected, some hypothesised ones did not reproduce, selected code context stayed
byte-identical, and only metadata and claim wording moved.

## Commits

| commit | kind |
| --- | --- |
| `2aaac750b326478bb3f29576aa1454365d0f734d` | functional — claim model, truthful negatives, bounded coverage |
| `f155a2a` | tooling — the four M149 evidence runners |
| *(this commit)* | evidence — `results/` artifacts + ledger row |

- M148 predecessor (final functional): `cc06012bec63498b181cad1e8b5fb9977cd03217`
- M149 final functional: `2aaac750b326478bb3f29576aa1454365d0f734d`
- `f6d36fc` is evidence-only (touches `results/` alone) and was **not** used as the paired predecessor.
- Branch `main`, no feature branch, nothing pushed, no `Co-Authored-By` trailer.

## What the audit found

15 consumers and 5 producers inventoried
(`stage5_m149_consumer_inventory.json`). **4 real overclaims reproduced and
fixed, 1 hypothesised overclaim did not reproduce, 9 consumers were already
truthful and were left alone (§129).**

One structural fact frames all of it, and the report states it plainly rather
than implying more reach than exists: **the workspace relevance/composition
layer is not wired into any MCP tool or CLI command at this commit.** Its only
callers are the Stage 5 harness. `productVisible` in the inventory means
"reachable through the product-layer API and shaped for a product response", not
"an agent sees it today". A future milestone that wires this layer up inherits
these claims verbatim, which is precisely why fixing them now is worth doing.

### Reproduced and fixed

**1. One sentence for three epistemic states.** `no_match` emitted

```
No repository carries evidence for this request.
```

identically when (a) every eligible member was checked and none matched,
(b) no lane ran because the request named no path or symbol, and (c) a lane was
requested but no probe existed. Measured on a two-member workspace in case (b):
that sentence, with `reposDeepProbed: 0`. A total non-observation was worded as a
finding about the workspace.

The fix is small because M147 had already built the right sentence and
`nominateRepositories` was discarding it: the deciding lane's own proof reason
already counts what it checked. It is now preferred whenever a lane produced one,
and a request that checked nothing says so, split by why.

| state | before | after |
| --- | --- | --- |
| all 3 members checked, path absent | `No repository carries evidence for this request.` | `No eligible repository indexes this path; all 3 were checked.` |
| all 2 members checked, symbol absent | `No repository carries evidence for this request.` | `No eligible repository defines this name; all 2 were checked.` |
| no hints to route on | `No repository carries evidence for this request.` | `This request names no path or symbol to route on, so no repository was checked.` |
| hints present, no probe available | `No repository carries evidence for this request.` | `No repository could be checked for this request: no index probe was available.` |

**2 and 3. Coverage grew linearly with the workspace.** The model-visible reason
interpolated one alias per unknown member, and `excludedNotReady` carried one
record per not-ready member.

| members | reason chars | member records | routing summary bytes |
| --- | --- | --- | --- |
| 11 | 320 → **211** | 20 → **12** | 1,140 → **978** |
| 100 | 2,189 → **214** | 198 → **12** | 9,595 → **983** |
| 1000 | 21,990 → **218** | 1,998 → **12** | 96,896 → **990** |

(Figures from `stage5_m149_coverage_scale.json`, real serializations of real
routing output at each member count — not projections. The commit message quotes
23,100/228/542 from an earlier run of the same control with wider aliases; the
defect and its scale are identical, only the alias width differs.)

Lists cap at four with the totals carried alongside. Verdicts are computed from
the totals, never the lists, so truncating the report cannot change what the
report concludes.

**4. Support-scan coverage was invisible.** With 21 members all indexing the
path, `supporting` was reported after a prefix scan of 8 — and nothing in the
response distinguished a short list from "no other repository could contribute".
A support-purpose coverage row now travels with the result:
`considered: 21, answered: 8, omittedByBound: 13, complete: false`. Selection is
untouched.

### Hypothesised, not reproduced (§73/§129)

I predicted the indexed-path lane would record an **outranked** member as
`definitely_absent` — a member that genuinely indexes the path but lost M145's
exact-beats-suffix precedence, then reported as "proven not to". It is
structurally unreachable: an `exact` match requires an absolute hint inside a
registered root (`isExactWithin`), which is exactly the tier-1 path-containment
condition, so tier 1 has already decided and the indexed-path lane never computes
a **deciding** proof in that configuration. In support mode it computes no proof
at all. Recorded, not altered.

### Already truthful, left alone

Cross-repository dedupe identity (all five collision shapes), per-item repository
provenance through merge, `formatRepositoryProvenance`, single-repository
collapse, `membershipAccessPath`, `index_status.accessCapability`,
`get_impact_graph.traversalLimitReached`, and the single-repository path
predicate. Nine consumers, no changes made for consistency aesthetics.

## Claim model

Scope: `member_local < scanned_members < enabled_members < workspace`.
`workspace` is deliberately wider than `enabled_members` — a disabled member was
never in the population any lane asked, so **no lane may speak for the
workspace**.

Negative strength: `not_observed < bounded_absence < authoritative_absence`, per
the confirmed policy — a partial scan earns a real negative over
`scanned_members` and is blocked from escalating; `answered === 0` is
`not_observed`; only a complete authoritative scan of the claimed scope earns
`authoritative_absence`. `refusedWithoutEvidence` and `omittedByBound` weaken
identically but stay separate fields, because you repair an index and you raise a
bound.

Completeness is per capability. `path_membership` and `symbol_exact_lookup`
settle member-local absence; `ranked_retrieval` never does, however complete the
sweep. Access path is deliberately **not** an authority axis: `indexed` and
`fallback` run the same statement over the same rows, so a fallback answer is no
less authoritative — only slower.

Full model in `stage5_m149_claim_model.md`; matrices in
`stage5_m149_{scope,negative_evidence,ownership,provenance_dedupe}_matrix.json`.

## Corpus (§97)

15 scenarios, each executed against both the M148 predecessor (imported from a
detached worktree at `cc06012`) and this tree.

```
defect_reproduced_and_fixed          2
already_correct_wording_sharpened    2
already_correct                     11
routingUnchanged                 15/15
refusedMemberNeverOpened          true
```

**Routing was identical on every scenario.** Only claims moved — which is exactly
the result an audit milestone should produce.

## Ownership and support

No product surface emits an "owner" claim at all. The strongest sentence is
`<alias> selected on <tier> evidence`, which names the evidence that decided
rather than asserting ownership. Verified across four shapes — shared-path
support, tests-only, config/docs-only, and a wrapper registered *first* — that a
support-only repository never becomes the lead and registration order never
confers ownership. No heuristic owner claim exists, so none needed labelling.

## Provenance and dedupe

| case | deduped | items | provenance retained |
| --- | --- | --- | --- |
| same path, different repo | no | 2 | yes |
| same FQN, different repo | no | 2 | yes |
| identical content, different repo | no | 2 | yes |
| divergent content, same path | no | 2 | yes |
| same path, no recorded identity | no | 2 | yes |

Identity is `(worktreeId ?? alias, relativePath, symbol)`; every component is
required. Single-repository output stays unlabelled (§111).

## Preservation

| gate | result |
| --- | --- |
| M146 anti-drift closure | 25 pass, 8/8 guard, **no new exemption** |
| M147 router + M148-B indexed_path | 60 pass, B-fixture intact, refused member never opened |
| M148-A access lifecycle | 20 pass (noop migration, idempotency, atomicity, concurrency, contention, read-path no-migration) |
| M141 readiness | 22 pass |
| M145 identity/composition | 77 pass |
| M142 retrieval hygiene | 862 pass |
| M140 orchestration/module | 37 pass |
| M139 impact truthfulness | 68 pass |
| M149 new controls | 32 pass |

Derivation fingerprints: **unchanged**. Each of the four touched source files was
mutated and every fingerprint recomputed — `index_format_version`,
`schema_version`, `indexer_fingerprint`, `parser_fingerprint` and `config_hash`
are byte-identical to the values M148 recorded. No index schema or version
change.

Full suite **4471 pass / 0 fail / 49 skip / 276 files** (M148 baseline
4439/0/49/274; the delta is M149's own 32 controls in 2 files). Both typechecks
clean, `git diff --check` clean.

## Paired benchmark

`provenanceValid: true`, predecessor `cc06012`, candidate `2aaac75`,
`srcDirty: false`.

| suite | cases | changed | semantic hash |
| --- | --- | --- | --- |
| django | 20 | 0 | identical |
| cross_repo_30 | 30 | 0 | identical |
| **Frozen50** | **50** | **0** | — |

Top-1 38, Top-3 44, gold anywhere 48, gold symbol anywhere 31, missing 2, mean
tokens 1832.4 — every figure identical on both sides and equal to the M148
baseline.

## ARC / TCKDB

Read-only. ARC ready; TCKDB_v2 `source_stale (head_changed)`; vtrace's own index
`index_corrupt (index_unreadable)`, mtime ~64 days old — all three pre-existing.
Absent-symbol and absent-path queries returned `bounded_absence` naming the two
unchecked members; the no-hints query opened **zero** indexes.

`realIndexesUntouched: true` — every mtime and size byte-identical before and
after, matching the session baseline. No read consumer triggered index, init,
migration or repair. The predecessor worktree is removed; no measurement copies
were made because nothing destructive was run.

## Query and performance cost

No new database queries. Coverage is composed from observations the lanes already
produced, so no member is re-opened or re-queried to reconstruct provenance the
producer already knew (§105–§107). M148's ~0.75 s projected 1000-member routing
cost is untouched and was deliberately not optimised (§104).

## Remaining limitations

1. The relevance/composition layer remains unreachable from MCP and CLI. The
   claims are truthful; nothing consumes them yet.
2. M147's eleven-member **real** control could not be reconstructed — only three
   real indexed repositories remain on this machine. Member-scale bounding is
   therefore measured synthetically at 11/100/1000, which §103 permits for
   response size; latency at scale remains an M148 projection.
3. `EvidenceScope` and `PositiveClaimStrength` are defined and enforced for
   negatives, but no current consumer emits a positive claim strong enough to
   need `PositiveClaimStrength` at runtime. It is scaffolding for M150.
4. M148's four recorded limitations are untouched by design: the indexed-path
   deciding lane still opens every enabled member's index, unknown members are
   still reported and never auto-repaired, `vtrace init` still surfaces migration
   failure through `index_status`, and the 100/1000-member latency figures remain
   projections.

## Recommended next milestone

The audit says the highest-value boundary is **not** richer cross-repository
composition yet. Two things are true: the claims are now truthful, and nothing in
the product consumes them. Building M150-style dependency semantics on top would
add a second unreachable layer above the first.

**Recommended: wire the workspace relevance/composition layer into a product
surface** — most likely `get_code_context` routing plus an `index_status`
coverage field — so the claim boundaries M146–M149 built are actually load-bearing,
and so the next composition milestone has a real consumer to be truthful to.
`M150 — Cross-Repository Evidence Composition and Dependency Semantics` is the
right milestone *after* that, not before it.

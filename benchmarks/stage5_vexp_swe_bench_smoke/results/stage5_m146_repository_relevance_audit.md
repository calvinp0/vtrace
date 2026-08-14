# M146-B — Repository relevance evidence audit

Functional predecessor (M146-A final functional): `a3040e19b461136d359d901edb8ddf9f6f8a34a4`
M146-A evidence: `a95e0d4adba5a9b1bd90a60a4aad482f7fbe0165`

## 1. The question this milestone adds

M145 made every file, symbol and candidate resolve to an authoritative worktree
identity. That answers **where an object belongs**. It deliberately refuses to
answer **whether a repository matters to this query**, and that refusal is what
M146-B picks up.

The two must not be conflated. Identity is a property of the data and is stable
across every request; relevance is a property of one request and changes with
every query. A router that treats a repository's identity as evidence of its
relevance is the M135/M137 project-name bias in a new costume.

## 2. Evidence inventory

The decisive audit question is not "is this signal useful?" but **"does reading
it require an index this runtime still agrees with?"** M146-A proved that an
index can be readable, source-fresh, and semantically obsolete. Evidence drawn
from such an index is not weak evidence — it is evidence produced by rules the
runtime has already refused.

| Evidence | Needs ready index? | Exact? | Ambiguity possible? | Cost | Used for routing |
| --- | --- | --- | --- | --- | --- |
| explicit selector (worktreeId / repositoryId / alias / path / cwd) | **no** | yes | no (M145 fails closed) | registration only | **yes — tier 0, authority** |
| absolute path inside a registered root | **no** | yes | only via nested roots | string compare | **yes — tier 1** |
| workspace registration metadata | **no** | n/a | no | already resolved | supporting |
| canonical repository/worktree identity | **no** | yes | no | already resolved | supporting |
| M144 failure-evidence frame (absolute) | **no** | yes | yes across repos | string compare | **yes — via tier 1** |
| indexed relative-path membership (M145 resolver) | **yes** | no | yes | one path list per member | **yes — tier 2** |
| exact symbol / FQN name | **yes** | yes | yes | one indexed lookup | **yes — tier 3** |
| FTS task match | **yes** | no | yes | bounded query | not used — lexical, ambiguous |
| document/config match | **yes** | no | yes | bounded query | not used |
| repository display name / alias in prose | no | no | yes | free | **rejected — §20/§66** |
| package/dependency metadata | yes | varies | yes | parse | **out of scope — M147** |

Two conclusions from this table drove the implementation.

**First, the index-free column is not empty.** An absolute path inside a
registered root is decided by the request, the registration and the filesystem —
nothing derived. So a repository whose index has been refused can still be
*identified* as the right one. That is what makes the honest answer "this is the
repository, and its index must be repaired first" expressible, instead of the
misleading "no repository matches".

**Second, the exact/ambiguous column decides the shape of the answer, not a
score.** Every index-derived signal can be ambiguous across repositories, and
M145 already established that a boolean membership predicate hides exactly the
case that matters. Ambiguity is therefore a status here too.

## 3. Why tiers and not a score

The obvious design is a weighted sum over these signals. It was rejected before
implementation for a reason M146-B §32 states directly: raw retrieval scores are
not established as comparable across repositories. Each repository's ranking was
calibrated against its own corpus by M122–M145. Nothing has shown that A's 1.9
outranks B's 1.8, or even that rank 1 in A is worth rank 1 in B.

A blended score would also have to break ties, and every available tie-break —
registration order, path length, alias — is a semantic decision disguised as an
implementation detail. M145 already refused position as a decision when
`primaryRepoAlias` silently defaulted to the first entry.

So evidence is grouped into ordered tiers, the highest tier producing anything
decides, and two repositories inside that tier is **ambiguous**, not a race.

```
0. explicit selection   index-free   authority, never overridden
1. path containment     index-free   an absolute path inside a root
2. indexed path         INDEXED      suffix membership via M145
3. exact symbol         INDEXED      bounded name lookup
```

## 4. The readiness gate

The split between tiers 1 and 2 is M146-A's invariant carried into routing:

```
DERIVATION-INCOMPATIBLE INDEX
MAY NOT CONTRIBUTE INDEX-DERIVED ROUTING EVIDENCE.
```

Without it the failure is circular and self-concealing: a stale index answers a
symbol probe, thereby selecting itself, after which the repository is rebuilt and
its answer presented as current. The routing decision was made by semantics the
runtime had already refused, and nothing in the result would say so.

The gate is structural rather than conditional. Which member pool a lane may draw
on is derived from `EVIDENCE_REQUIRES_READY_INDEX`, the same table that records
whether the lane reads derived state, so a lane added later cannot omit the gate
by forgetting an `if`.

Diagnostics keep the distinction §48 asks for: a member excluded for readiness is
reported with its readiness reason, never as "low relevance". A safety exclusion
and a relevance judgement are different facts and lead to different actions.

## 5. Cost

Repository nomination is cheaper than retrieval by construction, because the
index-free tiers are consulted first and a decisive path answers without opening
any index at all. Measured on a 101-member workspace with one decisive absolute
path: **0 indexes opened, 0 deep probes**, and the answer decided from
registration metadata alone.

When indexed lanes do run they are bounded by `maxDeepProbes` (default 8) and
counted per member rather than per lane, so consulting one index for both the
path and symbol lanes is one probe. Both probes are single bounded SQL statements
against the member's own index — **zero source reads**.

No global workspace index was created. §24's warning applies: a second persisted
store would inherit its own derivation-compatibility, membership-invalidation and
provenance problems, and the existing per-repository indexes proved sufficient
for bounded routing.

## 6. Signals deliberately not used

- **Repository display name in prose.** M135/M137 measured project-name bias.
  The alias is display metadata, and the word "arc" in a sentence is not a typed
  repository reference. A negative control asserts a prose token matching an
  alias does not select that repository.
- **FTS and document matches.** Real, but lexical and ambiguous, and both are
  index-derived so they inherit the readiness gate without adding exactness.
  Nothing measured so far needs them to route.
- **Package/dependency metadata and cross-repository graph edges.** Explicitly
  M147 territory. Inferring that repository A calls repository B because import
  names align would fabricate a relationship the index does not contain.

## 7. What routing produces

Four outcomes, kept distinct because they call for different actions:

| Status | Meaning | Action |
| --- | --- | --- |
| `selected` | exactly one relevant repository, queryable | retrieve |
| `ambiguous` | several remain plausible | abstain; report who matched |
| `no_match` | no repository carries evidence | preserve low-confidence state |
| `not_ready` | identified, index cannot answer safely | repair the index, then retry |

Collapsing `not_ready` into `no_match` would hide a repairable index behind an
answer that says nothing is relevant, and collapsing `ambiguous` into a selection
is the silent-first-match failure §28 forbids.

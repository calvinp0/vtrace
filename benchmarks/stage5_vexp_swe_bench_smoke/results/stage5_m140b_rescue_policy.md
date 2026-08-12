# M140-B — bounded upstream orchestration rescue: policy

The contract the lane implements, and the reasoning behind each bound. Numbers
here are defaults in `UPSTREAM_RESCUE_DEFAULTS` (`src/retrieval/upstreamRescue.ts`);
every one is overridable per request and none is repository- or task-specific.

## 1. The problem it solves

Retrieval finds symbols that *look like* the query. For a "how does X happen?"
question that is systematically insufficient: the implementation performing the
work shares the question's vocabulary, but the function that **decides** to call
it — the orchestration entry point actually being asked about — often shares
none, so it never becomes a candidate.

Measured on ARC at M140-A6, for the §35 serialization query:

| symbol | role | candidate rank | delivered |
|---|---|---|---|
| `perceive_molecule_from_xyz` | downstream implementation | 5 | yes (support) |
| `are_coords_compliant_with_graph` | branch logic | 3 | yes (pivot) |
| `ARCSpecies.mol_from_xyz` | orchestration, hop 1 | **absent** | no |
| `ARCSpecies.from_dict` | orchestration entry, hop 2 | **absent** | no |

Both missing symbols sit on an exact `calls` path whose tail *was* retrieved.
This is a candidate-generation gap, not a ranking one.

## 2. Shape

```
derive query intent (once per request)
        ↓  orchestration-shaped?  ── no ──▶ do nothing, report why
base retrieval + first scoring pass
        ↓
select ≤ maxRescueSeeds eligible seeds from the base ranking
        ↓
walk INCOMING `calls` edges upward, depth ≤ maxDepth
   per level: one batched capped edge query + one batched hydration
        ↓
admit ≤ maxUpstreamCandidatesPerSeed per node (relevance-gated)
        ↓
dedupe by symbol identity, combining path evidence without multiplying it
        ↓
score the survivors against the original query as ONE pool
        ↓
global cap, merge into the candidate pool, authoritative scoring pass
        ↓
ordinary selection / budget / delivery
```

The lane produces **candidates, not selections**. Everything it returns is
scored, ranked, budgeted and rendered by the same machinery as every other
candidate; there is no side channel (§56).

## 3. Activation gate

Rescue runs only when the request asks *how something happens* rather than
*where something is*. Decided once, from the already-derived intent (§16).

**Activates on:**
- a parsed conditional-alternative clause (`contrastKind = alternative_branches`)
  — a "when does it do A rather than B?" question is inherently about the code
  that chooses, which is the orchestration above both branches;
- a process frame: `how does/is/are/was/did…`, `what happens/triggers/invokes/
  orchestrates/drives`, `what (code) path`, `what leads to`.

**Suppressed by:**
- `kind = capability_lookup` — a capability question wants the definition that
  provides it, not its callers;
- an imperative lookup frame (`find …`, `where is …`, `definition of …`,
  `what file …`) together with an explicit symbol hypothesis (§17, §48).

Lookup frames are anchored to the **start** of the request, so "how does the
loader **find** the parser?" stays a process question.

**Deliberately excluded:** `who calls X` / `what calls X`. Caller *enumeration*
is impact analysis (`get_impact_graph`), which is bounded, complete, and reports
its own coverage. Retrieval recovers orchestration as context; it must not
quietly reimplement a caller listing (§18).

## 4. Seed eligibility

A seed is a base candidate confident enough to be worth expanding upward from.
All conditions required:

| condition | default | why |
|---|---|---|
| kind ∈ {function, method} | — | only call-chain-shaped symbols have meaningful callers |
| not a structural scope | — | `<module>` is a graph bridge, never an answer (§14) |
| not a test symbol | — | a test is the **top** of a call chain, not orchestration within one; the failing-test lane already owns test → implementation routing |
| rank ≤ `seedRankWindow` | 5 | only the candidates we are most confident about |
| `final ≥ seedMinScoreRatio × topFinal` | 0.75 | a weak candidate's callers are speculation about speculation |
| count ≤ `maxRescueSeeds` | 3 | bounds the outer term of the complexity |

## 5. Admission of a rescued caller

Calling the seed makes a symbol **reachable**; it never makes it **relevant**
(§29). A caller must independently match the original query on its own indexed
definition — name, fq name, signature, docstring, path. **No source is read at
any point** (§28), so the cost is metadata only.

Two gates, doing different jobs:

- **absolute floor** — at least `minMatchedQueryTerms` (2) distinct query content
  terms appear in the caller's definition. This is what excludes the unrelated
  tail. It is needed *because* the relative gate cannot: BM25 is normalised
  within a pool, so the best of 1,000 irrelevant callers still scores 1.0.
- **relative floor** — `minRelativeRelevance` (0.25) of the best BM25 score among
  that node's callers, with idf computed across exactly the callers in
  contention, so a term they all share cannot carry one of them.

## 6. Bounds

| bound | default | what it protects |
|---|---|---|
| `maxRescueSeeds` | 3 | one request cannot expand from everything |
| `maxUpstreamCandidatesPerSeed` | 3 | one popular seed cannot fill the pool |
| `maxUpstreamRescueCandidates` | 8 | several strong seeds cannot multiply |
| `maxDepth` | 2 (clamped to [1,2]) | ARC needs `from_dict → mol_from_xyz → perceive`; depth 3+ needs its own justification (§23) |
| `maxIncomingEdgesPerSeed` | 2000 | pathological fan-in |

Complexity is `seeds × callersPerSeed × depth` — independent of repository size
and of how popular any seed happens to be.

**On the edge cap specifically:** it is a ceiling against pathological fan-in,
**not** a relevance filter. Its retained prefix is ordered by edge id, which is
uncorrelated with relevance — measured: at 1,000 callers a 400 cap discarded
*both* relevant ones. It is therefore set well above realistic fan-in, and
`limitReached` reports when it bites so a truncated walk is never read as a
complete one.

## 7. Scoring

`upstreamRescueScore = min(cap, WEIGHT × depthFactor × relevance + multiSeedBonus)`

- `WEIGHT` = `cap` = **0.95**, calibrated against the bounded-component family it
  joins: `positiveObjectiveScore` caps at 0.36, `contrastPenalty` at 0.75,
  `directAnswerScore` at 0.95. Rescue sits with the last because it requires two
  independent facts — an exact static call edge into a strongly-matched
  implementation **and** the caller matching the query on its own definition.
  It is a ceiling, not a typical value: only a candidate topping the rescued pool
  at depth 1 reaches it.
- `depthFactor` = 1.0 at depth 1, 0.8 at depth 2 — closer orchestration is better
  evidence, all else equal, but a strongly-matching depth-2 entry point still
  outranks a barely-relevant depth-1 caller (§32).
- `multiSeedBonus` = 0.05 per extra seed, capped at 0.10. Five equivalent paths
  are corroboration, not five times the evidence (§26).

Added alongside the other bounded, attributable adjustments rather than inside
`combineFinalScore`, so the contribution stays separable and inspectable.

**Relevance is scored across the rescued set as ONE pool**, not per seed. This
was a correction made during implementation: per-seed normalisation ties the best
caller of *every* seed at 1.0 however weak it really is, which let a weakly
related seed's favourite caller displace the genuine entry point on the global
cap.

## 8. Attribution

A rescued candidate says what it is (§31):

```
rescued upstream caller (incoming call depth 2) of arc/species/perceive.py::perceive_molecule_from_xyz;
independently matches dictionary, object, species
upstream call path: ARCSpecies.from_dict -> ARCSpecies.mol_from_xyz -> perceive_molecule_from_xyz
```

It never claims a direct or lexical match, and it names the terms it *did* match
separately from the structural reason it was reachable.

## 9. Edge kinds

Only exact `calls` edges are traversed (§13, §51). `imports` / `references` /
`contains` describe proximity rather than invocation, and M139's unresolved
"potential callers" are explicitly not canonical edges (§52); either would let a
rescued path claim a static guarantee the index cannot back.

## 10. Known limitation

A rescued candidate has, by construction, almost no base score — being missed by
lexical search is the premise. A **bounded** contribution can therefore lift it
into the candidate pool, and (at depth 1, topping the rescued pool) into
delivery, but it cannot close an arbitrary gap to the lexical top.

Measured on ARC: `mol_from_xyz` goes absent → rank 6 → **delivered**, while
`from_dict` goes absent → rescued and scored at 0.975, rank 93 of 132 — recovered
as a candidate but not delivered. Closing that would require rescue to contribute
≈1.0, i.e. routinely outranking exact direct answers, which is the §70 defect
pattern. It is left as a truthful limitation rather than tuned away.

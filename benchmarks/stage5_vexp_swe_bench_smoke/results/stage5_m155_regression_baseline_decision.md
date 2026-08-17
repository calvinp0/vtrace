# Stage 5 M155-B2 — regression baseline decision

## Three gates, three questions

| Gate | Question it answers | Corpus | Cadence | Authority for |
| --- | --- | --- | --- | --- |
| **Fast gate** | did anything crash, break an invariant, or move unexpectedly? | Frozen50 (django.expanded 20 + cross_repo_30 30) | routine, per milestone | stability, regression **observability** |
| **Broad100** | how good is retrieval on unfamiliar tasks? | frozen 100-case SWE corpus, fresh index per checkpoint | major checkpoints | broad retrieval **quality**, architecture-era trend |
| **Paired30/100** | does giving an agent VTRACE help? | paired subset of the 100 | when the product changes what the agent receives | agent **utility** |

Different tools for different questions. The failure M155 diagnosed was one tool
answering all three.

## What changed

1. **Indexes are derived evidence, keyed by derivation identity.** The fast gate
   validates every case against the product's own derivation authority before
   scoring, and fails closed on stale, schema-unsupported, or unattributable
   indexes. See `stage5_m155_index_provenance_model.md`.
2. **The fast gate is re-baselined on freshly derived indexes.** 50/50
   derivation-valid, `gateUsable: true`. Before: 5/50. See
   `stage5_m155_regression_baseline_audit.md`.
3. **A suite is usable only if every case is valid.** Partial validity is what
   allowed 41 format-v1 indexes, 4 unattributable indexes and 5 fresh ones to be
   averaged into one "authoritative" number.
4. **Capability observability is proven, not assumed.** Four controls, each with a
   known-negative and known-positive checkpoint over the same source file — see
   `stage5_m155_capability_observability_controls.json`. All four separate.

## Frozen50's standing

**Retained** as the fast stability gate. It is small, fast, and now
derivation-valid.

**Removed** as the broad quality authority, on this evidence:

| | Frozen50 | Broad 100 |
| --- | ---: | ---: |
| M154 gold file Top-1 | 0.76 | **0.57** |
| M154 gold delivered | 0.90 | **0.78** |
| delivered-gold across M129→M154 | 0.90 at **all five** checkpoints | 0.79 → 0.78 |

Frozen50 is ~19 points easier on Top-1 and 12 points easier on delivery, and its
delivered-gold has not moved across five architecture eras. A gate that cannot move
cannot report progress or its absence. Steering by it is the mechanism by which
five eras of local milestone wins produced a flat broad result.

Frozen50 remains a valid *stability* signal precisely because it is stable: an
unexpected movement there is a strong crash/invariant signal. It is being asked the
question it can answer.

## Gold state stays three-way (§8)

Permanently, in every gate and every cross-analysis:

```
GOLD_DELIVERED                  gold reached the model (pivot or support)
GOLD_DISCOVERED_BUT_DISCARDED   gold entered the candidate pool and was withheld
GOLD_MISSING                    gold never surfaced
```

`discovered-but-discarded` is never folded into successful retrieval. The
M140→M150 transition is the standing example: `gold anywhere` rose 4 points while
delivered gold *fell*, because five cases moved `missing → discarded`. An agent
cannot use evidence it never receives.

## Rebuild policy

- The fast gate **does not** rebuild. It reports invalidity and stops.
- Rebuilding is an explicit, separate step (`run_stage5_m134_prepare_targets.ts`),
  which stamps each side's derivation identity.
- Because `vtrace_commit` is not derivation-relevant, an ordinary commit that
  leaves indexer, parser and config untouched requires **no** rebuild. Rebuild cost
  is paid only when derivation semantics actually change — which is the same
  condition under which the old cached evidence became a lie.

Measured cost when a rebuild is required: ~100 minutes wall for 100 repositories on
this machine, run in parallel across checkpoints; ~3.2 GB source and ~10 GB of
indexes per checkpoint.

## What B2 deliberately did not do

- No product code changed (`git status --porcelain src/` empty).
- No retrieval, ranking, delivery, or candidate behaviour altered. Every retrieval
  difference between the before and after baselines exists because the earlier
  benchmark was reading evidence the runtime rejects — not because the product moved.
- No new score thresholds invented (§23). The controls assert observability, never
  improvement.
- Frozen50 not deleted (§11).

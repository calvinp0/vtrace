# M212 — preregistration: is frozen A15 still a current-VEXP parity target?

Research and measurement only. No VTRACE product behaviour is changed, no frozen
scorer is touched, no coding agent is run, no model money is spent.

M211 rebuilt VTRACE's impact path into a complete census, a bounded evidence
projection and a deterministic continuation. Frozen A15 is still BELOW. Before
any further engine work is spent turning that cell green, M212 asks whether the
cell still describes the competitor architecture it was written to reproduce.

## The question, stated once

> Does frozen A15 still measure the impact-delivery behaviour of current VEXP,
> or has VEXP moved to an architecture that would not satisfy the frozen A15
> inline-default criterion?

## What frozen A15 actually says

Recovered mechanically from the committed scorer, not from memory:

| element | source | content |
|---|---|---|
| population | `m197aFixtures.ts:deriveCallSiteEdges(db, 50)` | first 50 `calls` edges by edge id carrying a persisted call site, `src <> dst` |
| query | `run_stage5_m197a_engine.ts` | `GetImpactGraph({ repo_root, symbol_fqn: pair.end, depth: 3 })`, default response |
| success | `m197aScoring.ts:callSiteIsRendered` | `directRelations` carries the caller, its `evidence.sourceText` is non-empty, and that text contains `evidence.referenceName` |
| MATCH | `run_stage5_m197a_report.ts` | ≥ 90% of eligible call sites |
| EXCEED | same | 100% |
| standing value | `stage5_m197a_claim_ledger.json` | C-LARGE impact surface **20%** — `VTRACE_BELOW_VEXP_CLAIM` |

Its cited origin is `V-B1`/`V-B2`, whose own reproducibility was recorded at
M196 as `INSUFFICIENT_METHOD` with the measurement definition **"none
published"**. That is the thread M212 pulls: the ≥ 90% inline-source bar is a
VTRACE-authored operationalisation of a VEXP claim, not a measured VEXP
behaviour.

## Decision criteria — fixed by the milestone brief, before any measurement

These are transcribed from the brief, not derived from results.

**SUPERSEDED** requires all four, with direct current-VEXP evidence:

1. current VEXP maintains truthful impact/blast-radius knowledge;
2. its default impact/MCP surface intentionally projects a bounded subset or compact form;
3. omitted evidence is deterministically expandable or otherwise retrievable through its documented architecture;
4. current VEXP itself would not satisfy the frozen A15 assumption that an arbitrary known caller is usually inline with source in the first default response.

**STILL REPRESENTATIVE** requires that default `get_impact_graph` normally
inline-enumerates enough exact callers with source evidence that ≥ 90% remains a
reasonable approximation of current product behaviour.

If #4 cannot be measured, **UNRESOLVED** is preferred to inference.

Whatever the verdict: frozen A15 stays BELOW, the matrix stays 14/15, the scorer
is not modified, and the history is not rewritten as 15/15.

## Instruments

| instrument | what it establishes |
|---|---|
| `m212VexpSurface.ts` | pure extraction of a shipped `vexp-cli` MCP bundle's tool catalog and impact-renderer field set; shadow-A15 representation and recall helpers |
| `run_stage5_m212_vexp_surface.ts` | runs that extraction over named bundles, reporting each bundle's own version |
| `run_stage5_m212_shadow_a15.ts` | controlled-fanout corpora, VTRACE default `get_impact_graph`, INLINE vs REACHABLE recall |
| `m212VexpSurface.test.ts` | unit cover for the extractor and the classifiers |

The shadow evaluator imports `callSiteIsRendered` from `m197aScoring` rather than
restating it, so a shadow verdict can never disagree with the frozen scorer about
the same relation. It measures a different POPULATION with the same predicate.

## Preregistered probe design

- Fanouts, fixed in advance: **1, 8, 32, 64, 65, 100, 200, 500**. One repository
  per fanout, so a target's caller count is the fanout and not a sum.
- Callers are `caller_0001 … caller_NNNN`, 20 per file, each with a real static
  call to `target`. Source is kept trivial so that a parse failure could not be
  mistaken for a projection decision.
- Sample: the **first ten caller FQNs lexicographically**, selected before any
  response is read.
- Two repeats per fanout; semantic fields compared, clock fields excluded.
- `INLINE_RECALL` = sampled callers inline with source ÷ sampled.
  `REACHABLE_RECALL` = sampled callers reachable through default plus the
  response's own deterministic continuation ÷ sampled. Generic search does not
  count toward either.

## Falsification controls, and where each is enforced

| id | control | enforcement |
|---|---|---|
| F1 | a generic `expand_vexp_ref` document does not prove `get_impact_graph` uses V-REF | V-REF attributed only from a tool's own description literal, read to its closing quote |
| F2 | an outdated bundle must not be called current | every bundle's version is read from its own `package.json` and printed |
| F3 | a small fixture cannot establish full-inline architecture | fanouts to 500 |
| F4 | a parser miss is not a projection decision | indexing recall measured against generator ground truth and reported separately |
| F5 | a truthful count does not imply delivery | census and delivered relations never combined; `classifyProjection` refuses to upgrade a count into a delivery |
| F6 | generic searchability is not deterministic expansion | REACHABLE_RECALL follows the response's own cursor only |
| F7 | caller identity, not file identity | `representationOf` matches the exact caller FQN |
| F8 | a label is not source-backed evidence | `INLINE_WITH_SOURCE` and `INLINE_WITHOUT_SOURCE` are distinct outcomes |
| F9 | samples chosen before results | sample fixed at corpus generation, before the first call |
| F10 | stable semantics | repeats compared on meaning, not on timing |
| F11 | frozen A15 immutability | M212 fails if any frozen scorer, threshold or corpus file changes |
| F12 | VTRACE product immutability | M212 fails on any `src/` change |

## Evidence classes

Every current-VEXP fact in the final report is labelled as exactly one of:

- **PUBLIC_DOC_FACT** — stated on a public VEXP page, with URL and retrieval date;
- **SHIPPED_ARTIFACT_FACT** — read out of a published `vexp-cli` distribution, with version;
- **BLACK_BOX_OBSERVATION** — observed by running VEXP;
- **INFERENCE** — reasoned, and marked as reasoning.

A conclusion resting only on INFERENCE cannot discharge criterion #4.

# M166 — MCP Response Tax and Model-Visible Compression Audit

## Commission

M165 closed PASS with the observation that a first `get_code_context` call spends a
median ~7,407 tokens on metadata against ~996 tokens of model-visible evidence — a
nominal 7.4:1 ratio. M166 must decide whether those metadata tokens are actually
**generated / transmitted / model-visible / billed**, or merely present in an offline
representation that never reaches the model.

The required order is MEASURE → ATTRIBUTE → CLASSIFY → SIMULATE → JUSTIFY →
IMPLEMENT (only if warranted) → PRESERVATION → OPTIONAL OFFLINE REPLAY.

No paid agent experiment by default.

## What M166 is not

Not a retrieval milestone (no FTS/BM25, ranking, candidate generation, caps, pivot or
support scoring, impact derivation, graph traversal, query interpretation, skeleton
generation, memory or flow changes). Not a routing milestone (no ambient routing,
auto-trigger, prompt injection, hooks). Not "make JSON smaller" — the layers
INTERNAL ≠ TRANSPORT ≠ AGENT-VISIBLE ≠ MODEL-CONTEXT ≠ BILLED are measured
independently.

## New permanent invariant

    SERIALIZED TOKENS ≠ MODEL-CONTEXT TOKENS until directly measured.

extending the standing chain

    GENERATED ≠ TRANSMITTED ≠ MODEL_VISIBLE ≠ BILLED

alongside IMPLEMENTED ≠ EXPOSED, AVAILABLE ≠ USED, CALL_MADE ≠ ANSWERED,
ANSWERED ≠ EVIDENCE_DELIVERED, PARSE_FAILURE ≠ ABSENCE.

## Workstreams

| WS | Question | Gate |
| -- | -------- | ---- |
| M166-A | What does one repository-context call cost at every boundary? | full path traced; internal vs MCP vs model-visible distinguished; real-run accounting correlated; M165's 7.4k located; known-positive attribution control passes; formal tax verdict issued |
| M166-B | What fraction is evidence versus metadata, duplication and transport? | 12/12 decomposed; taxonomy mechanically reproducible; consumers mapped; duplicate semantics proven; uniform-detector controls pass |
| M166-C | Can the agent-facing representation be compressed safely? | multiple counterfactual renderings simulated; semantic preservation and epistemic safety checked; machine consumers preserved conceptually; token deltas reported; primary decision issued |
| M166-D | Minimal model-facing compression repair | only if C justifies it; one authoritative renderer; no parallel API; retrieval selection unchanged; machine truth retained |
| M166-E | Offline preservation and economics qualification | 12-task replay; semantics preserved; economics measured; standard verification; explicit live-extension decision |

M166 may PASS with `A/B/C PASS, D NOT RUN — compression hypothesis refuted, E PASS`.
A no-change PASS is a fully valid result. No product change will be manufactured.

## Evidence sources (no new spend)

- The twelve real M164 `m164_tools_task_trigger_*` agent streams — the authority for
  what the model actually received and what was billed.
- The twelve preserved `m163_tools_task_trigger_*` workspaces, spoken to through a
  real `mcp-serve` child process — the authority for what the server produces and
  transmits.
- M165's `stage5_m165_context_pipeline_parity.json` for the disputed headline.

## Attribution method

Claude Code streams report per-request `cache_read_input_tokens` and
`cache_creation_input_tokens`. Where the identity

    cache_read[n+1] == cache_read[n] + cache_creation[n]

holds, the tokens a turn added to context are exactly that turn's cache-creation, and
every later request re-reads them. Marginal attribution of a single tool result within
a turn is bounded, never asserted exactly: LOWER_BOUND / ESTIMATED / UPPER_BOUND.
Offline tokenizer figures are labelled `OFFLINE_ESTIMATED_TOKENS` and never presented
as billing evidence.

## Safety rails carried in

Preserve every standing epistemic distinction: exact vs potential callers, support vs
ownership, `not_observed` vs bounded vs authoritative absence, ready vs degraded vs
stale vs wrong-worktree, partial vs complete coverage, fresh vs stale evidence.
Compression that could make any of those collapse fails regardless of token savings.

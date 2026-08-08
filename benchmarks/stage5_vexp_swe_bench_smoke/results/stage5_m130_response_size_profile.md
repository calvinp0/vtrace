# Stage 5 — M130 response-size profile

Verdict: **PASS**

## Incident

A `max_tokens: 6000` request returned a 86,989-character result.
`max_tokens` bounded the model-visible context; nothing bounded the serialized response.

## Root cause

The same selected context was serialized several times over:

1. `productContext.modelVisibleContext` — the authoritative rendered text.
2. `productContext.items[].content` — every body again, per item.
3. `capsuleResult.pivots[].source` / `support[].source` — every body a third time.
4. `pivotNeighborhood[].excerpts[].text` — neighbourhood source a fourth time.

Around them sat unbounded retrieval telemetry (query variants, lane candidate
matrices) and a legacy `context` section restating the selection with
per-candidate scores.

## Field sizes

| field | before (chars) | after (chars) |
| --- | ---: | ---: |
| `productContext` | 39367 | 19301 |
| `capsuleResult` | 15604 | 423 |
| `diagnostics` | 14266 | 904 |
| `pivotNeighborhood` | 6646 | 2 |
| `context` | 3680 | 324 |
| `deferred` | 1520 | 97 |
| `flow` | 841 | 1980 |
| `request` | 794 | 794 |
| `inspectFirst` | 708 | 350 |
| `taskSummary` | 677 | 92 |
| `intent` | 555 | 423 |
| `memory` | 536 | 314 |
| `rules` | 363 | 221 |
| `runtime` | 362 | 362 |
| `accounting` | 317 | 65 |
| `impact` | 220 | 220 |
| `capsule` | 150 | 150 |
| `authoritativeCapsuleManifestId` | 66 | 66 |
| `schemaVersion` | 22 | 22 |
| `savedObservation` | 4 | 4 |
| `responseBudget` | 0 | 1303 |
| **total** | **86989** | **27726** |

## Budget

- requested context tokens: 6000
- estimated model-visible tokens: 3316
- estimated metadata tokens: 3616
- estimated total response tokens: 6932 (ceiling 7000)
- serialized characters: 27726
- reduction: 68.13%
- compaction cost: 5.177 ms/response (40 samples)
- serialization: 0.167 ms → 0.038 ms
- retrieval latency impact: none; no retrieval, ranking or capsule-packing code path changed
- compaction applied: true
- post-fix uncompacted response (flow evidence restored): 88280 chars
- flow section included after the fix: true

## Gates

- model-visible context within the request: true
- complete response ≤ 7000 estimated tokens: true
- complete response ≤ 32000 characters: true
- authoritative model-visible context byte-identical: true
- duplicated bodies: 21 → 0

## Compacted fields

- `accounting`
- `capsuleResult.actionabilityHints[].evidence`
- `capsuleResult.digest`
- `capsuleResult.discarded`
- `capsuleResult.manifest_only`
- `capsuleResult.pivots`
- `capsuleResult.pivots[].evidence`
- `capsuleResult.pivots[].roleReason`
- `capsuleResult.pivots[].source`
- `capsuleResult.support[].evidence`

## Authoritative response shape

| field | role |
| --- | --- |
| `productContext.modelVisibleContext` | the only field carrying rendered source |
| `productContext.items` | compact metadata and stable references (id, path, symbol, roles, content mode, line span, content hash, token estimate) |
| `capsuleResult` | compact manifest: counts, budget, warnings, and per-item references via `contextItemId` |
| `context` | compatibility alias; `supersededBy: productContext` |
| `pivotNeighborhood` | identity and relation with `textCharacters`; read `path:startLine-endLine` for source |
| `diagnostics` | bounded summary by default |
| `flow` / `impact` | compact structured evidence |
| `responseBudget` | the two measurements and what compaction did |

## Compatibility decision

Consumers of `capsuleResult`, `context`, `productContext.items[].content`,
`pivotNeighborhood` and `diagnostics` were searched across source, MCP and CLI
wrappers, tests, benchmark harnesses, report generators, fixtures, schemas and
docs. Every non-MCP consumer (the Stage 5 harnesses, the CLI `run-pipeline`
command, the VS Code result panel) reads
`formatRunPipelineOrchestrationOutput` directly, which is UNCHANGED. Compaction
is applied at the MCP response boundary only.

Decision: **compact backward-compatible references**, not deletion. Fields keep
their names and positions; their bodies become references, and the declared
output schemas were relaxed so only identity, role and sizing are guaranteed.
An explicit `include_item_content: true` opt-in restores per-item bodies for any
client that genuinely needs them.

## Compaction policy

Deterministic, and applied in a fixed order only when the bounded default shape
still exceeds the ceiling:

1. duplicated source bodies out of metadata items
2. compatibility representations become stable references
3. verbose diagnostics reduce to counts and warning codes
4. unselected candidate evidence removed
5. pivot-neighbourhood metadata bounded
6. transitive impact/flow explanatory evidence bounded
7. the authoritative model-visible context is retained
8. freshness, provenance, warning and accounting state is retained

A final backstop drops whole OPTIONAL sections, least useful first, so the
envelope holds for any input rather than only for anticipated shapes. Critical
warnings (stale index, ambiguity) are never among them.

## Detail modes

`detail: compact | standard | debug`, defaulting to `standard`. Debug widens
diagnostics to bounded samples but obeys the same hard total ceiling; large raw
candidate matrices are never returned by default at any level.

Fixture: captured_incident_response. The captured incident payload is read-only evidence and is not committed.


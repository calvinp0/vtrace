# M136 metadata field-size profile

## Before/after summary

The replayed M135 debug-preset incident selected `get_dihedral` but the final guard replaced 2,516 model tokens with a 46-token notice. Its final response still spent 1,661 tokens on metadata. The archived motivating run reported 3,468 selected model tokens and approximately 6,871 pre-compaction metadata tokens; both reach the same all-or-nothing branch.

M136 with the same debug preset delivers `get_dihedral`, 12 selected/delivered items, 2,516 model tokens, and 1,444 metadata tokens: 3,960 total under the 4,000 ceiling. The standard 3,000-token acceptance below delivers the same answer with 2,020 model and 1,869 metadata tokens (3,889 total).

Largest final contributors are the single authoritative `modelVisibleContext`, bounded outer diagnostics, freshness, intent, and compact identity manifests. Source bodies remain serialized once. The detailed table counts serialized JSON characters, so escaped newlines make its per-string chars/4 column slightly higher than the authoritative response-budget measurement.

## M136 standard response field profile

Exact ARC dihedral query, max_tokens=3000. Token figures in this table are serialized-JSON chars/4 estimates.

| field | chars | tokens |
|---|---:|---:|
| productContext | 10903 | 2726 |
| productContext.modelVisibleContext | 8303 | 2076 |
| responseBudget | 1067 | 267 |
| diagnostics | 904 | 226 |
| productContext.freshness | 732 | 183 |
| intent | 441 | 111 |
| capsuleResult | 408 | 102 |
| request | 405 | 102 |
| runtime | 362 | 91 |
| flow | 325 | 82 |
| productContext.repository | 283 | 71 |
| productContext.delivery | 249 | 63 |
| productContext.items | 221 | 56 |
| productContext.timing | 209 | 53 |
| capsule | 150 | 38 |
| productContext.roleCounts | 116 | 29 |
| productContext.task | 115 | 29 |
| deferred | 97 | 25 |
| productContext.diagnostics | 76 | 19 |
| authoritativeCapsuleManifestId | 66 | 17 |
| accounting | 66 | 17 |
| productContext.taskHash | 66 | 17 |
| productContext.selectedFileHash | 66 | 17 |
| productContext.leadPivot | 62 | 16 |
| productContext.accounting | 56 | 14 |
| schemaVersion | 22 | 6 |
| productContext.capsuleMode | 10 | 3 |
| productContext.resultState | 10 | 3 |
| productContext.intent | 9 | 3 |
| productContext.deliveryFailed | 5 | 2 |
| inspectFirst | 4 | 1 |
| taskSummary | 4 | 1 |
| context | 4 | 1 |
| impact | 4 | 1 |
| memory | 4 | 1 |
| rules | 4 | 1 |
| savedObservation | 4 | 1 |
| productContext.resolved | 4 | 1 |
| productContext.retrievalFound | 4 | 1 |
| pivotNeighborhood | 2 | 1 |
| productContext.responseVersion | 1 | 1 |
| productContext.omittedItemCount | 1 | 1 |

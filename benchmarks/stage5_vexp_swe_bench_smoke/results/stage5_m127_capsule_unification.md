# Stage 5 M127 Unversioned Authoritative Capsule

## Summary

- Live incident: a healthy TCKDB index returned `requested=default`,
  `effective=v1`, `candidateFilesConsidered=0`, and `no_candidates`.
- Default-to-v1 cause: current M126 source normalized omission/`default` to a
  selector value for which `requestWantsCapsuleV2` was false. Both the direct MCP
  capsule handler and the run-pipeline response metadata contained explicit-v2-only
  branches.
- Stale-process finding: no original process remained to fingerprint. The
  configured executable was `<VTRACE_ROOT>/bin/vtrace`, a source-backed Bun
  launcher. Current source fully explains the incident, so process staleness is
  neither proven nor required. Long-lived MCP processes still require restart.
- Runtime consolidation: current product routes use
  `buildAuthoritativeProductRetrieval -> buildCapsule -> hybridRetrieve`, then
  bounded routed rescue, roles/packing, and enrichment from one request-local
  result.
- TCKDB result: `no_candidates` is fixed and all three MCP tools agree, but the
  frozen M126 ranker fails the required exact-query evidence acceptance.
- Verdict: **FAIL**.
- Recommendation: **fix product retrieval before promotion**; restart MCP after
  deploying the routing/provenance change.

## Pre-change Capsule Architecture

The old implementation lived under `src/capsule/` and combined routed retrieval,
profile assembly, roles, character packing, and rendering. The current
authoritative implementation lived under `src/capsuleV2/`; its
`buildCapsuleV2 -> hybridRetrieve` result was already the M123–M126 selection
authority inside run-pipeline, with M121 routed rescue applied by
`authoritativeProductRetrieval.ts`.

Product routing was inconsistent. `get_context_capsule` and CLI capsule could
still execute the old builder. Run-pipeline used the authoritative selection but
suppressed its structured projection and described the response as v1 by default.
Historical benchmark readers still parse old v1/v2 artifact labels.

## Incident Reproduction

The configured TCKDB MCP command points to
`<VTRACE_ROOT>/bin/vtrace mcp-serve --repo <TCKDB_ROOT>`. `bin/vtrace` loads
TypeScript from its own checkout with Bun; no compiled rebuild is required.
The reported process was gone and its exact loaded commit cannot be recovered.

An isolated archive of current TCKDB HEAD was indexed with 960 files, 23,119
symbols, and zero parse/read/persistence failures. The exact request now returns a
standard capsule with 25 authoritative candidates and routed rescue, rather than
`no_candidates`.

## Root Cause

The router default was the direct cause. Omission and literal `default` normalized
to `default`; only literal `v2` selected the newer direct handler/response branch.
No repository config, workspace config, environment variable, MCP startup flag,
or persisted state selected v1. Stale deployment remains possible generally, but
is unnecessary to explain this response.

## Unversioned Capsule Architecture

The current seam is:

```text
task/preset
  -> M126 hybridRetrieve
  -> bounded M121 routed rescue when triggered
  -> authoritative roles, lead, and budget packing
  -> product/impact/memory/rules enrichment
  -> one structured and rendered response
```

`buildCapsule` is the neutral facade. `AuthoritativeProductRetrieval` is retained
as the immutable request authority. `productContext`, rendered context,
`capsuleResult`, manifest projection, diagnostics, roles, and lead are derived
from that same object; selection is not rerun to create a second representation.

## Legacy Removal

Current MCP schemas no longer expose an engine field. Omission always uses the
authoritative capsule. Hidden migration aliases `default` and `v2` emit a
deprecation warning but do not affect execution. `v1` and `legacy` fail before
retrieval with `unsupported_legacy_capsule_engine`. CLI help no longer advertises
`--capsule-engine`; its hidden parser applies the same compatibility policy.

CLI capsule and CLI run-pipeline always use the authoritative seam. Automatic
catch-and-fallback was removed. Low-level historical/internal types and benchmark
artifact readers retain versioned names where broad mechanical renaming would
add risk; they are not runtime product choices.

## Runtime Provenance

Context responses and status output expose package version, checkout commit when
available, source-backed executable path, capsule implementation (`hybrid`),
retrieval implementation (`product-retrieval-v2`), ranking implementation, index
schema, and manifest version. Provenance is outside stable semantic hashes.

At audit time the package was 0.1.0 on source base `fdcda9a...`. Runtime reads
`.git/HEAD`, so after the M127 commit and process restart it reports the deployed
commit. An absolute configured launcher prevents unqualified global-binary
shadowing for the inspected TCKDB configuration.

## Exact TCKDB Acceptance

Selected files:

```text
backend/app/db/models/workflow.py
backend/app/importers/cccbdb/snapshot.py
schemas/python/tckdb-schemas/tckdb_schemas/workflows/computed_reaction_upload.py
clients/python/src/tckdb_client/builders/kinetics.py
backend/app/schemas/workflows/kinetics_upload.py
clients/python/tests/test_client.py
clients/python/tests/test_docs_calculation_note_conventions.py
```

Lead: `backend/app/db/models/workflow.py::WorkflowTool`.

The client implementation and `degeneracy_convention` are visible. The audited
expected snapshot, workflow, dependency, and notebook surfaces are:

```text
clients/python/tests/test_computed_reaction_upload_builder.py
.github/workflows/python-client-ci.yml
clients/python/pyproject.toml
clients/python/tests/test_builder_computed_reaction_demo_notebook.py
```

Those four surfaces are not visible, and the lead is unrelated. Acceptance is
therefore false. M127 does not hard-code these paths or retune the frozen M126
ranking/role/budget policy.

## Cross-Tool Parity

`get_code_context`, `get_context_capsule`, and `run_pipeline` have identical task
hash, capsule mode, selected-file hash, lead, roles, model-visible-context hash,
implementation, retrieval version, and rescue diagnostics. CLI capsule and CLI
run-pipeline execute the same authority. Default and alias behavior is covered by
the no-agent smoke.

## Product Regression

The frozen expanded-20 and cross-repository-30 fixtures produced zero selected
file, lead, role, or rendered-result differences from the M126 authority. The
quality record remains top-1 39/50, top-5/any-gold 46/50, all-gold-visible 45/50,
lead 39/50, four missing, eleven wrong pivots, and zero `no_candidates`.

The compound-query/path regression families remain green in the full test suite,
including slash, spaced slash, hyphen, parentheses, standalone/prose paths, URLs,
Windows paths, stack traces, CamelCase, snake_case, filenames, and bounded
16/17/32/48/96-term variants.

## Performance

The frozen-50 median was 595.874 ms versus the approximately 614 ms M126 seam;
p90 was 1,222.370 ms versus approximately 1,203 ms. The exact new TCKDB incident
query had a five-sample warm median of 966.211 ms; this is not the same query as
the M126 869 ms reference. No product route performs duplicate authoritative
retrieval.

## Compatibility

Current selectors are removed from advertised schemas and help. Deprecated input
aliases are parser-only. Explicit legacy requests fail. Historical Stage 5
artifact readers continue to interpret old version labels without making them
runtime options.

## Limitations

- The post-merge freshness defect remains assigned to M128.
- Internal filenames/types and historical reports retain versioned names.
- No live-agent effect claim is made.
- The exact TCKDB evidence/lead acceptance failed under the frozen M126 ranker.

## Deferred Work

- M128 post-merge freshness.
- M129 cross-repository workspace intelligence.
- Genuine JavaScript/JSX parsing.
- Tokenizer-exact accounting.
- A separately authorized product-retrieval correction for the exact TCKDB task.

## Success Criteria Check

Routing, explicit rejection, single-authority parity, runtime provenance,
frozen semantics/quality, performance sanity, current documentation, historical
readability, and no-agent constraints pass. The original serving commit cannot be
recovered, and exact-query snapshot/workflow/dependency/notebook/lead criteria
fail. Consequently the milestone cannot satisfy the PASS gate.

Verification completed:

```text
bun run typecheck             PASS
bun run typecheck:benchmarks  PASS
bun test                      PASS (3,718 pass; 49 superseded assertions skipped)
git diff --check              PASS
M127 no-agent smoke           executed; FAIL verdict from exact TCKDB acceptance
frozen 20 + 30 replay         PASS, zero semantic differences
```

## Verdict

**FAIL**

## Recommendation

**fix product retrieval before promotion**

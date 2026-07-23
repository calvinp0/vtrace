# Stage 5 M127 Capsule Unification Plan

## Scope and baseline

M127 removes capsule-engine choice from current product execution without changing
M126 retrieval semantics. The authoritative starting point is commit
`fdcda9a479522722c69a06b32d585b058670bc65` (`Optimize hybrid retrieval core`),
with `1272d2b`, `c678624`, `102dc37`, `965e561`, `a4b7cf6`, `3b0baa7`,
`6dbd519`, and `3efc964` as the preceding product-path authorities named in the
milestone request.

Before M127 the worktree already contained modified
`stage5_outcome_ledger.{md,json}`, untracked `AGENTS.md`,
`VTRACE_TOOLING_AUDIT.md`, `package-lock.json`, raw runs, streams, logs, caches,
workspaces, and unrelated benchmark results. They are excluded from this change.

## Engine definitions (questions 1–10)

1. The old capsule is implemented by `src/capsule/buildCapsule.ts`,
   `buildCapsuleImpl.ts`, `types.ts`, the profile modules under
   `src/capsuleProfiles/`, and the routed `routeQuery` candidate path. It is a
   distinct candidate input, role/profile assembly, character-budget packer, and
   renderer.
2. The current authoritative implementation is under `src/capsuleV2/`, with its
   builder in `buildCapsuleV2.ts` and its product authority in
   `authoritativeProductRetrieval.ts`.
3. Old construction is performed by `buildCapsule` with a
   `createSourceBackedCapsuleBuilder`; current construction is performed by
   `buildCapsuleV2`, then `buildAuthoritativeProductRetrieval` applies the bounded
   routed rescue and projects the same selection to the historical `Capsule`
   shape.
4. Runtime selection is centralized nominally in
   `src/capsuleV2/engineSelection.ts`, but duplicated in MCP handlers and CLI
   parsing. `requestWantsCapsuleV2` returns true only for explicit `v2`.
5. The old path is all three: a different routed retrieval input, profile/role
   assembly and packer/renderer. M123 already stopped it from being selection
   authority inside `runReliableContextRetrieval`, but its output shape and direct
   entry points remain.
6. Yes. `buildAuthoritativeProductRetrieval` calls `buildCapsuleV2`, whose
   candidate seam is `hybridRetrieve`; it then applies only M121's bounded routed
   rescue and projects that exact result.
7. Reachable old runtime paths are default `get_context_capsule`, default/mode
   `CLI capsule`, `handoff`, validation helpers, and old low-level APIs. The
   default `run_pipeline` response still labels itself v1 and suppresses the
   current structured projection even though its main context selection is
   already authoritative.
8. In `run_pipeline`, the legacy selection performed by
   `prepareCapsuleAssembly` is already non-authoritative diagnostic/profile data;
   `context.capsule` comes from `AuthoritativeProductRetrieval.capsule`.
9. `src/capsuleV2/stage5Artifacts.ts` and Stage 5 report/readback helpers must
   continue parsing historical `capsuleEngine: "v2"` artifacts. Historical
   result files and benchmark command-line condition labels remain records, not
   current runtime options.
10. Current names encoding versions include `src/capsuleV2/`,
    `buildCapsuleV2.ts`, `CapsuleV2Result`, `CapsuleV2ProductResponse`,
    `capsuleV2`, `capsuleV2ManifestId`, `renderCapsuleV2Human`, and historical
    benchmark filenames. M127 will introduce an unversioned public assembly seam
    and response terminology; broad historical/mechanical renaming is deferred
    where it adds risk without changing runtime reachability.

## Product routing (questions 11–24)

11. `get_code_context` delegates to the `run_pipeline` tool definition/handler
    after freshness checks, so it inherits the run-pipeline selector.
12. `get_context_capsule` independently parses `capsule_engine` and
    `capsuleEngine`; only explicit `v2` runs `buildCapsuleV2`. Otherwise it calls
    the old context-capsule pipeline.
13. `run_pipeline` parses both aliases, passes the raw value to
    `runPipelineOrchestrator`, and `buildCapsuleV2Section` runs the current
    projection only when `requestWantsCapsuleV2` is true.
14. `requested: "default"` means omission, literal `default`, an empty value, or
    even an unrecognized value after `parseRequestedCapsuleEngine` normalization.
15. It resolves to v1 because `requestWantsCapsuleV2("default")` is false and
    `buildCapsuleV2Section` returns `v1EngineSelection(requested)`. The MCP
    `get_context_capsule` handler has the same explicit-v2-only condition.
16. The controlling constants and functions are `CAPSULE_ENGINE`,
    `parseRequestedCapsuleEngine`, and `requestWantsCapsuleV2` in
    `src/capsuleV2/engineSelection.ts`; CLI accepted values duplicate the policy
    in `src/cli/commands/runPipelineCommand.ts`.
17. Preset/intent does not change the selector. It changes retrieval strategy and
    role policy only after an implementation is selected.
18. Missing and `"default"` are identical today; both normalize to `default` and
    select/describe v1.
19. No repository state/config field persists a capsule engine. Historical
    benchmark run metadata does, but product runtime does not consume it.
20. Neither `src/workspace/config.ts` nor `.vtrace` config/state selects an
    engine.
21. No environment variable selects an engine.
22. `mcp-serve` has no engine startup flag.
23. `vtrace run-pipeline` exposes `--capsule-engine
    <default|v1|v2|legacy>`. `vtrace capsule` has an implicit old-path switch:
    omission of `--intent` and `--budget` enters the old mode builder.
24. Stage 5 harnesses expose historical/labeled `--capsule-engine v2` flags.
    Their artifact readers remain compatible, but they are not current MCP/CLI
    product schemas.

## Shared authority (questions 25–32)

25. `AuthoritativeProductRetrieval` is the M123+ request authority. It contains
    one `CapsuleV2Result`, its projection to `Capsule`, routed-rescue diagnostics,
    and timing.
26. `run_pipeline` and `get_code_context` already use it for
    `context.capsule`; `get_context_capsule` does not on its default path.
27. `run_pipeline` prepares a routed/profile assembly independently for
    diagnostics but returns the authoritative projected capsule. Its optional
    current product section reuses the prebuilt authoritative result. Default
    `get_context_capsule` and CLI mode-based `capsule` still call the old builder.
28. `assembleProductContext` accepts `authoritativeRetrieval`; run-pipeline CLI
    supplies `orchestration.context.authoritativeRetrieval`. MCP handlers need the
    same invariant checked and made unconditional.
29. Disagreement is possible today across old/default surfaces and because the
    optional `capsuleV2` projection is suppressed even when the authoritative
    selection created `context.capsule`.
30. Yes. Default metadata says effective v1 even in `run_pipeline`, where M123's
    authoritative hybrid selection produced the returned context.
31. No. `candidateFilesConsidered` is currently copied from routed
    `pathSignalDiagnostics`; when routed rescue was not needed,
    `classifyQueryWithoutRetrieval` can report zero despite authoritative hybrid
    candidates. M127 will source candidate-stage diagnostics from the authority.
32. Engine selection metadata is resolved after reliable context retrieval in
    the orchestrator. `no_candidates` can therefore be diagnosed from a
    non-authoritative routed diagnostic even though hybrid retrieval already ran.

## Live process and version diagnosis (questions 33–40)

33. Current MCP context/status responses do not expose package version, commit,
    retrieval implementation, capsule implementation, or executable path
    together.
34. Consequently a departed stale MCP process cannot be distinguished
    retroactively from current source using its response.
35. `bin/vtrace` resolves its own checkout root and executes
    `bun <root>/src/cli/index.ts`; it is source-backed, not a compiled `dist`
    artifact.
36. No TypeScript rebuild is required for this launcher. A long-lived MCP process
    must be restarted to load changed modules.
37. `vtrace` is not currently on the inspected shell `PATH`; an old global binary
    could shadow an unqualified command elsewhere, but the installed TCKDB
    project config uses an absolute launcher path.
38. Yes in general. Claude/Codex configurations can name another checkout.
    Inspected TCKDB Claude configuration names the current checkout explicitly.
39. The TCKDB Claude project configuration names
    `<workspace>/bin/vtrace mcp-serve --repo <TCKDB>`. No serving process remains,
    so the exact PID of the reported request is unavailable.
40. The response lacked provenance, so its exact loaded commit cannot be proven.
    Current checkout is M126 commit `fdcda9a...`, and current source itself
    contains the default-to-v1 metadata route; stale source is not required to
    explain the observation.

## API schemas and compatibility (questions 41–50)

41. MCP `run_pipeline`, inherited `get_code_context`, and
    `get_context_capsule` schemas expose snake/camel engine fields.
42. CLI `run-pipeline` exposes `--capsule-engine`; Stage 5 benchmark CLIs also
    expose historical experiment flags. CLI `capsule` chooses old/current behavior
    indirectly through mode versus intent/budget flags.
43. `RequestedCapsuleEngine`, `EffectiveCapsuleEngine`,
    `CapsuleEngineSelection`, MCP input types, and CLI parsers accept versioned
    values.
44. No current repo/workspace product config persists the field. Historical run
    metadata and benchmark plans do.
45. Current `docs/mcp_tools.md`, `docs/mcp_tool_cheat_sheet.md`,
    `docs/cli_usage.md`, `docs/VTRACE_PRODUCT_OVERVIEW.md`,
    `docs/VTRACE_INTERNALS.md`, and `docs/VTRACE_ARCHITECTURE_AND_DEBUGGING.md`
    contain current versioned terminology. Files under `docs/benchmarks/` are
    historical records and may retain it.
46. Version behavior is asserted in `src/capsuleV2/engineSelection.test.ts`,
    `src/runPipeline/runPipelineOrchestrator.test.ts`, `src/mcp/mcp.test.ts`, and
    `src/cli/cli.test.ts`, plus historical Stage 5 harness tests.
47. Stage 5 manifest/meta readers, outcome aggregation, and old raw artifact
    readers must continue accepting v1/v2 labels.
48. Yes. Current responses can remove `capsuleEngine`; this is a private package
    (`package.json` has `private: true`) and repository history shows no released
    external API constraint. Input aliases can remain parser-only for a short
    migration period while being removed from advertised MCP schemas.
49. Yes. Stable implementation identity is useful for stale-process diagnosis,
    but it is diagnostic rather than selectable.
50. Add an unversioned `capsule` diagnostic with implementation, retrieval
    implementation, authority, and rescue status; add runtime package/commit/
    executable/schema/manifest identifiers. Accept hidden deprecated
    `default`/`v2` aliases with warnings, reject `v1`/`legacy` before retrieval,
    and do not emit the old selector as a current product choice.

## Planned implementation

1. Add an unversioned `buildCapsule` facade over the unchanged M126 builder and
   make `buildAuthoritativeProductRetrieval` the sole product assembly seam.
2. Replace selector state with compatibility validation: omission is normal;
   `default` and `v2` are deprecated no-op aliases; `v1` and `legacy` throw
   `unsupported_legacy_capsule_engine` before DB retrieval.
3. Make `run_pipeline`, `get_code_context`, `get_context_capsule`, CLI `capsule`,
   and CLI `run-pipeline` always project the same request-local authoritative
   result. Do not rebuild selection for structured versus rendered output.
4. Remove automatic catch-and-fallback. Current builder failures fail the request.
5. Source selected files, roles, lead, rendered context, and candidate diagnostics
   from the authority; keep routed diagnostics explicitly labeled as rescue data.
6. Add compact deterministic runtime provenance outside stable semantic hashes.
7. Remove engine fields from advertised MCP schemas and current docs; retain
   hidden transition parsing and historical artifact readers.
8. Add focused route/parity/rejection/provenance tests and the required offline
   M127 smoke. Run the exact TCKDB task against a temporary copied index, never
   modifying TCKDB source or in-place `.vtrace` state.
9. Run the frozen 20/30 suites, compound-query suite, M126 semantic comparison,
   and bounded performance seam without live agents, Docker, APIs, or VEXP.

## Acceptance and deferred cleanup

M127 must preserve byte-equivalent selected files, lead, roles, and rendered
context relative to M126's authoritative seam. The old low-level capsule package
may remain temporarily for historical manifests, handoff/validation compatibility,
and tests, but no current product route may invoke it. A broad directory/type
rename is deferred when it would obscure the routing change. M128 remains the
post-merge freshness correction; M129 remains cross-repository workspace
intelligence.

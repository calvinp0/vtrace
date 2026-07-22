# MCP Tools

The visible `vtrace` MCP surface is intentionally small and stable.

For broad coding, debugging, refactor, and repo-understanding tasks, start with `get_code_context`.
`run_pipeline` remains available as the stable/internal equivalent.

For the more tactical version of this guide, see [MCP Tool Cheat Sheet](./mcp_tool_cheat_sheet.md).

## Visible Tool Surface

The current visible tool names are:

- `get_code_context`
- `run_pipeline`
- `get_context_capsule`
- `get_impact_graph`
- `search_logic_flow`
- `get_skeleton`
- `index_status`
- `workspace_setup`
- `get_session_context`
- `search_memory`
- `save_observation`
- `expand_vexp_ref`

Most of those are directly useful today. `expand_vexp_ref` is the advanced exception.

## Language Coverage

Structural tools (`get_skeleton`, `get_impact_graph`, `search_logic_flow`, retrieval, and capsule shaping) only see what the per-language parser extracts. Coverage is deliberately uneven and conservative:

| Language   | Extensions             | Parser         | Indexed graph evidence                                                                                                                                                                                                                                | Status                                                                                                                           |
| ---------- | ---------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Python     | `.py`                  | Registered     | Symbols + `contains`, `imports`, statically resolved `calls` and `references`; conservative member (`self.x`, `cls.x`, `ClassName.x`) and inheritance/`super()` resolution                                                                            | Strongest. Broadest call/reference, member, and inheritance evidence.                                                            |
| TypeScript | `.ts`, `.tsx`          | Registered     | Symbols + `contains`, `imports`, and conservative statically resolved `calls` and `references` (same-file/imported functions, `this.method`/`ClassName.method`, type annotations, `extends`/`implements`, `new`, decorators)                          | Call/reference extraction is conservative static evidence; ambiguous receivers and dynamic dispatch are skipped.                 |
| Cython     | `.pyx`, `.pxd`, `.pxi` | Registered     | Symbols (incl. `cdef class` + methods) + `contains`, `imports`, and conservative statically resolved `calls` and `references` (same-file/imported/cimported/included callables, `self.method`/`ClassName.method`, inheritance bases, exact name uses) | Conservative class/method/call/reference support over a token-level model; ambiguous receivers and dynamic dispatch are skipped. |
| JavaScript | `.js`, `.jsx`          | Not registered | None                                                                                                                                                                                                                                                  | Detected by extension but has no registered parser, so files are scanned and skipped as `unregistered_language` (not indexed).   |
| Go         | `.go`                  | None           | None                                                                                                                                                                                                                                                  | Not currently implemented; not detected as an indexable source file.                                                             |
| Rust       | `.rs`                  | None           | None                                                                                                                                                                                                                                                  | Not currently implemented; not detected as an indexable source file.                                                             |

Notes:

- "Statically resolved" means exact, conservative resolution; ambiguous targets, dynamic dispatch, and unresolved references are skipped rather than guessed.
- Python, TypeScript, and Cython contribute statically resolved `calls`/`references` edges in this milestone; a repo with only JavaScript, Go, or Rust sources will report `callFlowEvidenceAvailable: false` from `search_logic_flow` because those languages have no extracted `calls` edges.
- This matrix reflects current behavior, not a roadmap commitment.

## Passive Tool-Call Observations

`vtrace` auto-captures compact `tool_call` observations for meaningful visible MCP tool calls. Current capture covers successful, useful calls to `get_code_context`/`run_pipeline`, `get_context_capsule`, `get_impact_graph`, `search_logic_flow`, `get_skeleton`, `search_memory`, `get_session_context`, and resolved `expand_vexp_ref` expansions.

Captured observations are deterministic and compact. They store tool name, exact query/task/symbol/file inputs where available, a short summary, and bounded metadata such as counts or selected profiles. They do not store full raw tool outputs.

When the tool input or output already exposes exact graph evidence, captured observations may link to repo-relative files, symbol ids, and symbol FQNs. `vtrace` does not fuzzy guess links or run extra retrieval just to enrich a passive observation. If a session id is present, the observation is associated with that session.

The following visible tools are intentionally excluded from passive capture:

- `index_status`
- `workspace_setup`
- `save_observation`

`index_status` and `workspace_setup` are often status/setup plumbing. `save_observation` already writes exactly what the caller asked to save and is not recursively captured.

This is a passive-memory substrate, not full VEXP parity. It does not add embeddings, semantic similarity, learned ranking, semantic consolidation, automatic rule promotion, or claims that every agent decision is understood.

## Conservative Passive Consolidation

`vtrace` can consolidate repeated passive observations within a single session. The first implementation is intentionally narrow: it targets repeated `mcp_auto` `tool_call` observations with the same deterministic lexical/structural signature. The signature uses exact fields such as tool name, normalized query text, intent, selected compact result-shape fields, sorted linked files, and sorted linked symbol FQNs. It does not use embeddings, semantic similarity, LLM merging, learned ranking, or cross-session memory merging.

Consolidated passive groups are stored as compact auto-generated `insight` observations from `consolidate_passive_observations`. Their body includes explicit metadata such as `consolidated=true`, `source_kind=tool_call`, source observation count, tool counts, first/last observed timestamps, source run ids, session id, deterministic signature, and preserved structural links. The consolidated observation keeps exact linked files, symbol ids, and symbol FQNs so it remains searchable and participates in existing stale-memory checks when those files or symbols later change.

Consolidation is thresholded. By default, at least three eligible passive observations with the same signature are required. Below that threshold, passive observations are left alone by consolidation. When a group is consolidated, only the grouped passive source observations are physically pruned. Manual observations, decisions, insights, warnings, anti-pattern/dead-end observations, and anything authored through `save_observation` are never consolidated or removed by this mechanism.

This is not semantic memory consolidation or automatic rule promotion.

## Session Lifecycle Compression

`vtrace` compresses inactive sessions into compact structural summaries. There is no background daemon or always-on scheduler; compression runs only through two deterministic, bounded triggers:

- **Explicit CLI command.** `vtrace compress-sessions <repo> [--idle-hours N] [--limit N] [--dry-run] [--json]` compresses every eligible inactive session on demand. `--idle-hours` overrides the inactivity threshold (`0` makes all active sessions eligible), `--limit` bounds how many sessions are processed, and `--dry-run` reports what would be compressed and consolidated without writing anything.
- **Bounded reindex sweep.** Every successful reindex (`vtrace index`, the `index_repo` MCP tool, and watcher auto-reindex) runs a small bounded sweep that compresses up to the first 20 sessions inactive past the default threshold. The sweep is idempotent, deterministic in which sessions it selects, and isolated — any failure is captured as a diagnostic on the reindex result and never fails indexing. When it compresses anything, it surfaces a `compress_sessions` progress line; otherwise it emits nothing.

The default compression threshold is two hours of inactivity. Compression records a deterministic summary with observation counts, tool-call counts by tool, unique linked files, unique linked symbol ids and FQNs, key lexical terms, first/last activity times, compression time, preserved durable count, and repeated passive tool-call source rows pruned through consolidation.

Compression also triggers conservative passive consolidation for the inactive session. Repeated passive groups become narrower consolidated summaries, while the broad compression summary remains the session-level aggregate. Durable observations remain preserved, including manual notes and non-ephemeral insights, decisions, warnings, and dead-end observations. Manual observations are not removed by compression.

Compressed sessions remain inspectable through session context: `get_session_context` reports the compression summary and returns preserved observations, including durable observations and compact consolidated passive summaries where present, without flooding the response with pruned repeated tool calls. Compression summaries and consolidated summaries are searchable, so `search_memory`, `run_pipeline.memory`, and capsule memory surfacing can find them through deterministic lexical and structural signals such as key terms, tool names, file paths, and symbol FQNs.

The default retention threshold is 90 days. This milestone reports deterministic cleanup candidates for old compressed sessions; physical deletion of compressed summaries and durable data is intentionally deferred.

## Capsule Manifest Staleness

`get_context_capsule` and `run_pipeline` persist a deterministic capsule manifest each time they build a non-empty capsule on an indexed repo, and surface its id:

- `get_context_capsule` returns `capsuleManifestId` at the top level of its output.
- `run_pipeline` returns it as `context.capsuleManifestId`.

The manifest id is a content hash of the source run id, query, and the capsule's items (file paths, symbol ids, FQNs, content modes), so repeated calls on the same repo state return the same id and persistence is idempotent — no duplicate rows. The id is `null` only for multi-repo capsules or before the repo has any index run.

Pass that id to the `check_capsule_staleness` MCP tool or `vtrace check-capsule <repo> <manifest-id> <comparison-run-id>` to evaluate whether the capsule's source-backed items are still fresh against a later index run. After a file or symbol referenced by the capsule is modified or removed and the repo is reindexed, the manifest reports `stale` with per-item reasons; otherwise it reports `fresh`. This is the same conservative structural diff machinery used for observation staleness — it is not semantic or runtime reachability.

## Optional Passive File Awareness

File watching is opt-in. `vtrace watch [repo]` runs a lightweight polling watcher that uses the same indexed-source scan rules as the indexer. It observes created, modified, and deleted source files, debounces bursts, and records a compact pending stale state in `.vtrace/state.json`.

The watcher is mark-stale-only by default. `vtrace watch [repo] --auto-reindex` explicitly opts into debounced automatic reindexing; setup never enables it implicitly. Auto-reindex prevents overlapping watcher-triggered index runs in the watcher process. If auto-reindex fails, stale state and compact failure metadata stay visible, and normal MCP tools remain usable.

`index_status` reports watcher support, whether watcher mode has been used for the repo, auto-reindex state, pending changed file count, a bounded sorted changed-file list, and freshness metadata. `run_pipeline.diagnostics.freshness` also reports stale and auto-reindex metadata when available.

A successful explicit reindex through the normal indexing path clears pending watcher-observed stale state and auto-reindex failure state. Reindexing continues to use the existing structural file and symbol diff machinery. Linked observations, passive `tool_call` observations, consolidated passive summaries, compressed session summary observations, and linked project rules become stale through conservative structural checks when their linked files or symbols are modified or removed.

This is not semantic rename detection, runtime dataflow, or full VEXP passive behavior.

## Conservative Anti-Pattern Observations

`vtrace` can detect a small set of conservative anti-patterns from passive observations and watcher/index signals. These are stored as durable `dead_end` observations with explicit anti-pattern metadata so they can be inspected through `get_session_context`, found through `search_memory`, and preserved during session compression.

The initial detectors are intentionally structural:

- `file_thrashing`: source-file watcher events show one file changed repeatedly within a short time window.
- `symbol_added_then_removed`: existing structural diffs show a symbol was added in one index run and removed in the next.

Detection is deterministic and deduped by evidence signature. Anti-pattern observations include a short summary, severity, exact linked files or symbol FQNs where available, and compact evidence such as change counts or index run ids. Linked anti-pattern observations participate in the existing stale-memory behavior when their files or symbols later change.

This is not semantic understanding of developer intent, progressive nudging, learned classification, semantic consolidation, or policy enforcement. `vtrace` does not block normal MCP behavior when an anti-pattern observation exists.

## Progressive Observation Nudges

`run_pipeline.diagnostics.nudge` may include a compact structural nudge when an active session has meaningful passive tool-call activity but no durable observation yet. Nudges are metadata in the tool result, not forced chat messages, retrieved context, or persisted observations.

The current schedule is deterministic:

- first full nudge after 3 passive `tool_call` observations in the session
- later brief nudges at most once every 5 additional passive tool calls
- no nudge once a durable observation exists

Durable observations include manual saves and durable kinds such as decisions, insights, warnings, and dead-end/anti-pattern observations. `index_status`, `workspace_setup`, and `save_observation` are excluded from nudging, and `save_observation` itself self-disables future nudges for that session by creating durable memory.

Nudges never block tool execution and do not write their own observations. They are not project rules, semantic judgment, learned behavior, or memory consolidation.

## Project Rule Candidates

`vtrace` can generate deterministic project-rule candidates from repeated evidence in one repo. Candidate generation is explicit through `vtrace rules generate-candidates <repo>` (`generate` remains an alias) and uses exact structural or lexical overlap only. The first threshold is three matching evidence observations in the same deterministic scope.

Eligible evidence is intentionally narrow:

- manual durable `decision` and `insight` observations
- consolidated passive summaries created by `consolidate_passive_observations`
- repeated anti-pattern observations such as `file_thrashing` or `symbol_added_then_removed`

Raw one-off passive `tool_call` observations do not generate rule candidates. Candidate generation never mutates or consumes the source observations.

Rule summaries are template-based and evidence-limited. They use cautious wording such as “Repeated durable evidence is linked to…” and “Consider…”. `vtrace` does not use embeddings, LLM synthesis, semantic project understanding, hidden-intent inference, or cross-repo rule learning for this feature.

Candidates are not active by default. A rule must be explicitly promoted before it can be injected into future context:

```bash
vtrace rules list <repo>
vtrace rules generate-candidates <repo>
vtrace rules add-active <repo> --summary "When changing run_pipeline output, update MCP docs and tests." --file src/mcp/tools.ts --term run_pipeline
vtrace rules promote <repo> <rule-id>
vtrace rules dismiss <repo> <rule-id>
vtrace rules disable <repo> <rule-id>
```

The command also accepts `vtrace rules <repo> list` style ordering.

Active rules are injected into `run_pipeline.rules` and `get_context_capsule.capsule.rules.active` only when they match the current task by deterministic signals such as linked file overlap, linked symbol FQN overlap, path-prefix overlap, query-term overlap, or selected intent. Injection is capped at three active rules. Candidate previews may appear in `run_pipeline.rules.candidates`, but they are explicitly labeled as candidates and are not active instructions. Capsules do not include candidate previews; active rules are kept separate from memory observations.

Rules are linked to files, symbol FQNs, lexical terms, tool names, intents, and anti-pattern types where that evidence exists. Candidate generation deduplicates by deterministic signature, updates matching candidates with new evidence, preserves dismissed candidates instead of recreating them, and may update evidence metadata on a matching active rule rather than creating a duplicate candidate. When explicit reindexing detects linked file or symbol changes, candidate and active rules become `stale`. Candidate, stale, disabled, and dismissed rules are not injected as active guidance. This milestone does not implement automatic promotion, semantic rule generation, embeddings, semantic similarity, cross-repo rules, policy enforcement, or tool blocking.

## Default Orchestration

### `get_code_context`

Vtrace default first-pass repo-context tool. This is the agent-friendly alias for `run_pipeline` and returns the same output for equivalent inputs.

Use it for:

- new coding tasks
- debugging orientation
- broad refactor orientation
- finding likely edit surfaces
- getting one structured orchestration result with intent, compact context, impact decision, memory/session evidence, diagnostics, and deferred metadata

Preferred input fields:

- `task`: natural-language task description
- `preset`: `auto`, `explore`, `debug`, `modify`, or `refactor`
- `max_tokens`: product-facing budget, mapped to the current character-budgeted capsule engine
- `include_tests`: caller preference; defaults on for debug and off otherwise
- `include_file_content`: caller preference; `run_pipeline` still returns compact representation metadata rather than raw full-file payloads
- `observation`: durable observation text to save with the run
- `repos`: optional workspace repo aliases

Backward-compatible aliases are still accepted:

- `query` for `task`
- `intent` for `preset`
- `maxBudgetCharacters` for `max_tokens`

`get_code_context` does not make itself mandatory before code edits. It is the broad-task entrypoint; exact tools remain better when the caller already has exact inputs.

### Shared product context response (version 2)

The single-repository forms of `get_code_context`, `get_context_capsule`, and
`run_pipeline` now carry the same additive `productContext` object. Existing v1
and opt-in-v2 outer fields remain available; `productContext` is the normalized
model-facing contract and always uses the shared Capsule v2 selection assembly.
For the same fresh index, task, intent, and budget it has the same task hash,
lead pivot, selected files, role assignments, worktree/freshness identity, and
token estimator on all three tools.

`productContext.responseVersion` is `2`. Its `items` are deterministically
ordered and can have multiple roles (`pivot`, `required`, `support`, `skeleton`,
`impact`, `memory`, `rule`, or `documentation`). Pivot source remains focused or
full source. Support compression uses indexed parser skeletons and signatures,
with an explicit bounded-excerpt or metadata fallback. Exact duplicate bodies
are rendered once even when an item is reached through multiple roles.

`productContext.modelVisibleContext` is the final deduplicated text measured by
`productContext.accounting`. Token values use `ceil(characters / 4)`, reported as
`estimateMethod: "character_ratio"` and `estimateExact: false`; they are not
provider-reported or billable-token counts. The canonical naive baseline is the
full content of each unique selected source file before compression. It excludes
duplicate inclusion and generated metadata, is not an entire-repository
baseline, and is `null` when a trustworthy baseline cannot be formed. Small
files may honestly produce a negative estimated reduction when structured
context costs more than their full text.

`productContext.timing` uses monotonic wall-clock measurements. Freshness,
capsule build, static impact, memory/rules, rendering, total time, and (when an
automatic refresh occurred) index refresh are reported separately. The current
Capsule v2 builder has no internal retrieval timing seam, so retrieval is
reported as `0` and the encompassing synchronous work is attributed to capsule
construction rather than double-counted. Impact items are bounded static graph
evidence, never claims about dynamic execution flow. Memory and rule items are
included only when existing stores return relevant, fresh/active entries.

Stale and invalid `get_code_context` responses also include an unresolved
`productContext`, with freshness diagnostics and measured total latency but no
fabricated selected-file savings. Multi-repository workspace normalization is
deferred; those existing outer responses remain unchanged.

### `run_pipeline`

Internal/stable name for the same default Vtrace repo-context pipeline exposed as `get_code_context`.

#### Opt-in Capsule v2 section (experimental)

By default `run_pipeline` (and therefore `get_code_context`, which delegates to it) returns the unchanged v1-only orchestration. Callers can additionally request the **Capsule v2** product section — the same bounded, intent-aware, evidence-scored primitive offered by `get_context_capsule` — without losing any v1 section:

- `capsule_engine: "v2"` (or the camelCase alias `capsuleEngine: "v2"`)

Optional v2-only inputs (ignored unless `capsule_engine=v2`):

- `capsule_intent` / `capsuleIntent`: `auto` (default) | `debug` | `refactor` | `modify` | `explain` | `impact` | `test-failure`
- `capsule_budget_tokens` / `capsuleBudgetTokens`: positive integer token budget (default `8000`)

When opted in, the orchestration result is **augmented** (not replaced):

- a top-level `contextEngine: "v2"` discriminator and a `capsuleV2` block (the same shape `get_context_capsule` returns under `capsuleV2`), plus a persisted `capsuleV2ManifestId`.
- all existing sections — `context`, `impact`, `flow`, `memory`, `rules`, `diagnostics`, and `deferred` refs — are preserved unchanged.

The default (no `capsule_engine`) path is byte-compatible with prior behavior except for the additive `accounting` block (see below); the v2 section is omitted entirely. As with `get_context_capsule`, the v2 section is single-repo only — a multi-repo workspace request with `capsule_engine=v2` is rejected — and persists a deterministic manifest that resolves via `check_capsule_staleness`. Making v2 the default is intentionally deferred.

The CLI mirrors the opt-in: `vtrace run-pipeline <repo> <query> --capsule-engine v2 [--capsule-intent <intent>] [--capsule-budget-tokens N]`.

#### Pivot-neighborhood excerpts (v2 only)

The `impact` and `flow` sections only carry source excerpts when the query resolves two flow endpoints (`flow`) or carries refactor-like intent (`impact`). Normal debug/modify queries trigger neither, so they would otherwise get no inline relationship source even when Capsule v2 already pinned the right pivots. The **`pivotNeighborhood`** section closes that gap.

When `capsule_engine=v2`, the response carries an additive `pivotNeighborhood` array: for the **top 1–2 pivots**, a small set of bounded source excerpts from the pivot's neighborhood, so a debug query gets useful nearby source without an explicit flow/impact trigger. Each entry is:

```ts
interface PivotNeighborhoodContext {
  pivot: { path: string; symbol: string | null; fqName: string | null };
  excerpts: Array<{
    filePath: string;
    symbol: string | null;
    fqName: string | null;
    startLine: number;   // 1-based
    endLine: number;     // 1-based
    text: string;        // never a whole file
    reason: "caller" | "callee" | "importer" | "imported"
          | "reference" | "support" | "sibling" | "fallback_symbol_window";
    truncated: boolean;
  }>;
  skipped?: Array<{ target: string; reason: string }>;
}
```

`reason` names the structural relationship the neighbor was reached through, in priority order: `support` (a Capsule v2 support item in the pivot's file/directory), `caller`/`callee` (calls edges), `importer`/`imported` (imports edges), `reference` (references edges), `sibling` (same parent scope/class), then `fallback_symbol_window` (a same-file neighbor reached through no edge). **The relationship names the edge; the snippet is still the neighbor symbol's own indexed line span (a symbol-window), never an exact call/reference line** — indexed edges carry no call-site location, so we never pretend a window is an exact edge site.

Bounds (defaults): top **2** pivots; max **4** excerpts per pivot; max **12** lines per excerpt (signature-focused neighbors use a tighter 6-line window); 200 chars per line (longer lines trimmed with `…`, `truncated` set). Best-effort: a neighbor whose source cannot be loaded freshly (missing/stale relative to the index) or whose symbol identity does not resolve is recorded under `skipped` rather than failing the run. The section is present only on the `capsule_engine=v2` path and may be an empty array when no pivot symbol identity resolves; the v1 path omits it entirely. Its excerpt files are counted in the `accounting` naive-file baseline. Retrieval, Capsule v2 ranking/scoring, and the `impact`/`flow` sections are unchanged — this is purely additive debug enrichment.

#### Context accounting (estimated, deterministic)

Single-repo `run_pipeline` / `get_code_context` responses (both the default v1 path and the v2 opt-in) carry an additive top-level `accounting` block so a caller can see how compact the emitted context is relative to the naive alternative — reading the full contents of every source file the context touched. The same block is on `get_context_capsule` (v1 and v2). It is **estimated and deterministic, not exact tokenizer truth**: every token figure is `chars / 4` (`method: "chars_div_4"`), the same approximation that sizes Capsule v2.

Fields:

- `latencyMs`: wall-clock latency of the measured orchestrator/handler path.
- `estimatedOutputTokens`: `chars / 4` of the actual emitted product response.
- `estimatedNaiveFullFileTokens`: `chars / 4` summed over the **full contents** of each unique file represented in the emitted context items (the `baseline`).
- `estimatedTokensSavedVsNaiveFullFile`: naive estimate minus emitted estimate, clamped at `0`.
- `estimatedSavingsPercentVsNaiveFullFile`: percent reduction vs. the naive baseline; `null` when no files were counted.
- `uniqueFilesCounted`: number of unique files actually read for the baseline.
- `method`: always `"chars_div_4"`.
- `baseline`: explicit wording of the naive comparison.
- `skippedFiles` (optional): files that could not be counted (missing/unreadable/outside the repo), with a reason.

The baseline reads **only** the unique files the capsule/context already selected — it never scans the repo, refuses paths that escape the repo root, and treats any missing/unreadable file as a recorded skip. Accounting is best-effort: if it fails, the `accounting` field is simply omitted and the request still succeeds. It does not affect retrieval, ranking, or capsule assembly. Multi-repo responses omit accounting. Exact tokenizer support and model-specific token accounting remain intentionally deferred.

### `get_context_capsule`

Return the compact context package directly, without the fuller orchestration role of `run_pipeline`.

Use it when you want:

- the capsule only
- a smaller manual retrieval flow
- a compact structural/task package without extra orchestration

#### Opt-in Capsule v2 engine (experimental)

By default `get_context_capsule` builds the **v1** capsule and returns the unchanged v1 output shape. Callers can opt into the **Capsule v2** engine — the bounded, intent-aware, evidence-scored context primitive otherwise used on the CLI/Stage-5 surface — by passing an explicit engine field:

- `capsule_engine: "v2"` (or the camelCase alias `capsuleEngine: "v2"`)

Optional v2-only inputs (ignored unless `capsule_engine=v2`):

- `capsule_intent`: `auto` (default) | `debug` | `refactor` | `modify` | `explain` | `impact` | `test-failure`
- `capsule_budget_tokens`: positive integer token budget (default `8000`)

When opted in, the response is a v2-native envelope instead of the v1 capsule:

- `engine: "v2"` and a `capsuleV2` block; the v1-only sections (`classification`, `routingProfile`, `capsuleProfile`, `capsule`) are omitted.
- `capsuleV2` contains: `engine`, `experimental: true`, `intent` (the resolved intent), `actualMode` (sizing tier or `no_context`), `reason` (only on `no_context`), a `budget` summary (`maxTokens` / `estimatedTokens` / `usedPercent`), `pivots` and `support` items (each with `path`, `symbol`, `fqName`, `kind`, `roleReason`, `contentMode`, `source`/`signature` content, `evidence`, `estimatedTokens`, `isNonSourceExample`), a bounded `discarded` list with `discardedTotal`, and a `diagnostics` summary (intent reason/confidence, role policy, counts, tier, likely files/symbols, failing tests, edit-risk directives).
- Output is bounded: the v2 engine budgets pivot/support content; the product surface additionally caps the discarded list. No unbounded file contents are emitted.

The default (no `capsule_engine`) path is byte-compatible with prior behavior; the v2 engine never affects it.

Notes / current scope:

- Single-repo only: a multi-repo workspace request with `capsule_engine=v2` is rejected (use the default v1 path for multi-repo).
- Manifest persistence is consistent with the v1 path — a deterministic `capsuleManifestId` is persisted and resolves via `check_capsule_staleness`. Because v2 items carry no DB `symbolId`, the manifest uses each item's `fqName` as the symbol-identity surrogate, so file-level staleness is exact while symbol-level staleness compares against the fqName surrogate (an intended difference from v1).
- Auto-capture of a `tool_call` observation is deferred for the v2 path (capture is keyed on the v1 capsule structure).
- Both the v1 and v2 single-repo responses carry the additive, estimated `accounting` block described under `run_pipeline` (deterministic `chars / 4`, not exact tokenizer truth).
- `get_code_context` remains the default "start here" tool; Capsule v2 is opt-in/experimental.

## Structural Tools

### `get_skeleton`

Return a compact structural view of one or more indexed files without function or method bodies.

Use it for:

- orienting in large files
- comparing candidate modules
- seeing imports, exports, declarations, classes, and methods cheaply

### `get_impact_graph`

Return a bounded structural dependent view for an exact indexed symbol.

Use it before:

- renames
- refactors
- public API changes
- interface changes that could affect callers or dependents

Prefer this specialist tool over `run_pipeline` when you already know the exact symbol FQN.

Use `get_impact_graph` when the user asks what breaks, blast radius, dependents, callers, references, or impact of changing a known symbol.

Each dependent node may carry an optional bounded `sourceExcerpt` showing why it depends on the focal symbol (the dependent/caller source), so you can read the relationship inline instead of issuing a follow-up `Read`. See [Bounded source excerpts](#bounded-source-excerpts) for the field shape and bounds.

Use `get_skeleton` when the relevant file path is already known and you need structural overview.

Use `search_symbols` for exact symbol lookup or when the context result is weak.

### `search_logic_flow`

Return bounded directed paths between two exact indexed symbol FQNs over indexed `contains`, `imports`, and statically resolved `calls` edges.

Use it when:

- you know the exact start symbol
- you know the exact end symbol
- you want the conservative static path between them, including call-flow edges where they were statically resolved

Important limits:

- exact FQN resolution only
- bounded deterministic paths only
- `calls` edges are static, conservative call-target resolution (Python, TypeScript, and Cython in this milestone); ambiguous or dynamic-dispatch targets are skipped, never guessed
- static evidence only — a traversed `calls` edge is not proof a call executes; this is not runtime tracing
- not semantic dataflow

Coverage is explicit. Each result reports:

- `supportedEdgeTypes` — the edge types traversal may use (`contains`, `imports`, `calls`)
- `observedEdgeTypes` — the edge types actually present in the returned paths
- `callFlowEvidenceAvailable` — whether any statically resolved `calls` edge existed in the indexed graph for the repo. When `false` (for example, a JavaScript-only repo), the result is honest structural containment/import traversal only and does not trace call flow
- `callFlowEvidenceUsed` — whether a returned path actually traverses a `calls` edge

Each path step may carry an optional bounded `sourceExcerpt` around the edge source (the `from` symbol, where the call/import/reference originates), so you can read the relationship inline instead of issuing a follow-up `Read`. See [Bounded source excerpts](#bounded-source-excerpts) for the field shape and bounds.

Prefer this specialist tool over `run_pipeline` when you already know the exact start and end FQNs.

### Bounded source excerpts

`get_impact_graph` dependents and `search_logic_flow` path steps can include a small inline `sourceExcerpt` so an agent can see the relevant relationship without re-reading files. The same excerpts ride through `run_pipeline` / `get_code_context`: each `flow.paths[]` carries a compact `sourceExcerpts` array (non-null step excerpts only), and each `impact.topDependents[]` node carries its `sourceExcerpt`.

Field shape:

```ts
interface SourceExcerpt {
  filePath: string;
  startLine: number;   // 1-based
  endLine: number;     // 1-based
  text: string;        // never a whole file
  reason: "symbol_span" | "edge_site" | "signature" | "fallback_symbol_window";
  truncated: boolean;
}
```

`reason` is honest about precision:

- `symbol_span` — the symbol's full indexed line span fit the budget and is shown verbatim.
- `signature` — a signature-focused leading window of a larger symbol (impact dependents).
- `fallback_symbol_window` — a generic leading window of a larger symbol (flow edge source).
- `edge_site` — reserved. Indexed edges carry **no** call-site line, so excerpts are derived from a symbol's own span and `edge_site` is never emitted today; the tool never pretends a symbol-window snippet pinpoints an exact call/reference line.

Bounds (defaults):

- max 12 lines per excerpt (hard ceiling, even if a larger window is requested); signature-focused excerpts default to 6 lines.
- per-line character cap (200 chars); longer lines are trimmed with `…` and `truncated` is set.
- up to 6 excerpts per returned flow path; up to 10 dependent excerpts per impact response.
- excerpts are best-effort: if source cannot be loaded freshly (missing file, content drift versus the index) the field is `null` and the tool still succeeds. The pure structural result (no bound repo root) omits the field entirely.

## Memory and Session Tools

### `save_observation`

Persist a durable observation worth remembering later.

### `search_memory`

Search saved observations and durable memory.

### `get_session_context`

Return recent/current session context so you can resume a workstream quickly.

## Setup and Health Tools

### `index_status`

Compact repo MCP status. Use it to check whether the repo is initialized, indexed, and ready.

It also reports optional watcher/freshness metadata, including pending watcher-observed file changes and auto-reindex state when `vtrace watch` has been used.

### `workspace_setup`

MCP-facing setup shell.

It supports:

- inspect mode
- apply mode

Use it when you want setup/readiness behavior through MCP instead of the CLI.
When `.vtrace/workspace.json` exists, inspect output also includes the configured workspace repos and their readiness.

`workspace_setup.status.claudeCode` is retained as a compatibility field name for generated local-agent config status. Public setup should be understood as setup for supported local coding agents, including Codex when selected; the field name does not imply that Codex setup is unsupported.

## Advanced Tool

### `expand_vexp_ref`

Advanced compressed-reference expansion.

`run_pipeline` may report deferred items with explicit `expandable` metadata. Only items marked `expandable: true` should be sent to `expand_vexp_ref`.

`expand_vexp_ref` accepts one exact public V-REF hash:

- exactly 12 characters
- lowercase hexadecimal
- no fuzzy lookup
- no prefix lookup
- no uppercase normalization

Expansion returns the stored deferred payload captured when `run_pipeline` emitted the V-REF. It does not recompute from disk or reconstruct content semantically. Source file changes after emission do not alter the stored expansion payload.

V-REF payloads are stored in the repo-local `.vtrace` SQLite state while retained. The process-local store remains a hot cache for same-server expansion, and repo-local persistence lets a repo-bound MCP server resolve retained hashes after restart. Persistence is bounded by retention policy, not permanent unlimited storage.

Current retention keeps up to 1000 persisted V-REF records per repo-local database and keeps bounded tombstones for deterministic cleanup. Capacity-evicted or expired records return `expired` while their tombstone is retained; never-seen well-formed hashes return `unknown_hash`.

Malformed, unknown, expired, and unsupported-category references return explicit structured failures. `vtrace` does not claim unlimited persistence, a special compressed format, or token-savings percentages.

## Notes

- `workspace_setup` and `index_status` are available before repo init
- the visible surface is product-facing and intentionally conservative
- structural tools expose indexed repository structure, not runtime truth
- `search_logic_flow` is best when both endpoints are exact FQNs

## Related Shell Commands

- `vtrace setup`
- `vtrace status`
- `vtrace doctor`
- `vtrace claude-config`
- `vtrace claude-config --agent codex`
- `vtrace daemon start|stop|status|logs`
- `vtrace watch`
- `vtrace mcp-serve --repo <repo>`

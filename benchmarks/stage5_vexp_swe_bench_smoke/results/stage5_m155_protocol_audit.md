# Stage 5 M155-A — protocol audit

Candidate under qualification: `051a7c559efcc90848390922b8a42293fb66dba5`
(M154 final functional). Predecessor of M154: `e3761ab989a14aea4e233844070491084f33b2ce`.

Repository state verified at audit time: branch `main`, 17 local-only commits, not
pushed, 14 pre-existing worktrees, pre-existing `stage5_outcome_ledger.*` dirt
preserved, no product code modified.

This audit answers §9–§17: what the historical Stage 5 protocol actually is, and
whether it is trustworthy enough to spend on. Three findings materially constrain
M155. All three are measurements, not inferences.

---

## Finding 1 — the historical VTRACE arm has no agent-callable tools

**The recovered protocol delivers VTRACE as pre-computed text injected into the
prompt, not as tools the agent may call.**

Evidence:

1. `VtraceMethod = "instructions-file" | "mcp" | "local-patch" | "indexed-context"`
   (`run_stage5_vexp_swe_bench_smoke.ts:254`). The value `"mcp"` is accepted by
   `parseArgs` and by the type guard at :10547/:10606 and is **never dispatched on
   anywhere in the harness**. Its only other occurrence in the repository is a test
   seeding the string into a metadata row to prove `runIngest` reports `"mixed"`.
   There is no MCP code path.
2. The external harness spawns Claude Code with `--strict-mcp-config` and, when no
   MCP config path is supplied, an explicitly EMPTY server set:
   `await writeFile(emptyConfig, JSON.stringify({ mcpServers: {} }))`
   (`vexp-swe-bench/src/agents/claude-code.ts:43-49`). The Stage 5 runner never
   supplies `mcpConfigPath` — `grep -rn "mcpServers|mcp_servers|--mcp"` over
   `benchmarks/` returns nothing.
3. The delivery mechanism is a file: `_vtrace_instructions.md`, assembled by
   `buildVtraceContextMarkdown` and confirmed injected by the stderr marker
   `STAGE5_VTRACE_INJECTION_LOG` ("Stage5 vtrace instructions injected from").

### What this makes unmeasurable

The following M155 requirements presuppose a tool-using agent and **cannot be
answered under the recovered protocol**:

| § | Requirement |
| --- | --- |
| 38 | tool discovery — which VTRACE tools are visible to the model |
| 39 | known-positive VTRACE tool-use control |
| 40 | VTRACE offered / used / not used |
| 41 | ordered telemetry showing `VTRACE → read → grep` |
| 74 | VTRACE usage rate |
| 76 | `get_impact_graph` called / useful / irrelevant / misleading |
| 77 | `get_code_context` correct lead / useful support / ignored |

These are not gaps in instrumentation. There is no tool call to instrument.

### What remains measurable

The paired question §27 actually asks — *baseline agent vs same agent + VTRACE* —
is intact, with VTRACE supplied as injected context. `--protocol all` runs both
arms natively. Ordered tool-call telemetry (`_tool_calls.json`, read/search/edit)
exists for both arms, so §48/§49/§50 (files read before first edit, grep calls,
time-to-first-relevant-file, turns, tokens, cost) are all measurable.

**Consequence for M155**: D can qualify VTRACE-as-injected-context. It cannot
qualify VTRACE-as-tool-surface. Any claim about tool utility would require new
benchmark infrastructure, which §29 ("recover the exact current implementation
rather than rebuilding it") and §114 (no product-feature commit) both discourage.

---

## Finding 2 — the canonical deterministic suites score current code against a 2026-06-08 index

**This is a benchmark-validity defect, and it is the reason M155-B cannot simply
rerun the existing suites.**

The committed baselines `stage5_retrieval_eval_expanded.*` (20 cases) and
`stage5_retrieval_eval_cross_repo_30.*` (30 cases) are marked
`artifactState: "authoritative"`. Their fixtures point at
`results/workspaces/{expanded,cross_repo}/<instance_id>`, and
`run_stage5_retrieval_eval.ts` **opens** `.vtrace/index.sqlite` there. It contains
no index build, no rebuild, and no staleness assertion.

Those indexes were built once:

```json
{ "vtrace_commit": "70354295895546c06166bec6d650d23f462ab7b5",
  "created_at": "2026-06-08T07:39:33.513Z" }
```

`index_runs` holds exactly one row (`created_at_ms` = 2026-06-08). `70354295` is
**491 commits behind HEAD** — pre-M129, pre-M140, pre-M147, pre-M150, pre-M152.
(Recent `index.sqlite` mtimes are schema migration on open, not re-indexing.)

### Known-positive control

Same instance (`psf__requests-1142`), same source tree, indexed with the M154
candidate versus the stale on-disk index:

| | stale (2026-06-08, `7035429`) | fresh (M154, `051a7c55`) |
| --- | ---: | ---: |
| files | 69 | 70 |
| symbols | 765 | 834 |
| edges | 1066 | 1219 |
| `document_chunks` | **0** | **6** |
| `symbol_mechanism_facts` | **0** | **79** |
| symbols of kind `module` | **0** | **69** |

The three zeros are the finding. In the corpus these suites measure:

- **M129 document-aware retrieval has no documents.** `document_chunks` is empty.
- **M150/M153 mechanism facts do not exist.** `symbol_mechanism_facts` is empty.
- **M140-A's module-scope symbol — the owner of imports — is absent.** There is no
  `module` kind at all; M140 raised ARC import edges 283 → 2281 through exactly
  this symbol.

The tables are *present but empty* because opening a stale index with current code
migrates its schema and leaves the new feature tables unpopulated. A suite reading
it therefore reports a product whose document lane, mechanism lane and module
ownership all silently contribute nothing — and reports it as authoritative.

### Consequence

A "0/50 changed" result from these suites is evidence of *containment* (M154 read
it correctly that way) but is **not** broad qualification: for any milestone whose
gain lives in the index rather than the ranking code, these suites are structurally
incapable of observing it. §68's historical trend table cannot be built from them.

M155-B and M155-C must prepare indexes per side via
`run_stage5_m134_prepare_targets.ts`, which builds each side's index with that
side's own `bin/vtrace`. The M134/M140 paired comparisons already did this
correctly; only the committed standalone baselines are affected.

---

## Finding 3 — the committed baselines are stale relative to the candidate

`stage5_retrieval_eval_baselines.meta.json` records
`generated_at_commit: 7b29882e` (M134, 2026-08-09). Since then:

```
git diff --stat 7b29882e..HEAD -- src/
205 files changed, 36899 insertions(+), 1536 deletions(-)
```

The byte-diff-against-committed-baseline path documented in CLAUDE.md is therefore
invalid for M155. §101's Frozen50 / Django / cross_repo_30 comparison must run as a
**paired predecessor/candidate** comparison with independently prepared indexes,
not as a diff against these files.

---

## Recovered task corpus (§11)

A fixed historical broad SWE-bench corpus exists and reconstructs exactly.

`stage5_m108_case_selection.json` + the committed M105/M106/M107 exclusion lists
compose a frozen pool of **100 instances across 12 repositories**:

| repo | n | repo | n |
| --- | ---: | --- | ---: |
| django | 44 | astropy | 5 |
| sympy | 17 | psf/requests | 4 |
| sphinx-doc | 7 | pytest-dev | 4 |
| matplotlib | 7 | pylint-dev | 2 |
| pydata/xarray | 6 | scikit-learn | 2 |
| | | pallets/flask | 1 |
| | | mwaskom/seaborn | 1 |

Selection method (from the committed artifact, pre-registered before any live run):
pool = `stage5_m103_deterministic_scoreboard.detail.json` rows with
`generation_status=scored`; M108's own extension was the deterministic COMPLEMENT
of the committed M105/M106/M107 sets — "no strata, no sampling, no backup list".

Clean indexed workspaces exist for **100/100** of these instances under
`results/workspaces/{expanded,cross_repo}` — a 1:1 match with the pool, no extras
and no gaps.

This satisfies §11's strong preference: M155 reuses the exact historical task IDs
rather than constructing a new corpus under §13, and no VEXP task list is copied
(§14).

### Fixture gap

The 100-case pool has no fixture in the modern `run_stage5_retrieval_eval.ts`
format; the largest existing fixtures are `cross_repo.30` (30) and
`django.expanded` (20). `build_stage5_retrieval_fixture.ts --instances` builds one
deterministically from the gold patches (`label_source = gold_patch`), with the
labels used for scoring only and never fed into retrieval. Building it is
benchmark work permitted by §5 and changes no product behaviour.

---

## Live-run preconditions (§96)

| Precondition | State |
| --- | --- |
| external `vexp-swe-bench` harness | present |
| `claude` CLI credentials | present (`~/.claude/.credentials.json`; `ANTHROPIC_API_KEY` unset) |
| testbed prefix `/home/calvin/miniforge3/envs/vexp_swebench` | present |
| `$VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX` | unset — must be passed via `--expected-testbed-prefix` or the run fails closed (M89) |
| mandatory env + shell guards | implemented, fail-closed before agent spawn |
| paired baseline arm | supported natively (`--protocol all`) |

Historical cost anchor: M108 spent **$25.27** for 50 single-arm VTRACE cases
(~$0.51/case) against an M73 historical treatment cost of $28.19 for the same 50.
A paired 100-case run is ~200 agent runs. Live runs are strictly sequential (they
share `_agent_stream.jsonl`), and each run re-clones its repository.

## Operational constraint

`/tmp` is a 32 GB tmpfs with ~6 GB free; indexing a single medium repository there
fails with `disk I/O error`. All M155 target corpora must be prepared under
`/home` (610 GB free). Measured index cost on `/home`: 4 s for a 5 MB repository,
~71 s for a 21 MB repository (sympy), both requiring the quarantine-retry loop.

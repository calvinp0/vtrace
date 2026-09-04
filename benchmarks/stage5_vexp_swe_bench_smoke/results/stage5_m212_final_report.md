# M212 — current-VEXP impact-delivery revalidation and frozen A15 validity audit

## 1. Executive verdict

**M212 — PASS.** Research and measurement only.

```text
CURRENT_VEXP_DOCS_SUPPORT_PROGRESSIVE_IMPACT_DISCLOSURE
CURRENT_VEXP_DOES_NOT_SUPPORT_FROZEN_A15_INLINE_ASSUMPTION
FROZEN_A15_SUPERSEDED_BY_CURRENT_VEXP_ARCHITECTURE
```

Frozen parity remains **14 / 15**. A15 remains **BELOW**. VTRACE product
changes: **0**. Frozen scorer changes: **0**. Live-agent runs: **0**. Live model
spend: **$0**.

The finding is stronger, and different in kind, from the one the brief
anticipated. The brief expected to find that VEXP had *moved* to a compact
census plus bounded projection plus expansion, leaving A15 behind. What the
shipped artifacts show is that **VEXP's `get_impact_graph` has never rendered
call-site source in either version read** — its renderer emits fully-qualified
names, edge types, depths and file paths, and has no source-bearing field at
all. The field set is byte-identical between the version frozen A15 was authored
against and the newest public release.

So frozen A15's ≥ 90% inline-source bar was never a measurement of VEXP
behaviour. It is a VTRACE-authored operationalisation of VEXP claim `V-B1`,
whose reproducibility M196 recorded at the time as `INSUFFICIENT_METHOD` with
the measurement definition **"none published"**. A15 is superseded by absence,
not by a newer expansion mechanism.

**One criterion of the four required for SUPERSEDED is not discharged**, and is
reported as unmet rather than argued around — see §14. The decision in §18 is
robust to it either way.

## 2. Starting repository state

```text
branch                main
HEAD at start         98aa60a5189e9e2ee24f96e28db05c8140eb737d
ahead of origin/main  225        behind 0        pushed no
git diff --check      clean
working tree          213 pre-existing dirty/untracked entries, all preserved
```

M211's chain reproduced mechanically: `dc2e5f0b` audit, `ea7cf446` functional,
`d9ca2ec0` self-caught repair, `98aa60a5` ledger. Matches the brief.

## 3. Current VEXP version identity

| | |
|---|---|
| installed on this machine | **vexp-cli 2.0.24** (`/home/calvin/.npm-global/lib/node_modules/vexp-cli`) |
| newest public release | **vexp-cli 3.1.1**, changelog-dated 2026-09-03 |
| obtained for this audit | `npm pack vexp-cli@3.1.1`, sha256 `5f17c30111310d2f2f7bc47e1a3855d7e1b66152186c5b73ab59784e850ec831` |
| licence present | **none** — `~/.vexp/` holds only `update-check.json` |
| effective plan | `FREE_LIMITS` (`dist/license.js`): `maxNodes 2000, maxRepos 1, allTools false` |

**Control F2 fired immediately and governs this whole milestone.** The installed
binary is two minor versions stale and refuses to run at all — every invocation,
including `vexp --help`, prints only:

```text
vexp update required!   Installed: 2.0.24   Available: 3.1.1
```

It is therefore never characterised as current VEXP. The 3.1.1 tarball was
fetched into an isolated scratch directory and unpacked there; the user's global
install was **not** upgraded, replaced or modified.

## 4. Public documentation findings

Retrieved **2026-09-04**.

### C1 — impact census decoupled from token budget: **NOT ESTABLISHED**

`PUBLIC_DOC_FACT (negative)`. The brief states that the changelog describes a
defect where impacted nodes were capped from the token budget, producing
incorrect impact counts, replaced by a node-count limit independent of that
budget. Two targeted passes over <https://vexp.dev/changelog>, plus a site-scoped
search, **do not find such an entry.** What exists nearby is a plan-tier index
node cap ("At 80% of the node cap … at 100%, new nodes stop being added") and
"Impact and ranking refresh after every edit" — neither is C1.

C1 is recorded as unverified. It is not used to support any conclusion.

### C2 — leaner impact MCP surface: **CONFIRMED**

`PUBLIC_DOC_FACT`. <https://vexp.dev/changelog>, **v3.0.0, 2026-08-27**, section
"Sharper impact analysis":

> "Blast-radius results are now built exclusively from corroborated call edges,
> so every listed caller genuinely references your symbol."

> "The dependents count is one clearly labeled number, pivot headers carry exact
> line ranges for surgical follow-up reads, and the default MCP surface is
> leaner, with the reference expander appearing dynamically the moment compact
> output needs it."

Also **v3.1.0, 2026-08-31**: blast radius is disclosed in "every run_pipeline
answer … in its header, so an agent knows the blast radius it is reading."

### C3 — compact references: **run_pipeline / compressed output only, NOT get_impact_graph**

`PUBLIC_DOC_FACT` + `SHIPPED_ARTIFACT_FACT`. The docs describe `expand_vexp_ref`
generically — "Retrieves the original code behind a `[V-REF:xxxx]` marker (12 hex
chars) found in compressed vexp output" — which, on its own, is exactly the
docs-only overreach control **F1** forbids relying on.

The artifact settles it. In vexp-cli 3.1.1, the string `V-REF` occurs seven
times, and every occurrence is in `run_pipeline`'s `include_file_content`
description ("modify/refactor return skeletons + V-REF"), its `prose_compression`
description, or the `expand_vexp_ref` tool itself. **The impact renderer never
emits a V-REF marker and `get_impact_graph`'s description never mentions one.**

### Plan gating

`PUBLIC_DOC_FACT`, <https://vexp.dev/docs>: "Impact graphs and flow analysis are
paid-plan features, not part of Starter."

### One documentation/artifact discrepancy, reported rather than smoothed

The v3.0.0 changelog says the reference expander appears "dynamically the moment
compact output needs it". In the shipped 3.1.1 bundle the default tool list is
the **static** array `_F = [run_pipeline, get_skeleton, verify_done]`, and
`expand_vexp_ref` appears in exactly two places: its own definition and the
all-tools array. No conditional registration of it exists in the MCP JavaScript.
`sendToolListChanged` is present only as an unused method of the bundled MCP SDK.
Whatever implements "dynamically" is not in the JS layer. `INFERENCE`: it may
live in the Rust core, which this audit could not read.

## 5. Current impact tool schema

`SHIPPED_ARTIFACT_FACT`, read from `mcp/mcp-server.cjs` in both bundles.

`get_impact_graph` accepts, **identically in 2.0.24 and 3.1.1**:

| parameter | type | notes |
|---|---|---|
| `symbol_fqn` | string | required |
| `depth` | number | max traversal depth, default 5 |
| `cross_repo` | boolean | cross-repo matches and synthetic edges |
| `format` | string | `list` \| `tree` \| `mermaid`, default `tree` |

There is **no** `limit`, `max_nodes`, `max_tokens`, `cursor`, `compact` or
`include_source` parameter, and no continuation of any kind. The tool has no way
for a caller to ask for more, or for a response to say there is more.

`expand_vexp_ref` accepts a single `hash` (12 hex characters).

### The decisive artifact: what the impact renderer can emit

The MCP layer renders the engine's reply into the markdown the model reads. The
node emitters read exactly these fields, **identical across both versions**:

```text
fqn   edge_type   depth   file_path   cross_repo   repo   children
```

plus the header's `root_fqn`, `total_impacted`, `max_depth_reached`,
`query_time_ms`, `mermaid`. Every impacted node is rendered as:

```text
- **[repo] pkg/mod.py::caller** — `calls` (depth 1)
  *pkg/mod.py*
```

**No source text. No call expression. Not even a line number.** A renderer with
no source-bearing field cannot satisfy the frozen A15 predicate on any corpus,
for any symbol, at any budget, on any plan. This is a statement about capability,
not about a sample — which is why it settles a question the licence-blocked probe
could not.

The one residual hole is honest to state: `B$` returns `typeof n === "string" ? n
: YL(n, format)`, so a core that returned a pre-rendered string would bypass the
renderer. Nothing in the documentation or the JS suggests it does, and the
`format` parameter would be meaningless if it did, but that branch was not
observed.

### Default tool catalog — the finding the brief did not anticipate

| | 2.0.24 (frozen source) | 3.1.1 (current) |
|---|---|---|
| listed by default | `run_pipeline`, `get_skeleton`, `index_status`, `expand_vexp_ref` (4) | `run_pipeline`, `get_skeleton`, `verify_done` (3) |
| behind `VEXP_ALL_TOOLS` | 7, incl. **`get_impact_graph`** | 9, incl. **`get_impact_graph`** and now `expand_vexp_ref` |

**`get_impact_graph` is not in VEXP's default agent-facing catalog in either
version.** VEXP's own CLI states the design verbatim (`dist/cli.js`): "the MCP
tool list shows 4 by default to keep the catalog small; every tool stays
callable — VEXP_ALL_TOOLS=1 lists them all". On the free tier `allTools` is
`false` and the CLI reports "All tools: no (7/10)".

In 3.1.1 the default impact surface is therefore not `get_impact_graph` at all.
It is:

- `run_pipeline`, whose default description is "Ranked pivot files with line
  ranges plus **blast radius** for this repo, in one call"; and
- `verify_done`, which returns "dependents referencing symbols you changed but
  left untouched **(file:line)**".

That last parenthesis is worth pausing on. `m197aScoring.ts` control **F5**
states the frozen rule: *"a result containing only `file:line` does not satisfy
A15 … coordinates are a pointer to the expression, not the expression."* VEXP's
current default dependents surface delivers precisely `file:line`.

## 6. Synthetic corpus

Eight isolated repositories under `/tmp/m212/corpora`, one per fanout, generated
by `run_stage5_m212_shadow_a15.ts` — outside every VTRACE frozen corpus root.
Each holds `src/target.ts` exporting `target(value: number)`, and callers
`caller_0001 … caller_NNNN` at 20 per file, each making a real static call.
TypeScript was chosen because it is the language of C-MED and of VTRACE's own
strongest call-edge extraction, so a resolution failure would be a surprise
rather than a confound.

Fanouts **1, 8, 32, 64, 65, 100, 200, 500**, and the sample — the first ten
caller FQNs lexicographically — were fixed in the preregistration before any
response existed (control F9).

## 7. Indexing truth

Control F4 is clean at every fanout: **indexing recall 100%** (1/1, 8/8, 32/32,
64/64, 65/65, 100/100, 200/200, 500/500). No projection result in this report is
contaminated by a parser miss.

The census decomposition is exactly truthful:

| fanout | resolved callers | importers | census direct | truth |
|---|---|---|---|---|
| 1 | 1 | 2 | 3 | ✓ |
| 8 | 8 | 1 | 9 | ✓ |
| 32 | 32 | 2 | 34 | ✓ |
| 64 | 64 | 4 | 68 | ✓ |
| 65 | 65 | 4 | 69 | ✓ |
| 100 | 100 | 5 | 105 | ✓ |
| 200 | 200 | 10 | 210 | ✓ |
| 500 | **500** | 25 | 525 | ✓ |

`resolvedCallers` equals the fanout exactly at every point, and `importers`
equals the caller-file count exactly (500 callers ÷ 20 per file = 25).
`exactCallers` reads 0 throughout: these import-mediated TypeScript calls
classify as `resolved` rather than `exact` strength. That is an edge-strength
classification property of the corpus, **not** a census error — which is why
M211's decision never to sum the two behind one label is what makes the number
readable here.

## 8. Fanout results — VTRACE default `get_impact_graph`

| fanout | indexed | census | inline | inline+source | expandable | bytes | INLINE_RECALL | REACHABLE_RECALL | class |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 3 | 3 | 3 | — | 7566 | 100% | 100% | FULL_INLINE_ENUMERATION |
| 8 | 8 | 9 | 1 | 0 | 8 | 5570 | **0%** | 75% | BOUNDED_INLINE_WITH_OTHER_EXPANSION |
| 32 | 32 | 34 | 2 | 2 | 32 | 7104 | 20% | 100% | BOUNDED_INLINE_WITH_OTHER_EXPANSION |
| 64 | 64 | 68 | 2 | 2 | 66 | 7116 | 20% | 100% | BOUNDED_INLINE_WITH_OTHER_EXPANSION |
| 65 | 65 | 69 | 2 | 2 | 67 | 7125 | 20% | 100% | BOUNDED_INLINE_WITH_OTHER_EXPANSION |
| 100 | 100 | 105 | 2 | 2 | 103 | 7143 | 20% | 100% | BOUNDED_INLINE_WITH_OTHER_EXPANSION |
| 200 | 200 | 210 | 2 | 2 | 208 | 7149 | 20% | 100% | BOUNDED_INLINE_WITH_OTHER_EXPANSION |
| 500 | 500 | 525 | 2 | 2 | 523 | 7416 | 20% | 100% | BOUNDED_INLINE_WITH_OTHER_EXPANSION |

Two things are worth stating plainly.

**The default response is size-invariant to blast radius.** From fanout 1 to
fanout 500 — a 500× change in the truthful universe — the response moves between
5570 and 7566 bytes and delivers two relations. The census tracks the universe
exactly while the render does not move. That is the M211 architecture behaving
as designed, measured directly rather than argued.

**The 20% is not a coincidence of ARC.** Frozen A15 reports 20% on C-LARGE. The
shadow evaluator reproduces 20% at every fanout from 32 to 500 on a synthetic
corpus with nothing in common with ARC. The frozen number is a property of the
architecture's evidence budget, not of the corpus it was measured on.

### The fanout-8 anomaly, reported rather than smoothed

Fanout 8 is the worst point in the sweep and the only one below 100% reachable.
Its default response delivers **one** relation and that relation carries **no**
source text, so INLINE_RECALL is 0% — worse than fanout 500. Following the
continuation to exhaustion (4 pages) recovers 6 of 8 sampled callers with source;
the remaining 2 arrive as `INLINE_WITHOUT_SOURCE`. So at small fanout the stream
can deliver a caller's identity without ever affording its call expression.

This is a genuine residual in the M211 ladder at small universes, it was not
predicted, and it is recorded here as an observation for a future milestone. It
is not repaired in M212, which changes no product code.

## 9. Default-response behaviour

VTRACE: a truthful census over the complete direct universe, a bounded
projection of two relations, and a continuation handle. Determinism held —
semantics identical across two repeats at all eight fanouts, comparing delivered
relations, source text, census and remaining count while excluding timing
(control F10).

Current VEXP: `BLACK_BOX_OBSERVATION` **not obtainable** (see §22). At the
artifact level the default catalog does not contain `get_impact_graph`; the
default blast-radius disclosure is a `run_pipeline` header and `verify_done`'s
`file:line` dependents list.

## 10. Expansion behaviour

VTRACE's continuation was followed to exhaustion at every fanout — 253 pages at
fanout 500 — with **zero continuation faults** and no harness truncation. It is
stateless, binds the index revision and request scope, and returns real indexed
source. It is not a V-REF-style marker and makes no claim to be.

For current VEXP, on the artifact evidence:

- `get_impact_graph` has no cursor, limit or continuation parameter;
- the impact renderer emits no V-REF marker, so `expand_vexp_ref` has nothing in
  an impact response to expand (control F1 satisfied with tool-specific evidence,
  not generic documentation);
- in 3.1.1 `expand_vexp_ref` is itself gated out of the default catalog.

**No deterministic impact-expansion mechanism was found in current VEXP.** Being
able to reach a caller later through generic search would not count (control F6).

## 11. Shadow frozen-A15 result against current VEXP

The shadow evaluator could not be *run* against VEXP — the tool is paid-plan
gated, no licence exists on this machine, and the core binary
(`@vexp/core-linux-x64`) is not installed. That probe is reported as infeasible,
not as performed.

The question it would have asked is nonetheless answered, at a level a single
probe could not reach. Frozen A15 requires `sourceText` that is non-empty and
contains the callee's `referenceName`. VEXP's impact renderer has **no
source-bearing field in either version read**. Its shadow A15 score is therefore
**0%** — structurally, not statistically — against a MATCH threshold of 90%.

```text
CURRENT_VEXP_DOES_NOT_SUPPORT_FROZEN_A15_INLINE_ASSUMPTION
```

## 12. Inline recall vs reachable recall

| | frozen A15 sees | M212 also measures |
|---|---|---|
| VTRACE, fanout ≥ 32 | INLINE_RECALL **20%** | REACHABLE_RECALL **100%** |
| VTRACE, fanout 8 | INLINE_RECALL 0% | REACHABLE_RECALL 75% |
| current VEXP | INLINE_RECALL **0% (structural)** | no impact-expansion mechanism found |

Frozen A15 scores only the left column. On the architecture VTRACE now has, the
left column is a statement about the evidence budget of one response and the
right column is a statement about whether the graph's knowledge is retrievable at
all. A15 cannot distinguish a response that hides 498 callers from one that
counts them truthfully and hands over a cursor to every one of them.

## 13. Current VEXP vs M211 architecture

| property | current VEXP (3.1.1) | VTRACE M211 |
|---|---|---|
| complete impact census | **yes** — `total_impacted` is a scalar separate from `nodes`; changelog v3.0.0 "one clearly labeled number" | yes — census over the complete direct universe, before any budget |
| census independent of tokens | `UNKNOWN` — engine-side, not readable; C1 unverified | yes — measured truthful at fanout 500 |
| bounded default projection | **yes at the catalog level** — impact is not a default tool; default disclosure is a `run_pipeline` header | yes — 2 relations, response flat across 500× fanout |
| source-backed evidence | **no** — renderer has no source-bearing field, both versions | yes — 2 of 2 delivered relations carry the call expression at fanout ≥ 32 |
| exact-call truth | **yes** — v3.0.0 "exclusively from corroborated call edges" | yes — resolved/exact never summed behind one label |
| compact refs | V-REF exists, but **not in impact output** | no — and does not claim to |
| continuation | **none found** on `get_impact_graph` | yes — self-validating cursor, 253 pages, 0 faults |
| stateless expansion | n/a | yes — stores nothing, binds revision and scope |
| default arbitrary-caller inline | **0% (structural)** | 20% frozen; 20% reproduced synthetically |

**SAME PRINCIPLE**: both products keep a truthful count separate from what the
default response renders, and both deliberately shrink the default agent-facing
surface. **DIFFERENT IMPLEMENTATION**: VTRACE bounds the render and hands back a
cursor to the remainder; VEXP omits the impact tool from the default catalog
entirely and renders names and paths when it is called. They are not variants of
one design.

## 14. Frozen A15 validity decision

```text
FROZEN_A15_SUPERSEDED_BY_CURRENT_VEXP_ARCHITECTURE
```

Against the four criteria §17 requires, with what discharges each:

| # | criterion | verdict | evidence |
|---|---|---|---|
| 1 | truthful blast-radius knowledge | **supported** | `total_impacted` separate from `nodes` (artifact); v3.0.0 "one clearly labeled number" (doc) |
| 2 | default surface projects a bounded/compact form | **supported** | impact absent from the 3-tool default catalog, both versions (artifact); v3.0.0 "the default MCP surface is leaner" (doc) |
| 3 | omitted evidence deterministically expandable | **NOT DISCHARGED** | no cursor/limit param; no V-REF in impact output; expander itself gated out of default in 3.1.1 |
| 4 | VEXP would not itself satisfy the frozen A15 inline assumption | **supported, decisively** | impact renderer has no source-bearing field in either version — 0% structurally |

Criterion 3 is unmet and is not argued around. The label is issued because
criterion 4 — the one §17 says must be measured or the verdict falls back to
UNRESOLVED — is measured, and answers no.

Two honesty notes on the label itself:

- **"Superseded" overstates the mechanism.** Nothing moved. The impact renderer's
  field set is identical between the version frozen A15 was authored against
  (2.0.24) and the newest release (3.1.1). A15 is superseded by *absence* — it
  never described VEXP's impact tool — rather than by VEXP adopting a newer
  architecture. Its true origin is `V-B1`, a claim M196 recorded as
  `INSUFFICIENT_METHOD`, "none published".
- **A reader who requires all four criteria should read this as UNRESOLVED on
  criterion 3.** Nothing in §18 changes under that reading: criterion 4 alone
  removes the case for A15 engine work, because a bar VEXP itself scores 0%
  against is not a parity gap.

## 15. Falsification F1–F12

| id | outcome |
|---|---|
| F1 | **enforced and it bit.** V-REF attribution originally used a fixed 2000-char window; the unit test caught it crediting the marker to neighbouring tools on a compact bundle. Now reads each tool's own description literal. Impact/V-REF is established from the artifact, never from the generic expander doc. |
| F2 | **fired.** Installed 2.0.24 is stale and refuses to run; 3.1.1 fetched in isolation; every version printed from its own `package.json`. The old bundle is never labelled current. |
| F3 | **satisfied.** Fanouts to 500; conclusions rest on the ≥ 32 region, not on the fanout-1 case. |
| F4 | **clean.** Indexing recall 100% at all eight fanouts, measured against generator ground truth and reported separately. |
| F5 | **enforced.** `classifyProjection` refuses to upgrade a truthful count into a delivery; census 525 and delivered 2 are never combined. |
| F6 | **enforced.** REACHABLE_RECALL follows only the response's own cursor. VEXP is not credited with expansion for being searchable. |
| F7 | **enforced and unit-tested.** Exact caller FQN; a sibling caller in the same file scores `CENSUS_ONLY`. |
| F8 | **enforced.** `INLINE_WITH_SOURCE` and `INLINE_WITHOUT_SOURCE` are distinct — and the distinction carried the fanout-8 finding. |
| F9 | **enforced.** Sample fixed at corpus generation, before the first call; fanouts and thresholds preregistered in `stage5_m212_preregistration.md`, committed before results. |
| F10 | **passed.** Semantics identical across 2 repeats × 8 fanouts, timing excluded. |
| F11 | **passed.** `git status --porcelain` over `m197aScoring.ts`, `m197aFixtures.ts`, `run_stage5_m197a_engine.ts`, `run_stage5_m197a_report.ts` — empty. |
| F12 | **passed.** `git status --porcelain src/` — empty. Zero `src/` changes. |

## 16. Frozen VTRACE matrix

Unchanged. Not re-run by M212, not re-scored by M212.

```text
A1  MATCHES   A2  EXCEEDS   A3  MATCHES   A4  EXCEEDS   A5  MATCHES
A6  EXCEEDS   A7  EXCEEDS   A8  EXCEEDS   A9  MATCHES   A10 MATCHES
A11 EXCEEDS   A12 MATCHES   A13 EXCEEDS   A14 MATCHES   A15 BELOW

TOTAL: 14 / 15
```

The correct statement of the position, and the only one M212 licenses:

```text
Frozen historical parity:            14 / 15
Current-VEXP architecture audit:     A15 no longer representative
No unresolved current deterministic architecture gap is demonstrated
by the frozen A15 behaviour.
```

C-MED stays frozen at 508: M212 added benchmark files only, and C-MED is `src/`.

## 17. What was NOT changed

VTRACE product (`src/`), the A15 scorer, the A1–A15 definitions and thresholds,
retrieval, ranking, the impact architecture, the frozen corpora, the user's
global `vexp` installation, and any pre-existing dirty file.

## 18. Strategic implication

**Outcome B — freeze the VTRACE impact architecture at M211.**

Frozen A15 asks VTRACE to place an arbitrary caller inline with its call
expression in the first default response, at ≥ 90%. M210 already showed that
predicate arithmetically unreachable — 90% means delivering universe rank 530
inside 1200 model-visible tokens. M212 adds the reason it was never worth
reaching: **the competitor scores 0% against it, structurally, and has done so in
every version read.** Engineering toward it would move VTRACE away from the
competitor, not toward it.

Retain 14/15 as historical fact. Record A15 as no longer representative. Do not
delete it, do not rescore it, never write 15/15.

Recommended next: proceed to the separately-authorised causal-benchmark
preregistration — Baseline vs Baseline+VTRACE vs Baseline+VEXP — which
`ENGINE QUALITY != CODING-AGENT UTILITY` and
`CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED` both still govern. No paid run
was started here.

Two smaller leads, neither licensed by M212:

- the fanout-8 residual in §8 (small universes can deliver identity without
  affording the call expression);
- M211's standing per-relation restatement overhead, which is what actually caps
  evidence density and is a compatibility milestone rather than a budget one.

## 19. Verification

```text
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun test                       6265 pass, 49 skip, 0 fail (385 files)
git diff --check               clean

live-agent runs                0
live model spend               $0
VEXP deterministic tool calls  0   (licence-blocked; static artifact read instead)
VEXP processes started         0   (2.0.24 refuses to run; 3.1.1 never executed)
Docker                         not used
VTRACE product behaviour changes  0
frozen scorer changes             0
```

## 20. Repository state / commit SHAs

```text
98aa60a5   M211 ledger row (M212 starting HEAD)
e7567d68   M212 commit 1 — research harness + preregistration
0b7bd8f9   M212 commit 2 — evidence, results, ledger row and this report
```

Committed locally on `main`. Not pushed.

## 21. Reproducibility package

| artifact | path |
|---|---|
| preregistration | `results/stage5_m212_preregistration.md` |
| pure helpers + unit tests | `m212VexpSurface.ts`, `m212VexpSurface.test.ts` |
| bundle surface runner | `run_stage5_m212_vexp_surface.ts` |
| synthetic generator + shadow evaluator | `run_stage5_m212_shadow_a15.ts` |
| VEXP surface results | `results/stage5_m212_vexp_surface.json` |
| fanout results | `results/stage5_m212_shadow_a15.json` |

```bash
npm pack vexp-cli@3.1.1     # sha256 5f17c301...ec831, unpack to <dir>/package
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m212_vexp_surface.ts \
  --bundle /home/calvin/.npm-global/lib/node_modules/vexp-cli --bundle <dir>/package
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m212_shadow_a15.ts --scratch <scratch>
```

No licence token, credential or secret appears in any committed artifact. Timing
fields are excluded from every determinism comparison and are not load-bearing in
any claim.

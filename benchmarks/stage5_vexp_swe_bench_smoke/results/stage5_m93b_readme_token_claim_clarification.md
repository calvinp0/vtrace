# Stage 5 M93B README Token-Claim Clarification

## Summary

- **Inspected README claims:** the headline "Up to 74% fewer tokens in benchmarked
  workflows" (README.md:21), the "What VTRACE delivers" paragraph (README.md:19),
  the benchmark-caveats block (README.md:31-37), and the engineering-controls /
  boundaries sections (README.md:226-245).
- **What changed:** the untraceable "74%" figure was **removed** and replaced with
  two **traceable, measured, downstream agent-side** numbers, each linked to its
  committed report. The caveat paragraph now states the internal budgeter is
  deterministic and character-based (`chars/4` estimate, not a tokenizer), frames
  Stage 5 as integrated downstream validation (not a pure deterministic-core
  benchmark, not a public SWE-bench pass@1 claim), points to the planned M94
  deterministic scoreboard, and clarifies that V4/C7_D are default-off diagnostics
  and env/shell guards are safety infrastructure — neither is a token-reduction
  product feature. A boundaries bullet now states VTRACE is not a semantic oracle,
  dynamic call graph, or complete multi-language blast-radius engine.
- **"74%" disposition: REPLACED.** It was not traceable to any tracked report
  (`git grep` finds the token-reduction `74` only inside README.md itself). Per the
  milestone's unsupported-number rule, it was replaced with the tracked M92 result
  and the tracked Stage 3 result rather than kept.
- **Why:** accuracy over a bigger number. The replacement claims are grounded in
  committed reports and are still a strong product claim.

## Claim Traceability

| Claim | Source (tracked) | Value |
| --- | --- | --- |
| Old headline "up to 74% fewer tokens" | **none** — not found in any tracked report | untraceable → removed |
| Stage 5 clean-core token reduction | `results/stage5_m92_core_reduction50_validation.md` (+ `.json` `pct_delta: -26.71`) | **−26.7% tokens, −25.0% cost, resolution preserved 20/50 vs 20/50** |
| Stage 3 controlled Claude Code reduction | `benchmarks/arc_stage3_agent_usage/STAGE3_RESULTS.md` | **46.5% mean actual total-token reduction** (12 paired tasks; 42.81% median) |

- **M92 clean core result:** 50/50 valid; V4/C7_D disabled; env + shell guards
  pass; total tokens −26.71% and cost −25.01% vs the M73 baseline on the frozen
  M90 50-task split, with resolution preserved (20/50).
- **Downstream measured vs internal budgeting distinction:** the reported
  reductions are agent-run telemetry (VTRACE + agent), i.e. **downstream** token
  usage. They are **not** produced by tokenizer-accurate capsule packing — the
  capsule budgeter is `CapsuleBudgetModel.CharacterCount` and its "tokens" are a
  `chars/4` estimate. The README now states this next to the claim.

## Docs Consistency

- **README.md** — edited (headline, caveats, boundaries). No "74%" remains; no
  `vexb`.
- **docs/current_product_state.md** — already stated the same distinction
  (character-based budget; README figures are measured agent-side savings, not
  tokenizer-accurate). **No change needed**; verified consistent (also references
  the same M92 numbers and V4/C7_D default-off / env-shell-guard framing).
- **docs/M94_DETERMINISTIC_SCOREBOARD_PLAN.md** — the README now links to it as the
  planned deterministic-core scoreboard. **No change needed**; consistent.

## Tests

- Extended `src/productDocsHonesty.test.ts` with a README guard test
  ("README token-reduction claim stays qualified and traceable"): asserts no
  resurrected `74%`, no stale `vexb`, and — when the README mentions tokens — that
  it discloses `character-based` budgeting + `chars/4` estimate + `downstream
  agent` framing; asserts Stage 5 is framed as `integrated downstream validation`
  and `not a public SWE-bench pass@1 claim`; asserts V4/C7_D are `default-off
  diagnostics` and `not the token-reduction mechanism`.
- **Verification result:** `bun test src/productDocsHonesty.test.ts` → 4 pass / 0
  fail. Full suite + typechecks pass (see the M93B JSON summary).

## Recommendation

**Proceed to M94 deterministic scoreboard.** The README token-reduction language is
now traceable, qualified, and consistent with the product-truth docs. The remaining
open item is exactly what M94 addresses: a deterministic, pre-agent retrieval/
capsule scoreboard that measures core quality independently of the integrated
Stage 5 signal.

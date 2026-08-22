# M171 — competitor reference: product shape, not benchmark parity

**Secondary context only (§84).** Every VEXP fact below comes from the frozen
M168 artifacts. No VEXP was installed, no licence was bought, and current VEXP
2.7.0 is not assumed to reproduce the March behaviour M168 studied.

## Tool surface

| | VTRACE (default registry) | VEXP 2.0.24 (default) |
|---|---|---|
| Tools visible in `tools/list` | 14 | 4 |
| Total visible description characters | 3,699 | 2,181 |
| `run_pipeline` description characters | 223 | 949 |
| Hidden behind a flag | 7 | 7 |

VEXP spends more words on fewer doors. On the one tool both call `run_pipeline`,
VEXP's description asserts primacy — *PRIMARY TOOL*, *ALWAYS call this first*,
*ALWAYS prefer this over Read, Grep, Glob* — while VTRACE's is a bare alias
pointer to `get_code_context`.

M168 also established that matching VEXP's narrow surface needs no product
change: `createRestrictedMcpToolRegistry` already ships.

## First-orientation philosophy

Both products are in the same category: index once, connect a coding agent, get
an automatic first orientation, then let the agent work normally. The difference
M171 measured is not the category but the disclosure.

| | VTRACE default today | M171 candidate |
|---|---|---|
| Median model-visible tokens | 6,766 | 582 |
| Top-level keys | 22 | 4–6 |
| Repository source characters | 895 median | unchanged — cut from the same rendering |
| Evidence density | 24.4% | 68.3% |

## What M171 does not claim

M171 produces a **VEXP-class product shape**, not benchmark parity. It does not
claim VTRACE matches VEXP's solve rate or cost, and it could not: M168 established
that the published VEXP artifact cannot show its own treatment was active, that
its accounting disagrees with the provider's by 23.5%, and that the causal
benchmark behind the headline number is not faithfully attributable.

## Differentiation M171 preserves

Nothing was removed to look more like VEXP. The deterministic local
architecture, revision and worktree authority, truthful readiness, derivation
validation, cross-repository support, graph relationships, document and config
indexing, and full provenance all remain — internally, and at `detail=debug`.

The differentiation the milestone was aiming at is:

> rich internal authority, small default disclosure.

The candidate reaches the disclosure half. It did not ship, for a reason that has
nothing to do with VEXP: a 2-point gold-symbol gate, missed by three cases.

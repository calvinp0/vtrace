# Stage 5 token-discipline preflight: matplotlib-22719

**PASS** — the STAGE5_TOKEN_DISCIPLINE policy is injected for `matplotlib__matplotlib-22719` in `strong_context_patch_first` mode, and the baseline arm does not receive it. Phase 2 (live paired rerun) may proceed.

## What this checks

This is a read-only preflight. It reconstructs the VTRACE context section for `matplotlib__matplotlib-22719` from the capsule recorded in `eval-controlled-vtrace-matplotlib-22719`'s `_run.meta.json`, then re-runs the exact injection functions the live harness uses (`classifyContextStrength` → `buildTokenDisciplineBlock` → `detectTokenDisciplineText`). It runs no agents, no Docker, and no model calls.

Section source: `run-meta`.

## Required preflight fields

| field | value |
| --- | --- |
| tokenDisciplineInjected | yes |
| tokenDisciplineMode | strong_context_patch_first |
| baselineTokenDisciplineInjected | no |
| leadPivotPresent | yes |
| supportSnippetsPresent | yes |
| contextInjected | yes |
| preEditSearchBudget | 2 |
| preEditBashBudget | 1 |
| repeatedFileReadLimit | 1 |

## Injected-block directive checks

| directive | present |
| --- | --- |
| STAGE5_TOKEN_DISCIPLINE marker | yes |
| pre-edit search/read budget | yes |
| pre-edit Bash budget | yes |
| patch before broad rediscovery | yes |

## Context-strength rationale

- strong context: lead pivot + file + support + injected
- strong context: lead pivot + file + support + injected
- token-discipline block injected in strong_context_patch_first mode
- baseline-shaped prompt carries no token-discipline block (expected)

## Injected block (verbatim)

```text
## STAGE5_TOKEN_DISCIPLINE

The context capsule is precomputed and provides a strong lead pivot. Use it as the primary source of truth.

Before calling tools:
1. Read the capsule pivots and support snippets.
2. Decide whether the edit target is already identified.
3. If the target file/function is present, patch first; do not rediscover it with grep.

Tool budget:
- At most 2 search/grep/read calls before the first edit when the capsule has a lead pivot.
- At most 1 Bash inspection command before the first edit unless tests are being run.
- Do not run broad recursive grep after the capsule already names a pivot file.
- Do not repeatedly read or grep the same file/symbol (at most 1 re-read).
- Do not use Bash loops to inspect many files unless the capsule lacks a plausible target.
- If you need more context, prefer one focused read around the lead pivot.
- If the capsule provides deferred refs, expand only the exact ref needed.

Patch trigger:
- If the capsule lead pivot and support evidence identify a plausible edit location, make the minimal patch before doing more search.

Stop condition:
- After two unsuccessful searches, stop searching and state the uncertainty rather than looping.
```

## Non-claims

- This preflight does not run the live agent and does not measure token savings.
- This preflight does not establish the 100-task token-reduction number.
- This preflight does not prove the policy reduces overhead — only that it is injected.
- This preflight does not change Stage 5 policy accounting.

# M218 — launch-risk statement under M214 + A1 (informational; no authorisation requested)

```text
Hard ceiling awaiting authorisation:            $735
Ordinary exposure (200 x $3.5):          $700
Infrastructure-retry reserve (10 x $3.5):   $35
Intended valid outcomes:                        200 (manifest rows 200; retries are attempts on existing rows)
Amendment:                                      M214_A1_RETRY_RESERVE 0ed156bc924a4817122c46b5c9fc0334e5f046c2dce0547eef2573b2483b76c1
Executable authority (M214 + A1):               782f8a94e5d6bb8e09000b16c37a1037d72cb40537523ab61db0c53fa80ef086
Spend authorisation:                            SPEND_AUTHORIZATION_PENDING
```

## Consequence

> Up to 10 preregistered infrastructure retries can be funded at the $3.5 cap without making completion of all 200 intended runs impossible under the $735 hard ceiling. An eleventh needed retry, or a reserve that cannot fund one more retry at cap, halts the cohort with COHORT_HALTED_RETRY_RESERVE_EXHAUSTED; the rows that never ran stay PLANNED and the cohort is reported as incomplete. No outcome is fabricated and no budget is raised at runtime.

## What the executor does about it

- P12 refuses any COHORT row unless the executable authority M214 + A1 is bound and its lineage matches the verified preregistration, manifest and external reference; M214's $700 authority alone is refused by name.
- P7 requires the operator's authorisation to name the active $735 ceiling; P8 and the cohort loop enforce it.
- P11 admits a retry only when its class is on M214's frozen rerunnable list, a reserve slot remains, the remaining reserve dollars fund it at cap, and the hard ceiling admits one more attempt at cap. Each decision records the retry ordinal, parent row, reason, class, prior spend, new maximum exposure, remaining reserve and remaining global reserve.
- RETRY_RESERVE_EXHAUSTED halts the cohort as `COHORT_HALTED_RETRY_RESERVE_EXHAUSTED`; the operator is never asked at runtime to raise the budget.
- Cleanup of owned scratch is part of continuation safety: a valid result whose scratch cannot be proven gone blocks the next row through the same interlock, and only the predeclared recovery path resumes it:
  1. the cohort loop stops; no next row is selected
  2. an operator invokes the launcher's --recover-isolation action (no other flag reaches BLOCKED state)
  3. the probe enumerates residual substrate state under the cohort work root
  4. the probe remediates exactly what it enumerated: harness containers, evaluator containers, processes referencing the work root, the stale arm root
  5. the probe enumerates again and the second enumeration must be empty
  6. ISOLATION_RECOVERY_VERIFIED is appended and continuation returns to CONTINUATION_SAFE
  7. the operator relaunches with --resume; selectNextRow resumes at the next unstarted row in frozen order, and a row with a valid outcome is refused rather than rerun

## Outcome-blind

This artifact and every operational status view carry rows completed, rows remaining, spend consumed, remaining reserve, scratch health, isolation state and halt reason. None carries a pass rate, a per-arm count, a discordant table or a test statistic before fixed-N finalisation.


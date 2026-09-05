# M217 — launch-risk statement (informational; no authorisation requested)

```text
Ceiling awaiting authorisation:               $700
Maximum planned exposure for 200 ordinary rows: $700  (200 x $3.5)
Paid retry reserve:                            $0
Mathematical maximum (every row retried once): $1400  (refused by the ceiling, never funded)
Spend authorisation:                           SPEND_AUTHORIZATION_PENDING
```

## Consequence

> Any infrastructure failure that consumes paid budget before a retry may make completion of all 200 intended runs impossible under the frozen $700 ceiling. The executor will permit such a retry when it fits under the ceiling, will record FIXED_N_COMPLETION_NOT_GUARANTEED before it begins, and will halt with COHORT_HALTED_SPEND_CEILING when the ceiling binds; the rows that never ran stay PLANNED and the cohort is reported as incomplete.

## What the executor does about it

- Before any attempt, P8 refuses a run whose own cap would breach the ceiling (unchanged from M215).
- Before any attempt, P11 computes current spend + this attempt's cap + every remaining required attempt at cap, and records whether fixed-N completion is still guaranteed.
- Frozen retry binding: `PERMIT_RETRY_AND_DECLARE_COMPLETION_NOT_GUARANTEED`. A rerunnable infrastructure failure is entitled to a second attempt; the failed attempt's cost stays in the cumulative total; and if the ceiling binds the cohort is INCOMPLETE and is reported as incomplete. M214 contains no rule that prefers completing first attempts over honouring a permitted retry, so refusing the retry to protect completion would be a new scheduling rule. The frozen binding therefore PERMITS a retry that fits under the ceiling and DECLARES, mechanically and before the retry begins, that fixed-N completion is no longer guaranteed. The ceiling itself remains the refusal that binds.
- The refusing branch exists in code and is controlled, so a later preregistration amendment could select it; selecting it here would be a policy decision this milestone is not authorised to make.
- When the ceiling binds, the cohort halts with `COHORT_HALTED_SPEND_CEILING`; the rows that never ran stay PLANNED and the cohort is reported as incomplete. No outcome is fabricated.
- When isolation between rows cannot be proven, the cohort halts with `COHORT_HALTED_ISOLATION_RISK` and only the predeclared recovery path can resume it:
  1. the cohort loop stops; no next row is selected
  2. an operator invokes the launcher's --recover-isolation action (no other flag reaches BLOCKED state)
  3. the probe enumerates residual substrate state under the cohort work root
  4. the probe remediates exactly what it enumerated: harness containers, evaluator containers, processes referencing the work root, the stale arm root
  5. the probe enumerates again and the second enumeration must be empty
  6. ISOLATION_RECOVERY_VERIFIED is appended and continuation returns to CONTINUATION_SAFE
  7. the operator relaunches with --resume; selectNextRow resumes at the next unstarted row in frozen order, and a row with a valid outcome is refused rather than rerun

## Outcome-blind

This artifact and every operational status view carry rows completed, rows remaining, spend consumed, maximum remaining exposure, isolation state and halt reason. None carries a pass rate, a per-arm count, a discordant table or a test statistic before fixed-N finalisation.


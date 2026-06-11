# Stage 5 Astropy protocol diagnostic

_Generated: 2026-06-11T18:25:16.579Z_

## Summary

An auditable Capsule v2 protocol run on `astropy__astropy-14369` (run label `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`) injected indexed Capsule v2 context (force-inject), placed `astropy/units/format/cds.py::CDS` first, and avoided the earlier loop pattern (both loop heuristics false). It produced a patch but Docker evaluation reported it UNRESOLVED. The diagnosis is updated to **patch_mistake_despite_good_context**, superseding the earlier `noisy_pivot_ranking` hypothesis for this auditable run.

## Run identity

- Run label: `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`
- Instance: `astropy__astropy-14369`
- Condition: `vtrace`
- Protocol: `vtrace-indexed`
- Capsule engine: v2
- Pivot ranking version: v2
- Context policy override: force-inject
- Model: claude-opus-4-5-20251101
- Commit: fa4e8d1cd279acf9b24560813c8652494ccd5922

## Capsule v2 evidence

- Capsule v2 artifacts persisted: yes
- Manifest / ranking / context files present: yes / yes / yes
- Capsule intent: debug
- Capsule budget: 8000
- Capsule estimated tokens: 5086
- Top pivot (meta): astropy/units/format/cds.py::CDS
- Pivot count / support count: 2 / 4
- Context injected: yes
- Treatment valid: true
- PIVOT_CHECK policy: strict_risk_gated (injected: no)
- PIVOT_CHECK reason: strict_risk_gated: no strong risk signal (hidden_pivot alone is insufficient)

## Ranking/context evidence

The persisted ranking and rendered context both lead with `astropy/units/format/cds.py::CDS` (rank-1 is the expected pivot: yes).

| rank | path | symbol | kind | pivotRankScore |
| ---: | --- | --- | --- | ---: |
| 1 | astropy/units/format/cds.py | CDS | class | 2.853 |
| 2 | astropy/units/format/vounit.py | VOUnit | class | 3.049 |

## Ordered telemetry evidence

- Ordered telemetry available: yes
- Total tool calls: 16
- Bash tool calls: 6
- Grep-like tool calls: 4
- File-read tool calls: 5
- File-write tool calls: 1
- Unique files touched: 5
- Long Bash loop heuristic: no
- Repeated search heuristic: no

Both loop heuristics are false: the auditable run did not exhibit the earlier loop pattern.

## Docker outcome

- Evaluation ran: yes
- Evaluation method: docker
- Docker used: yes
- Evaluation error: null
- Instances evaluated: 1
- Resolved count: 0
- Resolved: False
- Cost (USD): $1.1538184999999999
- Total tokens: 2,123,513

## Patch analysis

- Patch present: yes
- Edited files: astropy/units/format/cds.py, astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py
- Deleted files: astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py
- Deleted generated parser tables: astropy/units/format/cds_lextab.py, astropy/units/format/cds_parsetab.py
- Touches `p_combined_units` grammar method: yes
- Narrow known-good grammar reorder present: yes
- Broad grammar rewrite detected: yes

The patch deleted a generated parser table and relocated grammar productions into `p_combined_units`, a broad rewrite, rather than the narrower known-good reorder `division_of_units: unit_expression DIVISION combined_units` → `combined_units DIVISION unit_expression`.

## Diagnosis update

- Primary issue: `patch_mistake_despite_good_context`
- Secondary issues: `capsule_budget_too_large`, `grammar_patch_minimality`
- Supersedes (history): `noisy_pivot_ranking` (earlier strict/risk runs without persisted Capsule artifacts)
- Computed failure mode: `patch_mistake_despite_good_context` (context good: yes; Docker resolved: no)

The auditable protocol run shows that the current indexed Capsule v2 path can place astropy/units/format/cds.py::CDS first and avoid the earlier loop pattern, but the produced patch still failed Docker evaluation. Therefore the current Astropy failure mode is no longer primarily missing or noisy localization evidence. It is patch_mistake_despite_good_context: the agent saw the relevant parser class and edited the right file, but made a broad grammar rewrite/deletion instead of the narrower known-good grammar change.

## Ranking metadata caveat

> Detected: rank 1 `astropy/units/format/cds.py::CDS` (pivotRankScore 2.853) is ordered ahead of rank 2 `astropy/units/format/vounit.py::VOUnit` (pivotRankScore 3.049), which is HIGHER.

_capsule_v2_ranking.json reports cds.py::CDS as rank 1 while vounit.py::VOUnit has a higher pivotRankScore. This should be clarified in a later artifact-format cleanup: either rank should correspond to final rendered order and score should be labeled diagnosticScore, or final rank should sort by pivotRankScore. This caveat does not change the current diagnosis because the rendered context and metadata both place cds.py first.

## Recommended next step

Add a deterministic patch-minimality/probe diagnostic for Astropy-style generated parser rewrites: flag patches that delete generated parser tables or broadly relocate grammar productions when a narrower grammar-rule edit is possible. Do this as a probe/report first, not as automatic repair.

## Non-claims

- This report does not re-run agents or Docker.
- This report does not claim pivot-ranking v2 caused any resolution.
- This report does not claim aggregate improvement.
- This report does not prove Capsule budget is optimal.
- This report does not change repair policy.


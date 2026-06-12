# Stage 5 control-loop status

_Generated: 2026-06-12T06:39:55.931Z_

_Reporting only. Consolidates committed Stage 5 report JSONs into one read-only status. Runs no agent / live critic / repair / Docker / model; mutates no existing report and no raw artifact._

## Summary

Status: `single_instance_verified_control_loop`. The auditable Astropy protocol run (`astropy__astropy-14369`, run label `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`) had valid indexed Capsule v2 context with lead pivot `astropy/units/format/cds.py::CDS`, yet its source patch was unresolved. A deterministic patch-shape probe and a live critic independently AGREED that repair was required; a gated, shape-validated one-shot repair then converted the instance from unresolved to resolved under Docker (convertedUnresolvedToResolved=true). This is single-instance verified evidence of a controlled context-action-repair loop, not an aggregate score (aggregateComparable=false).

## Why this matters for token reduction

This work advances VTRACE from a pure context-reduction system toward a controlled context-action-repair loop. The generalizable piece is not the Astropy-specific parser fix; it is the pattern: compact context, auditable context quality, deterministic patch-shape probes, gated live critic agreement, gated one-shot repair, post-repair shape validation, Docker verification, and separate accounting. This reduces wasted tokens by avoiding blind reruns and only spending repair tokens when a cheap deterministic signal and a live critic agree.

## Current control loop

The Stage 5 chain now runs as a controlled loop:

1. Compact, indexed Capsule v2 context (auditable: persisted artifacts, treatment validity).
2. Ordered tool telemetry + loop heuristics to audit context quality and agent behavior.
3. Deterministic patch-shape / minimality probe (cheap, no model) flags risky patches.
4. Gated live critic — only consulted for flagged patches — must agree repair is required.
5. Gated one-shot repair behind explicit flags, with narrow actionable guidance.
6. Post-repair shape gate rejects broad rewrites / generated-table deletion.
7. Docker verification of the repaired patch.
8. Separate, labelled accounting that never merges into first-pass token reduction.

## Evidence chain

- Astropy protocol run had valid indexed Capsule v2 context.
- cds.py::CDS was the lead pivot.
- loop heuristics were false.
- source patch resolved=false.
- deterministic generated-parser minimality probe repairRequired=true.
- live critic agreed repairRequired=true.
- first generated-parser repair failed because cds_parsetab.py was not updated.
- consistency diagnostic found source_grammar_changed_without_generated_table_update.
- shape-gated repair changed cds.py + cds_parsetab.py.
- Docker resolved=true for the shape-gated repair.
- convertedUnresolvedToResolved=true.
- recovery cost was about $3.0043.
- original repair cap was exceeded historically, and cost-cap enforcement has now been hardened.

## Astropy generated-parser case study

Instance `astropy__astropy-14369` is the single verified instance. Indexed Capsule v2 placed `astropy/units/format/cds.py::CDS` as the lead pivot and loop heuristics were false (loopHeuristicsFalse=true), so the failure was a patch mistake despite good context: the source patch made a broad generated-parser rewrite and was unresolved (sourcePatchResolved=false). The deterministic probe (repairRequired=true) and the live critic (repairRequired=true) agreed (criticAgreement=true). A first repair failed because `cds_parsetab.py` was not updated; a consistency diagnostic identified `source_grammar_changed_without_generated_table_update`. The shape-gated repair changed `cds.py` + `astropy/units/format/cds_parsetab.py`, passed the shape gate (shapeGateAccepted=true), and Docker reported resolved=true (repairedPatchResolved=true).

## Cost and token implications

- Repair-side recovery cost was about $3.0043 (critic + repair), recorded SEPARATELY from first-pass token reduction.
- The control loop reduces wasted tokens by avoiding blind reruns: live-critic and repair tokens are spent ONLY when the cheap deterministic probe and the live critic agree.
- The verified repair exceeded its cost cap historically (repairCostCapExceededHistorically=true); cost-cap enforcement has since been hardened (costCapHardened=true).
- First-pass strict-v2 token reduction and repair-side recovery cost are kept distinct and are NOT merged.

## Safety gates

Any live generated-parser repair is bounded by ALL of:

- disabled by default
- explicit --run-label required
- --enable-patch-repair required
- --allow-generated-parser-repair required
- valid live critic artifact required
- deterministic/live agreement required
- actionable narrow guidance required
- one attempt only
- fail-open behavior
- post-repair shape gate
- cost-cap enforcement
- no default generated-parser allowlist entry

## What is generalized

- The control-loop PATTERN: compact context, auditable context quality, deterministic patch-shape probes, gated live critic agreement, gated one-shot repair, post-repair shape validation, Docker verification, and separate accounting.
- Deterministic, cheap patch-shape probing as a pre-filter before spending any live-critic or repair tokens.
- Requiring a cheap deterministic signal AND a live critic to AGREE before any repair token is spent.
- Keeping repair-side recovery cost accounted SEPARATELY from first-pass token reduction.

## What is not generalized yet

- The Astropy-specific generated-parser fix itself (cds.py + cds_parsetab.py) is one verified instance, not a general capability.
- Generated-parser repair is NOT proven to generalize to other parser systems or defect classes.
- There is no aggregate SWE-bench improvement claim; this is single-instance verified evidence.
- Generated-parser defect classes remain OFF the default repair allowlist.

## Current boundaries

- Single verified instance: astropy__astropy-14369 only.
- Generated-parser repair stays disabled by default behind explicit flags.
- The verified repair historically exceeded its cost cap; cost-cap enforcement has been hardened but broader use must wait for the recommended dry-run proof.
- Repair recovery cost (~$3.0043) is recorded separately and is NOT folded into first-pass token reduction.

## Recommended next milestones

1. Run a no-model dry-run proving the hardened cost-cap now blocks the historical generated-parser repair under a $0.40 cap.
2. Add a small report comparing first-pass strict-v2 tokens vs repair-side recovery cost, keeping first-pass and repair costs separate.
3. Try one additional generated-parser-like case only if a real candidate exists; do not synthesize broad claims from Astropy alone.
4. Define an expected-value policy for repair: repair only when the defect class has observed conversion evidence and estimated cost fits the cap.

_Generated-parser repair is NOT recommended for broad enablement yet._

## Non-claims

- This report does not claim aggregate SWE-bench improvement.
- This report does not claim generated-parser repair generalizes beyond the verified Astropy case.
- This report does not merge repair recovery into first-pass token reduction.
- This report does not enable broader repair usage.
- This report does not change policy accounting.
- This report does not run agents, repair, live critic, or Docker.


# M183 — invalidity and rerun policy

**Frozen before any M183 live run existed.** Classification does not consult the
outcome. §27/§28/§29/§68/§69.

## INVALID (external): the apparatus failed, so the arm never measured anything

- the provider returned no usable completion
- the repository failed to prepare before the agent started
- the environment could not initialize; disk or inode exhaustion before spawn
- the orientation was ABSENT at treatment start, or the index was invalid
- the harness crashed
- the grader infrastructure was unavailable

Eligible for a bounded rerun (`MAX_RETRIES = 4`, matched by the driver's
`ABORT_RE`, 30s backoff).

## VALID: the agent worked and this is what happened

- the agent produced a bad patch, or no patch
- the agent hit the 250-turn ceiling (`turn_limit_hit`) — §69
- the agent hit the $3 per-instance cost ceiling (`cost_limit_hit`) — §68
- the agent ignored the orientation entirely — §33
- the agent spent its budget on the wrong file

**Not eligible for rerun.** These are results. A run is not invalid because it
failed, and it is not invalid because its outcome was surprising.

## Treatment validity is delivery, not adoption

An arm B run is valid when the orientation was DELIVERED through the model-facing
channel. Whether the agent read it, used it, or ignored it is measured and
reported, and changes nothing about validity (§33/§34). `CALL_MADE !=
EVIDENCE_DELIVERED` is inherited; here the delivery is by construction and the
witness records the bytes.

## Pair validity

The primary paired analysis uses pairs where **both** arms are valid. A valid
failure opposite a missing arm is never counted as a win for either side (§28).
The spend guard is evaluated at TASK entry precisely so that the cap cannot
manufacture a censored pair.

## Replacement

An instance that leaves the manifest for a protocol reason is recorded as
EXCLUDED with its reason and is **not replaced** (§14). Replacing after outcomes
exist would let the sample follow the results.

## Reruns are not selective

A rerun fires from `ABORT_RE` matching the stderr of a failed spawn. No rerun is
ever initiated because an outcome was unexpected (§29).

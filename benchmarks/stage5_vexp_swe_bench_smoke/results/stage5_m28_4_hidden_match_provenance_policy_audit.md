# Stage 5 — M28.4 fair-provenance policy for tests that coincide with a hidden FAIL_TO_PASS

**Date:** 2026-06-17
**Follows:** M28.3 clean fair-discovery rerun (`0d6d2f2`), which found that for `sphinx-7462`
the genuinely-relevant focused test (`tests/test_domain_py.py::test_parse_annotation`) **is**
the hidden FAIL_TO_PASS node — so the old policy (exact FAIL_TO_PASS match ⇒ `injected_metadata`
⇒ disallowed) could never rate it fair even after a genuine discovery.

## Policy conclusion

**A selected test that merely COINCIDES with a withheld FAIL_TO_PASS label is not, by itself,
injection contamination.** Contamination is when the label was *exposed in the prompt/injected
context* before the command. After the M28.2 prompt sanitization, those are different things and
the classifier must distinguish them:

| Situation | Classification | Fair? |
| --- | --- | --- |
| Label **exposed** in prompt, selected test matches it (Case A) | `injected_metadata` | ❌ |
| Hidden match, sanitized, **no** discovery (Case B) | `ambiguous` (`injected_metadata` if exposure unknown) | ❌ |
| Hidden match, sanitized, **weak** discovery (broad grep, output only, no read) (Case C) | `ambiguous` | ❌ |
| Hidden match, sanitized, **strong** discovery (repo search→read/output) (Case D) | **`agent_discovered_hidden_match`** | ✅ |
| **Non-hidden** discovered test, strong discovery (Case E) | `agent_discovered` | ✅ |

"Strong discovery" is unchanged from M28: a file-targeted SEARCH (the search command/path names
the test file/leaf) AND (a READ of the test file OR an OUTPUT that surfaced the node). A broad
grep over a directory whose only signal is its output does **not** qualify (`searched=false`).

## What changed

`src/capsule/toolOutputCapture.ts`:
- New provenance class `agent_discovered_hidden_match` added to `TestProvenanceClass`.
- `classifyTestProvenance` gains `promptExposedTestNames?: readonly string[] | null` — the
  withheld labels that were ACTUALLY exposed in the prompt (a subset of `injectedTestNames`).
  Semantics: `undefined`/`null` ⇒ exposure UNKNOWN ⇒ conservative pre-M28.4 behavior; an array
  (possibly empty) ⇒ exposure KNOWN. The strict gate now:
  - `exposedMatch` ⇒ `injected_metadata` (real contamination, regardless of discovery);
  - hidden match + strong discovery + exposure known-and-sanitized ⇒ `agent_discovered_hidden_match`;
  - hidden match + strong discovery + exposure unknown ⇒ `ambiguous` (cannot rule out exposure);
  - hidden match + weak/no discovery ⇒ `ambiguous` when exposure known-and-sanitized, else
    `injected_metadata` (legacy preserved).
- `fairProvenance` now allows `agent_discovered` **or** `agent_discovered_hidden_match`.
- `assessFairVerification` and `buildFairVerificationReport` thread `promptExposedTestNames`
  through (optional; omitted ⇒ pre-M28.4 behavior).

`benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts`:
- New `readPromptExposedTestNames(dir, injectedTestNames)` reads the rendered revision prompt and
  returns the subset of withheld labels that literally appear in it (full id, node leaf, or
  params-stripped leaf). `null` when the prompt artifact is missing (exposure unknown).
- `computeAgentTestCommandPlan` passes `promptExposedTestNames` into `buildFairVerificationReport`,
  so the planner credits a sanitized discovered hidden match.

This is purely additive: every existing call site that does not pass `promptExposedTestNames`
keeps its exact prior behavior. No retrieval/ranking/scoring/candidate-generation or Capsule v2
pivot selection was touched.

## Answers to the brief

- **Can an exact hidden match be allowed after strong discovery?** Yes — `agent_discovered_hidden_match`,
  but only when the prompt was provably sanitized (label not exposed) AND the agent reached the
  test via a real search→read/output chain.
- **Does a prompt-exposed match stay disallowed?** Yes — `injected_metadata`, even with a full
  discovery chain. Exposure dominates.
- **Does the M28.3 real artifact remain ineligible?** Yes — it has a broad grep (searched=false,
  output only) and no test-file read, so it stays disallowed (now `ambiguous`).
- **Does a synthetic search+read hidden match become planner-eligible?** Yes, with a canonical
  unpiped command.
- **Do shell-piped commands remain rejected?** Yes — command safety is independent of the
  provenance upgrade; a discovered hidden match with `2>&1`/`|` is still `diagnosticOnly` and
  ineligible.

## Offline audit

Run against the **real M28.3 artifact** plus five synthetic cases (no live agent, no Docker):

| # | Audit check | Result |
| --- | --- | --- |
| 1 | M28.3 real artifact remains ineligible | **PASS** — exposed labels `[]` (sanitized), discovery weak (broad grep, no read) ⇒ `ambiguous`, `allowed=false` |
| 2 | Synthetic leaked-prompt exact match | **PASS** — `injected_metadata`, `allowed=false` |
| 3 | Synthetic no-leak / no-discovery exact match | **PASS** — `ambiguous`, `allowed=false` |
| 4 | Synthetic no-leak / weak grep-only exact match | **PASS** — `ambiguous`, `allowed=false` |
| 5 | Synthetic no-leak / search+read exact match | **PASS** — `agent_discovered_hidden_match`, `allowed=true` |
| 6 | Synthetic non-hidden search+read discovered test | **PASS** — `agent_discovered`, `allowed=true` |

## Tests

- `src/capsule/toolOutputCapture.test.ts` (8 new M28.4 tests): exposed-match ⇒ injected; sanitized
  no/weak/strong discovery; allowed only when discovery is strong; non-hidden stays
  `agent_discovered`; M28.3-shape stays ineligible for exposure null and `[]`; the
  prompt-sanitization signal flips the verdict (sanitized→fair, exposed→injected, unknown→ambiguous).
- `src/capsule/agentTestCommandPlanner.test.ts` (2 new): discovered-hidden-match + canonical
  unpiped pytest ⇒ eligible; discovered-hidden-match + pipe/redirect ⇒ still rejected.

## Verification

- `bun run typecheck` — clean.
- `bun run typecheck:benchmarks` — clean.
- `bun test` — **2820 pass, 0 fail** (170 files).
- `git diff --check` — clean.
- Retrieval no-change proof — `stage5_retrieval_eval_expanded.csv` and
  `stage5_retrieval_eval_cross_repo_30.csv` **byte-identical** to baselines. (The brief's second
  retrieval fixture path had a typo; used the committed
  `benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.cross_repo.30.json`.)

## Scope

No live agents, no Docker, no verifier execution, no command execution, no sweeps. Revision pass
remains off by default; revised patches are not wired into canonical evaluation.

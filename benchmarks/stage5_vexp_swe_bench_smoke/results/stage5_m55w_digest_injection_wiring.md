# Stage 5 M55W — Capsule v2 digest injection wiring

Closes the measurability gap the **M55V** report found: the Stage 5 live harness
re-rendered injected context from `inspectFirst + renderCapsuleV2Human + neighborhood`
and never read the M55 product `capsuleV2.digest`, so a digest A/B was not runnable.

This milestone is **code + report only**. No live agents, no Docker, no API spend.

## What was wired

A default-off Stage 5 runner flag now injects the exact M55 product digest into the
VTRACE context, wrapped in an unambiguous sentinel.

| Item | Value |
|---|---|
| **Flag added** | `--inject-capsule-digest` (default **off**; `v2` engine only) |
| **Sentinel** | `<VTRACE_CAPSULE_V2_DIGEST_START>` … `<VTRACE_CAPSULE_V2_DIGEST_END>` |
| **Digest source** | `toCapsuleV2ProductResponse(result, { query, warnings }).digest` — byte-identical to the MCP `capsuleV2.digest` |
| **Placement** | **First** in the injected context, before `inspectFirst` / `renderCapsuleV2Human` / neighborhood |
| **Existing render** | **Kept** (not removed) — see duplication note below |
| **impact / memory / rules** | **Warning-only** (not threaded) — honest `*_not_threaded_into_digest` markers, no fabricated counts |

### Default-off / backwards compatibility

When `--inject-capsule-digest` is absent the injected context is byte-identical to
before: the block builder returns `""` and the context array is unchanged. Confirmed
by test (`M55W: default classify … omits the digest sentinel`) and by the full suite
staying green.

### Where the digest appears (injection order)

```
1. <VTRACE_CAPSULE_V2_DIGEST_START> … digest … <VTRACE_CAPSULE_V2_DIGEST_END>   (NEW, opt-in)
2. inspectFirst guidance
3. renderCapsuleV2Human output
4. pivot neighborhood
```

(The Stage 5 / VTRACE instruction header is prepended later when the full agent
prompt is assembled; the digest leads the *capsule body*.)

### Exact injected block (rendered from the test fixture)

```
<VTRACE_CAPSULE_V2_DIGEST_START>
# combinator SQL output is wrong for values_list
● pivot SQLCompiler.get_combinator_sql  [signature ~1200t]
    why: named in the issue
○ skel QuerySet.values_list  [signature ~120t]
    why: query construction entry point
budget: 1200/8000t (15%)
warnings: pivot_source_bounded_to_signatures, impact_not_threaded_into_digest, memory_not_threaded_into_digest, rules_not_threaded_into_digest
<VTRACE_CAPSULE_V2_DIGEST_END>
```

## How digest-present validation now works

Detect an M55-digest run by the **sentinel**, never by glyphs:

- **Positive signal:** the injected context (captured in `_vtrace_instructions.snapshot.md`)
  contains `<VTRACE_CAPSULE_V2_DIGEST_START>`.
- **Do NOT** use `●` / `○` / `budget:` — the pre-M55 `renderCapsuleV2Human` output
  already carried those (`renderItem.ts:roleBullet` + the human render's budget line),
  so they false-positive on a non-digest run. This is pinned by the test
  `M55W: glyph/budget markers are NOT a reliable digest signal — only the sentinel is`.

If a VTRACE run with `--inject-capsule-digest` lacks the sentinel, it is
`m55_digest_not_present` and must not be counted (e.g. a `no_context` skip injects
no context at all).

## impact / memory / rules: warning-only (conservative)

The Stage 5 capsule path runs `vtrace query --capsule-engine v2`, which yields only
the capsule result — it does **not** compute impact/memory/rules at capsule-build
time. Threading those would require an orchestrator-level rewrite, which is out of
scope. So the digest is stamped with honest warnings
(`impact_not_threaded_into_digest`, `memory_not_threaded_into_digest`,
`rules_not_threaded_into_digest`) and renders **no** `→ impact` / `◎ memory` /
`◇ rule` lines. Nothing is fabricated. Folding these seams is left as explicit
follow-up before any breadth run.

## Duplication note

The digest and the retained `renderCapsuleV2Human` output overlap (both list pivots/
support with `●`/`○` and a budget line). The digest adds a `# query` header, per-item
`[mode ~Nt]` tags, `why:` on support, and the warnings line; the human render adds the
full signatures/source bodies. Both are kept for now (the safer default — removing the
human render risks dropping the focused source bodies the agent needs). A future
milestone can decide whether the digest should *replace* the human render once the
impact/memory/rules seams are folded in.

## Future live A/B command shape (NOT executed)

```bash
# baseline arm
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol baseline \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> --run-label m55w_baseline_<instance> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results

# digest arm
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> --run-label m55w_vtrace_digest_<instance> \
  --show-vtrace-index-log --context-policy force-inject \
  --capsule-engine v2 --capsule-intent debug --capsule-budget 8000 \
  --inject-capsule-digest \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

Then `--mode evaluate --eval-mode docker` per case, and validate each digest arm by
asserting the sentinel is present in its `_vtrace_instructions.snapshot.md`.

## Tests added (all offline; no agent spawn)

In `run_stage5_vexp_swe_bench_smoke.test.ts`:

1. default classify (no flag) omits the sentinel — backwards-compat.
2. glyph/`budget:` markers are NOT a reliable digest signal — only the sentinel is.
3. `injectDigest` prepends the sentinel block, it leads the context, and the block
   carries the exact `toCapsuleV2ProductResponse(...).digest`.
4. injected digest carries honest `*_not_threaded_into_digest` warnings and no
   fabricated `→/◎/◇` lines.
5. `classifyCapsuleOutput` threads the digest options through to the v2 classifier.
6. `--inject-capsule-digest` parses default-off and on (`parseArgs`).

## Files changed

- `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts` — flag,
  config field + default, help text, sentinel constants, `ClassifyCapsuleOptions`,
  `buildInjectedCapsuleV2DigestBlock`, threaded options through
  `classifyCapsuleOutput` / `classifyCapsuleV2Output`, call-site wiring.
- `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_live_capsule_precheck.ts` —
  added `injectCapsuleDigest: false` to its `CliConfig` literal.
- `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.test.ts` —
  6 new tests + imports.
- This report.

## Verification

- `bun run typecheck` ✅ · `bun run typecheck:benchmarks` ✅
- `bun test` → **3032 pass, 0 fail** (was 3026; +6) · `git diff --check` clean
- No retrieval evals required (no retrieval/scoring/ranking/candidate-generation code
  touched — this only changes the benchmark harness's injected-context assembly behind
  a default-off flag).

## Confirmation

**No live agents were run. No Docker. No API spend.** Only harness wiring, offline
tests, and this report.

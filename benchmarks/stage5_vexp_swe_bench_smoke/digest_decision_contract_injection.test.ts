// M57 — Assembly-level tests for the digest decision contract + compact injection,
// exercised through the real `classifyCapsuleOutput` path (the same code run-protocol
// uses). No live agents, no Docker, no subprocess — a real in-process index fixture
// (base <- alpha <- beta) feeds a serialized Capsule v2 result into classify.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import {
  DIGEST_DECISION_CONTRACT_START,
  DIGEST_DECISION_CONTRACT_END,
  parseDigestDecisionContract,
} from "../../src/capsuleV2/digestDecisionContract";
import {
  truncateContextByPriority,
  STRUCTURED_CONTRACT_OMITTED_MARKER,
} from "../../src/capsuleV2/sectionBudgetAccounting";
import { MAX_DIGEST_QUERY_CHARS } from "../../src/capsuleV2/productAdapter";
import {
  classifyCapsuleOutput,
  buildStage5DigestEnrichments,
  STAGE5_ATOMIC_SENTINEL_BLOCKS,
  CAPSULE_V2_DIGEST_SENTINEL_START,
  CAPSULE_V2_DIGEST_SENTINEL_END,
  type ClassifyCapsuleOptions,
} from "./run_stage5_vexp_swe_bench_smoke";

const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const INSPECT_FIRST_HEADING = "## VTRACE inspect-first";

async function withClassifier(
  run: (classify: (extra: Partial<ClassifyCapsuleOptions>) => string) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m57-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "base.ts"), 'export function base(): string {\n  return "base";\n}\n');
    await writeFile(path.join(repoRoot, "src", "alpha.ts"), 'import { base } from "./base";\nexport function alpha(): string {\n  return base();\n}\n');
    await writeFile(path.join(repoRoot, "src", "beta.ts"), 'import { alpha } from "./alpha";\nexport function beta(): string {\n  return alpha();\n}\n');
    await indexProject({ repoRoot, db });
    const task = "refactor the base function in src/base.ts";
    const result = buildCapsuleV2({ db, repoRoot, task, intent: CapsuleIntent.Refactor, maxTokens: 8_000 });
    const stdout = JSON.stringify(result);
    const provider = (parsed: typeof result) =>
      buildStage5DigestEnrichments({ db, repoRoot, query: task, result: parsed, intent: "modify" });
    const classify = (extra: Partial<ClassifyCapsuleOptions>): string =>
      classifyCapsuleOutput(stdout, {
        injectDigest: true,
        query: task,
        digestEnrichmentProvider: provider as ClassifyCapsuleOptions["digestEnrichmentProvider"],
        ...extra,
      }).context;
    await run(classify);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("M57: decision contract is absent by default (digest on, contract flag off)", async () => {
  await withClassifier((classify) => {
    const ctx = classify({});
    assert.ok(ctx.includes(DIGEST_START), "digest should still be injected");
    assert.equal(ctx.includes(DIGEST_DECISION_CONTRACT_START), false);
  });
});

test("M57: decision contract appears exactly once with both sentinels when enabled", async () => {
  await withClassifier((classify) => {
    const ctx = classify({ digestDecisionContract: true });
    assert.equal((ctx.match(new RegExp(DIGEST_DECISION_CONTRACT_START, "g")) ?? []).length, 1);
    assert.equal((ctx.match(new RegExp(DIGEST_DECISION_CONTRACT_END, "g")) ?? []).length, 1);
    // Lead pivot (base) is a required target, rendered after the digest.
    assert.match(ctx, /\d+\. PIVOT \S*base\S*/);
    assert.ok(ctx.indexOf(DIGEST_START) < ctx.indexOf(DIGEST_DECISION_CONTRACT_START), "contract follows the digest");
  });
});

test("M57: compact mode is absent by default — inspect-first is present", async () => {
  await withClassifier((classify) => {
    const ctx = classify({ digestDecisionContract: true });
    assert.ok(ctx.includes(INSPECT_FIRST_HEADING), "inspect-first present without compact mode");
  });
});

test("M57: compact mode suppresses the duplicated inspect-first block but keeps digest + contract", async () => {
  await withClassifier((classify) => {
    const ctx = classify({ digestDecisionContract: true, compactDigestInjection: true });
    assert.equal(ctx.includes(INSPECT_FIRST_HEADING), false, "compact mode drops inspect-first");
    assert.ok(ctx.includes(DIGEST_START), "digest preserved under compact mode");
    assert.ok(ctx.includes(DIGEST_DECISION_CONTRACT_START), "decision contract preserved under compact mode");
    // Focused source body (unique content) is preserved — never dropped by compact mode.
    assert.match(ctx, /● pivot/);
  });
});

test("M58: bounded decisions are off by default — the M57 two-way contract is rendered", async () => {
  await withClassifier((classify) => {
    const ctx = classify({ digestDecisionContract: true });
    assert.ok(ctx.includes(DIGEST_DECISION_CONTRACT_START), "contract present");
    assert.equal(ctx.includes("INSPECT_ONLY_NO_EDIT"), false, "no three-way decision by default");
  });
});

test("M58: --bounded-digest-decisions renders the three-way contract with anti-over-edit guidance", async () => {
  await withClassifier((classify) => {
    const ctx = classify({ digestDecisionContract: true, boundedDigestDecisions: true });
    assert.ok(ctx.includes(DIGEST_DECISION_CONTRACT_START), "contract present");
    assert.match(ctx, /decision: EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/);
    assert.match(ctx, /Required target does not mean required edit\./);
  });
});

test("M58: bounded + compact keeps digest and decision sentinels and drops inspect-first", async () => {
  await withClassifier((classify) => {
    const ctx = classify({
      digestDecisionContract: true,
      boundedDigestDecisions: true,
      compactDigestInjection: true,
    });
    assert.ok(ctx.includes(DIGEST_START), "digest preserved");
    assert.ok(ctx.includes(DIGEST_DECISION_CONTRACT_START), "decision contract preserved");
    assert.equal(ctx.includes(INSPECT_FIRST_HEADING), false, "compact still drops inspect-first");
    assert.match(ctx, /INSPECT_ONLY_NO_EDIT/, "bounded three-way decision present");
  });
});

// === M61: the REAL structured-bounded context survives Stage 5 truncation atomically.
// This exercises the same `truncateContextByPriority(..., { atomicBlocks })` call the
// harness applies at buildVtraceContextMarkdown, on the genuine digest + contract render
// (real glyphs, real grammar) — the M60B pylint-8898 failure was this step.

function lockedCharsOf(ctx: string): number {
  const ds = ctx.indexOf(CAPSULE_V2_DIGEST_SENTINEL_START);
  const de = ctx.indexOf(CAPSULE_V2_DIGEST_SENTINEL_END) + CAPSULE_V2_DIGEST_SENTINEL_END.length;
  const cs = ctx.indexOf(DIGEST_DECISION_CONTRACT_START);
  const ce = ctx.indexOf(DIGEST_DECISION_CONTRACT_END) + DIGEST_DECISION_CONTRACT_END.length;
  return (de - ds) + (ce - cs);
}

function occ(h: string, n: string): number {
  return h.split(n).length - 1;
}

test("M61: real structured-bounded context keeps both sentinel blocks under a tight truncation budget", async () => {
  await withClassifier((classify) => {
    const ctx = classify({
      digestDecisionContract: true,
      boundedDigestDecisions: true,
      compactDigestInjection: true,
    });
    // A budget that holds the two atomic blocks but forces the surrounding render to be
    // shed — the pylint-8898 shape, where the digest + contract must outrank the body.
    const cut = lockedCharsOf(ctx) + 200;
    const reduced = truncateContextByPriority(ctx, cut, { atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS });

    // Strict four-sentinel validity holds on the TRUNCATED context.
    assert.equal(occ(reduced.text, DIGEST_START), 1, "digest START exactly once");
    assert.equal(occ(reduced.text, CAPSULE_V2_DIGEST_SENTINEL_END), 1, "digest END exactly once");
    assert.equal(occ(reduced.text, DIGEST_DECISION_CONTRACT_START), 1, "contract START exactly once");
    assert.equal(occ(reduced.text, DIGEST_DECISION_CONTRACT_END), 1, "contract END exactly once");
    // The strict parser (both sentinels required) confirms the contract is intact.
    assert.equal(parseDigestDecisionContract(reduced.text).present, true);
    assert.ok((reduced.budget.atomicBlocksPreserved ?? []).includes("capsule_v2_digest"));
    assert.ok((reduced.budget.atomicBlocksPreserved ?? []).includes("digest_decision_contract"));
  });
});

test("M61: a budget below the atomic floor fails CLOSED — no partial sentinel pair", async () => {
  await withClassifier((classify) => {
    const ctx = classify({
      digestDecisionContract: true,
      boundedDigestDecisions: true,
      compactDigestInjection: true,
    });
    // Smaller than the two blocks combined: at least one block cannot fit.
    const cut = Math.floor(lockedCharsOf(ctx) / 2);
    const reduced = truncateContextByPriority(ctx, cut, { atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS });
    // Never a dangling START without its END (the invariant the validator depends on).
    assert.equal(
      reduced.text.includes(DIGEST_DECISION_CONTRACT_START),
      reduced.text.includes(DIGEST_DECISION_CONTRACT_END),
      "contract sentinels appear together or not at all",
    );
    assert.equal(
      reduced.text.includes(DIGEST_START),
      reduced.text.includes(CAPSULE_V2_DIGEST_SENTINEL_END),
      "digest sentinels appear together or not at all",
    );
    // A block that could not fit is reported, not silently split.
    assert.ok((reduced.budget.atomicBlocksOmitted ?? []).length > 0);
  });
});

// === M63: digest-header compaction recovers over-budget structured contracts =======
// The M62 fail-closed cases were driven by a multi-KB verbatim issue header in the
// digest, not by impact enrichment or the contract. With deterministic header
// compaction the digest stays small, so the structured-bounded blocks fit the real
// 12,000-char atomic budget — VALID instead of FAIL_CLOSED. Same in-process index
// path, no agents/Docker. The full task/problem statement still reaches the agent via
// the harness prompt; only the digest *header* field is compacted.

const VTRACE_CONTEXT_MAX_CHARS = 12_000; // == DEFAULT_CONFIG.vtraceContextMaxChars

// A pivot-bearing lead ("base" lexically matches the fixture) followed by a multi-KB
// problem statement — the shape that pushed pylint-8898/sympy-12419/matplotlib-22719
// over budget in M62.
function oversizedTask(): string {
  const lead = "refactor the base function in src/base.ts\n\n";
  const body = "Detailed bug report: base() returns the wrong value under chaining. "
    .repeat(160); // several KB, far over the 800-char digest-header cap
  return lead + body + "\nExpected: correct value. Actual: wrong value at the tail.";
}

async function withOversizedClassifier(
  run: (classify: (extra: Partial<ClassifyCapsuleOptions>) => string, task: string) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m63-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "base.ts"), 'export function base(): string {\n  return "base";\n}\n');
    await writeFile(path.join(repoRoot, "src", "alpha.ts"), 'import { base } from "./base";\nexport function alpha(): string {\n  return base();\n}\n');
    await writeFile(path.join(repoRoot, "src", "beta.ts"), 'import { alpha } from "./alpha";\nexport function beta(): string {\n  return alpha();\n}\n');
    await indexProject({ repoRoot, db });
    const task = oversizedTask();
    const result = buildCapsuleV2({ db, repoRoot, task, intent: CapsuleIntent.Refactor, maxTokens: 8_000 });
    const stdout = JSON.stringify(result);
    const provider = (parsed: typeof result) =>
      buildStage5DigestEnrichments({ db, repoRoot, query: task, result: parsed, intent: "modify" });
    const classify = (extra: Partial<ClassifyCapsuleOptions>): string =>
      classifyCapsuleOutput(stdout, {
        injectDigest: true,
        query: task,
        digestEnrichmentProvider: provider as ClassifyCapsuleOptions["digestEnrichmentProvider"],
        ...extra,
      }).context;
    await run(classify, task);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("M63: a multi-KB query is compacted in the digest header — verbatim issue body never injected", async () => {
  await withOversizedClassifier((classify, task) => {
    assert.ok(task.length > MAX_DIGEST_QUERY_CHARS, "fixture must exceed the cap");
    const ctx = classify({ digestDecisionContract: true, boundedDigestDecisions: true, compactDigestInjection: true });
    assert.ok(ctx.includes("query_truncated: true"), "header marked compacted");
    assert.ok(ctx.includes(`query_original_chars: ${task.length}`), "original char count recorded");
    // The repeated multi-KB body must not appear verbatim inside the injected context.
    assert.equal(ctx.includes(task), false, "verbatim oversized task not injected");
    // The digest block itself is now small relative to the budget.
    assert.ok(lockedCharsOf(ctx) < VTRACE_CONTEXT_MAX_CHARS, "locked blocks fit the budget");
  });
});

test("M63: over-budget case becomes VALID under the real 12k atomic budget after compaction", async () => {
  await withOversizedClassifier((classify) => {
    const ctx = classify({ digestDecisionContract: true, boundedDigestDecisions: true, compactDigestInjection: true });
    const reduced = truncateContextByPriority(ctx, VTRACE_CONTEXT_MAX_CHARS, { atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS });
    // Strict four-sentinel validity — established by the sentinels + structured parser,
    // NOT by generic glyphs.
    assert.equal(occ(reduced.text, DIGEST_START), 1, "digest START exactly once");
    assert.equal(occ(reduced.text, CAPSULE_V2_DIGEST_SENTINEL_END), 1, "digest END exactly once");
    assert.equal(occ(reduced.text, DIGEST_DECISION_CONTRACT_START), 1, "contract START exactly once");
    assert.equal(occ(reduced.text, DIGEST_DECISION_CONTRACT_END), 1, "contract END exactly once");
    assert.equal(parseDigestDecisionContract(reduced.text).present, true, "contract parses as present");
    // VALID, not fail-closed: no omission marker, no partial sentinel.
    assert.equal(reduced.text.includes(STRUCTURED_CONTRACT_OMITTED_MARKER), false, "no omission marker");
  });
});

test("M63: compacted injected digest is deterministic across repeated builds", async () => {
  const ctxs: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    await withOversizedClassifier((classify) => {
      ctxs.push(classify({ digestDecisionContract: true, boundedDigestDecisions: true, compactDigestInjection: true }));
    });
  }
  assert.equal(ctxs[0], ctxs[1], "same query ⇒ byte-identical injected context");
});

test("M63: below the atomic floor the contract still fails CLOSED — no partial sentinel pair", async () => {
  await withOversizedClassifier((classify) => {
    const ctx = classify({ digestDecisionContract: true, boundedDigestDecisions: true, compactDigestInjection: true });
    const cut = Math.floor(lockedCharsOf(ctx) / 2); // smaller than the two blocks combined
    const reduced = truncateContextByPriority(ctx, cut, { atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS });
    assert.equal(
      reduced.text.includes(DIGEST_DECISION_CONTRACT_START),
      reduced.text.includes(DIGEST_DECISION_CONTRACT_END),
      "contract sentinels appear together or not at all",
    );
    assert.equal(
      reduced.text.includes(DIGEST_START),
      reduced.text.includes(CAPSULE_V2_DIGEST_SENTINEL_END),
      "digest sentinels appear together or not at all",
    );
    assert.ok((reduced.budget.atomicBlocksOmitted ?? []).length > 0, "omission is explicit, not a silent split");
  });
});

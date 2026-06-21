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
} from "../../src/capsuleV2/digestDecisionContract";
import {
  classifyCapsuleOutput,
  buildStage5DigestEnrichments,
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

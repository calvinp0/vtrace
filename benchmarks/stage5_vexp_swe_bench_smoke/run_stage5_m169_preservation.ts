/**
 * M169 start state and product-freeze proof (§60, §61, §62, §83).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_preservation.ts
 *
 * M169 is an audit. The claim it must be able to make at the end is that the
 * product did not move while it was measured, and the way to make that claim
 * cheap and total is to compare git's own tree hash for `src/` — not a file
 * count, not a diff summary, the object identity of the whole subtree.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: path.resolve("."), encoding: "utf-8" }).trim();

const resolve = (rev: string): { sha: string; committedAt: string; subject: string } | null => {
  try {
    return {
      sha: git("rev-parse", rev),
      committedAt: git("log", "-1", "--format=%cI", rev),
      subject: git("log", "-1", "--format=%s", rev),
    };
  } catch { return null; }
};

const M167 = "de7bfe48b5bbadd50ff7ab7c85621f15f1dd3a37";
const srcTreeAt = (rev: string): string | null => {
  try { return git("rev-parse", `${rev}:src`); } catch { return null; }
};

const headSrcTree = srcTreeAt("HEAD");
const frozenSrcTree = srcTreeAt(M167);
const workingSrcDirty = git("status", "--porcelain", "src").length > 0;

const document = {
  schemaVersion: "stage5.m169.preservation.v1",
  milestone: "M169",
  provenance: {
    M167: resolve(M167),
    M168_authority: resolve("aaa334d90ad7498f213cd6ba5486d4c4908716e1"),
    M168_protocol_freeze: resolve("55e1f0bba2a7a62fd0a79dfcfb631bcd313e316e"),
    M168_harness_corrections: [
      resolve("85cbabc5635e223131f3bf08830c474e5ddf4233"),
      resolve("546ce88b6d6a4e403d75f42d8a07236d14a4804b"),
      resolve("8b4ba43708b217d41efb8d23fd3089071ece2e1e"),
    ],
    M168_live_evidence: resolve("413093e032dd9d31b37d4c16f5f80452df8d083c"),
    HEAD: resolve("HEAD"),
    originMain: resolve("origin/main"),
  },
  productFreeze: {
    subtree: "src",
    frozenAt: M167,
    frozenTreeHash: frozenSrcTree,
    headTreeHash: headSrcTree,
    identical: frozenSrcTree !== null && frozenSrcTree === headSrcTree,
    workingTreeDirty: workingSrcDirty,
    claim: "src/ is byte-identical to M167 across the whole of M168 and M169. "
      + "Every M169 change lives under benchmarks/.",
  },
  expectations: {
    productBehaviour: "unchanged",
    retrieval: "unchanged",
    ranking: "unchanged",
    runPipelineDefaultBudget: "unchanged",
    searchPolicy: "unchanged",
    liveSpendUsd: 0,
  },
};

writeFileSync(path.join(RESULTS, "stage5_m169_preservation.json"), `${JSON.stringify(document, null, 2)}\n`);
console.log("wrote stage5_m169_preservation.json");
console.log(`src tree  M167 ${frozenSrcTree}`);
console.log(`src tree  HEAD ${headSrcTree}`);
console.log(`identical:     ${document.productFreeze.identical}   working tree dirty: ${workingSrcDirty}`);

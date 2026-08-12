// M142 Workstream D — where the large serialized responses actually come from.
//
// The failure report cites a ~63 kB serialized tool response and a ~28 kB
// envelope carrying ~3.3k tokens of useful content. §54 says not to assume the
// M130/M133 whole-response contract already covers the path, so this measures
// both shapes side by side rather than inferring one from the other:
//
//   engine result   `CapsuleV2Result` — the internal structure, carrying the
//                   full candidate scorecard and discard tail
//   product response what `get_code_context` actually serializes
//
// Reports the content/diagnostics split for each, at several budgets.
//
// Read-only against a prepared index. No agents, Docker, VEXP, network, or paid
// API.

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";
import { CapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

const ARC_ROOT = path.resolve(process.env.M142_ARC_ROOT ?? "/home/calvin/code/ARC");
const DEFAULT_INDEX = "/home/calvin/bench/vtrace-m142/arc-m141.sqlite";
const RUNNER_NAME = "m142_response_size";

const QUERIES: ReadonlyArray<{ id: string; task: string }> = [
  {
    id: "behavioral_normal_mode",
    task:
      "How does ARC verify that a saddle point actually connects the intended "
      + "reactants and products by looking at how the atoms move in the imaginary "
      + "vibration?",
  },
  { id: "behavioral_gaussian_route", task: "How does ARC decide which Gaussian route keywords to emit?" },
  { id: "explicit_lookup", task: "Where is which() implemented?" },
];

const BUDGETS = [3_000, 6_000, 12_000] as const;

/** Bytes each top-level field contributes, largest first. */
function fieldSizes(value: object): Array<{ field: string; bytes: number }> {
  return Object.entries(value)
    .map(([field, contents]) => ({ field, bytes: JSON.stringify(contents)?.length ?? 0 }))
    .sort((left, right) => right.bytes - left.bytes);
}

export function measureResponse(result: CapsuleV2Result) {
  const product = toCapsuleV2ProductResponse(result);
  const engineBytes = JSON.stringify(result).length;
  const productBytes = JSON.stringify(product).length;
  const contentBytes =
    (JSON.stringify(product.pivots)?.length ?? 0) + (JSON.stringify(product.support)?.length ?? 0);
  const diagnosticsBytes = productBytes - contentBytes;
  return {
    engine: {
      serializedBytes: engineBytes,
      fields: fieldSizes(result as unknown as object).slice(0, 6),
    },
    product: {
      serializedBytes: productBytes,
      // A rough but stable proxy; the point is the RATIO, not a token count.
      estimatedTokens: Math.round(productBytes / 4),
      contentBytes,
      diagnosticsBytes,
      contentShare: Math.round((contentBytes / Math.max(1, productBytes)) * 1000) / 1000,
      fields: fieldSizes(product as unknown as object).slice(0, 8),
    },
    budget: {
      maxTokens: product.budget.maxTokens,
      estimatedTokens: product.budget.estimatedTokens,
    },
  };
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m142_response_size.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const target = await prepareRunnerOutput({ argv: process.argv.slice(2), runner: RUNNER_NAME });
  const indexPath = argument("--index") ?? DEFAULT_INDEX;
  const label = argument("--label") ?? "m142_after";

  const db = new Database(indexPath, { readonly: true });
  try {
    const rows = [];
    for (const query of QUERIES) {
      for (const maxTokens of BUDGETS) {
        const result = buildCapsuleV2({
          db,
          repoRoot: ARC_ROOT,
          task: query.task,
          intent: CapsuleIntent.Explain,
          maxTokens,
        });
        rows.push({ id: query.id, task: query.task, maxTokens, ...measureResponse(result) });
      }
    }
    const artifact = {
      schemaVersion: "stage5.m142.response-size.v1",
      label,
      generatedFrom: {
        vtraceHead: git(process.cwd(), ["rev-parse", "HEAD"]),
        arcHead: git(ARC_ROOT, ["rev-parse", "HEAD"]),
        indexPath,
      },
      // Stated up front because it is the whole finding.
      note:
        "`engine` is the internal CapsuleV2Result and is NEVER returned by an MCP "
        + "tool; `product` is what get_code_context serializes. Comparing the two "
        + "is the point: a large engine structure is not a large response.",
      rows,
    };
    const outPath = path.join(target.dir, `stage5_m142_response_boundedness_${label}.json`);
    await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`${outPath}\n`);
    for (const row of rows) {
      process.stdout.write(
        `${row.id} @${row.maxTokens}: engine=${row.engine.serializedBytes}B `
        + `product=${row.product.serializedBytes}B content=${(row.product.contentShare * 100).toFixed(0)}% `
        + `diagnostics=${row.product.diagnosticsBytes}B est=${row.budget.estimatedTokens}tok\n`,
      );
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}

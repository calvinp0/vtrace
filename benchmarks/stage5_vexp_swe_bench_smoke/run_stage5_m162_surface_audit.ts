/**
 * M162-A artifact runner — emits the callable-surface audit and the frozen
 * tool-schema manifest.
 *
 * Offline and side-effect free apart from writing its two artifacts: it reads
 * the product registry in-process, so the recorded surface is the surface the
 * live agent would be offered rather than a transcription of it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m162_surface_audit.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { auditCallableSurface, serializeListedTool } from "./m162CallableSurface";
import { defaultMcpToolRegistry } from "../../src/mcp/tools";

const SCHEMA_VERSION = 1;
const MILESTONE = "M162";

function parseOutDir(argv: readonly string[]): string {
  const index = argv.indexOf("--out");
  if (index !== -1 && argv[index + 1] !== undefined) {
    return path.resolve(argv[index + 1]!);
  }
  return path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { encoding: "utf8" }).trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function main(): void {
  const outDir = parseOutDir(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  const audit = auditCallableSurface();
  const productSha = git(["rev-parse", "HEAD"]);
  // A dirty tree means the audited surface is not the committed surface. That
  // does not invalidate an exploratory run, but it must be visible in the
  // artifact rather than inferred later.
  const treeClean = git(["status", "--porcelain"]).length === 0;

  const surfaceArtifact = {
    schemaVersion: SCHEMA_VERSION,
    milestone: MILESTONE,
    workstream: "A",
    title: "Callable VTRACE agent-surface audit",
    productSha,
    treeClean,
    method:
      "defaultMcpToolRegistry is read in-process and every model-visible tool is serialized "
      + "exactly as tools/list delivers it. Nothing here is inferred from filenames.",
    visibleToolCount: audit.visibleToolCount,
    hiddenToolIds: audit.hiddenToolIds,
    includedToolIds: audit.includedToolIds,
    schemaTokenCost: {
      fullVisibleSurface: audit.fullSurfaceSchemaTokens,
      selectedSet: audit.selectedSchemaTokens,
      declined: audit.fullSurfaceSchemaTokens - audit.selectedSchemaTokens,
      note:
        "Estimated at chars/4 over {name, description, inputSchema}. This is a per-turn prompt-prefix "
        + "cost carried like M161's injected capsule, not a one-off.",
    },
    policyFlaggedToolIds: audit.policyFlaggedToolIds,
    suitePolicy: audit.suitePolicy,
    tools: audit.tools,
  };

  const selected = defaultMcpToolRegistry
    .listMetadata()
    .filter((metadata) => audit.includedToolIds.includes(metadata.toolId));

  const perTool = selected.map((metadata) => {
    const serialized = serializeListedTool(metadata);
    return {
      toolId: metadata.toolId,
      descriptionSha256: sha256(metadata.description),
      inputSchemaSha256: sha256(JSON.stringify(metadata.inputSchema)),
      listedToolSha256: sha256(serialized),
      schemaChars: serialized.length,
    };
  });

  // One hash over the whole offered surface: names + descriptions + schemas.
  // §24 requires this to be frozen before any live treatment runs, so that a
  // mid-sweep description edit cannot be pooled with earlier outcomes (§77).
  // The routing policy is served on `initialize` and is therefore part of the
  // offered surface, not commentary about it: it is hashed alongside the tools so
  // a change to either invalidates the freeze.
  const suitePolicySha256 = sha256(audit.suitePolicy.text);
  const toolSetSha256 = sha256(
    JSON.stringify([
      ...perTool.map((tool) => [tool.toolId, tool.listedToolSha256]),
      ["__suite_policy__", suitePolicySha256],
    ]),
  );

  const manifestArtifact = {
    schemaVersion: SCHEMA_VERSION,
    milestone: MILESTONE,
    workstream: "A",
    title: "Frozen M162 callable tool-schema manifest",
    productSha,
    treeClean,
    toolSetSha256,
    tools: perTool,
    suitePolicy: {
      sha256: suitePolicySha256,
      chars: audit.suitePolicy.chars,
      estimatedTokens: audit.suitePolicy.estimatedTokens,
      policyFlags: audit.suitePolicy.flags,
      text: audit.suitePolicy.text,
      servedOn: "initialize.result.instructions",
    },
    totalSchemaTokens: audit.selectedSchemaTokens,
    /** Schema + routing policy: the turn-0 VTRACE context CALLABLE actually carries. */
    totalStaticTokens: audit.selectedStaticTokens,
    mcpServer: {
      transport: "stdio",
      command: "vtrace mcp-serve --repo <task-workspace>",
      protocolVersion: "2024-11-05",
      serverId: "vtrace_rc1_mcp",
      note:
        "The server is repo-bound at startup; repo_root additionally selects a linked worktree "
        + "per call. Both are recorded per invocation so routing is provable rather than assumed.",
    },
  };

  const surfacePath = path.join(outDir, "stage5_m162_callable_surface_audit.json");
  const manifestPath = path.join(outDir, "stage5_m162_tool_schema_manifest.json");
  writeFileSync(surfacePath, `${JSON.stringify(surfaceArtifact, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifestArtifact, null, 2)}\n`);

  console.log(`M162-A surface audit -> ${surfacePath}`);
  console.log(`M162-A schema manifest -> ${manifestPath}`);
  console.log(
    `visible=${audit.visibleToolCount} hidden=${audit.hiddenToolIds.length} `
    + `selected=[${audit.includedToolIds.join(", ")}] `
    + `schemaTokens selected=${audit.selectedSchemaTokens} full=${audit.fullSurfaceSchemaTokens}`,
  );
  console.log(`toolSetSha256=${toolSetSha256}`);
  if (audit.policyFlaggedToolIds.length > 0) {
    console.log(`POLICY FLAGS on: ${audit.policyFlaggedToolIds.join(", ")}`);
  }
}

main();

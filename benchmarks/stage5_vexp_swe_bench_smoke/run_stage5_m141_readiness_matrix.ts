// M141 evidence: the readiness state matrix and cross-tool parity matrix.
//
// Builds a real index for each readiness state, evaluates it through the shared
// evaluator, and queries the same state through `index_status` and every
// readiness-sensitive product tool. Deterministic and offline: temp git repos,
// no agents, no Docker, no VEXP, no network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m141_readiness_matrix.ts \
//     [--out <dir>] [--evidence] [--workspace-root <dir>]

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";

import { resolveIndexMetaPath, type IndexMeta } from "../../src/indexer/indexMeta";
import {
  evaluateIndexReadiness,
  summarizeIndexReadiness,
  withRuntimeSignals,
  type IndexReadiness,
} from "../../src/indexer/indexReadiness";
import { initRepo } from "../../src/setup/initRepo";
import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { defaultMcpToolRegistry } from "../../src/mcp/tools";
import { MCP_SERVER_ID, MCP_SERVER_SCHEMA, McpToolId, type McpServerContext } from "../../src/mcp/types";
import {
  prepareRunnerOutput,
  prepareScratchRoot,
  describeRunnerPaths,
  SHARED_RUNNER_OPTIONS_HELP,
} from "./lib/runnerPaths";

const execFile = promisify(execFileCallback);
const RUNNER_NAME = "m141_readiness_matrix";
const registry = defaultMcpToolRegistry;

/** Each product tool, with the policy it applies to a not-ready index. */
const PRODUCT_TOOLS = [
  { toolId: McpToolId.GetCodeContext, input: { query: "alpha" }, policy: "fail_closed" },
  { toolId: McpToolId.GetContextCapsule, input: { query: "alpha" }, policy: "fail_closed" },
  { toolId: McpToolId.RunPipeline, input: { query: "alpha" }, policy: "fail_closed" },
  { toolId: McpToolId.GetImpactGraph, input: { symbol_fqn: "alpha.py::alpha" }, policy: "serve_with_warning" },
  { toolId: McpToolId.SearchLogicFlow, input: { start: "beta.py::beta", end: "alpha.py::alpha" }, policy: "serve_with_warning" },
] as const;

type StateName =
  | "current_ready"
  | "source_changed"
  | "dirty_source_changed"
  | "schema_incompatible"
  | "newer_unsupported_schema"
  | "capability_missing"
  | "wrong_repo"
  | "wrong_worktree"
  | "missing_index"
  | "unreadable_index";

interface StateCase {
  readonly name: StateName;
  readonly description: string;
  readonly build: (root: string) => Promise<void>;
  /** Capabilities the evaluation should be asked to require, if any. */
  readonly requiredCapabilities?: readonly ("edge_call_sites" | "document_chunks")[];
  /** Some states cannot host a product request at all (no index to bind). */
  readonly skipProductTools?: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(`run_stage5_m141_readiness_matrix.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const output = await prepareRunnerOutput({ argv, runner: RUNNER_NAME });
  const scratch = await prepareScratchRoot({ argv, runner: RUNNER_NAME });

  const cases = buildCases();
  const readinessRows: unknown[] = [];
  const parityRows: unknown[] = [];
  let disagreements = 0;

  for (const stateCase of cases) {
    const root = path.join(scratch, stateCase.name);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await stateCase.build(root);

    const readiness = await evaluateIndexReadiness(root, {
      probe: "full",
      ...(stateCase.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: [...stateCase.requiredCapabilities] }),
    });
    readinessRows.push(readinessRow(stateCase, readiness));

    if (stateCase.skipProductTools === true) continue;
    // Product tools declare no hard capability requirement (M131 deliberately
    // kept older indexes without `edge_call_sites` usable), so they are compared
    // against the base evaluation. A capability-only difference is recorded
    // explicitly rather than counted as a disagreement.
    const baseReadiness = await evaluateIndexReadiness(root, { probe: "full" });
    const parity = await queryEveryTool(root, stateCase, baseReadiness, readiness);
    parityRows.push(parity);
    if (parity.disagreements.length > 0) disagreements += parity.disagreements.length;
  }

  const verdict = disagreements === 0 ? "PASS" : "FAIL";
  await writeJson(output.dir, "stage5_m141_readiness_matrix.json", {
    schemaVersion: "stage5.m141.readiness-matrix.v1",
    verdict,
    paths: describeRunnerPaths({ argv, runner: RUNNER_NAME, output }),
    states: readinessRows,
  });
  await writeJson(output.dir, "stage5_m141_cross_tool_readiness.json", {
    schemaVersion: "stage5.m141.cross-tool-readiness.v1",
    verdict,
    disagreements,
    policy: {
      fail_closed:
        "index_status, get_code_context, and the shared M119 product-context layer inside "
        + "get_context_capsule and run_pipeline refuse an index the readiness evaluator rejects.",
      serve_with_warning:
        "get_impact_graph and search_logic_flow keep M131's older-index contract and answer with "
        + "bounded static evidence. This is declared policy applied to the SAME verdict, not a "
        + "second opinion about whether the index is ready.",
    },
    rows: parityRows,
  });

  console.log(`M141 readiness matrix: ${verdict} (${readinessRows.length} states, ${disagreements} disagreement(s))`);
  for (const row of readinessRows as Array<Record<string, unknown>>) {
    console.log(`  ${String(row.case).padEnd(24)} ready=${String(row.ready).padEnd(5)} ${row.state} / ${row.reason} -> ${row.action}`);
  }
  if (verdict !== "PASS") process.exitCode = 1;
}

function buildCases(): StateCase[] {
  return [
    {
      name: "current_ready",
      description: "freshly indexed repository, nothing changed",
      build: async (root) => { await indexedRepo(root); },
    },
    {
      name: "source_changed",
      description: "a new commit after indexing",
      build: async (root) => {
        await indexedRepo(root);
        await writeFile(path.join(root, "gamma.py"), "def gamma():\n    return 3\n");
        await git(root, "add", "-A");
        await commit(root, "second");
      },
    },
    {
      name: "dirty_source_changed",
      description: "an uncommitted edit at the same HEAD",
      build: async (root) => {
        await indexedRepo(root);
        await writeFile(path.join(root, "alpha.py"), "def alpha():\n    return 99\n");
      },
    },
    {
      name: "schema_incompatible",
      description: "same source, index written by a different indexer/parser build",
      build: async (root) => {
        await indexedRepo(root);
        await patchMeta(root, (meta) => {
          meta.parser_fingerprint = "0".repeat(64);
          meta.manifest.index.parserVersion = "0".repeat(64);
        });
      },
    },
    {
      name: "newer_unsupported_schema",
      description: "index written by a newer runtime than this one",
      build: async (root) => {
        await indexedRepo(root);
        await patchMeta(root, (meta) => {
          meta.index_format_version += 1;
          meta.manifest.schemaVersion += 1;
          meta.manifest.index.indexSchemaVersion += 1;
        });
      },
    },
    {
      name: "capability_missing",
      description: "older index without the M131 call-site table, capability required",
      requiredCapabilities: ["edge_call_sites"],
      build: async (root) => {
        await indexedRepo(root);
        const db = new Database(path.join(root, ".vtrace", "index.sqlite"));
        db.exec("DROP TABLE IF EXISTS edge_call_sites");
        db.close();
      },
    },
    {
      name: "wrong_repo",
      description: "index built for a different repository",
      build: async (root) => {
        await indexedRepo(root);
        await patchMeta(root, (meta) => {
          meta.manifest.repository.repositoryId = "someotherrepository00000";
        });
      },
    },
    {
      name: "wrong_worktree",
      description: "index built for a different worktree of the same repository",
      build: async (root) => {
        await indexedRepo(root);
        await patchMeta(root, (meta) => {
          meta.manifest.worktree.worktreeId = "someotherworktree0000000";
        });
      },
    },
    {
      name: "missing_index",
      description: "git repository with no index at all",
      skipProductTools: true,
      build: async (root) => {
        await git(root, "init", "--initial-branch=main");
      },
    },
    {
      name: "unreadable_index",
      description: "index file present but not a readable SQLite database",
      skipProductTools: true,
      build: async (root) => {
        await indexedRepo(root);
        await writeFile(path.join(root, ".vtrace", "index.sqlite"), "not a database");
      },
    },
  ];
}

function readinessRow(stateCase: StateCase, readiness: IndexReadiness) {
  const summary = summarizeIndexReadiness(readiness);
  return {
    case: stateCase.name,
    description: stateCase.description,
    sourceFresh: summary.sourceFresh,
    schemaCompatible: summary.schemaCompatible,
    capabilityCompatible: summary.capabilityCompatible,
    repoCompatible: summary.repositoryCompatible,
    worktreeCompatible: summary.worktreeCompatible,
    ready: summary.ready,
    state: summary.state,
    reason: summary.reason,
    action: summary.recommendedAction,
    missingCapabilities: summary.missingCapabilities,
    legacyFreshness: {
      status: readiness.freshness.status,
      reason: readiness.freshness.reason,
      action: readiness.freshness.action,
    },
  };
}

async function queryEveryTool(
  root: string,
  stateCase: StateCase,
  readiness: IndexReadiness,
  requestedCapabilityReadiness: IndexReadiness,
) {
  const context = contextBoundTo(root);
  const statusResult = await callTool(context, McpToolId.IndexStatus, {});
  const statusReadiness = statusResult.ok === true
    ? statusResult.output.indexReadiness
    : null;

  const expected = summarizeIndexReadiness(withRuntimeSignals(readiness, {}));
  const disagreements: string[] = [];
  const tools: unknown[] = [];

  if (statusReadiness === null) {
    disagreements.push("index_status did not answer");
  } else if (statusReadiness.ready !== expected.ready) {
    disagreements.push(`index_status ready=${statusReadiness.ready} vs evaluator ready=${expected.ready}`);
  }

  for (const tool of PRODUCT_TOOLS) {
    const result = await callTool(context, tool.toolId, { ...tool.input });
    const verdict = authoritativeVerdict(result);
    tools.push({
      tool: tool.toolId,
      policy: tool.policy,
      answered: result.ok === true,
      resolved: verdict.resolved,
      reason: verdict.reason,
    });
    if (tool.policy !== "fail_closed") continue;
    if (expected.ready && verdict.resolved !== true) {
      disagreements.push(`${tool.toolId} refused an index the evaluator calls ready (${verdict.reason})`);
    }
    if (!expected.ready && verdict.resolved === true) {
      disagreements.push(`${tool.toolId} served an index the evaluator refuses (${expected.reason})`);
    }
  }

  const capabilityDifference = requestedCapabilityReadiness.ready === expected.ready
    ? null
    : {
      note: "the state was evaluated with an explicit capability requirement no product tool declares",
      withRequiredCapabilities: {
        ready: requestedCapabilityReadiness.ready,
        state: requestedCapabilityReadiness.state,
        reason: requestedCapabilityReadiness.reason,
        missing: requestedCapabilityReadiness.capabilities.missing,
      },
      withoutRequiredCapabilities: { ready: expected.ready, state: expected.state, reason: expected.reason },
    };

  return {
    case: stateCase.name,
    evaluator: { ready: expected.ready, state: expected.state, reason: expected.reason, action: expected.recommendedAction },
    capabilityDifference,
    index_status: statusReadiness === null ? null : {
      ready: statusReadiness.ready,
      state: statusReadiness.state,
      reason: statusReadiness.reason,
      action: statusReadiness.recommendedAction,
      legacyIsStale: statusResult.output.freshness.isStale,
    },
    tools,
    disagreements,
  };
}

/** Normalized "did this tool serve the index?" across the three response shapes. */
function authoritativeVerdict(result: any): { resolved: boolean | null; reason: string } {
  if (result?.ok !== true) {
    return { resolved: false, reason: String(result?.error?.details?.reason ?? result?.error?.code ?? "error") };
  }
  const output = result.output ?? {};
  if (output.resolved === false) return { resolved: false, reason: String(output.reason ?? "unresolved") };
  const productContext = output.productContext;
  if (productContext !== undefined) {
    return {
      resolved: productContext.resolved === true,
      reason: String(productContext.freshness?.reason ?? "fresh"),
    };
  }
  return { resolved: null, reason: "served_with_warning" };
}

async function indexedRepo(root: string): Promise<void> {
  await writeFile(path.join(root, "alpha.py"), "def alpha():\n    return 1\n");
  await writeFile(path.join(root, "beta.py"), "from alpha import alpha\n\n\ndef beta():\n    return alpha()\n");
  await git(root, "init", "--initial-branch=main");
  await git(root, "add", "-A");
  await commit(root, "initial");
  await initRepo({ repoPath: root });
}

async function patchMeta(root: string, mutate: (meta: IndexMeta) => void): Promise<void> {
  const metaPath = resolveIndexMetaPath(root);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as IndexMeta;
  mutate(meta);
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

async function git(root: string, ...args: string[]): Promise<void> {
  const isInit = args[0] === "init";
  await execFile("git", isInit ? [...args, root] : ["-C", root, ...args], { encoding: "utf8" });
}

async function commit(root: string, message: string): Promise<void> {
  await execFile("git", [
    "-C", root, "-c", "user.email=m141@example.com", "-c", "user.name=M141",
    "commit", "-qm", message,
  ], { encoding: "utf8" });
}

function contextBoundTo(repoRoot: string): McpServerContext {
  const paths = resolveRepoLocalPaths(repoRoot);
  return {
    serverId: MCP_SERVER_ID,
    repoRoot,
    dbPath: paths.dbPath,
    configPath: paths.configPath,
    statePath: paths.statePath,
    initialized: true,
    config: null,
    state: null,
  } as McpServerContext;
}

async function callTool(
  context: McpServerContext,
  toolId: McpToolId,
  input: Record<string, unknown>,
): Promise<any> {
  const definition = registry.getByToolId(toolId);
  if (definition === undefined) throw new Error(`tool ${toolId} is not registered`);
  return await definition.handler({
    context,
    request: { schema: MCP_SERVER_SCHEMA, requestId: "m141", toolId, input },
  }) as any;
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  await main();
}

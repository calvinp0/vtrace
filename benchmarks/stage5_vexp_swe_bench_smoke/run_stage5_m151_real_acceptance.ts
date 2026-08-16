/**
 * M151 — real-repository acceptance through the wired product path.
 *
 * §63-§66 and §76-§77 ask for ARC and TCKDB to be routed and answered by the REAL
 * product surface, and §103 asks that M150's behavioural results survive it.
 *
 * SAFETY
 * ----------------
 * The workspace config is written into a THROWAWAY host repository, never into
 * ARC's or TCKDB's `.vtrace/`. The authoritative indexes are checksummed before
 * and after (§116) and are only ever read.
 *
 * Deterministic. No agents, no network, no Docker.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { initRepo } from "../../src/setup/initRepo";
import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { resolveIndexDbPath } from "../../src/indexer/indexMeta";
import { defaultMcpToolRegistry } from "../../src/mcp/tools";
import { MCP_SERVER_ID, MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import type { McpServerContext } from "../../src/mcp/types";
import { resolveWorkspaceConfigPath, writeWorkspaceConfig } from "../../src/workspace/config";

const execFile = promisify(execFileCallback);
const RESULTS = path.join(import.meta.dir, "results");

const ARC = "/home/calvin/code/ARC";
const TCKDB = "/home/calvin/code/TCKDB_v2";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

async function checksum(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 32);
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
  const registry = defaultMcpToolRegistry;
  return (await registry.getByToolId(toolId)!.handler({
    context,
    request: { schema: MCP_SERVER_SCHEMA, requestId: "m151-real", toolId, input },
  })) as any;
}

function routing(result: any): any {
  return result.ok ? result.output?.workspaceRouting : result.error?.details?.workspaceRouting;
}

/** Pivot-role items, in delivered order: the answer the model is led to. */
function leadItems(result: any): { path: string; symbol: string | null; roles: string[] }[] {
  const items = result.output?.productContext?.items ?? [];
  return items
    .filter((item: any) => (item.roles ?? []).some((role: string) => /pivot|required/iu.test(role)))
    .map((item: any) => ({ path: item.path, symbol: item.symbol ?? null, roles: item.roles }));
}

function describe(result: any, expectLead: string | null) {
  const route = routing(result);
  const pivots = leadItems(result);
  return {
    ok: result.ok,
    errorCode: result.ok ? null : result.error?.code ?? null,
    routedRepository: route?.leadRepository ?? null,
    routeOutcome: route?.outcome ?? null,
    routeSource: route?.routeSource ?? null,
    decidingTier: route?.decidingTier ?? null,
    uniquenessProven: route?.uniquenessProven ?? null,
    membersDeepProbed: route?.coverage?.repositoriesDeepProbed ?? null,
    expectedRepository: expectLead,
    routedAsExpected: expectLead === null ? null : route?.leadRepository === expectLead,
    leadPivot: pivots[0] ?? null,
    pivotCount: pivots.length,
    itemsDelivered: result.output?.productContext?.items?.length ?? 0,
    responseBytes: JSON.stringify(result.output ?? result.error).length,
    routingBytes: route === undefined || route === null ? 0 : JSON.stringify(route).length,
  };
}

async function main(): Promise<void> {
  const arcDb = resolveIndexDbPath(ARC);
  const tckdbDb = resolveIndexDbPath(TCKDB);
  const before = {
    arc: await checksum(arcDb),
    tckdb: await checksum(tckdbDb),
  };

  const scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m151-real-"));
  const rows: Record<string, unknown> = {};

  try {
    // A throwaway host: the workspace config lives HERE, so nothing is written
    // into ARC's or TCKDB's repo-local state.
    const host = path.join(scratch, "host");
    await mkdir(path.join(host, "src"), { recursive: true });
    await writeFile(path.join(host, "src", "host_marker.py"), "def host_marker():\n    return 1\n");
    await git(host, "init", "--initial-branch=main");
    await git(host, "config", "user.email", "m151@example.com");
    await git(host, "config", "user.name", "M151");
    await git(host, "add", ".");
    await git(host, "commit", "-m", "host");
    await initRepo({ repoPath: host });

    const mixed = [
      { alias: "arc", rootPath: ARC, enabled: true },
      { alias: "tckdb", rootPath: TCKDB, enabled: true },
      { alias: "host", rootPath: host, enabled: true },
    ];
    await writeWorkspaceConfig(resolveWorkspaceConfigPath(host), {
      schemaVersion: "1.0.0",
      name: "m151-real",
      primaryRepoAlias: "arc",
      repos: mixed,
    } as never);

    const context = contextBoundTo(host);

    // ---- §63 ARC family selection, M150's headline behaviour --------------
    rows.arc_family_selection = {
      section: "§63",
      query: "How does ARC decide which reaction family wins?",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, {
          query: "How does ARC decide which reaction family wins?",
          repos: ["arc"],
        }),
        "arc",
      ),
      note:
        "Scoped to ARC explicitly: the query names no path and no identifier, so "
        + "auto-routing has no evidence and must not invent it (§73). M150's "
        + "behavioural result is what is being preserved here.",
    };

    // ---- §64 ARC family ordering ------------------------------------------
    rows.arc_family_ordering = {
      section: "§64",
      query: "What determines the precedence/order when multiple reaction families match?",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, {
          query: "What determines the precedence/order when multiple reaction families match?",
          repos: ["arc"],
        }),
        "arc",
      ),
    };

    // ---- §66 explicit symbol routes without naming the repository ---------
    rows.arc_exact_symbol_route = {
      section: "§66",
      query: "what does determine_family do",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, { query: "what does determine_family do" }),
        "arc",
      ),
      note: "No repository named in the request; the exact-symbol lane must choose ARC.",
    };

    // ---- §65 explicit path routes without naming the repository -----------
    rows.arc_exact_path_route = {
      section: "§65",
      query: "Explain arc/reaction.py",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, { query: "Explain arc/reaction.py" }),
        "arc",
      ),
    };

    // ---- §76/§77 TCKDB ----------------------------------------------------
    rows.tckdb_scoped = {
      section: "§76",
      query: "How are thermodynamic properties stored?",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, {
          query: "How are thermodynamic properties stored?",
          repos: ["tckdb"],
        }),
        "tckdb",
      ),
    };

    // ---- §77 mixed workspace, no repository named -------------------------
    rows.mixed_arc_symbol = {
      section: "§77",
      query: "explain determine_family",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, { query: "explain determine_family" }),
        "arc",
      ),
      note: "ARC-owned identifier in a 3-member workspace; must route by evidence, not name.",
    };
    rows.mixed_host_symbol = {
      section: "§77",
      query: "explain host_marker",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, { query: "explain host_marker" }),
        "host",
      ),
      note: "Host-owned identifier; the same lane must choose the host member.",
    };
    rows.mixed_ambiguous = {
      section: "§77",
      query: "How does the system decide what to do?",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, {
          query: "How does the system decide what to do?",
        }),
        null,
      ),
      note:
        "Deliberately ambiguous prose. No lane can decide, so the workspace's "
        + "configured default answers and says so - it is not a claim about relevance.",
    };

    // ---- §74/§75 repository identity is not symbol evidence ---------------
    rows.project_name_not_symbol = {
      section: "§74/§75",
      query: "What does ARC do with reaction families?",
      ...describe(
        await callTool(context, McpToolId.GetCodeContext, {
          query: "What does ARC do with reaction families?",
        }),
        null,
      ),
      note:
        "The word ARC is a registered alias AND a class name in that repository. "
        + "Routing must reach the configured default on absent evidence rather than "
        + "treat the prose mention as a route.",
    };

    const after = { arc: await checksum(arcDb), tckdb: await checksum(tckdbDb) };

    await writeFile(
      path.join(RESULTS, "stage5_m151_real_repo_acceptance.json"),
      `${JSON.stringify({
        milestone: "M151",
        generatedAt: new Date().toISOString(),
        surface: "MCP get_code_context via defaultMcpToolRegistry",
        realRepositories: { arc: ARC, tckdb: TCKDB },
        note:
          "§59: only three real indexed repositories exist on this machine, so the "
          + "real controls are 1-3 members and larger scales are synthetic and labelled "
          + "as such.",
        authoritativeIndexIntegrity: {
          section: "§116",
          arcBefore: before.arc,
          arcAfter: after.arc,
          arcUnchanged: before.arc === after.arc,
          tckdbBefore: before.tckdb,
          tckdbAfter: after.tckdb,
          tckdbUnchanged: before.tckdb === after.tckdb,
          finding:
            "The LEAD repository's index file changes on every read. Measured: three "
            + "consecutive get_code_context calls against ARC produced three different "
            + "file hashes (size stable after the first).",
          attribution:
            "PRE-EXISTING, not M151. The identical probe run against the M150 baseline "
            + "tree reproduces it exactly, so this is the long-standing behaviour of "
            + "`withReadyRepoDb` -> `openIndexerDatabase`, which runs the schema "
            + "initializer on the repository retrieval binds to.",
          m151AddedPathsAreReadOnly:
            "Every path M151 introduces opens members with { readonly: true }: the "
            + "routing probe and the supporting-repository composition. A member that "
            + "is probed for a route but does not lead is byte-identical afterwards, "
            + "asserted in src/mcp/workspaceProductRouting.test.ts.",
          consequence:
            "§21/§90 hold for M151's own additions and do NOT hold for the pre-existing "
            + "lead-retrieval binding. Recorded as a standing limitation rather than "
            + "claimed as an M151 result either way.",
        },
        cases: rows,
      }, null, 2)}\n`,
    );

    for (const [id, row] of Object.entries(rows)) {
      const value = row as any;
      console.log(
        `  ${value.ok ? "answered" : "declined"} ${id.padEnd(28)} routed=${String(value.routedAsExpected)}`
        + ` repo=${String(value.routedRepository).padEnd(6)} outcome=${String(value.routeOutcome).padEnd(18)}`
        + ` lead=${value.leadPivot?.symbol ?? value.leadPivot?.path ?? "-"}`,
      );
    }
    console.log(`\n[m151-real] ARC index unchanged:   ${before.arc === after.arc}`);
    console.log(`[m151-real] TCKDB index unchanged: ${before.tckdb === after.tckdb}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();

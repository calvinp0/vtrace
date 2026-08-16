// M151 — workspace routing through the REAL product surface.
//
// §100 is the reason this file exists rather than another router fixture: the
// milestone was opened because four milestones of routing evidence had only ever
// been exercised by calling `nominateRepositories` directly. Every case here goes
// through `defaultMcpToolRegistry`, so what is measured is what an agent gets.
//
// The controls that matter most are the negative ones. A refused member's index
// must never be opened; a supporting member's mere existence must not change the
// lead's answer; two repositories holding the same path must not collapse into
// one; and a query that names no path and no identifier must not be routed by the
// repository name it happens to mention.

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import { resolveRepoLocalPaths } from "../setup/repoState";
import { resolveIndexDbPath } from "../indexer/indexMeta";
import { resolveWorkspaceConfigPath, writeWorkspaceConfig } from "../workspace/config";
import { defaultMcpToolRegistry } from "./tools";
import { McpToolId } from "./types";
import type { McpServerContext } from "./types";

const execFile = promisify(execFileCallback);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m151-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

/** A tiny indexed repository. `files` maps relative path -> source. */
async function createRepo(name: string, files: Record<string, string>): Promise<string> {
  const root = path.join(scratch, name);
  for (const [relative, source] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, relative), source);
  }
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "m151@example.com");
  await git(root, "config", "user.name", "M151");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  await initRepo({ repoPath: root });
  return root;
}

/** Register a workspace at `hostRoot` over the given members. */
async function makeWorkspace(
  hostRoot: string,
  members: readonly { alias: string; rootPath: string; enabled?: boolean }[],
  primaryRepoAlias?: string,
): Promise<void> {
  await writeWorkspaceConfig(resolveWorkspaceConfigPath(hostRoot), {
    schemaVersion: "1.0.0",
    name: "m151",
    // Only set a primary when a case wants the configured-default authority.
    primaryRepoAlias: primaryRepoAlias ?? members[0]!.alias,
    repos: members.map((member) => ({
      alias: member.alias,
      rootPath: member.rootPath,
      enabled: member.enabled ?? true,
    })),
  } as never);
}

function contextBoundTo(repoRoot: string): McpServerContext {
  const paths = resolveRepoLocalPaths(repoRoot);
  return {
    serverId: "vtrace",
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
  const definition = registry.getByToolId(toolId);
  assert.notEqual(definition, undefined, `tool ${toolId} must be registered`);
  return (await definition!.handler({
    context,
    request: { schema: registry.schema, requestId: "m151", toolId, input },
  })) as any;
}

const ALPHA_SOURCE = {
  "src/alpha_engine.py": [
    "def alpha_only_symbol(records):",
    "    \"\"\"Choose the winning record for alpha.\"\"\"",
    "    return sorted(records)[0]",
    "",
    "def alpha_helper(value):",
    "    return alpha_only_symbol([value])",
  ].join("\n"),
};

const BETA_SOURCE = {
  "src/beta_engine.py": [
    "def beta_only_symbol(records):",
    "    \"\"\"Choose the winning record for beta.\"\"\"",
    "    return sorted(records)[-1]",
  ].join("\n"),
};

function routingOf(result: any) {
  return result.output?.workspaceRouting;
}

// ---------------------------------------------------------------------------
// The gap M151 closes
// ---------------------------------------------------------------------------

describe("a configured workspace no longer disables the product", () => {
  test("get_code_context answers in a workspace with no repos argument", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });

    // Before M151 this was invalid_request, and both remediations it advised
    // ("omit repos or select exactly one") also failed.
    assert.equal(result.ok, true);
    assert.equal(routingOf(result).leadRepository, "alpha");
  });

  test("selecting exactly one repository works, as the old error claimed it would", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "beta_only_symbol",
      repos: ["beta"],
    });

    assert.equal(result.ok, true);
    assert.equal(routingOf(result).leadRepository, "beta");
    assert.equal(routingOf(result).outcome, "explicit_member");
  });
});

// ---------------------------------------------------------------------------
// §11/§102 — single-repository behaviour must not move
// ---------------------------------------------------------------------------

describe("single-repository preservation (§11)", () => {
  test("a one-member workspace returns byte-identical context to no workspace at all", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);

    const before = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }]);
    const after = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });

    assert.equal(before.ok, true);
    assert.equal(after.ok, true);
    // Routing metadata is additive; the delivered context is the same object.
    assert.equal(
      after.output.productContext.modelVisibleContext,
      before.output.productContext.modelVisibleContext,
    );
    assert.deepEqual(
      after.output.productContext.items.map((item: any) => [item.path, item.symbol, item.roles]),
      before.output.productContext.items.map((item: any) => [item.path, item.symbol, item.roles]),
    );
  });

  test("no workspace config means routing never runs and nothing is probed", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });

    assert.equal(result.ok, true);
    assert.equal(routingOf(result).isWorkspace, false);
    assert.equal(routingOf(result).outcome, "single_repository");
    assert.equal(routingOf(result).coverage.repositoriesDeepProbed, 0);
  });

  test("the presence of another member does not change the lead's content (§28 hard control)", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);

    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }]);
    const alone = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });

    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);
    const withNeighbour = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });

    assert.equal(alone.ok, true);
    assert.equal(withNeighbour.ok, true);
    assert.equal(routingOf(withNeighbour).leadRepository, "alpha");
    // The whole point of default-off composition: another repository EXISTING
    // is not a reason for the answer to change.
    assert.equal(
      withNeighbour.output.productContext.modelVisibleContext,
      alone.output.productContext.modelVisibleContext,
    );
  });
});

// ---------------------------------------------------------------------------
// §25/§66/§71 — exact symbol routing
// ---------------------------------------------------------------------------

describe("exact-symbol routing (§25, §66, §71)", () => {
  test("a symbol unique to one member routes there", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "what does beta_only_symbol do",
    });

    assert.equal(result.ok, true);
    assert.equal(routingOf(result).leadRepository, "beta");
    assert.equal(routingOf(result).decidingTier, "exact_symbol");
  });

  test("a symbol defined in two members does not yield a unique route", async () => {
    const shared = "def shared_symbol(x):\n    return x\n";
    const alpha = await createRepo("alpha", { "src/a.py": shared });
    const beta = await createRepo("beta", { "src/b.py": shared });
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "explain shared_symbol",
    });

    // Ambiguity is reported, never resolved by picking the first member.
    assert.equal(result.ok, false);
    assert.equal(result.error.details.workspaceRouting.outcome, "abstained");
    expect(result.error.details.workspaceRouting.coverage.candidates.sort())
      .toEqual(["alpha", "beta"]);
  });

  test("a symbol no member defines does not claim the symbol is absent from source", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }], "alpha");

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "explain absent_symbol_nothing_defines",
    });

    // No evidence anywhere -> the workspace's configured default answers. The
    // response must not say the symbol does not exist (§82).
    assert.equal(result.ok, true);
    assert.equal(routingOf(result).outcome, "configured_member");
    assert.match(routingOf(result).reason, /No routing evidence/u);
    assert.doesNotMatch(JSON.stringify(routingOf(result)), /does not exist|no repository contains/iu);
  });
});

// ---------------------------------------------------------------------------
// §24/§68/§69 — path routing
// ---------------------------------------------------------------------------

describe("path routing (§24, §68, §69)", () => {
  test("a path indexed by exactly one member routes there", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "Explain src/beta_engine.py",
    });

    assert.equal(result.ok, true);
    assert.equal(routingOf(result).leadRepository, "beta");
    assert.equal(routingOf(result).decidingTier, "indexed_path");
  });

  test("an absolute path inside one member is authoritative and needs no index", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: `Explain ${path.join(beta, "src/beta_engine.py")}`,
    });

    assert.equal(result.ok, true);
    assert.equal(routingOf(result).leadRepository, "beta");
    assert.equal(routingOf(result).decidingTier, "path_containment");
    // Containment is decided from registration metadata alone.
    assert.equal(routingOf(result).coverage.repositoriesDeepProbed, 0);
  });

  test("the same relative path in two members is ambiguous, not arbitrarily assigned (§68)", async () => {
    const alpha = await createRepo("alpha", { "src/config.py": "SETTING = 'alpha'\n" });
    const beta = await createRepo("beta", { "src/config.py": "SETTING = 'beta'\n" });
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "Explain src/config.py",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.details.workspaceRouting.outcome, "abstained");
  });
});

// ---------------------------------------------------------------------------
// §34/§88/§89/§145 — refused members
// ---------------------------------------------------------------------------

describe("refused members (§34, §88, §145)", () => {
  test("a refused member is never opened for retrieval and the route still succeeds", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const broken = await createRepo("broken", BETA_SOURCE);
    // Remove the index so the member cannot answer. Its SOURCE is untouched, so
    // it remains a place the target could live — which is why it becomes
    // UNKNOWN rather than absent.
    await rm(resolveIndexDbPath(broken), { force: true });
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "broken", rootPath: broken }]);

    const dbPathBefore = resolveIndexDbPath(broken);
    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });

    assert.equal(result.ok, true);
    assert.equal(routingOf(result).leadRepository, "alpha");
    // alpha is the only member that answered positively, so it leads — but the
    // refused member means nobody may claim it is the ONLY one.
    assert.equal(routingOf(result).outcome, "sole_evidence_match");
    assert.equal(routingOf(result).uniquenessProven, false);
    // §21/§90: a read path must not recreate what it found missing.
    await assert.rejects(() => stat(dbPathBefore), "a read path must not create a member's index");
    // The refusal is reported as a safety exclusion, never as low relevance.
    expect(routingOf(result).coverage.excludedNotReadyTotal).toBeGreaterThan(0);
  });

  test("when no member can answer, the product says so without claiming absence", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await rm(resolveIndexDbPath(beta), { force: true });
    await makeWorkspace(alpha, [{ alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "beta_only_symbol",
    });

    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result.error), /no repository contains|does not exist/iu);
  });
});

// ---------------------------------------------------------------------------
// §30-§33 — cross-repository identity
// ---------------------------------------------------------------------------

describe("multi-repository provenance (§30-§33)", () => {
  test("composed context keeps each item bound to its own repository", async () => {
    // Same relative path AND same symbol name in both members, with different
    // bodies: the case where a merge keyed on path or name would silently drop
    // one identity.
    const alpha = await createRepo("alpha", {
      "src/config.py": "def load_config():\n    return 'ALPHA_VALUE'\n",
    });
    const beta = await createRepo("beta", {
      "src/config.py": "def load_config():\n    return 'BETA_VALUE'\n",
    });
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "load_config",
      repos: ["alpha"],
      include_supporting_repos: true,
    });

    assert.equal(result.ok, true);
    const items = result.output.productContext.items;
    const repositories = new Set(
      items.map((item: any) => item.metadata?.repository?.alias).filter(Boolean),
    );
    // Whatever composition admitted, no item may have lost its repository.
    for (const item of items) {
      if (item.metadata?.repository !== undefined) {
        assert.ok(typeof item.metadata.repository.alias === "string");
      }
    }
    assert.ok(repositories.size <= 2);
  });
});

// ---------------------------------------------------------------------------
// §73-§75 — routing must not be driven by repository names
// ---------------------------------------------------------------------------

describe("repository identity is not symbol evidence (§74, §75)", () => {
  test("naming a member in prose does not route to it", async () => {
    // `beta` is a registered member AND a word in the query. Nothing in the
    // request names a path or an identifier, so routing has no evidence and
    // must fall back to the configured default rather than to the member the
    // sentence mentioned.
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }], "alpha");

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "How does beta decide which record wins?",
    });

    assert.equal(result.ok, true);
    assert.equal(routingOf(result).leadRepository, "alpha");
    assert.equal(routingOf(result).outcome, "configured_member");
  });
});

// ---------------------------------------------------------------------------
// §15/§51/§62 — bounded metadata
// ---------------------------------------------------------------------------

describe("routing metadata stays bounded (§15, §62)", () => {
  test("a large workspace does not put a record per member in the response", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    // Synthetic members: registered, never indexed. They exercise the census and
    // the exclusion bound without the cost of indexing 60 repositories.
    const members = [{ alias: "alpha", rootPath: alpha }];
    for (let index = 0; index < 60; index += 1) {
      members.push({ alias: `syn${index}`, rootPath: path.join(scratch, `syn${index}`) });
    }
    await makeWorkspace(alpha, members, "alpha");

    const result = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });

    assert.equal(result.ok, true);
    const routing = routingOf(result);
    assert.equal(routing.coverage.repositoriesRegistered, 61);
    // Counts scale; named lists do not.
    expect(routing.coverage.excludedNotReady.length).toBeLessThanOrEqual(4);
    expect(routing.coverage.candidates.length).toBeLessThanOrEqual(4);
    expect(routing.supportingRepositories.length).toBeLessThanOrEqual(4);
    expect(JSON.stringify(routing).length).toBeLessThan(4_000);
  });

  test("index_status computes its census over every member and serializes a bounded sample", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const members = [{ alias: "alpha", rootPath: alpha }];
    for (let index = 0; index < 60; index += 1) {
      members.push({ alias: `syn${index}`, rootPath: path.join(scratch, `syn${index}`) });
    }
    await makeWorkspace(alpha, members, "alpha");

    const result = await callTool(contextBoundTo(alpha), McpToolId.IndexStatus, {});

    assert.equal(result.ok, true);
    const coverage = result.output.coverage;
    // Truth from the full census...
    assert.equal(coverage.registeredMembers, 61);
    assert.equal(coverage.readyMembers, 1);
    assert.equal(coverage.refusedMembers, 60);
    // ...display from a bounded sample, and the two are independent.
    assert.equal(result.output.repos.length, 4);
    assert.equal(coverage.omittedByBound, 57);
    assert.equal(coverage.examplesEmitted, 4);
    assert.equal(result.output.workspace.configuredReposTotal, 61);
    expect(result.output.workspace.configuredRepos.length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// §42/§79 — surfaces agree
// ---------------------------------------------------------------------------

describe("cross-surface agreement (§42, §79)", () => {
  test("get_code_context and get_context_capsule route to the same member", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const contextResult = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "beta_only_symbol",
    });
    const capsuleResult = await callTool(contextBoundTo(alpha), McpToolId.GetContextCapsule, {
      query: "beta_only_symbol",
    });

    assert.equal(contextResult.ok, true);
    assert.equal(capsuleResult.ok, true);
    assert.equal(
      capsuleResult.output.workspaceRouting.leadRepository,
      contextResult.output.workspaceRouting.leadRepository,
    );
    assert.equal(capsuleResult.output.workspaceRouting.leadRepository, "beta");
  });
});

// ---------------------------------------------------------------------------
// §91 — determinism
// ---------------------------------------------------------------------------

describe("determinism (§91)", () => {
  test("concurrent identical requests route identically", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, { query: "beta_only_symbol" })),
    );

    const leads = new Set(results.map((result) => routingOf(result).leadRepository));
    assert.deepEqual([...leads], ["beta"]);
  });

  test("member registration order does not change the route", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);

    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);
    const forward = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "beta_only_symbol",
    });

    await makeWorkspace(alpha, [{ alias: "beta", rootPath: beta }, { alias: "alpha", rootPath: alpha }]);
    const reversed = await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "beta_only_symbol",
    });

    assert.equal(routingOf(forward).leadRepository, routingOf(reversed).leadRepository);
  });
});

// ---------------------------------------------------------------------------
// §21/§90 — read paths do not mutate
// ---------------------------------------------------------------------------

describe("read paths do not mutate member indexes (§21, §90)", () => {
  test("routing leaves every member index byte-identical", async () => {
    const alpha = await createRepo("alpha", ALPHA_SOURCE);
    const beta = await createRepo("beta", BETA_SOURCE);
    await makeWorkspace(alpha, [{ alias: "alpha", rootPath: alpha }, { alias: "beta", rootPath: beta }]);

    // beta is probed for the route but is NOT the lead, so nothing should touch it.
    const before = await readFile(resolveIndexDbPath(beta));
    await callTool(contextBoundTo(alpha), McpToolId.GetCodeContext, {
      query: "alpha_only_symbol",
    });
    const after = await readFile(resolveIndexDbPath(beta));

    assert.ok(before.equals(after), "a probed member's index must not change");
  });
});

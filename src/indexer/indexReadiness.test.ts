import { afterAll, describe, expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { initRepo } from "../setup/initRepo";
import { readRepoLocalState } from "../setup/repoState";
import { inspectIndexFreshness } from "../runtime/indexFreshness";
import {
  evaluateIndexReadiness,
  inspectWorktreeIndexFreshness,
  summarizeIndexReadiness,
  withRuntimeSignals,
  type IndexReadiness,
} from "./indexReadiness";
import { resolveIndexMetaPath, type IndexMeta } from "./indexMeta";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeIndexedRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "m141-readiness-"));
  roots.push(root);
  await writeFile(path.join(root, "alpha.py"), "def alpha():\n    return 1\n");
  await writeFile(path.join(root, "beta.py"), "from alpha import alpha\n\n\ndef beta():\n    return alpha()\n");
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["-C", root, "add", "-A"]);
  await execFile("git", [
    "-C", root, "-c", "user.email=m141@test", "-c", "user.name=m141", "commit", "-qm", "init",
  ]);
  await initRepo({ repoPath: root });
  return root;
}

async function patchMeta(root: string, mutate: (meta: IndexMeta) => void): Promise<void> {
  const metaPath = resolveIndexMetaPath(root);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as IndexMeta;
  mutate(meta);
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

/** The `index_status` verdict, computed exactly as the MCP tool computes it. */
async function statusVerdict(root: string, readiness: IndexReadiness) {
  const state = await readRepoLocalState(path.join(root, ".vtrace", "state.json")).catch(() => undefined);
  return inspectIndexFreshness({
    repoRoot: root,
    ...(state?.lastIndexSnapshot === undefined ? {} : { lastIndexSnapshot: state.lastIndexSnapshot }),
    ...(state?.observedFileChanges === undefined ? {} : { observedFileChanges: state.observedFileChanges }),
    ...(state?.fileWatcher === undefined ? {} : { fileWatcher: state.fileWatcher }),
    readiness: summarizeIndexReadiness(readiness),
  });
}

describe("M141 index readiness", () => {
  test("a freshly indexed repo is ready on every dimension", async () => {
    const root = await makeIndexedRepo();
    const readiness = await evaluateIndexReadiness(root, { probe: "full" });

    expect(readiness.ready).toBe(true);
    expect(readiness.state).toBe("ready");
    expect(readiness.reason).toBe("fresh");
    expect(readiness.recommendedAction).toBe("none");
    expect(readiness.sourceFresh).toBe(true);
    expect(readiness.schemaCompatible).toBe(true);
    expect(readiness.capabilityCompatible).toBe(true);
    expect(readiness.repositoryCompatible).toBe(true);
    expect(readiness.worktreeCompatible).toBe(true);
    expect(readiness.failedDimensions).toEqual([]);
  });

  test("post-index status and the product path agree the index is ready", async () => {
    const root = await makeIndexedRepo();
    const readiness = await evaluateIndexReadiness(root, { probe: "full" });
    const status = await statusVerdict(root, readiness);

    expect(readiness.ready).toBe(true);
    expect(status.isStale).toBe(false);
    expect(status.state).toBe("fresh");
    expect(readiness.freshness.status).toBe("fresh");
  });

  test("source freshness is separate from schema compatibility", async () => {
    // The exact real-world contradiction: VTRACE's own indexer/parser moved,
    // the indexed repository did not. Source is fresh; the index is unusable.
    const root = await makeIndexedRepo();
    await patchMeta(root, (meta) => {
      meta.parser_fingerprint = "0".repeat(64);
      meta.manifest.index.parserVersion = "0".repeat(64);
    });
    const readiness = await evaluateIndexReadiness(root, { probe: "full" });

    expect(readiness.sourceFresh).toBe(true);
    expect(readiness.schemaCompatible).toBe(false);
    expect(readiness.ready).toBe(false);
    expect(readiness.state).toBe("schema_incompatible");
    // M146-A: the state still says the index cannot be consumed, but the reason
    // now names the actual cause. Nothing about the stored SCHEMA moved here —
    // the parser did — and `index_status` renders this reason to the user.
    expect(readiness.reason).toBe("derivation_changed");
    expect(readiness.recommendedAction).toBe("full_rebuild");
  });

  test("index_status no longer reports fresh for a schema-incompatible index", async () => {
    const root = await makeIndexedRepo();
    await patchMeta(root, (meta) => {
      meta.parser_fingerprint = "0".repeat(64);
      meta.manifest.index.parserVersion = "0".repeat(64);
    });
    const readiness = await evaluateIndexReadiness(root, { probe: "full" });
    const status = await statusVerdict(root, readiness);
    const productSide = await inspectWorktreeIndexFreshness(root);

    // Pre-M141 this asserted the defect: state "fresh", isStale false.
    expect(status.state).toBe("possibly_stale");
    expect(status.isStale).toBe(true);
    expect(status.reasons.map((reason) => reason.code)).toContain("index_derivation_incompatible");
    expect(status.recommendedAction).toContain("Rebuild");
    expect(productSide.status).not.toBe("fresh");
    // The pre-M141 legacy freshness contract is deliberately untouched by the
    // M146-A reason split: product tools still see exactly what they always did.
    expect(productSide.reason).toBe("index_schema_changed");
  });

  test("an index written by a newer runtime asks for a runtime upgrade, not a rebuild", async () => {
    const root = await makeIndexedRepo();
    await patchMeta(root, (meta) => {
      meta.index_format_version += 1;
      meta.manifest.schemaVersion += 1;
      meta.manifest.index.indexSchemaVersion += 1;
    });
    const readiness = await evaluateIndexReadiness(root);

    expect(readiness.schemaCompatible).toBe(false);
    expect(readiness.reason).toBe("schema_unsupported");
    expect(readiness.recommendedAction).toBe("unsupported_runtime_upgrade");
  });

  test("a HEAD move is source staleness an incremental refresh can resolve", async () => {
    const root = await makeIndexedRepo();
    await writeFile(path.join(root, "gamma.py"), "def gamma():\n    return 3\n");
    await execFile("git", ["-C", root, "add", "-A"]);
    await execFile("git", [
      "-C", root, "-c", "user.email=m141@test", "-c", "user.name=m141", "commit", "-qm", "second",
    ]);
    const readiness = await evaluateIndexReadiness(root);

    expect(readiness.sourceFresh).toBe(false);
    expect(readiness.schemaCompatible).toBe(true);
    expect(readiness.state).toBe("source_stale");
    expect(readiness.reason).toBe("head_changed");
    expect(readiness.recommendedAction).toBe("incremental_refresh");
  });

  test("an uncommitted edit at the same HEAD is a dirty-fingerprint change", async () => {
    const root = await makeIndexedRepo();
    await writeFile(path.join(root, "alpha.py"), "def alpha():\n    return 2\n");
    const readiness = await evaluateIndexReadiness(root);

    expect(readiness.sourceFresh).toBe(false);
    expect(readiness.reason).toBe("dirty_fingerprint_changed");
    expect(readiness.recommendedAction).toBe("incremental_refresh");
    expect(readiness.freshness.reason).toBe("working_tree_changed");
  });

  test("a missing index is index_missing, not source staleness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "m141-empty-"));
    roots.push(root);
    await execFile("git", ["init", "-q", root]);
    const readiness = await evaluateIndexReadiness(root, { probe: "full" });

    expect(readiness.state).toBe("index_missing");
    expect(readiness.reason).toBe("index_missing");
    expect(readiness.ready).toBe(false);
    expect(readiness.freshness.reason).toBe("missing_index");
  });

  test("an unreadable index database is corrupt, not stale", async () => {
    const root = await makeIndexedRepo();
    await writeFile(path.join(root, ".vtrace", "index.sqlite"), "this is not a sqlite database");
    const readiness = await evaluateIndexReadiness(root, { probe: "full" });

    expect(readiness.state).toBe("index_corrupt");
    expect(readiness.reason).toBe("index_unreadable");
    expect(readiness.recommendedAction).toBe("full_rebuild");
  });

  test("an unreadable manifest is corrupt, not stale", async () => {
    const root = await makeIndexedRepo();
    await writeFile(resolveIndexMetaPath(root), "{ not json");
    const readiness = await evaluateIndexReadiness(root);

    expect(readiness.state).toBe("index_corrupt");
    expect(readiness.reason).toBe("index_unreadable");
    expect(readiness.freshness.reason).toBe("manifest_invalid");
  });

  test("an index built for another repository is refused with wrong_repository", async () => {
    const root = await makeIndexedRepo();
    await patchMeta(root, (meta) => {
      meta.manifest.repository.repositoryId = "someotherrepository00000";
    });
    const readiness = await evaluateIndexReadiness(root);

    expect(readiness.repositoryCompatible).toBe(false);
    expect(readiness.state).toBe("repository_mismatch");
    expect(readiness.reason).toBe("wrong_repository");
    expect(readiness.recommendedAction).toBe("inspect_index");
    expect(readiness.freshness.status).toBe("blocked");
  });

  test("an index built for another worktree is refused with wrong_worktree", async () => {
    const root = await makeIndexedRepo();
    await patchMeta(root, (meta) => {
      meta.manifest.worktree.worktreeId = "someotherworktree0000000";
    });
    const readiness = await evaluateIndexReadiness(root);

    expect(readiness.repositoryCompatible).toBe(true);
    expect(readiness.worktreeCompatible).toBe(false);
    expect(readiness.state).toBe("worktree_mismatch");
    expect(readiness.reason).toBe("wrong_worktree");
    expect(readiness.freshness.reason).toBe("worktree_mismatch");
  });

  test("capability compatibility is evaluated only against declared requirements", async () => {
    const root = await makeIndexedRepo();
    const base = await evaluateIndexReadiness(root, { probe: "full" });
    const withCallSites = await evaluateIndexReadiness(root, {
      probe: "full",
      requiredCapabilities: ["edge_call_sites"],
    });

    expect(base.capabilities.available?.edge_call_sites).toBe(true);
    expect(base.capabilities.required).toEqual([]);
    expect(withCallSites.capabilityCompatible).toBe(true);
    expect(withCallSites.ready).toBe(true);
  });

  test("a required capability the index lacks yields capability_incompatible", async () => {
    const root = await makeIndexedRepo();
    // An older index predating M131's call-site table: structurally readable,
    // source-fresh, but unable to serve call-site evidence.
    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(root, ".vtrace", "index.sqlite"));
    db.exec("DROP TABLE IF EXISTS edge_call_sites");
    db.close();

    const readiness = await evaluateIndexReadiness(root, {
      probe: "full",
      requiredCapabilities: ["edge_call_sites"],
    });

    expect(readiness.sourceFresh).toBe(true);
    expect(readiness.schemaCompatible).toBe(true);
    expect(readiness.capabilityCompatible).toBe(false);
    expect(readiness.state).toBe("capability_incompatible");
    expect(readiness.reason).toBe("capability_missing");
    expect(readiness.capabilities.missing).toEqual(["edge_call_sites"]);

    // M131 preserved older-index support: a tool that does not declare the
    // capability still sees a ready index. The difference is explicit.
    const withoutRequirement = await evaluateIndexReadiness(root, { probe: "full" });
    expect(withoutRequirement.ready).toBe(true);
    expect(withoutRequirement.capabilities.available?.edge_call_sites).toBe(false);
  });

  test("runtime signals downgrade a ready index consistently for both surfaces", async () => {
    const root = await makeIndexedRepo();
    const base = await evaluateIndexReadiness(root);

    const drifted = withRuntimeSignals(base, { observedSourceChanges: true });
    expect(drifted.ready).toBe(false);
    expect(drifted.state).toBe("source_stale");
    expect(drifted.freshness.reason).toBe("working_tree_changed");

    const emptied = withRuntimeSignals(base, { indexHasNoFiles: true });
    expect(emptied.state).toBe("index_missing");
    expect(emptied.freshness.reason).toBe("missing_index");
  });

  test("the readiness summary stays compact and never embeds the manifest", async () => {
    const root = await makeIndexedRepo();
    const summary = summarizeIndexReadiness(await evaluateIndexReadiness(root, { probe: "full" }));

    expect(Object.keys(summary).sort()).toEqual([
      "capabilityCompatible",
      // M156: coverage rides alongside readiness as its own axis. Two scalars,
      // not a list of paths — the bound is what keeps this summary compact.
      "coverageComplete",
      "failedFiles",
      "missingCapabilities",
      "ready",
      "reason",
      "recommendedAction",
      "repositoryCompatible",
      "schemaCompatible",
      "sourceFresh",
      "state",
      "worktreeCompatible",
    ].sort());
    expect(JSON.stringify(summary).length).toBeLessThan(400);
  });
});

// M145 §130-§134: real-repository workspace acceptance.
//
// Synthetic collisions prove the resolvers behave; they cannot prove that a real
// workspace leaves real retrieval alone. This registers ARC and TCKDB side by
// side and re-runs each repository's own queries under explicit routing, then
// compares them byte for byte against the same queries with no workspace
// present at all.
//
// The structural reason the comparison holds is worth stating rather than
// assuming: retrieval takes a database handle and a repository root, and no
// workspace input reaches it. Registering a second repository therefore has no
// channel through which to change an A-routed answer. This run is what turns
// that from an argument into a measurement.
//
// HYGIENE. Both checkouts are opened READ-ONLY, and the workspace config is
// written to a temporary directory outside both source trees — §136 and §175
// exist because a config dropped into ARC's `.vtrace` would dirty a user
// repository and, worse, become indexable source.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { evaluateIndexReadiness, summarizeIndexReadiness } from "../../src/indexer/indexReadiness";
import { CapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { listAllFilePaths } from "../../src/db/repositories/filesRepository";
import { createPathMembershipResolver, PathMembershipStatus } from "../../src/workspace/pathMembership";
import { evaluateWorkspaceReadiness } from "../../src/workspace/readiness";
import {
  captureRepoIdentityRecord,
  resolveWorkspaceRegistry,
  routeWorkspaceRequest,
  workspaceMembershipScopes,
  type WorkspaceRouteResult,
} from "../../src/workspace/registry";
import { WORKSPACE_CONFIG_SCHEMA_VERSION, writeWorkspaceConfig } from "../../src/workspace/config";

const ARC_ROOT = path.resolve(process.env.M145_ARC_ROOT ?? "/home/calvin/code/ARC");
const TCKDB_ROOT = path.resolve(process.env.M145_TCKDB_ROOT ?? "/home/calvin/code/TCKDB_v2");

/** ARC's standing behavioural queries, plus TCKDB's acceptance query. */
const QUERIES = [
  { repo: "arc", task: "how does ARC compute a dihedral angle", intent: CapsuleIntent.Explain },
  { repo: "arc", task: "how does ARC restore an ARCSpecies from a dictionary", intent: CapsuleIntent.Explain },
  { repo: "arc", task: "how does ARC build a molecule from xyz coordinates", intent: CapsuleIntent.Explain },
  { repo: "arc", task: "how does ARC perceive a molecule from xyz", intent: CapsuleIntent.Explain },
  { repo: "tckdb", task: "how does TCKDB validate a species entry", intent: CapsuleIntent.Explain },
  { repo: "tckdb", task: "how are TCKDB reactions stored", intent: CapsuleIntent.Explain },
] as const;

/** Generic names both corpora use — the cross-collision control of §133. */
const COLLIDING_TERMS = ["Species", "Reaction", "calculation"] as const;

interface CapsuleShape {
  readonly lead: string | null;
  readonly selectedFiles: readonly string[];
  readonly roles: readonly string[];
  readonly contentModes: readonly string[];
  readonly estimatedTokens: number | null;
}

/** The model-visible shape: what was selected, in what role, at what size. */
function shapeOf(capsule: CapsuleV2Result): CapsuleShape {
  const items = [...capsule.pivots, ...capsule.support];
  return {
    lead: items[0]?.fq_name ?? null,
    selectedFiles: items.map((item) => item.path),
    roles: items.map((item) => `${item.role}:${item.selection_role ?? item.role_reason}`),
    contentModes: items.map((item) => item.content_mode),
    estimatedTokens: items.reduce((total, item) => total + item.estimated_tokens, 0),
  };
}

function isFailure(route: WorkspaceRouteResult): route is Extract<WorkspaceRouteResult, { ok: false }> {
  return route.ok === false;
}

function openIndex(repoRoot: string): Database {
  return new Database(path.join(repoRoot, ".vtrace", "index.sqlite"), { readonly: true });
}

async function main(): Promise<void> {
  const outDir = path.resolve(process.argv[2] ?? "benchmarks/stage5_vexp_swe_bench_smoke/results");
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "m145-real-ws-"));
  const arcDb = openIndex(ARC_ROOT);
  const tckdbDb = openIndex(TCKDB_ROOT);

  try {
    // ----- alone: no workspace config exists anywhere -----
    const alone = new Map<string, CapsuleShape>();
    for (const query of QUERIES) {
      const db = query.repo === "arc" ? arcDb : tckdbDb;
      const root = query.repo === "arc" ? ARC_ROOT : TCKDB_ROOT;
      alone.set(query.task, shapeOf(await buildCapsuleV2({
        db,
        repoRoot: root,
        task: query.task,
        intent: query.intent,
        maxTokens: 3000,
      })));
    }

    // ----- registered side by side -----
    const configPath = path.join(workspaceDir, ".vtrace", "workspace.json");
    const config = await writeWorkspaceConfig(configPath, {
      schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
      primaryRepoAlias: "arc",
      repos: [
        { alias: "arc", rootPath: ARC_ROOT, enabled: true, ...(await captureRepoIdentityRecord(ARC_ROOT)) },
        { alias: "tckdb", rootPath: TCKDB_ROOT, enabled: true, ...(await captureRepoIdentityRecord(TCKDB_ROOT)) },
      ],
    });
    const registry = await resolveWorkspaceRegistry({ config });
    const readiness = await evaluateWorkspaceReadiness(registry);

    const routed = new Map<string, CapsuleShape>();
    const routes: Array<{ repo: string; alias: string | null; source: string | null; worktreeId: string | null }> = [];
    for (const query of QUERIES) {
      const route = routeWorkspaceRequest(registry, { alias: query.repo });
      if (isFailure(route)) {
        throw new Error(`explicit route to ${query.repo} failed: ${route.reason}`);
      }
      routes.push({
        repo: query.repo,
        alias: route.repository.alias,
        source: route.source,
        worktreeId: route.repository.worktreeId,
      });
      const db = route.repository.alias === "arc" ? arcDb : tckdbDb;
      routed.set(query.task, shapeOf(await buildCapsuleV2({
        db,
        repoRoot: route.repository.rootPath,
        task: query.task,
        intent: query.intent,
        maxTokens: 3000,
      })));
    }

    const comparisons = QUERIES.map((query) => {
      const before = alone.get(query.task)!;
      const after = routed.get(query.task)!;
      return {
        repo: query.repo,
        task: query.task,
        identical: JSON.stringify(before) === JSON.stringify(after),
        lead: after.lead,
        selectedFiles: after.selectedFiles,
        estimatedTokens: after.estimatedTokens,
      };
    });

    // ----- membership isolation across the two real corpora -----
    const arcPaths = listAllFilePaths(arcDb);
    const tckdbPaths = listAllFilePaths(tckdbDb);
    const pathsByRoot = new Map<string, readonly string[]>([
      [ARC_ROOT, arcPaths],
      [TCKDB_ROOT, tckdbPaths],
    ]);
    const scopes = workspaceMembershipScopes(registry, (repo) => () => pathsByRoot.get(repo.rootPath) ?? []);
    const arcWorktreeId = registry.repositories.find((repo) => repo.alias === "arc")!.worktreeId!;
    const resolver = createPathMembershipResolver(scopes, arcWorktreeId);

    // Paths only one corpus owns must resolve to exactly that corpus.
    const arcOnly = arcPaths.filter((candidate) => !tckdbPaths.includes(candidate)).slice(0, 25);
    const tckdbOnly = tckdbPaths.filter((candidate) => !arcPaths.includes(candidate)).slice(0, 25);
    const shared = arcPaths.filter((candidate) => tckdbPaths.includes(candidate));

    const arcOnlyCorrect = arcOnly.filter((candidate) => {
      const resolution = resolver.resolve(candidate);
      return resolution.worktreeId === arcWorktreeId
        && resolution.status === PathMembershipStatus.UniqueResolved;
    }).length;
    const tckdbOnlyNotArc = tckdbOnly.filter((candidate) => {
      const resolution = resolver.resolve(candidate);
      return resolution.worktreeId !== arcWorktreeId;
    }).length;
    const sharedAmbiguous = shared.slice(0, 25).filter((candidate) => (
      resolver.resolve(candidate).status === PathMembershipStatus.Ambiguous
    )).length;

    // Generic type names live in both corpora; explicit routing keeps them apart.
    const collisionRows = COLLIDING_TERMS.map((term) => ({
      term,
      arcHits: countSymbol(arcDb, term),
      tckdbHits: countSymbol(tckdbDb, term),
    }));

    // §112/§113: what does M145 code say about an index written before it?
    const compatibility = await Promise.all([ARC_ROOT, TCKDB_ROOT].map(async (root) => {
      const summary = summarizeIndexReadiness(await evaluateIndexReadiness(root, { probe: "full" }));
      return {
        root,
        ready: summary.ready,
        state: summary.state,
        reason: summary.reason,
        recommendedAction: summary.recommendedAction,
        // The identity dimensions must stay TRUE: a manifest written before
        // instance evidence existed makes no claim, and silence must not refute.
        repositoryCompatible: summary.repositoryCompatible,
        worktreeCompatible: summary.worktreeCompatible,
        schemaCompatible: summary.schemaCompatible,
      };
    }));

    const allIdentical = comparisons.every((row) => row.identical);
    const output = {
      schemaVersion: "stage5.m145.real-repo-acceptance.v1",
      pass: allIdentical
        && arcOnlyCorrect === arcOnly.length
        && tckdbOnlyNotArc === tckdbOnly.length
        && sharedAmbiguous === Math.min(shared.length, 25)
        // Identity must not be what refuses an old index; schema may be.
        && compatibility.every((row) => row.repositoryCompatible && row.worktreeCompatible),
      note: "Retrieval takes (db, repoRoot) and no workspace input; this run measures that a registered second repository leaves every A-routed answer byte-identical.",
      workspace: {
        workspaceId: registry.workspaceId,
        configPath,
        insideSourceTrees: configPath.startsWith(ARC_ROOT) || configPath.startsWith(TCKDB_ROOT),
        members: registry.repositories.map((repo) => ({
          alias: repo.alias,
          rootPath: repo.rootPath,
          repositoryId: repo.repositoryId,
          worktreeId: repo.worktreeId,
          registration: repo.registration,
        })),
        readiness: {
          total: readiness.total,
          ready: readiness.ready,
          stale: readiness.stale,
          missing: readiness.missing,
          repos: readiness.repos.map((repo) => ({
            alias: repo.alias,
            ready: repo.ready,
            state: repo.index?.state ?? null,
            registration: repo.registration,
          })),
        },
      },
      routes,
      equivalence: {
        queries: comparisons.length,
        identical: comparisons.filter((row) => row.identical).length,
        rows: comparisons,
      },
      membershipIsolation: {
        arcIndexedFiles: arcPaths.length,
        tckdbIndexedFiles: tckdbPaths.length,
        sharedRelativePaths: shared.length,
        arcOnlySampled: arcOnly.length,
        arcOnlyResolvedToArc: arcOnlyCorrect,
        tckdbOnlySampled: tckdbOnly.length,
        tckdbOnlyNotResolvedToArc: tckdbOnlyNotArc,
        sharedSampled: Math.min(shared.length, 25),
        sharedReportedAmbiguous: sharedAmbiguous,
      },
      crossCollision: collisionRows,
      indexCompatibility: {
        note: "M145 edited src/indexer, so indexer_fingerprint moved and pre-M145 indexes are schema_incompatible -> full_rebuild. No silent reinterpretation, and the identity dimensions stay true because an old manifest carries no instance evidence to contradict.",
        rows: compatibility,
      },
    };

    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, "stage5_m145_arc_workspace_acceptance.json"),
      `${JSON.stringify({ ...output, focus: "arc" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(outDir, "stage5_m145_tckdb_workspace_acceptance.json"),
      `${JSON.stringify({ ...output, focus: "tckdb" }, null, 2)}\n`,
      "utf8",
    );

    process.stdout.write(
      `m145 real-repo acceptance: pass=${output.pass} identical=${output.equivalence.identical}/${output.equivalence.queries} `
      + `sharedPaths=${shared.length} arcOnly=${arcOnlyCorrect}/${arcOnly.length}\n`,
    );
    if (!output.pass) process.exitCode = 1;
  } finally {
    arcDb.close();
    tckdbDb.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

function countSymbol(db: Database, name: string): number {
  const row = db.query("SELECT count(*) AS hits FROM symbols WHERE local_name = ?").get(name) as { hits: number } | null;
  return row?.hits ?? 0;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

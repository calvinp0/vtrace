// M141 Workstream C — memory-rule evaluation cost.
//
// `memoryRulesMs` was ~40% of a real ARC request (2.17s of 5.45s; 6.9s of a
// larger one measured during M141). Profiling showed it was not memory
// classification: `getObservationStaleness` re-walked the whole index-run chain
// per observation, materializing every run's file and symbol run-state tables
// again each time. These tests pin the two properties that make it bounded —
// expensive discovery is O(1) per request, and the verdicts are unchanged —
// rather than pinning a millisecond number.

import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openIndexerDatabase } from "../db/sqlite";
import { createTestProductStores } from "../testing/productStores";
import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import { listObservations, persistObservation } from "../session/repositories/observationsRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { indexProject } from "../indexer/indexProject";
import { ObservationKind, ObservationSource } from "./types";
import { searchMemory } from "./searchMemory";
import {
  createObservationStalenessCache,
  getObservationStaleness,
} from "./staleness";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const FILES = ["mod_a.py", "mod_b.py"] as const;

/** A module whose functions change body text on every generation. */
function moduleSource(fileName: string, symbolCount: number, generation: number): string {
  const lines: string[] = [];
  for (let index = 0; index < symbolCount; index += 1) {
    // A slice of the symbols changes each generation, so the run diffs are real.
    const value = index % 5 === 0 ? generation : 0;
    lines.push(`def ${path.basename(fileName, ".py")}_symbol_${index}():`);
    lines.push(`    return ${value}`);
    lines.push("");
  }
  return lines.join("\n");
}

interface Fixture {
  readonly db: Database;
  /**
   * Both stores. The query counter below instruments the INDEX handle only,
   * which is exactly what M141 measures: run-chain discovery behind staleness.
   * Loading the observations themselves is a session read and legitimately O(N).
   */
  readonly stores: ReturnType<typeof createTestProductStores>;
  readonly repoRoot: string;
  readonly latestRunId: number;
  queries(): number;
  reset(): void;
  close(): void;
}

async function buildFixture(input: {
  runCount: number;
  symbolsPerFile: number;
  observationCount: number;
}): Promise<Fixture> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "m141-memscale-"));
  roots.push(repoRoot);
  const db = openIndexerDatabase();
  const stores = createTestProductStores(db);

  for (let generation = 1; generation <= input.runCount; generation += 1) {
    for (const fileName of FILES) {
      await writeFile(
        path.join(repoRoot, fileName),
        moduleSource(fileName, input.symbolsPerFile, generation),
      );
    }
    await indexProject({ repoRoot, db });
  }

  const symbolIds = FILES
    .flatMap((fileName) => listSymbolsForFile(db, fileName).map((symbol) => symbol.id));

  for (let index = 0; index < input.observationCount; index += 1) {
    persistObservation(stores, {
      repoRoot,
      sessionId: "m141-session",
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: `alpha finding ${index}`,
      body: "alpha body",
      createdAtMs: 1_000 + index,
      sourceRunId: 1,
      linkedFilePaths: [...FILES],
      // Enough links per observation that per-link scanning of the run diffs is
      // measurable — the shape the real ARC index has (1,471 symbol links).
      linkedSymbolIds: symbolIds.slice(index % 4, (index % 4) + 8),
    });
  }

  let queries = 0;
  const original = db.query.bind(db);
  (db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
    queries += 1;
    return original(sql);
  };

  return {
    db,
    stores,
    repoRoot,
    latestRunId: getLatestIndexRun(db)!.id,
    queries: () => queries,
    reset: () => { queries = 0; },
    close: () => stores.close(),
  };
}

describe("M141 memory-rule scaling", () => {
  test("expensive index discovery is O(1) in the number of observations", async () => {
    const counts = [1, 10, 40];
    const measured: Array<{ observations: number; queries: number }> = [];

    for (const observationCount of counts) {
      const fixture = await buildFixture({ runCount: 5, symbolsPerFile: 60, observationCount });
      fixture.reset();
      searchMemory(fixture.stores, { query: "alpha", maxResults: 5 });
      measured.push({ observations: observationCount, queries: fixture.queries() });
      fixture.close();
    }

    // Loading the observations themselves is legitimately O(N). The run-chain
    // discovery behind staleness must not be: before M141 it added roughly 37
    // queries per observation on the real ARC index.
    const growthPerObservation = (measured.at(-1)!.queries - measured[0]!.queries)
      / (counts.at(-1)! - counts[0]!);
    expect(growthPerObservation).toBeLessThan(4);
  }, 60_000);

  test("the run-diff memo does not change any staleness verdict", async () => {
    const fixture = await buildFixture({ runCount: 5, symbolsPerFile: 60, observationCount: 30 });
    const observations = listObservations(fixture.stores.session);

    const uncached = observations.map((observation) => (
      getObservationStaleness(fixture.db, observation, fixture.latestRunId)
    ));
    const cache = createObservationStalenessCache();
    const cached = observations.map((observation) => (
      getObservationStaleness(fixture.db, observation, fixture.latestRunId, cache)
    ));

    expect(JSON.stringify(cached)).toBe(JSON.stringify(uncached));
    // The comparison must actually have found staleness, or this proves nothing.
    expect(uncached.some((entry) => entry.reasons.length > 0)).toBe(true);
    fixture.close();
  }, 60_000);

  test("skipping staleness for non-matching observations preserves the result set", async () => {
    const fixture = await buildFixture({ runCount: 3, symbolsPerFile: 40, observationCount: 20 });

    // "zeta" matches nothing, so no observation may survive; "alpha finding 3"
    // matches, and its staleness must be resolved exactly as before.
    expect(searchMemory(fixture.stores, { query: "zeta", maxResults: 10 })).toEqual([]);
    const matched = searchMemory(fixture.stores, { query: "alpha finding 3", maxResults: 10 });
    expect(matched.length).toBeGreaterThan(0);
    for (const result of matched) {
      expect(result.staleness.observationId).toBe(result.observation.id);
      expect(result.staleness.comparisonRunId).toBe(fixture.latestRunId);
    }
    fixture.close();
  }, 60_000);
});

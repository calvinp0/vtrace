import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";

import { initializeSchema } from "../db/schema";
import { buildSyntheticGraph, type SyntheticGraphSpec } from "../graph/syntheticGraphFixture";
import { searchLogicFlow, type LogicFlowOutput } from "./searchLogicFlow";

/**
 * Scale-sensitive and metamorphic tests for flow traversal.
 *
 * These are deliberately NOT more syntax fixtures. M130's defect survived a full
 * suite of syntax fixtures because it only appeared above a size threshold none
 * of them crossed. The properties asserted here are the ones that class of bug
 * violates:
 *
 *   - the answer is invariant to unrelated graph growth
 *   - the answer is invariant to storage/insertion order
 *   - short-path work stays bounded as the graph grows
 *   - a bound that bites is reported as a bound, never as "no path"
 */

async function withSyntheticGraph<T>(
  spec: SyntheticGraphSpec,
  body: (db: Database, graph: ReturnType<typeof buildSyntheticGraph>) => T,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vtrace-flow-scale-"));
  const db = new Database(path.join(directory, "index.sqlite"));

  try {
    initializeSchema(db);
    return body(db, buildSyntheticGraph(db, spec));
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function requireOutput(result: ReturnType<typeof searchLogicFlow>): LogicFlowOutput {
  if (result.ok === false) {
    throw new Error(`Expected a flow result, got ${result.error.code}: ${result.error.message}`);
  }
  return result.output;
}

/** The parts of a flow result that must never move for a given graph. */
function semanticShape(output: LogicFlowOutput): unknown {
  return {
    reachable: output.summary.reachable,
    shortestPathEdgeCount: output.summary.shortestPathEdgeCount,
    traversalLimitReached: output.summary.traversalLimitReached,
    paths: output.paths.map((flowPath) => ({
      nodes: flowPath.nodes.map((node) => node.fqName),
      steps: flowPath.steps.map((step) => [step.edgeType, step.fromFqName, step.toFqName]),
    })),
  };
}

test("a one-edge synthetic path is found in a small graph", async () => {
  await withSyntheticGraph({ totalEdges: 20 }, (db, graph) => {
    const output = requireOutput(searchLogicFlow(db, {
      start: graph.startFqName,
      end: graph.endFqName,
      maxPaths: 3,
    }));

    assert.equal(output.summary.reachable, true);
    assert.equal(output.summary.shortestPathEdgeCount, 1);
    assert.equal(output.paths[0]?.steps.length, 1);
    assert.equal(output.paths[0]?.steps[0]?.edgeType, "calls");
  });
});

test("10k unrelated edges do not change a one-edge result, wherever the edge is stored", async () => {
  const positions = ["first", "middle", "last", "interleaved", "shuffled"] as const;
  const shapes: unknown[] = [];

  for (const plantedPosition of positions) {
    // eslint-disable-next-line no-await-in-loop -- fixtures are intentionally sequential
    const shape = await withSyntheticGraph({ totalEdges: 12_000, plantedPosition, seed: 7 }, (db, graph) => {
      const output = requireOutput(searchLogicFlow(db, {
        start: graph.startFqName,
        end: graph.endFqName,
        maxPaths: 3,
      }));

      assert.equal(output.diagnostics.edgesAvailable >= 10_000, true);
      assert.equal(output.summary.reachable, true);
      assert.equal(output.summary.shortestPathEdgeCount, 1);
      assert.equal(output.summary.traversalLimitReached, false);
      return semanticShape(output);
    });

    shapes.push(shape);
  }

  for (const shape of shapes.slice(1)) {
    assert.deepEqual(shape, shapes[0], "storage order changed the semantic result");
  }
});

test("a short path in a 100k-edge graph does not load the graph", async () => {
  await withSyntheticGraph({ totalEdges: 100_000, plantedPosition: "middle" }, (db, graph) => {
    const output = requireOutput(searchLogicFlow(db, {
      start: graph.startFqName,
      end: graph.endFqName,
      maxPaths: 3,
    }));

    assert.equal(output.summary.reachable, true);
    assert.equal(output.summary.shortestPathEdgeCount, 1);
    assert.equal(output.diagnostics.edgesAvailable >= 100_000, true);

    // The whole point of M131: work tracks the explored subgraph. A one-edge
    // answer must not touch a meaningful fraction of a 100k-edge repository.
    assert.equal(
      output.diagnostics.traversal.edgesFetched < 1_000,
      true,
      `fetched ${output.diagnostics.traversal.edgesFetched} edges for a one-edge path`,
    );
    assert.equal(output.diagnostics.edgesInspected < 1_000, true);
    assert.equal(output.diagnostics.traversal.mode, "indexed_frontier_expansion");
    assert.equal(output.diagnostics.traversal.frontierBatches <= 4, true);
  });
});

test("explored work stays flat as the surrounding graph grows 50x", async () => {
  const measurements: Array<{ totalEdges: number; fetched: number; relaxed: number; queries: number }> = [];

  for (const totalEdges of [2_000, 20_000, 100_000]) {
    // eslint-disable-next-line no-await-in-loop -- fixtures are intentionally sequential
    const measurement = await withSyntheticGraph({ totalEdges, plantedPosition: "middle" }, (db, graph) => {
      const output = requireOutput(searchLogicFlow(db, {
        start: graph.startFqName,
        end: graph.endFqName,
        maxPaths: 3,
      }));
      assert.equal(output.summary.reachable, true);
      assert.equal(output.summary.shortestPathEdgeCount, 1);
      return {
        totalEdges: output.diagnostics.edgesAvailable,
        fetched: output.diagnostics.traversal.edgesFetched,
        relaxed: output.diagnostics.traversal.edgesRelaxed,
        queries: output.diagnostics.traversal.dbQueries,
      };
    });

    measurements.push(measurement);
  }

  const smallest = measurements[0]!;
  const largest = measurements[measurements.length - 1]!;

  assert.equal(largest.totalEdges / smallest.totalEdges >= 40, true, "fixture did not actually grow");
  // Not a claim of O(1) — a claim that unrelated size does not dominate.
  assert.equal(largest.fetched <= smallest.fetched * 2, true, `fetched grew ${smallest.fetched} -> ${largest.fetched}`);
  assert.equal(largest.relaxed <= smallest.relaxed * 2, true, `relaxed grew ${smallest.relaxed} -> ${largest.relaxed}`);
  assert.equal(largest.queries <= smallest.queries * 2, true, `queries grew ${smallest.queries} -> ${largest.queries}`);
},
// This test asserts WORK -- edges fetched, edges relaxed, queries issued -- and
// none of those depend on the clock. What does take time is its fixtures: three
// synthetic graphs totalling 122,000 edges, which on a contended machine sit
// either side of bun's 5 s default and made the suite fail for a reason the test
// is not about. The budget is explicit so a real regression in the measured
// quantities is still what fails it.
30_000);

test("a frontier that outgrows the budget reports the budget, not a missing path", async () => {
  await withSyntheticGraph(
    { totalEdges: 6_000, plantedPathLength: 3, startFanOut: 400, plantedPosition: "last" },
    (db, graph) => {
      const starved = requireOutput(searchLogicFlow(db, {
        start: graph.startFqName,
        end: graph.endFqName,
        maxPaths: 3,
        maxEdges: 5,
      }));

      assert.equal(starved.summary.reachable, false);
      assert.equal(starved.summary.traversalLimitReached, true);
      assert.equal(starved.diagnostics.traversal.budgetExhausted, true);
      assert.equal(starved.diagnostics.traversal.budgetLimit, 5);
      // The distinction the product depends on: an exhausted budget is a
      // statement about the search, never about the graph.
      assert.equal(starved.diagnostics.edgesInspected <= 5, true);

      const funded = requireOutput(searchLogicFlow(db, {
        start: graph.startFqName,
        end: graph.endFqName,
        maxPaths: 3,
      }));

      assert.equal(funded.summary.reachable, true);
      assert.equal(funded.summary.traversalLimitReached, false);
      assert.equal(funded.summary.shortestPathEdgeCount, 3);
    },
  );
});

test("two resolved endpoints with no connecting path report no path and no budget claim", async () => {
  await withSyntheticGraph({ totalEdges: 5_000, plantedPosition: "middle" }, (db, graph) => {
    // Search backwards along the planted edge: both endpoints resolve, and the
    // directed graph genuinely holds no path in that direction.
    const output = requireOutput(searchLogicFlow(db, {
      start: graph.endFqName,
      end: graph.startFqName,
      maxPaths: 3,
    }));

    assert.equal(output.summary.reachable, false);
    assert.equal(output.summary.shortestPathEdgeCount, null);
    assert.equal(output.summary.traversalLimitReached, false);
    assert.equal(output.diagnostics.traversal.budgetExhausted, false);
    assert.equal(
      output.coverage.notes.some((note) => note.includes("cannot prove two endpoints are unconnected")),
      true,
    );
  });
});

test("repeated identical queries return byte-identical results", async () => {
  await withSyntheticGraph({ totalEdges: 20_000, plantedPosition: "shuffled", seed: 42 }, (db, graph) => {
    const runs = [0, 1, 2].map(() => JSON.stringify(requireOutput(searchLogicFlow(db, {
      start: graph.startFqName,
      end: graph.endFqName,
      maxPaths: 5,
    }))));

    assert.equal(runs[1], runs[0]);
    assert.equal(runs[2], runs[0]);
  });
});

test("the traversal budget bounds work, never graph membership", async () => {
  await withSyntheticGraph({ totalEdges: 50_000, plantedPosition: "last" }, (db, graph) => {
    // A budget far below the graph size still finds a one-edge path: the bound
    // is on relaxation, not on which edges exist. Before M130 this exact shape
    // returned "not connected".
    const output = requireOutput(searchLogicFlow(db, {
      start: graph.startFqName,
      end: graph.endFqName,
      maxPaths: 3,
      maxEdges: 50,
    }));

    assert.equal(output.summary.reachable, true);
    assert.equal(output.summary.shortestPathEdgeCount, 1);
    assert.equal(output.summary.traversalLimitReached, false);
    assert.equal(output.diagnostics.edgesAvailable >= 50_000, true);
  });
});

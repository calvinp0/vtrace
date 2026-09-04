import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { getImpactGraph, type ImpactGraphOutput } from "./getImpactGraph";
import { compactImpactProductResponse } from "./impactResponseEnvelope";
import {
  IMPACT_CONTINUATION_ERROR,
  decodeImpactContinuation,
  encodeImpactContinuation,
  IMPACT_CONTINUATION_VERSION,
  IMPACT_ORDERING_AUTHORITY,
} from "./impactContinuation";

/**
 * M211: the census answers "how much impact exists" and the projection answers
 * "how much of it should be read now". These tests exist to keep those two
 * questions from collapsing back into one, which is what they were before M211:
 * `summary.consumers` counted the delivered slice, so a symbol with 40 callers
 * reported the value of `max_edges`.
 */

const TARGET = "src/hub.ts::hub";

test("census counts the whole universe while the projection is bounded by max_edges", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const wide = requireImpact(db, repoRoot, { maxEdges: 2_000 });
      const narrow = requireImpact(db, repoRoot, { maxEdges: 5 });

      // F1: the census is identical either side; only the render moves.
      assert.equal(narrow.impactCensus.directRelations, wide.impactCensus.directRelations);
      assert.equal(narrow.impactCensus.exactCallers, wide.impactCensus.exactCallers);
      assert.equal(narrow.impactCensus.resolvedCallers, wide.impactCensus.resolvedCallers);
      assert.equal(narrow.impactCensus.affectedFiles, wide.impactCensus.affectedFiles);

      assert.equal(narrow.directRelations.length, 5);
      assert.ok(wide.directRelations.length > narrow.directRelations.length);
      // The census exceeds what the narrow response could render, which is the
      // whole point: before M211 these two numbers were the same number.
      assert.ok(narrow.impactCensus.directRelations > narrow.directRelations.length);
    } finally {
      db.close();
    }
  });
});

test("summary.consumers reports the universe, not the delivered slice", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const narrow = requireImpact(db, repoRoot, { maxEdges: 3 });
      const wide = requireImpact(db, repoRoot, { maxEdges: 2_000 });

      assert.equal(narrow.summary.consumers.exactCallerCount, wide.summary.consumers.exactCallerCount);
      assert.equal(
        narrow.summary.consumers.exactCallerCount,
        narrow.impactCensus.exactCallers + narrow.impactCensus.resolvedCallers,
      );
      assert.ok(narrow.summary.consumers.exactCallerCount > narrow.directRelations.length);
    } finally {
      db.close();
    }
  });
});

test("census is invariant across every evidence budget", async () => {
  await withFanoutFixture(24, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const censuses = [400, 1_200, 4_000, 20_000].map((maxTokens) =>
        JSON.stringify(compactImpactProductResponse(requireImpact(db, repoRoot, { maxTokens })).impactCensus));
      assert.equal(new Set(censuses).size, 1, "census moved with the evidence budget");
    } finally {
      db.close();
    }
  });
});

test("a zero-impact symbol gets a zero census, no continuation and no filler", async () => {
  await withFanoutFixture(4, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const result = getImpactGraph(db, { symbolFqn: "src/orphan.ts::orphan", depth: 3, format: "list" }, { repoRoot });
      assert.equal(result.ok, true);
      if (result.ok !== true) return;
      const response = compactImpactProductResponse(result.output);

      assert.equal(response.impactCensus.directRelations, 0);
      assert.equal(response.impactCensus.exactCallers, 0);
      assert.equal(response.impactCensus.affectedFiles, 0);
      assert.equal(response.directRelations.length, 0);
      // §17: an exhausted stream is never handed a ref that would expand to nothing.
      assert.equal(response.continuation, null);
    } finally {
      db.close();
    }
  });
});

test("every rendered relation is in the census universe, exactly once", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const universe = new Set(requireImpact(db, repoRoot, { maxEdges: 2_000 }).directRelations.map((relation) => relation.id));
      const response = compactImpactProductResponse(requireImpact(db, repoRoot, {}));
      const rendered = response.directRelations.map((relation) => relation.id);

      assert.equal(new Set(rendered).size, rendered.length, "a relation was rendered twice");
      for (const id of rendered) assert.ok(universe.has(id), `rendered relation ${id} is not in the census universe`);
    } finally {
      db.close();
    }
  });
});

test("rendered relations keep the epistemic class the universe gave them", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const universe = new Map(requireImpact(db, repoRoot, { maxEdges: 2_000 })
        .directRelations.map((relation) => [relation.id, relation]));
      const response = compactImpactProductResponse(requireImpact(db, repoRoot, {}));

      for (const relation of response.directRelations) {
        const truth = universe.get(relation.id);
        assert.ok(truth !== undefined);
        assert.equal(relation.strength, truth.strength, "projection changed a relation's strength");
        assert.equal(relation.kind, truth.kind, "projection changed a relation's kind");
        assert.equal(relation.direction, truth.direction, "projection changed a relation's direction");
      }
    } finally {
      db.close();
    }
  });
});

test("continuation reconciles: offset + delivered + remaining equals the census total", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const response = compactImpactProductResponse(requireImpact(db, repoRoot, {}));
      const handle = response.continuation;
      assert.ok(handle !== null, "40 relations do not fit the default budget, so a handle is owed");

      assert.equal(handle.delivered, response.directRelations.length);
      assert.ok(handle.remaining >= 0);
      assert.equal(handle.offset + handle.delivered + handle.remaining, handle.total);
      assert.equal(handle.total, response.impactCensus.directRelations);
    } finally {
      db.close();
    }
  });
});

test("continuation pages concatenate to the prefix of one canonical stream", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const canonical = requireImpact(db, repoRoot, { maxEdges: 2_000 }).directRelations.map((relation) => relation.id);

      const walked: string[] = [];
      let ref: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const result = getImpactGraph(
          db,
          { symbolFqn: TARGET, depth: 3, format: "list", ...(ref === undefined ? {} : { continuationRef: ref }) },
          { repoRoot },
        );
        assert.equal(result.ok, true);
        if (result.ok !== true) return;
        const response = compactImpactProductResponse(result.output);
        walked.push(...response.directRelations.map((relation) => relation.id));
        if (response.continuation === null) break;
        ref = response.continuation.ref;
      }

      assert.ok(walked.length > 1, "pagination delivered nothing beyond the first page");
      assert.equal(new Set(walked).size, walked.length, "a relation appeared on two pages");
      assert.deepEqual(walked, canonical.slice(0, walked.length), "pages are not the prefix of the canonical stream");
    } finally {
      db.close();
    }
  });
});

test("expansion is identical for a fresh database handle: no hidden call state", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const first = openIndexerDatabase();
    let ref: string;
    let expectedIds: string[];
    try {
      await indexProject({ repoRoot, db: first });
      const page1 = compactImpactProductResponse(requireImpact(first, repoRoot, {}));
      assert.ok(page1.continuation !== null);
      ref = page1.continuation.ref;
      const page2 = getImpactGraph(first, { symbolFqn: TARGET, depth: 3, format: "list", continuationRef: ref }, { repoRoot });
      assert.equal(page2.ok, true);
      if (page2.ok !== true) return;
      expectedIds = page2.output.directRelations.map((relation) => relation.id);
    } finally {
      first.close();
    }

    // A second process would hold no memory of the first. The nearest reachable
    // equivalent in-test is a database handle that never saw the minting call.
    const second = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db: second });
      const again = getImpactGraph(second, { symbolFqn: TARGET, depth: 3, format: "list", continuationRef: ref }, { repoRoot });
      assert.equal(again.ok, true);
      if (again.ok !== true) return;
      assert.deepEqual(again.output.directRelations.map((relation) => relation.id), expectedIds);
    } finally {
      second.close();
    }
  });
});

test("a tampered, malformed or out-of-scope continuation ref fails closed", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const handle = compactImpactProductResponse(requireImpact(db, repoRoot, {})).continuation;
      assert.ok(handle !== null);
      const good = handle.ref;

      const reasonFor = (ref: string, overrides: Record<string, unknown> = {}): string => {
        const result = getImpactGraph(
          db,
          { symbolFqn: TARGET, depth: 3, format: "list", continuationRef: ref, ...overrides },
          { repoRoot },
        );
        assert.equal(result.ok, false, "an invalid continuation ref was accepted");
        if (result.ok !== false) return "";
        assert.equal(result.error.code, "invalid_continuation");
        return String(result.error.details.reason);
      };

      assert.equal(reasonFor(`${good.slice(0, -3)}AAA`), IMPACT_CONTINUATION_ERROR.Tampered);
      assert.equal(reasonFor("not-a-ref"), IMPACT_CONTINUATION_ERROR.Malformed);
      assert.equal(reasonFor(good.split(".")[0]!), IMPACT_CONTINUATION_ERROR.Malformed);
      // Same target, different universe: the cursor would index into a stream
      // that was never the one it was minted over.
      assert.equal(reasonFor(good, { depth: 5 }), IMPACT_CONTINUATION_ERROR.ScopeMismatch);
      assert.equal(reasonFor(good, { direction: "downstream" }), IMPACT_CONTINUATION_ERROR.ScopeMismatch);
    } finally {
      db.close();
    }
  });
});

test("a continuation ref minted against another index revision is refused", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const handle = compactImpactProductResponse(requireImpact(db, repoRoot, {})).continuation;
      assert.ok(handle !== null);
      const decoded = decodeImpactContinuation(handle.ref);
      assert.equal(decoded.ok, true);
      if (decoded.ok !== true) return;

      // Re-index: a new index run, same source. The stream may be identical, but
      // the ref no longer speaks for the revision it was minted against, and §25
      // requires that to be a refusal rather than a lucky agreement.
      await indexProject({ repoRoot, db });
      const result = getImpactGraph(db, { symbolFqn: TARGET, depth: 3, format: "list", continuationRef: handle.ref }, { repoRoot });
      assert.equal(result.ok, false);
      if (result.ok !== false) return;
      assert.equal(result.error.details.reason, IMPACT_CONTINUATION_ERROR.StaleIndex);
    } finally {
      db.close();
    }
  });
});

test("a ref whose cursor outruns the stream is refused rather than silently truncated", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const truth = requireImpact(db, repoRoot, { maxEdges: 2_000 });
      const forged = encodeImpactContinuation({
        version: IMPACT_CONTINUATION_VERSION,
        indexRunId: indexRunIdOf(db),
        symbolId: truth.resolvedSymbol.symbolId,
        symbolFqn: truth.resolvedSymbol.fqName,
        depth: 3,
        direction: "both",
        relations: null,
        includeLexical: false,
        includeUnresolved: false,
        ordering: IMPACT_ORDERING_AUTHORITY,
        after: truth.impactCensus.directRelations + 10,
        afterRelationId: null,
      });
      const result = getImpactGraph(db, { symbolFqn: TARGET, depth: 3, format: "list", continuationRef: forged }, { repoRoot });
      assert.equal(result.ok, false);
      if (result.ok !== false) return;
      assert.equal(result.error.details.reason, IMPACT_CONTINUATION_ERROR.StreamShifted);
    } finally {
      db.close();
    }
  });
});

test("representation degrades from the tail, so the head keeps its source line", async () => {
  await withFanoutFixture(40, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const response = compactImpactProductResponse(requireImpact(db, repoRoot, {}));
      const carries = response.directRelations.map((relation) =>
        (relation.evidence.sourceText ?? "").trim().length > 0);

      // Whatever the budget affords, source lines are held by a PREFIX. The old
      // cliff produced all-or-nothing; a gap here would mean a relation kept its
      // line while an earlier, higher-authority one lost it.
      const firstWithout = carries.indexOf(false);
      if (firstWithout >= 0) {
        assert.ok(
          carries.slice(firstWithout).every((value) => value === false),
          "source lines are not held by a prefix of the projection",
        );
      }
    } finally {
      db.close();
    }
  });
});

test("counting does not render: a wide universe does not hydrate a wide excerpt set", async () => {
  await withFanoutFixture(60, async (repoRoot) => {
    const db = openIndexerDatabase();
    try {
      await indexProject({ repoRoot, db });
      const response = requireImpact(db, repoRoot, { maxEdges: 4 });

      // The census saw every relation; only the delivered ones carry evidence.
      assert.ok(response.impactCensus.directRelations >= 60);
      assert.equal(response.directRelations.length, 4);
      const hydrated = response.directRelations.filter((relation) =>
        (relation.evidence.sourceText ?? "").length > 0).length;
      assert.ok(hydrated > 0, "the delivered relations should still be hydrated");
    } finally {
      db.close();
    }
  });
});

function indexRunIdOf(db: ReturnType<typeof openIndexerDatabase>): number | null {
  const row = db.query("SELECT id FROM index_runs ORDER BY id DESC LIMIT 1").get() as { id: number } | null;
  return row === null ? null : row.id;
}

function requireImpact(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  overrides: { maxEdges?: number; maxTokens?: number },
): ImpactGraphOutput {
  const result = getImpactGraph(db, { symbolFqn: TARGET, depth: 3, format: "list", ...overrides }, { repoRoot });
  assert.equal(result.ok, true, `impact graph failed for ${TARGET}`);
  if (result.ok !== true) throw new Error("unreachable");
  return result.output;
}

/**
 * A hub called from `callers` distinct files, so the direct relation universe is
 * genuinely larger than any default budget can render — the shape §28 asks for
 * and the one the ARC corpus exhibits naturally.
 */
async function withFanoutFixture(callers: number, run: (repoRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-m211-"));
  const repoRoot = path.join(root, "repo");
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "hub.ts"),
      ["export function hub(value: string): string {", "  return `hub:${value}`;", "}", ""].join("\n"),
    );
    await writeFile(
      path.join(repoRoot, "src", "orphan.ts"),
      ["export function orphan(): number {", "  return 0;", "}", ""].join("\n"),
    );
    for (let index = 0; index < callers; index += 1) {
      await writeFile(
        path.join(repoRoot, "src", `caller${String(index).padStart(3, "0")}.ts`),
        [
          "import { hub } from \"./hub\";",
          "",
          `export function caller${index}(): string {`,
          `  return hub("caller-${index}");`,
          "}",
          "",
        ].join("\n"),
      );
    }
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

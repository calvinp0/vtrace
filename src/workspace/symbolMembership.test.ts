/**
 * M147 §47 — the membership probe's two access paths must agree exactly.
 *
 * A presence proof is only as good as the answer it consumes. Two properties
 * have to hold, and neither may be assumed from how the query was written:
 *
 *   NO FALSE NEGATIVES. Every name the repository actually defines must report
 *   present. One false negative is one false uniqueness claim, because a rival
 *   owner would be recorded as proven absent.
 *
 *   PATH EQUIVALENCE. An index carrying the name access path and one without it
 *   must return the same answer for the same question. Only latency may differ.
 *
 * The second is checked against a real index with the access path added and
 * removed underneath the same probe, over that repository's entire name
 * population — not a sample chosen to pass.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";

import { resolveIndexDbPath } from "../indexer/indexMeta";
import { initRepo } from "../setup/initRepo";
import { MembershipAccessPath } from "./repositoryPresence";
import { createDatabaseProbe } from "./repositoryRelevance";
import { cleanupWorkspaceFixtures, makeFixtureRepo, makeWorkspaceRoot } from "./workspaceFixture";

afterAll(cleanupWorkspaceFixtures);

const NAME_ACCESS_PATH_DDL = [
  "CREATE INDEX IF NOT EXISTS idx_symbols_local_name ON symbols(local_name)",
  "CREATE INDEX IF NOT EXISTS idx_symbols_fq_name ON symbols(fq_name)",
] as const;

const NAME_ACCESS_PATH_INDEXES = ["idx_symbols_local_name", "idx_symbols_fq_name"] as const;

/**
 * A repository with enough distinct names for the population sweep to mean
 * something, in the state that predates the access path.
 *
 * M148-A made the migration part of the index lifecycle, so a freshly indexed
 * repository now arrives ALREADY migrated. That is the product improvement, and
 * it is exactly what these controls must undo: the property under test is that
 * the two access modes agree, which needs a database in each mode.
 */

async function membershipRepo(): Promise<string> {
  const root = await makeWorkspaceRoot("m147-membership-");
  const files: Record<string, string> = {};
  for (let module = 0; module < 6; module += 1) {
    const lines: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      lines.push(`class Widget${module}_${index}:`);
      lines.push(`    def render_${module}_${index}(self):`);
      lines.push(`        return ${index}`);
      lines.push(`def helper_${module}_${index}():`);
      lines.push(`    return ${index}`);
    }
    files[`src/mod_${module}.py`] = `${lines.join("\n")}\n`;
  }
  const repoRoot = await makeFixtureRepo(path.join(root, "repo"), { files });
  await initRepo({ repoPath: repoRoot });
  const db = new Database(resolveIndexDbPath(repoRoot));
  try {
    for (const name of NAME_ACCESS_PATH_INDEXES) db.run(`DROP INDEX IF EXISTS ${name}`);
  } finally {
    db.close();
  }
  return repoRoot;
}

function allNames(db: Database): string[] {
  return (db.query("SELECT local_name AS n FROM symbols UNION SELECT fq_name FROM symbols").all() as Array<{ n: string }>)
    .map((row) => row.n);
}

describe("M147 exact-name membership", () => {
  test("neither access path ever answers 'absent' for a name the repository defines", async () => {
    const repoRoot = await membershipRepo();
    const db = new Database(resolveIndexDbPath(repoRoot));
    const names = allNames(db);
    expect(names.length).toBeGreaterThan(200);

    const probeBefore = createDatabaseProbe(db);
    expect(probeBefore.membershipAccessPath!()).toBe(MembershipAccessPath.Fallback);
    const missedOnFallback = names.filter((name) => !probeBefore.hasExactSymbol(name));

    for (const statement of NAME_ACCESS_PATH_DDL) db.run(statement);

    const probeAfter = createDatabaseProbe(db);
    expect(probeAfter.membershipAccessPath!()).toBe(MembershipAccessPath.Indexed);
    const missedOnIndexed = names.filter((name) => !probeAfter.hasExactSymbol(name));

    // Zero BY CONSTRUCTION for both: the proof rests on this, so it is measured
    // over the whole population rather than argued from the SQL.
    expect(missedOnFallback).toEqual([]);
    expect(missedOnIndexed).toEqual([]);
    db.close();
  }, 60_000);

  test("both access paths return identical answers across the whole name population", async () => {
    const repoRoot = await membershipRepo();
    const db = new Database(resolveIndexDbPath(repoRoot));
    const names = allNames(db);
    // Names the repository does NOT define, including near-misses that share a
    // prefix with real ones — the shapes most likely to expose a plan that
    // matched on something other than equality.
    const absent = [
      ...names.slice(0, 50).map((name) => `${name}_absent`),
      ...names.slice(0, 50).map((name) => name.toUpperCase()),
      ...Array.from({ length: 50 }, (_, index) => `ZzNeverDefined_${index}`),
      "", " ", "%", "_", "Widget%", "helper_0_%",
    ];
    const questions = [...names, ...absent];

    const fallbackProbe = createDatabaseProbe(db);
    expect(fallbackProbe.membershipAccessPath!()).toBe(MembershipAccessPath.Fallback);
    const fallbackAnswers = questions.map((name) => fallbackProbe.hasExactSymbol(name));

    for (const statement of NAME_ACCESS_PATH_DDL) db.run(statement);

    const indexedProbe = createDatabaseProbe(db);
    expect(indexedProbe.membershipAccessPath!()).toBe(MembershipAccessPath.Indexed);
    const indexedAnswers = questions.map((name) => indexedProbe.hasExactSymbol(name));

    expect(indexedAnswers).toEqual(fallbackAnswers);
    // And the sweep actually exercised both outcomes, so agreeing on "always
    // false" could not pass it.
    expect(fallbackAnswers.filter(Boolean).length).toBe(names.length);
    expect(fallbackAnswers.filter((hit) => !hit).length).toBe(absent.length);
    db.close();
  }, 60_000);

  test("a fully-qualified name resolves on the same terms as a simple one", async () => {
    const repoRoot = await membershipRepo();
    const db = new Database(resolveIndexDbPath(repoRoot));
    const fqNames = (db.query("SELECT DISTINCT fq_name AS n FROM symbols LIMIT 40").all() as Array<{ n: string }>)
      .map((row) => row.n);

    const before = createDatabaseProbe(db);
    const fallback = fqNames.map((name) => before.hasExactSymbol(name));
    for (const statement of NAME_ACCESS_PATH_DDL) db.run(statement);
    const after = createDatabaseProbe(db);

    expect(fqNames.map((name) => after.hasExactSymbol(name))).toEqual(fallback);
    expect(fallback.every(Boolean)).toBe(true);
    db.close();
  }, 60_000);

  test("the reported access path describes the database, not the configuration", async () => {
    const repoRoot = await membershipRepo();
    const db = new Database(resolveIndexDbPath(repoRoot));

    expect(createDatabaseProbe(db).membershipAccessPath!()).toBe(MembershipAccessPath.Fallback);

    // One half of the access path is not the access path: a router bounding its
    // cost on "indexed" must not be told so until both lookups are keyed.
    db.run(NAME_ACCESS_PATH_DDL[0]);
    expect(createDatabaseProbe(db).membershipAccessPath!()).toBe(MembershipAccessPath.Fallback);

    db.run(NAME_ACCESS_PATH_DDL[1]);
    expect(createDatabaseProbe(db).membershipAccessPath!()).toBe(MembershipAccessPath.Indexed);
    db.close();
  }, 60_000);
});

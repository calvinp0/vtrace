/**
 * M200 — P1..P14 package-surface fixtures: expected behaviour AND full-build
 * equality (§15, §26, §47).
 *
 * Two claims per fixture, and they are separate on purpose.
 *
 *   BEHAVIOUR — did the planner reach the stated conclusion for the stated
 *   reason. A fixture that reaches the right graph by rebuilding when it should
 *   have bounded is not a pass; nor is one that bounds when it should have
 *   refused.
 *
 *   EQUIVALENCE — is the incrementally refreshed index identical to a clean
 *   rebuild of the same final tree, across every projected table including the
 *   three M200 added. This is the claim that survives if the behaviour
 *   classification is ever wrong, so it is asserted for EVERY fixture, including
 *   the ones that legitimately fall back (§26).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m200_package_equivalence.ts \
 *     [--scratch <dir>] [--out <name>] [--only P4,P9]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { indexProject } from "../../src/indexer/indexProject";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { compareProjections, fullSemanticProjection } from "./m199Equivalence";
import { PACKAGE_FIXTURES, writeFixtureState, writePadding, type PackageFixture } from "./m200PackageFixtures";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m200-pkg"));
const OUT = argOf("--out", "stage5_m200_package_equivalence.json");
const ONLY = argOf("--only", "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
mkdirSync(SCRATCH, { recursive: true });

const PARSER = { parserVersion: "builtin-parser-v1" };

function openDb(root: string): Database {
  mkdirSync(path.join(root, ".vtrace"), { recursive: true });
  return openIndexerDatabase(path.join(root, ".vtrace", "index.sqlite"));
}

function freshRoot(tag: string): string {
  const root = path.join(SCRATCH, tag);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

/** File-to-file edges, the surface a stale resolution would show up in. */
function fileEdges(db: Database): Set<string> {
  const rows = db.query(`
    SELECT sf.path AS src, tf.path AS dst FROM edges e
    JOIN symbols s ON s.id = e.src_symbol_id JOIN files sf ON sf.id = s.file_id
    JOIN symbols t ON t.id = e.dst_symbol_id JOIN files tf ON tf.id = t.file_id
    WHERE sf.path <> tf.path`).all() as { src: string; dst: string }[];
  return new Set(rows.map((row) => `${row.src} -> ${row.dst}`));
}

function descriptorRows(db: Database): Set<string> {
  const rows = db.query(`
    SELECT file_path, requested_module, relative_level, resolved_target_path
    FROM import_descriptors`).all() as
    { file_path: string; requested_module: string; relative_level: number; resolved_target_path: string | null }[];
  return new Set(rows.map((row) =>
    `${row.file_path}|${row.requested_module}|${row.relative_level}|${row.resolved_target_path ?? ""}`));
}

/** The final tree: `before` with `after` applied. */
function finalState(fixture: PackageFixture): Record<string, string> {
  const merged: Record<string, string> = { ...fixture.before };
  for (const [relative, content] of Object.entries(fixture.after)) {
    if (content === null) delete merged[relative];
    else merged[relative] = content;
  }
  return merged;
}

const results: unknown[] = [];
let behaviourFailures = 0;
let equivalenceFailures = 0;

for (const fixture of PACKAGE_FIXTURES) {
  if (ONLY.length > 0 && !ONLY.includes(fixture.id)) continue;

  // --- incremental arm: cold index the BEFORE tree, then refresh onto AFTER.
  const incrementalRoot = freshRoot(`inc-${fixture.id}`);
  writeFixtureState(incrementalRoot, fixture.before);
  writePadding(incrementalRoot);
  const incrementalDb = openDb(incrementalRoot);
  const cold: any = await indexProject({ repoRoot: incrementalRoot, db: incrementalDb, ...PARSER });
  writeFixtureState(incrementalRoot, fixture.after);
  for (const [relative, content] of Object.entries(fixture.after)) {
    if (content === null) rmSync(path.join(incrementalRoot, relative), { force: true });
  }
  const refresh: any = await indexProject({
    repoRoot: incrementalRoot, db: incrementalDb,
    previousSnapshot: cold.snapshot, hasExistingGraph: true, ...PARSER,
  });
  const incrementalProjection = fullSemanticProjection(incrementalDb);
  const incrementalEdges = fileEdges(incrementalDb);
  const incrementalDescriptors = descriptorRows(incrementalDb);
  incrementalDb.close();

  // --- rebuild arm: cold index the FINAL tree, nothing incremental about it.
  const rebuildRoot = freshRoot(`full-${fixture.id}`);
  writeFixtureState(rebuildRoot, finalState(fixture));
  writePadding(rebuildRoot);
  const rebuildDb = openDb(rebuildRoot);
  await indexProject({ repoRoot: rebuildRoot, db: rebuildDb, ...PARSER });
  const rebuildProjection = fullSemanticProjection(rebuildDb);
  const rebuildEdges = fileEdges(rebuildDb);
  rebuildDb.close();

  const comparison = compareProjections(incrementalProjection, rebuildProjection);
  const closure = refresh.performance?.bindingClosure ?? null;
  const mode = refresh.performance?.mode;

  // --- behaviour checks, each named so a failure says which claim broke.
  const checks: { id: string; ok: boolean; detail: string }[] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  check("surface_change_detected",
    fixture.expect.surfaceChanged === (closure !== null),
    `expected surfaceChanged=${fixture.expect.surfaceChanged}, closure ${closure === null ? "absent" : "present"}`);
  check("plan_mode", mode === fixture.expect.plan, `${mode} (expected ${fixture.expect.plan})`);
  if (fixture.expect.refusal !== undefined) {
    check("refusal", closure?.refusal === fixture.expect.refusal,
      `${closure?.refusal ?? "none"} (expected ${fixture.expect.refusal})`);
  }
  for (const required of fixture.expect.closureIncludes ?? []) {
    check(`closure_includes:${required}`,
      (closure?.closureFiles ?? []).includes(required),
      (closure?.closureFiles ?? []).join(", ") || "(none)");
  }
  for (const forbidden of fixture.expect.closureExcludes ?? []) {
    check(`closure_excludes:${forbidden}`,
      !(closure?.closureFiles ?? []).includes(forbidden),
      (closure?.closureFiles ?? []).join(", ") || "(none)");
  }
  // Edge claims are asserted on BOTH arms: an edge the rebuild does not have
  // either is a fixture that describes something other than what it says.
  for (const [src, dst] of fixture.expect.edgesAfter ?? []) {
    check(`edge:${src}->${dst}`,
      incrementalEdges.has(`${src} -> ${dst}`) && rebuildEdges.has(`${src} -> ${dst}`),
      `incremental=${incrementalEdges.has(`${src} -> ${dst}`)} rebuild=${rebuildEdges.has(`${src} -> ${dst}`)}`);
  }
  for (const [src, dst] of fixture.expect.edgesAbsentAfter ?? []) {
    check(`edge_absent:${src}->${dst}`,
      !incrementalEdges.has(`${src} -> ${dst}`) && !rebuildEdges.has(`${src} -> ${dst}`),
      `incremental=${incrementalEdges.has(`${src} -> ${dst}`)} rebuild=${rebuildEdges.has(`${src} -> ${dst}`)}`);
  }
  for (const [file, module, level, target] of fixture.expect.descriptorsInclude ?? []) {
    const key = `${file}|${module}|${level}|${target ?? ""}`;
    check(`descriptor:${key}`, incrementalDescriptors.has(key), incrementalDescriptors.has(key) ? "present" : "absent");
  }

  const behaviourOk = checks.every((c) => c.ok);
  if (!behaviourOk) behaviourFailures += 1;
  if (!comparison.equal) equivalenceFailures += 1;

  results.push({
    id: fixture.id, title: fixture.title, rationale: fixture.rationale,
    expected: fixture.expect,
    observed: {
      mode, fallbackReason: refresh.performance?.fallbackReason ?? null,
      parsedFiles: refresh.performance?.parsedFiles, bindingClosure: closure,
    },
    behaviour: { ok: behaviourOk, checks },
    equivalence: {
      equal: comparison.equal, normalizedGraphHashEqual: comparison.normalizedGraphHashEqual,
      unequalSections: comparison.sections.filter((s) => !s.equal),
    },
  });
  console.log(`${behaviourOk && comparison.equal ? "PASS" : "FAIL"}  ${fixture.id.padEnd(4)} `
    + `${fixture.title.padEnd(34)} mode=${String(mode).padEnd(13)} `
    + `closure=${closure === null ? "-" : (closure.refusal ?? `${closure.closureFiles.length} files`)} `
    + `equal=${comparison.equal}`
    + (behaviourOk ? "" : `  ← ${checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join("; ")}`));
}

const payload = {
  milestone: "M200", purpose: "P1..P14 package-surface behaviour and full/incremental equality",
  generatedFromCommit: (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim(),
  fixtures: results.length, behaviourFailures, equivalenceFailures,
  verdict: behaviourFailures === 0 && equivalenceFailures === 0 ? "PASS" : "FAIL",
  results,
};
writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\n${results.length} fixtures, ${behaviourFailures} behaviour failure(s), `
  + `${equivalenceFailures} equivalence failure(s) -> ${payload.verdict}`);
console.log(`wrote results/${OUT}`);

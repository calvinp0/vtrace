/**
 * M190-A — freeze the held-out replication stratum.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_manifest.ts
 *
 * M190 is an OUT-OF-SAMPLE REPLICATION of the frozen M189 I5 derivation, and the only thing
 * that makes it one is that membership of the held-out set is decided from committed M189
 * artifacts BEFORE any held-out outcome is scored. This script is therefore deliberately
 * dumb: it reads two immutable files, subtracts one from the other, and hashes the result.
 *
 * HELD-OUT MEMBERSHIP (§8). An arm is held out when
 *
 *   1. M189-A certified it I5-usable  (stage5_m189_corpus_ledger.jsonl, usableForI5), and
 *   2. it does NOT appear in M189-B's end-to-end analysis
 *      (stage5_m189_decision_points.jsonl, keyed on rawDir), and
 *   3. it does not appear in M189-B's skip list (stage5_m189_skipped.json — empty, checked).
 *
 * Membership is decided from ARTIFACTS, never from the filesystem. `treeFor()` in the M189
 * driver answers "is this instance indexed RIGHT NOW", and M190 is about to index the very
 * instances that predicate excludes; deriving membership from it would let the held-out set
 * dissolve the moment the milestone did its work. The committed decision-point file is the
 * record of what M189 actually saw, and it cannot move.
 *
 * §8's fourth condition — "not used to inspect/tune the DEPENDENCIES derivation" — is
 * implied by (2): M189 §4 records that the pilot which motivated the DEPENDENCIES arm ran
 * over the first 78 arms of the M183-plus-I6 stratum, every one of which is inside the 866.
 *
 * The manifest is the denominator for the rest of the milestone. §9: an arm that later
 * proves unanalysable stays in it and receives an exclusion reason; it is never swapped out.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const M189_FUNCTIONAL_SHA = "12a1056e8f5e2e3319440d6c884eaf1c616c678e";
const M189_EVIDENCE_SHA = "dc66a9afe17fbcec4f4ebd65ebbc5aa17dcd901f";
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const BENCH_REPOS = "/home/calvin/code/vexp-swe-bench/.bench-repos";
const TREES = "/home/calvin/.cache/m189_trees";

/**
 * The freeze, recorded mechanically (§3). These are git blob ids of the load-bearing M189
 * derivation as committed at the evidence SHA, taken with `git rev-parse HEAD:<path>` rather
 * than transcribed, so a reviewer can re-derive them and a silent edit to the derivation
 * between the freeze and the replication cannot pass unnoticed.
 */
const FROZEN_DERIVATION_FILES = [
  "benchmarks/stage5_vexp_swe_bench_smoke/m189Evidence.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/m189Evidence.test.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_corpus.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_mechanism.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_specimens.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_controls.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/stage5_task_derivation.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/validationExecution.ts",
  "src/impact/getImpactGraph.ts",
] as const;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

const frozenBlobs = Object.fromEntries(
  FROZEN_DERIVATION_FILES.map((f) => [f, git("rev-parse", `${M189_EVIDENCE_SHA}:${f}`)]),
);

interface LedgerRow {
  readonly runLabel: string; readonly family: string; readonly rawDir: string;
  readonly month: string; readonly model: string;
  readonly instanceId: string; readonly repo: string; readonly baseCommit: string;
  readonly resolved: boolean;
  readonly usableForI5: boolean; readonly usableForI6: boolean;
}

const ledger: LedgerRow[] = readFileSync(path.join(RESULTS, "stage5_m189_corpus_ledger.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerRow);

const analysedRawDirs = new Set<string>(
  readFileSync(path.join(RESULTS, "stage5_m189_decision_points.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { rawDir: string }).rawDir),
);

const skipList = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m189_skipped.json"), "utf8")) as {
  skipped: { runLabel: string; why: string }[];
};
for (const s of skipList.skipped) {
  // M189-B skipped nothing; if that ever changes, a skipped arm was still EXPOSED to the
  // derivation and must not be laundered into the replication set.
  for (const r of ledger) if (r.runLabel === s.runLabel) analysedRawDirs.add(r.rawDir);
}

/** Can the base tree be materialised at all? Recorded now so §9's exclusion reasons are
 *  attributable to corpus state rather than to whatever happened during indexing. */
const benchRepoDir = (repo: string): string => path.join(BENCH_REPOS, repo.replace("/", "__"));

const heldOut = ledger
  .filter((r) => r.usableForI5 && !analysedRawDirs.has(r.rawDir))
  .map((r) => {
    const repoDir = benchRepoDir(r.repo);
    const repoPresent = existsSync(repoDir);
    return {
      rawDir: r.rawDir,
      runLabel: r.runLabel,
      family: r.family,
      month: r.month,
      model: r.model,
      instanceId: r.instanceId,
      repo: r.repo,
      baseCommit: r.baseCommit,
      resolved: r.resolved,
      usableForI5: r.usableForI5,
      usableForI6: r.usableForI6,
      heldOutReason: "I5_USABLE_NOT_IN_M189_MECHANISM_ANALYSIS",
      benchRepoPresent: repoPresent,
      indexPresentAtFreeze: existsSync(path.join(TREES, r.instanceId, ".m189_indexed")),
    };
  })
  .sort((a, b) => (a.rawDir < b.rawDir ? -1 : a.rawDir > b.rawDir ? 1 : 0));

// The fingerprint covers exactly the identity of the stratum: which arms, at which base
// revision. It deliberately does NOT cover `resolved`, so a reader can verify the manifest
// without the outcome column and see that membership never consulted it.
const fingerprintBody = heldOut.map((a) => `${a.rawDir}\t${a.instanceId}\t${a.baseCommit}`).join("\n");
const manifestHash = createHash("sha256").update(`${fingerprintBody}\n`).digest("hex");

const tasks = new Set(heldOut.map((a) => a.instanceId));
const repos = new Set(heldOut.map((a) => a.repo));
const analysedRows = ledger.filter((r) => analysedRawDirs.has(r.rawDir));

const manifest = {
  milestone: "M190",
  purpose: "out-of-sample replication stratum for the frozen M189 I5 derivation",
  frozenDerivation: {
    m189FunctionalSha: M189_FUNCTIONAL_SHA,
    m189EvidenceSha: M189_EVIDENCE_SHA,
    blobIds: frozenBlobs,
    blobSetHash: createHash("sha256")
      .update(`${Object.entries(frozenBlobs).map(([f, id]) => `${id}  ${f}`).join("\n")}\n`)
      .digest("hex"),
  },
  membershipRule: {
    include: "stage5_m189_corpus_ledger.jsonl :: usableForI5 === true",
    exclude: "rawDir present in stage5_m189_decision_points.jsonl (the 866 arms M189-B analysed)",
    excludeAlso: "runLabel present in stage5_m189_skipped.json (empty in M189)",
    decidedFrom: "committed M189 artifacts only; never the current filesystem",
  },
  corpus: {
    ledgerArms: ledger.length,
    i5UsableArms: ledger.filter((r) => r.usableForI5).length,
    m189AnalysedArms: analysedRawDirs.size,
    m189AnalysedTasks: new Set(analysedRows.map((r) => r.instanceId)).size,
    m189AnalysedRepos: new Set(analysedRows.map((r) => r.repo)).size,
  },
  heldOut: {
    arms: heldOut.length,
    tasks: tasks.size,
    repositories: repos.size,
    failures: heldOut.filter((a) => !a.resolved).length,
    successes: heldOut.filter((a) => a.resolved).length,
    repositoriesList: [...repos].sort(),
    tasksNewToM190: [...tasks].filter((t) => !new Set(analysedRows.map((r) => r.instanceId)).has(t)).sort(),
    reposNewToM190: [...repos].filter((t) => !new Set(analysedRows.map((r) => r.repo)).has(t)).sort(),
    benchRepoMissing: heldOut.filter((a) => !a.benchRepoPresent).length,
    alreadyIndexedAtFreeze: heldOut.filter((a) => a.indexPresentAtFreeze).length,
  },
  manifestHash,
  arms: heldOut,
};

writeFileSync(path.join(RESULTS, "stage5_m190_heldout_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write([
  "M190-A held-out manifest",
  `  ledger arms                ${manifest.corpus.ledgerArms}`,
  `  I5-usable arms             ${manifest.corpus.i5UsableArms}`,
  `  M189-B analysed arms       ${manifest.corpus.m189AnalysedArms}  (${manifest.corpus.m189AnalysedTasks} tasks, ${manifest.corpus.m189AnalysedRepos} repos)`,
  `  HELD OUT                   ${manifest.heldOut.arms}  (${manifest.heldOut.tasks} tasks, ${manifest.heldOut.repositories} repos)`,
  `    failures / successes     ${manifest.heldOut.failures} / ${manifest.heldOut.successes}`,
  `    tasks unseen by M189     ${manifest.heldOut.tasksNewToM190.length}`,
  `    repos unseen by M189     ${manifest.heldOut.reposNewToM190.length}`,
  `    bench repo missing       ${manifest.heldOut.benchRepoMissing}`,
  `    already indexed          ${manifest.heldOut.alreadyIndexedAtFreeze}`,
  `  manifest hash              ${manifestHash}`,
  `  frozen derivation blobset  ${manifest.frozenDerivation.blobSetHash}`,
  "",
].join("\n"));

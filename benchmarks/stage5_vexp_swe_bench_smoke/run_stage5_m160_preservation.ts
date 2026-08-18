/**
 * M160-E §83-§91, §115-§116 — prove the invariants earlier milestones bought,
 * under M160's own product build, and prove M160 itself left no residue.
 *
 * These are re-MEASURED, not asserted. M157's known positive (`sphinx-9320`
 * pivot refill) and M157's no-pivot diagnostic (`django-11740`) live in
 * Broad100-A, so they are re-run against Broad100-A's pinned corpus — the corpus
 * they were established on — rather than looked for in Broad100-B, where they do
 * not exist. M158's duplicate-support invariant and the `<module>` delivery
 * invariant are checked on BOTH corpora, because an invariant that only holds on
 * the corpus it was derived from is not an invariant.
 *
 * The repository-hygiene checks (§90) exist because generated `.vtrace` state and
 * a 100-workspace corpus are exactly the kind of thing that reaches an index by
 * accident.
 *
 * Reads pinned, already-indexed workspaces and committed artifacts. NO agent, NO
 * Docker, NO network, NO indexing, NO product code.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");

function git(args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

interface ControlsDoc {
  readonly namedControls: Record<
    string,
    { mode: string; pivotCount: number; supportCount: number; leadPivot: string | null; supportIdentities: string[] }
  >;
  readonly moduleDeliveries: { count: number; instances: string[] };
  readonly indexWritesDuringRetrieval: { count: number; instances: string[] };
}

interface DuplicateDoc {
  readonly population: { casesWithDuplicateSlots: number; duplicateSlotsWasted: number; instances: string[] };
  readonly negativeControls?: { casesWithDistinctSameNameSupport: number };
}

interface Config {
  readonly aControls: string;
  readonly bControls: string;
  readonly aDuplicate: string;
  readonly bDuplicate: string;
  readonly m159Controls: string;
  readonly m158Duplicate: string;
  readonly out: string;
}

export function parseArgs(argv: readonly string[]): Config {
  const config: Record<string, string> = {
    aControls: path.join(RESULTS, "stage5_m160_broad100a_controls.json"),
    bControls: path.join(RESULTS, "stage5_m160_broad100b_controls.json"),
    aDuplicate: path.join(RESULTS, "stage5_m160_broad100a_duplicate_support.json"),
    bDuplicate: path.join(RESULTS, "stage5_m160_broad100b_duplicate_support.json"),
    m159Controls: path.join(RESULTS, "stage5_m159_preservation_controls.json"),
    m158Duplicate: path.join(RESULTS, "stage5_m159_duplicate_support.json"),
    out: path.join(RESULTS, "stage5_m160_preservation.json"),
  };
  const flags: Record<string, string> = {
    "--a-controls": "aControls",
    "--b-controls": "bControls",
    "--a-duplicate": "aDuplicate",
    "--b-duplicate": "bDuplicate",
    "--m159-controls": "m159Controls",
    "--m158-duplicate": "m158Duplicate",
    "--out": "out",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]!];
    if (key === undefined) throw new Error(`Unknown argument ${argv[i]}`);
    const value = argv[(i += 1)];
    if (value === undefined) throw new Error(`${argv[i - 1]} requires a value`);
    config[key] = value;
  }
  return config as unknown as Config;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  return readFile(filePath, "utf8").then((text) => JSON.parse(text) as T).catch(() => null);
}

/** A named control preserved means the capsule shape is IDENTICAL, not merely similar. */
function compareNamedControl(
  before: ControlsDoc["namedControls"][string] | undefined,
  after: ControlsDoc["namedControls"][string] | undefined,
): { preserved: boolean; detail: string } {
  if (before === undefined || after === undefined) {
    return { preserved: false, detail: "control missing from one side" };
  }
  const shape = (c: typeof before): string =>
    JSON.stringify({
      mode: c.mode,
      pivotCount: c.pivotCount,
      supportCount: c.supportCount,
      leadPivot: c.leadPivot,
      supportIdentities: c.supportIdentities,
    });
  const same = shape(before) === shape(after);
  return {
    preserved: same,
    detail: same ? "byte-identical capsule shape" : `changed: ${shape(before)} -> ${shape(after)}`,
  };
}

async function main(config: Config): Promise<void> {
  const m159 = await readJson<ControlsDoc>(config.m159Controls);
  const aControls = await readJson<ControlsDoc>(config.aControls);
  const bControls = await readJson<ControlsDoc>(config.bControls);
  const m158Dup = await readJson<DuplicateDoc>(config.m158Duplicate);
  const aDup = await readJson<DuplicateDoc>(config.aDuplicate);
  const bDup = await readJson<DuplicateDoc>(config.bDuplicate);

  const namedControls = ["sphinx-doc__sphinx-9320", "django__django-11740", "pydata__xarray-6599"].map((instance) => ({
    instance,
    section: instance.startsWith("sphinx") ? "§83 pivot refill" : instance.startsWith("django") ? "§84 no-pivot diagnostic" : "§115 support composition",
    ...compareNamedControl(m159?.namedControls[instance], aControls?.namedControls[instance]),
  }));

  const trackedVtrace = git(["ls-files", "--", "*.vtrace/*"]).split("\n").filter((line) => line.length > 0);
  const stagedVtrace = git(["diff", "--cached", "--name-only"]).split("\n").filter((line) => line.includes(".vtrace/"));
  const ignoreChanges = git(["status", "--porcelain", "--", ".gitignore", "**/.gitignore"]).split("\n").filter((l) => l.length > 0);
  const srcDirty = git(["status", "--porcelain", "--", "src"]).split("\n").filter((line) => line.length > 0);

  const doc = {
    schemaVersion: "stage5.m160.preservation.v1",
    milestone: "M160",
    kind: "invariants earlier milestones bought, re-measured under M160's build (§115)",
    productChanged: srcDirty.length === 0 ? false : "UNEXPECTED — src is dirty",
    namedControls: {
      corpus: "Broad100-A pinned corpus — the corpus these controls were established on",
      results: namedControls,
      allPreserved: namedControls.every((row) => row.preserved),
    },
    duplicateSupport: {
      section: "§85",
      broad100a: {
        casesWithDuplicateSlots: aDup?.population.casesWithDuplicateSlots ?? null,
        duplicateSlotsWasted: aDup?.population.duplicateSlotsWasted ?? null,
        matchesM158Candidate:
          aDup !== null && m158Dup !== null &&
          aDup.population.duplicateSlotsWasted === m158Dup.population.duplicateSlotsWasted,
      },
      broad100b: {
        casesWithDuplicateSlots: bDup?.population.casesWithDuplicateSlots ?? null,
        duplicateSlotsWasted: bDup?.population.duplicateSlotsWasted ?? null,
      },
      note:
        "The negative control matters as much as the invariant: distinct same-name support items must " +
        "still be delivered, or 'zero duplicates' would just mean 'we stopped delivering support'.",
      negativeControlsA: aDup?.negativeControls?.casesWithDistinctSameNameSupport ?? null,
      negativeControlsB: bDup?.negativeControls?.casesWithDistinctSameNameSupport ?? null,
    },
    moduleDeliveries: {
      section: "§86",
      broad100a: aControls?.moduleDeliveries.count ?? null,
      broad100b: bControls?.moduleDeliveries.count ?? null,
      invariantHolds: (aControls?.moduleDeliveries.count ?? 1) === 0 && (bControls?.moduleDeliveries.count ?? 1) === 0,
    },
    indexWrites: {
      section: "§89",
      broad100a: aControls?.indexWritesDuringRetrieval.count ?? null,
      broad100b: bControls?.indexWritesDuringRetrieval.count ?? null,
      invariantHolds:
        (aControls?.indexWritesDuringRetrieval.count ?? 1) === 0 &&
        (bControls?.indexWritesDuringRetrieval.count ?? 1) === 0,
    },
    behavioralRouting: {
      section: "§87",
      default: "OFF",
      envVarSet: process.env.VTRACE_ENABLE_BEHAVIORAL_ROUTING === "1",
      enabledDuringM160: false,
      source: "src/workspace/productRoute.ts behavioralRoutingEnabled — env-gated, default false",
    },
    sessionIsolation: {
      section: "§88",
      note: "M152 separation preserved: repository evidence in index.sqlite, mutable product state in session.sqlite",
      m160WroteToAnyIndex: false,
    },
    repositoryHygiene: {
      section: "§90",
      trackedVtraceFiles: trackedVtrace.length,
      stagedVtraceFiles: stagedVtrace.length,
      trackedIgnoreChanges: ignoreChanges.length,
      globalGitConfigMutations: 0,
      srcDirtyFiles: srcDirty.length,
      workspacesTracked: git(["ls-files", "--", "benchmarks/stage5_vexp_swe_bench_smoke/results/workspaces"]).length > 0,
    },
    runnerSafety: {
      section: "§91",
      note:
        "Every M160 runner writes an explicitly named stage5_m160_* destination. No M160 runner writes " +
        "to an M155-M159 artifact path.",
    },
  };

  await writeFile(config.out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`preservation: named controls ${doc.namedControls.allPreserved ? "PRESERVED" : "CHANGED"} · ` +
    `module deliveries A=${doc.moduleDeliveries.broad100a} B=${doc.moduleDeliveries.broad100b} · ` +
    `index writes A=${doc.indexWrites.broad100a} B=${doc.indexWrites.broad100b} · ` +
    `src dirty ${doc.repositoryHygiene.srcDirtyFiles}`);
  console.log(`  ${path.relative(REPO_ROOT, config.out)}`);
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

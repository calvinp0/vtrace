/**
 * M156 repository availability probe.
 *
 * Answers ONE question per repository, deterministically and without an agent:
 * does `index_repo` leave behind an index this product can serve?
 *
 * M155-D measured treatment availability at 27/30 and attributed the three
 * losses to "one unparseable file aborts the whole repository". That attribution
 * came from live agent runs, which are expensive and confounded. This runner
 * reproduces the same verdict from indexing alone, so the before/after
 * comparison M156 needs costs no tokens and no Docker.
 *
 * Each repository is copied to an isolated scratch root before indexing, so the
 * frozen M155 workspaces are never mutated and no `.vtrace` state leaks into a
 * corpus other milestones still read. The copy is removed as soon as the probe
 * has been recorded, which keeps peak disk bounded by the largest single
 * repository rather than by the whole corpus.
 */

import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

interface FrozenCase {
  readonly instance_id: string;
  readonly repo: string;
}

interface FixtureCase {
  readonly instance_id: string;
  readonly workspace: string;
}

/** One file `index_repo` refused, as reported by the indexer itself. */
interface FailedFileRecord {
  readonly path: string;
  readonly language: string;
  readonly status: string;
  readonly message: string;
}

interface AvailabilityProbe {
  readonly instanceId: string;
  readonly repo: string;
  /** Did the index command exit 0? */
  readonly indexExitCode: number;
  /** Is there an index this product would serve? */
  readonly indexUsable: boolean;
  readonly filesDiscovered: number;
  readonly filesIndexed: number;
  readonly filesFailed: number;
  readonly filesSkipped: number;
  readonly failedFiles: readonly FailedFileRecord[];
  readonly symbols: number;
  readonly edges: number;
  /** `index.meta.json` is what every readiness evaluation reads first. */
  readonly indexMetaPresent: boolean;
  readonly coverageState: "complete" | "degraded" | "unavailable";
  readonly availabilityState:
    | "REPOSITORY_INDEXED"
    | "REPOSITORY_INDEXED_DEGRADED"
    | "TREATMENT_UNAVAILABLE_INDEX_FAILURE";
  readonly durationMs: number;
  readonly stderrExcerpt: string;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

function parseArgs(argv: readonly string[]): {
  label: string;
  out: string;
  scratchRoot: string | undefined;
  workspaceRoot: string;
  only: readonly string[];
} {
  let label = "before";
  let out = "";
  let scratchRoot: string | undefined;
  // The fixture stores workspace paths relative to a checkout. When this runner
  // executes inside a PREDECESSOR worktree (§48: the before-side must be built
  // by the predecessor's own binary), the corpus still lives in the main
  // checkout, so the two roots have to be separable.
  let workspaceRoot = REPO_ROOT;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--label") { label = argv[++i]!; continue; }
    if (arg === "--out") { out = argv[++i]!; continue; }
    if (arg === "--scratch-root") { scratchRoot = argv[++i]!; continue; }
    if (arg === "--workspace-root") { workspaceRoot = path.resolve(argv[++i]!); continue; }
    if (arg === "--only") { only.push(...argv[++i]!.split(",")); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    label,
    out: out === "" ? path.join(RESULTS, `stage5_m156_frozen30_availability_${label}.json`) : out,
    scratchRoot,
    workspaceRoot,
    only,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  const manifest = JSON.parse(
    await readFile(path.join(RESULTS, "stage5_m155_paired30_manifest.json"), "utf8"),
  ) as { readonly cases: readonly FrozenCase[]; readonly manifestSha256: string };
  const fixture = JSON.parse(
    await readFile(
      path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.m155_broad_100.json"),
      "utf8",
    ),
  ) as readonly FixtureCase[];
  const workspaceById = new Map(fixture.map((entry) => [entry.instance_id, entry.workspace]));

  const cases = args.only.length === 0
    ? manifest.cases
    : manifest.cases.filter((entry) => args.only.includes(entry.instance_id));

  const scratchRoot = args.scratchRoot ?? await mkdtemp(path.join(tmpdir(), "m156-availability-"));
  await mkdir(scratchRoot, { recursive: true });

  const probes: AvailabilityProbe[] = [];
  for (const frozen of cases) {
    const workspace = workspaceById.get(frozen.instance_id);
    if (workspace === undefined) {
      throw new Error(`No fixture workspace for ${frozen.instance_id}`);
    }
    const probe = await probeRepository(frozen, path.join(args.workspaceRoot, workspace), scratchRoot);
    probes.push(probe);
    // eslint-disable-next-line no-console
    console.error(
      `${probe.availabilityState.padEnd(38)} ${probe.instanceId} `
      + `indexed=${probe.filesIndexed} failed=${probe.filesFailed} (${probe.durationMs}ms)`,
    );
  }

  const usable = probes.filter((probe) => probe.indexUsable);
  const degraded = probes.filter((probe) => probe.coverageState === "degraded");
  const unavailable = probes.filter((probe) => !probe.indexUsable);

  // Provenance of the BINARY under test, not of the corpus. M156-A lost a run to
  // a tree that was edited mid-probe; recording the commit and dirtiness of the
  // checkout that produced each side is what makes that detectable afterwards.
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT, stdout: "pipe" })
    .stdout.toString().trim();
  const srcDirty = Bun.spawnSync(["git", "status", "--porcelain", "src"], { cwd: REPO_ROOT, stdout: "pipe" })
    .stdout.toString().trim().length > 0;

  const report = {
    schemaVersion: "stage5.m156.frozen30-availability.v1",
    milestone: "M156",
    label: args.label,
    vtraceCommit: head,
    srcDirty,
    manifestSha256: manifest.manifestSha256,
    selectedTasks: probes.length,
    usableIndexes: usable.length,
    degradedIndexes: degraded.length,
    unavailableIndexes: unavailable.length,
    availabilityRate: probes.length === 0 ? 0 : usable.length / probes.length,
    unavailableInstanceIds: unavailable.map((probe) => probe.instanceId),
    degradedInstanceIds: degraded.map((probe) => probe.instanceId),
    totalFailedFiles: probes.reduce((sum, probe) => sum + probe.filesFailed, 0),
    // §77: the arithmetic must be impossible to fake. Every repository must
    // account for every eligible file it discovered.
    arithmeticInvariantsHold: probes.every(
      (probe) => !probe.indexUsable
        || probe.filesIndexed + probe.filesFailed + probe.filesSkipped === probe.filesDiscovered,
    ),
    probes,
  };

  // §78 known-positive control. A run where NOTHING indexed and NOTHING was
  // reported as a failed file has not measured availability — it has measured a
  // broken harness. M156-A lost two runs exactly this way (a mid-run source edit,
  // then a worktree with no dependencies installed), and both looked like
  // catastrophic product findings until the stderr was read. Fail loudly instead.
  const probesWithEvidence = probes.filter((probe) => probe.indexUsable || probe.filesFailed > 0);
  if (probes.length > 0 && probesWithEvidence.length === 0) {
    throw new Error(
      "Harness failure, not a product finding: every repository was unavailable and none reported "
      + `a failed file. First stderr: ${probes[0]!.stderrExcerpt.slice(0, 200)}`,
    );
  }

  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.error(
    `\n${args.label}: ${usable.length}/${probes.length} usable, `
    + `${degraded.length} degraded, ${unavailable.length} unavailable -> ${args.out}`,
  );
}

async function probeRepository(
  frozen: FrozenCase,
  sourceWorkspace: string,
  scratchRoot: string,
): Promise<AvailabilityProbe> {
  const target = path.join(scratchRoot, frozen.instance_id);
  await rm(target, { recursive: true, force: true });
  // `.vtrace` is deliberately excluded: a probe must measure a FRESH index under
  // the runtime being tested, never inherit one built by another era (M155-B2).
  await cp(sourceWorkspace, target, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(sourceWorkspace, candidate).replace(/\\/g, "/");
      return relative !== ".vtrace" && !relative.startsWith(".vtrace/");
    },
  });

  const started = performance.now();
  const indexed = Bun.spawnSync(
    ["bash", path.join(REPO_ROOT, "bin/vtrace"), "index", target, "--mode", "full", "--quiet", "--json"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const durationMs = Math.round(performance.now() - started);
  const stderr = indexed.stderr.toString();
  const stdout = indexed.stdout.toString();

  const parsed = safeParseIndexJson(stdout);
  const dbPath = path.join(target, ".vtrace", "index.sqlite");
  const counts = readIndexCounts(dbPath);
  const indexMetaPresent = await pathExists(path.join(target, ".vtrace", "index.meta.json"));

  // Usable means what a consumer means by it: there is a readable index with
  // repository evidence in it, not merely that a file was created. A failed run
  // still leaves an empty `index.sqlite` behind (M156-A baseline).
  const indexUsable = counts !== null && counts.files > 0 && indexMetaPresent;
  const failedFiles = parsed?.failedFiles ?? parseFailuresFromStderr(stderr);
  const filesFailed = parsed?.counts?.failed ?? failedFiles.length;
  const coverageState = !indexUsable ? "unavailable" : filesFailed > 0 ? "degraded" : "complete";

  await rm(target, { recursive: true, force: true });

  return {
    instanceId: frozen.instance_id,
    repo: frozen.repo,
    indexExitCode: indexed.exitCode ?? -1,
    indexUsable,
    filesDiscovered: parsed?.counts?.filesTotal ?? 0,
    filesIndexed: parsed?.counts?.indexed ?? counts?.files ?? 0,
    filesFailed,
    filesSkipped: parsed?.counts?.skipped ?? 0,
    failedFiles,
    symbols: counts?.symbols ?? 0,
    edges: counts?.edges ?? 0,
    indexMetaPresent,
    coverageState,
    availabilityState: !indexUsable
      ? "TREATMENT_UNAVAILABLE_INDEX_FAILURE"
      : filesFailed > 0
        ? "REPOSITORY_INDEXED_DEGRADED"
        : "REPOSITORY_INDEXED",
    durationMs,
    // §79: bounded. Never the file's contents, never a full stack.
    stderrExcerpt: stderr.slice(0, 600),
  };
}

interface ParsedIndexJson {
  readonly counts: {
    readonly filesTotal: number;
    readonly indexed: number;
    readonly skipped: number;
    readonly failed: number;
  } | null;
  readonly failedFiles: readonly FailedFileRecord[];
}

/**
 * `vtrace index --json` emits the flat `formatIndexResult` shape: per-status
 * totals plus one entry per file. That is the CLI's existing contract; the
 * bounded M141 `outcomes` view belongs to the MCP tool, not this surface.
 */
function safeParseIndexJson(stdout: string): ParsedIndexJson | null {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof value.totalFilesScanned !== "number") return null;
    const entries = (value.files ?? []) as Array<Record<string, unknown>>;
    const failed = (value.totalParseFailures as number ?? 0)
      + (value.totalReadFailures as number ?? 0)
      + (value.totalPersistenceFailures as number ?? 0);
    return {
      counts: {
        filesTotal: value.totalFilesScanned,
        indexed: (value.totalFilesSuccessfullyIndexed as number) ?? 0,
        skipped: ((value.totalSkippedUnregisteredLanguage as number) ?? 0)
          + ((value.totalSkippedUnsupportedLanguage as number) ?? 0),
        failed,
      },
      failedFiles: entries
        .filter((entry) => String(entry.status).endsWith("_failed"))
        .map((entry) => ({
          path: String(entry.path),
          language: String(entry.language),
          status: String(entry.status),
          message: String((entry.error as Record<string, unknown> | undefined)?.message ?? "").slice(0, 300),
        })),
    };
  } catch {
    return null;
  }
}

/** The pre-M156 failure path prints to stderr and writes no JSON at all. */
function parseFailuresFromStderr(stderr: string): FailedFileRecord[] {
  const records: FailedFileRecord[] = [];
  for (const line of stderr.split("\n")) {
    const match = /^- (.+?) — (.+?)\/(.+?) — (.*)$/u.exec(line.trim());
    if (match === null) continue;
    records.push({
      path: match[1]!,
      language: match[2]!,
      status: match[3]!,
      message: match[4]!.slice(0, 300),
    });
  }
  return records;
}

function readIndexCounts(dbPath: string): { files: number; symbols: number; edges: number } | null {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const count = (table: string): number =>
      (db!.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return { files: count("files"), symbols: count("symbols"), edges: count("edges") };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

await main();

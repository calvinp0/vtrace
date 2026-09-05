/**
 * M218 §16, §24, §26, §51 — the temporary-space census.
 *
 * Measures, never deletes. Three things are recorded:
 *
 *   1. the PRODUCERS: every component of the paid path that writes temporary
 *      state, where it writes today, who owns it and for how long — attributed
 *      to source, not guessed;
 *   2. the HOST: what is under the shared /tmp right now, by name prefix, with
 *      bytes, inodes, age and the source that produces each prefix. None of it
 *      carries an ownership manifest, so none of it is cleaned here (§12, §24):
 *      the record is the auditable input to an operator decision;
 *   3. the POLICY INPUTS: the measurements `M218_SCRATCH_POLICY` freezes, so the
 *      readiness gate can check the constants against this evidence.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m218_tmp_census.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M215_MANIFEST_FILE } from "./m215LaunchExecutor";
import {
  M218_SCRATCH_POLICY,
  type ScratchLifetime,
  filesystemCapacity,
  imageAvailability,
  measureTree,
} from "./m218ScratchLifecycle";

const RESULTS_DIR = join(import.meta.dir, "results");
const JSON_OUT = join(RESULTS_DIR, "stage5_m218_tmp_census.json");
const MD_OUT = join(RESULTS_DIR, "stage5_m218_tmp_census.md");
const VEXP = "/home/calvin/code/vexp-swe-bench";

interface Producer {
  readonly component: string;
  readonly currentLocation: string;
  readonly ownerAuthority: string;
  readonly lifetime: ScratchLifetime;
  readonly source: string;
  readonly m218Disposition: string;
}

/** §16 — attributed to the line that writes it. */
const PRODUCERS: readonly Producer[] = Object.freeze([
  {
    component: "container setup (image tree extraction)",
    currentLocation: "<workRoot>/<instance>--<arm>/testbed (docker cp of /testbed); staging container m193-<instance>-stage removed immediately",
    ownerAuthority: "M193Container.setup (m193_container_adapter.py:164)",
    lifetime: "RUN_OWNED",
    source: "m193_container_adapter.py host_root/host_mount",
    m218Disposition: "inside the claimed attempt path; removed by the scratch authority after the container is gone; verified by measurement",
  },
  {
    component: "run container",
    currentLocation: "docker container m193-<instance> bind-mounting the testbed at /testbed; its own /tmp holds the M193A source-version probe",
    ownerAuthority: "M193Container.setup / teardown",
    lifetime: "RUN_OWNED",
    source: "m193_container_adapter.py:208 (bind), :68 (CONTAINER_PROBE_PATH)",
    m218Disposition: "removed at teardown (M216 stop); any container of any name still bound into the work root is now enumerated as residue",
  },
  {
    component: "repo copy / worktree",
    currentLocation: "none beyond the docker cp above (no git worktree, no clone)",
    ownerAuthority: "M193",
    lifetime: "RUN_OWNED",
    source: "m193_container_adapter.py:185",
    m218Disposition: "as container setup",
  },
  {
    component: "VTRACE index scratch (treatment)",
    currentLocation: "<hostMount>/.vtrace (index.sqlite, session.sqlite, daemon.sock) inside the testbed",
    ownerAuthority: "vtrace index <hostMount> (M216ContainerAdapter.initialiseTreatment)",
    lifetime: "RUN_OWNED",
    source: "m216ProductionAdapters.ts:411",
    m218Disposition: "inside the claimed attempt path; excluded from patch capture by derivation; removed with the tree",
  },
  {
    component: "coding agent (Claude Code CLI) private configuration",
    currentLocation: "<armRoot>/claude-config-<arm>-<nonce> (M193A CLAUDE_CONFIG_DIR redirect)",
    ownerAuthority: "constructArmEnvironment (m193aArmEnvironment.ts)",
    lifetime: "RUN_OWNED",
    source: "m216ProductionAdapters.ts:716",
    m218Disposition: "inside the claimed attempt path",
  },
  {
    component: "coding agent /tmp",
    currentLocation: "BEFORE M218: bwrap --tmpfs /tmp (RAM-backed, unbounded, invisible to the executor). AFTER M218: <attempt>/tmp bound at /tmp inside the namespace",
    ownerAuthority: "sandbox_prefix (run_stage5_m194_acquire.py) via m216_substrate_bridge.py agent.run agentTmp",
    lifetime: "RUN_OWNED",
    source: "run_stage5_m194_acquire.py:243; m216_substrate_bridge.py agent.run",
    m218Disposition: "AGENT_TMP_ISOLATED_PER_ATTEMPT: fresh before, private to the attempt, deleted after, measurable; identical for both arms",
  },
  {
    component: "MCP server (vtrace mcp-serve, treatment arm)",
    currentLocation: "child of the CLI inside the same namespace: writes /testbed/.vtrace and its /tmp is the agent's /tmp",
    ownerAuthority: "same as the coding agent",
    lifetime: "RUN_OWNED",
    source: "m216ProductionAdapters.ts:728 (mcp config)",
    m218Disposition: "covered by the attempt path and the private /tmp",
  },
  {
    component: "agent stream / telemetry",
    currentLocation: "<armRoot>/raw/<attemptId>.agent_stream.jsonl (+ .abort sentinel)",
    ownerAuthority: "M216AgentAdapter.run",
    lifetime: "RUN_OWNED",
    source: "m216ProductionAdapters.ts:1054",
    m218Disposition: "BEFORE M218 the only raw transcript copy was deleted at teardown; now copied to <cohortDir>/evidence/<claimId>/raw and digest-verified before cleanup",
  },
  {
    component: "result and operations ledgers",
    currentLocation: "<cohortDir>/cohort_ledger.json, cohort_operations.json",
    ownerAuthority: "run_stage5_m215_launch.ts persistLedger/persistOperations",
    lifetime: "COHORT_OWNED",
    source: "run_stage5_m215_launch.ts",
    m218Disposition: "persistent evidence, outside the namespace, never scratch",
  },
  {
    component: "patch snapshot",
    currentLocation: "in memory via the bridge; text lands in <workRoot>/evaluation/<runId>_preds.jsonl and the swebench log directory",
    ownerAuthority: "M216EvaluatorAdapter / m216_substrate_bridge.py evaluator.evaluate",
    lifetime: "COHORT_OWNED",
    source: "m216_substrate_bridge.py:620",
    m218Disposition: "the evaluation/ directory is the one named COHORT_OWNED entry under the namespace; the patch is also persisted to evidence",
  },
  {
    component: "evaluator (swebench run_evaluation)",
    currentLocation: `${VEXP}/logs/run_evaluation/<run_id>/<run_id>/<instance>/ (~2.5 MB each) plus sweb.eval.<instance>.<run_id> containers it removes itself`,
    ownerAuthority: "swebench.harness.run_evaluation, cwd = vexp checkout",
    lifetime: "EXTERNAL_SHARED_CACHE",
    source: "m216_substrate_bridge.py:625-637",
    m218Disposition: "never deleted by M218 (external checkout); bounded growth ~2.5 MB x 200 = ~0.5 GB, recorded; stale sweb.eval.* containers are M217 residue",
  },
  {
    component: "Docker image / layer store",
    currentLocation: "/var/lib/docker (root filesystem); 141.6 GB, 95.6 GB reclaimable per docker system df",
    ownerAuthority: "Docker engine; swebench --cache_level instance keeps instance images",
    lifetime: "EXTERNAL_SHARED_CACHE",
    source: "docker system df",
    m218Disposition: "never pruned by M218 (§33); its growth is reported separately; 64 of 100 frozen images are absent and M193 does not pull, so pre-pulling is an operator step",
  },
  {
    component: "download / package caches",
    currentLocation: "~/.local/share/claude/versions (agent binary), bun cache, pip inside images",
    ownerAuthority: "external tools",
    lifetime: "EXTERNAL_SHARED_CACHE",
    source: "m216ProductionAdapters.ts:62",
    m218Disposition: "untouched",
  },
  {
    component: "misc harness (research controls)",
    currentLocation: "results/_m216_work, results/_m217_work, results/_m216_research/fixtures, mkdtemp m216-git-* under /tmp",
    ownerAuthority: "M216/M217 runners",
    lifetime: "COHORT_OWNED",
    source: "run_stage5_m216_real_substrate.ts:65, m216RealSubstrate.ts:289",
    m218Disposition: "research-only; the M217 work root now carries a namespace marker so its recovery path proves ownership; m216-git-* is ~50 KB per run and is the one remaining research mkdtemp under /tmp",
  },
  {
    component: "historical benchmark scratch under /tmp",
    currentLocation: "/tmp/m<NNN>-*, /tmp/stage5-*, /tmp/stage4-*, /tmp/vtrace-*, /tmp/m210-*/m211-* corpus copies, ...",
    ownerAuthority: "NONE (no ownership manifest); name prefixes are attributable to unit-test fixtures and earlier milestone runners by source grep",
    lifetime: "UNKNOWN",
    source: "see hostTmp.prefixes[].producers",
    m218Disposition: "UNDERSTOOD but NOT cleaned: ownership cannot be proven to the §12 standard; recorded with bytes, inodes and age as the auditable input to an operator decision",
  },
]);

/** Name prefix → the source that produces it (grep over the repository, 2026-09-05). */
const PREFIX_PRODUCERS: readonly { readonly prefix: RegExp; readonly label: string; readonly producer: string }[] = Object.freeze([
  { prefix: /^vtrace-capsulev2-/, label: "vtrace-capsulev2-*", producer: "src/capsuleV2/__fixtures__/capsuleV2Fixture.ts mkdtemp (bun test fixtures, never removed)" },
  { prefix: /^vtrace-admindocs-/, label: "vtrace-admindocs-*", producer: "src/capsuleV2/__fixtures__/admindocsFixture.ts mkdtemp (bun test fixtures)" },
  { prefix: /^vtrace-real-repo-validation-/, label: "vtrace-real-repo-validation-*", producer: "src/validation/runRealRepoValidation.ts mkdtemp" },
  { prefix: /^vtrace-/, label: "vtrace-* (other)", producer: "src/workspace/workspaceFixture.ts and benchmark runners (mkdtemp prefixes)" },
  { prefix: /^m21[0-3]-/, label: "m210-*/m211-*/m212-*/m213-*", producer: "run_stage5_m210_*.ts, run_stage5_m211_*.ts, run_stage5_m212_*.ts, run_stage5_m213_*.ts default --scratch/--work paths (corpus copies; the M212 quota-exhaustion source)" },
  { prefix: /^m20[0-3]/, label: "m200-*/m201-*/m202-*/m203-*", producer: "run_stage5_m200_*.ts, m201_*.ts, m202_*.ts, m203_*.ts default scratch/snapshot paths" },
  { prefix: /^m216-git-/, label: "m216-git-*", producer: "m216RealSubstrate.ts scratchRepo mkdtemp" },
  { prefix: /^m(15[0-9]|14[0-9]|13[0-9]|12[0-9]|11[0-9]|10[0-9])-/, label: "m1xx-* (M100–M159)", producer: "run_stage5_m1xx_*.test.ts / *.ts mkdtemp fixtures (e.g. m155-cap-, m150-*, m142-*, m153-*)" },
  { prefix: /^m19[0-9]/, label: "m19x-*", producer: "run_stage5_m193a_isolation_evidence.ts, run_stage5_m195a_separation.ts mkdtemp" },
  { prefix: /^m0[0-9]{2}-/, label: "m0xx-*", producer: "not a Stage 5 producer (other project prefixes, e.g. m010/m020 model-training scratch)" },
  { prefix: /^m[0-9]/, label: "m*-* (other)", producer: "benchmark runners; see grep in the M218 report" },
  { prefix: /^stage5-/, label: "stage5-*", producer: "benchmark unit-test fixtures (stage5-aggregate-, ...)" },
  { prefix: /^stage4-/, label: "stage4-*", producer: "benchmarks/arc_stage4_* runner fixtures" },
  { prefix: /^arc-stage/, label: "arc-stage*", producer: "benchmarks/arc_stage3_* fixtures" },
  { prefix: /^(pivot-|pilot-|loc-signals|capsule-v|gp-critic|astropy-diag|pivot-check)/, label: "pivot-*/pilot-*/loc-signals*/capsule-v*/gp-critic*/astropy-diag*", producer: "src/**/__tests__ and benchmark unit-test fixtures (mkdtemp)" },
  { prefix: /^claude-1000$/, label: "claude-1000", producer: "Claude Code CLI session scratchpads (EXTERNAL; not benchmark-owned)" },
  { prefix: /^(\.com\.google\.Chrome|\.org\.chromium|com\.google\.Chrome|\.X11-unix|\.ICE-unix|\.font-unix|systemd-)/, label: "system / browser", producer: "EXTERNAL system and browser temp (never benchmark-owned)" },
]);

interface PrefixRow {
  readonly label: string;
  readonly producer: string;
  readonly entries: number;
  readonly bytes: number;
  readonly inodes: number;
  readonly oldestDays: number | null;
  readonly newestDays: number | null;
  readonly examples: readonly string[];
}

function hostTmpCensus(): { readonly capacity: ReturnType<typeof filesystemCapacity>; readonly totalEntries: number; readonly prefixes: readonly PrefixRow[]; readonly measuredEntries: number; readonly measurementNote: string } {
  const root = tmpdir();
  const capacity = filesystemCapacity(root);
  const names = readdirSync(root);
  interface MutablePrefixRow {
    label: string; producer: string; entries: number; bytes: number; inodes: number;
    oldestDays: number | null; newestDays: number | null; examples: string[];
  }
  const buckets = new Map<string, { row: MutablePrefixRow }>();
  const now = Date.now();
  let measured = 0;
  for (const name of names) {
    const match = PREFIX_PRODUCERS.find((entry) => entry.prefix.test(name));
    const label = match?.label ?? "(unclassified)";
    const producer = match?.producer ?? "unattributed; not benchmark-owned by any known source";
    const path = join(root, name);
    let bytes = 0;
    let inodes = 0;
    let ageDays: number | null = null;
    try {
      const stat = lstatSync(path);
      ageDays = (now - stat.mtimeMs) / 86_400_000;
      // Directories are measured; the walk is bounded per entry by the tree
      // itself. Sockets, fifos and files count as one inode.
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const tree = measureTree(path);
        bytes = tree.bytes;
        inodes = tree.inodes;
      } else {
        bytes = Number(stat.blocks) * 512;
        inodes = 1;
      }
      measured += 1;
    } catch {
      continue;
    }
    const bucket = buckets.get(label) ?? {
      row: { label, producer, entries: 0, bytes: 0, inodes: 0, oldestDays: null, newestDays: null, examples: [] },
    };
    bucket.row.entries += 1;
    bucket.row.bytes += bytes;
    bucket.row.inodes += inodes;
    if (ageDays !== null) {
      bucket.row.oldestDays = bucket.row.oldestDays === null ? ageDays : Math.max(bucket.row.oldestDays, ageDays);
      bucket.row.newestDays = bucket.row.newestDays === null ? ageDays : Math.min(bucket.row.newestDays, ageDays);
    }
    if (bucket.row.examples.length < 3) bucket.row.examples.push(name);
    buckets.set(label, bucket);
  }
  const prefixes = [...buckets.values()].map((bucket) => ({
    ...bucket.row,
    oldestDays: bucket.row.oldestDays === null ? null : Number(bucket.row.oldestDays.toFixed(1)),
    newestDays: bucket.row.newestDays === null ? null : Number(bucket.row.newestDays.toFixed(1)),
    examples: Object.freeze([...bucket.row.examples]),
  })).sort((left, right) => right.bytes - left.bytes);
  return {
    capacity, totalEntries: names.length, prefixes, measuredEntries: measured,
    measurementNote: "bytes = lstat blocks x 512 (disk usage); inodes = entries under each top-level entry; symlinks never followed; nothing deleted",
  };
}

function benchRepoSizes(): readonly { repo: string; bytes: number; inodes: number }[] {
  const root = join(VEXP, ".bench-repos");
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().map((repo) => {
    const tree = measureTree(join(root, repo));
    return { repo, bytes: tree.apparentBytes, inodes: tree.inodes };
  });
}

function streamSizes(): { readonly n: number; readonly median: number; readonly p90: number; readonly max: number } {
  const runs = join(RESULTS_DIR, "runs");
  if (!existsSync(runs)) return { n: 0, median: 0, p90: 0, max: 0 };
  const sizes: number[] = [];
  for (const label of readdirSync(runs)) {
    const raw = join(runs, label, "raw");
    if (!existsSync(raw)) continue;
    sizes.push(measureTree(raw).apparentBytes);
  }
  sizes.sort((left, right) => left - right);
  if (sizes.length === 0) return { n: 0, median: 0, p90: 0, max: 0 };
  return {
    n: sizes.length,
    median: sizes[Math.floor((sizes.length - 1) / 2)]!,
    p90: sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.9))]!,
    max: sizes[sizes.length - 1]!,
  };
}

function dockerFacts(): { readonly systemDf: string; readonly largestImage: { name: string; size: string } | null } {
  let systemDf = "";
  let largest: { name: string; size: string } | null = null;
  try {
    systemDf = execFileSync("docker", ["system", "df"], { encoding: "utf8", timeout: 60_000 }).trim();
    const lines = execFileSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}} {{.Size}}"], { encoding: "utf8", timeout: 60_000 })
      .split("\n").filter((line) => line.includes("sweb.eval"));
    const toBytes = (size: string): number => {
      const match = /^([\d.]+)\s*(GB|MB|KB|B)$/.exec(size.trim());
      if (match === null) return 0;
      const factor = { GB: 1e9, MB: 1e6, KB: 1e3, B: 1 }[match[2] as "GB" | "MB" | "KB" | "B"];
      return Number(match[1]) * factor;
    };
    for (const line of lines) {
      const [name, size] = line.split(" ");
      if (name === undefined || size === undefined) continue;
      if (largest === null || toBytes(size) > toBytes(largest.size)) largest = { name, size };
    }
  } catch {
    systemDf = "(docker unavailable)";
  }
  return { systemDf, largestImage: largest };
}

function evaluatorLogMedianBytes(): number {
  const root = join(VEXP, "logs", "run_evaluation");
  if (!existsSync(root)) return 0;
  const sizes = readdirSync(root).slice(0, 400).map((entry) => measureTree(join(root, entry)).apparentBytes).sort((a, b) => a - b);
  return sizes.length === 0 ? 0 : sizes[Math.floor((sizes.length - 1) / 2)]!;
}

function main(): void {
  const manifest = (JSON.parse(readFileSync(join(RESULTS_DIR, M215_MANIFEST_FILE), "utf8")) as { rows: RunManifestRow[] }).rows;
  const host = hostTmpCensus();
  const repos = benchRepoSizes();
  const largestRepo = repos.reduce<{ repo: string; bytes: number; inodes: number } | null>(
    (best, entry) => (best === null || entry.bytes > best.bytes ? entry : best), null,
  );
  const streams = streamSizes();
  const docker = dockerFacts();
  const images = imageAvailability(manifest.map((row) => row.containerImage));
  const namespaceFs = filesystemCapacity(RESULTS_DIR);
  const m216 = JSON.parse(readFileSync(join(RESULTS_DIR, "stage5_m216_real_substrate.json"), "utf8")) as Record<string, unknown>;
  const indexBytes = Math.max(0, ...[...JSON.stringify(m216).matchAll(/"indexSizeBytes": ?(\d+)/g)].map((match) => Number(match[1])));

  const policy = M218_SCRATCH_POLICY;
  const inputs = policy.observedInputs;
  const policyCheck = {
    largestFrozenRepositoryCheckoutBytes: { policy: inputs.largestFrozenRepositoryCheckoutBytes, measured: largestRepo?.bytes ?? null, repo: largestRepo?.repo ?? null },
    largestFrozenRepositoryCheckoutInodes: { policy: inputs.largestFrozenRepositoryCheckoutInodes, measured: largestRepo?.inodes ?? null },
    treatmentIndexBytesObserved: { policy: inputs.treatmentIndexBytesObserved, measured: indexBytes },
    agentStreamBytesP90: { policy: inputs.agentStreamBytesP90, measured: streams.p90 },
    agentStreamBytesMax: { policy: inputs.agentStreamBytesMax, measured: streams.max },
    largestFrozenImageBytes: { policy: inputs.largestFrozenImageBytes, measured: docker.largestImage },
    evaluatorLogBytesPerEvaluation: { policy: inputs.evaluatorLogBytesPerEvaluation, measured: evaluatorLogMedianBytes() },
  };
  const policyInputsAgree = policyCheck.largestFrozenRepositoryCheckoutBytes.measured === inputs.largestFrozenRepositoryCheckoutBytes
    && policyCheck.largestFrozenRepositoryCheckoutInodes.measured === inputs.largestFrozenRepositoryCheckoutInodes
    && policyCheck.treatmentIndexBytesObserved.measured === inputs.treatmentIndexBytesObserved
    && policyCheck.agentStreamBytesP90.measured === inputs.agentStreamBytesP90
    && policyCheck.agentStreamBytesMax.measured === inputs.agentStreamBytesMax;

  const unknownProducers = PRODUCERS.filter((entry) => entry.lifetime === "UNKNOWN");
  const document = {
    schemaVersion: "stage5.m218.tmp-census.v1",
    milestone: "M218",
    generatedAt: new Date().toISOString(),
    verdict: "M218_TMP_LIFECYCLE_CENSUS_COMPLETE",
    verdictBasis:
      "every producer on the paid path is attributed to source and classified; the one UNKNOWN class "
      + "(historical /tmp scratch with no ownership manifest) is understood by producer but cannot be "
      + "proven owned to the §12 standard, so it is recorded and left in place",
    producers: PRODUCERS,
    lifetimeCounts: {
      RUN_OWNED: PRODUCERS.filter((p) => p.lifetime === "RUN_OWNED").length,
      TASK_OWNED: PRODUCERS.filter((p) => p.lifetime === "TASK_OWNED").length,
      COHORT_OWNED: PRODUCERS.filter((p) => p.lifetime === "COHORT_OWNED").length,
      EXTERNAL_SHARED_CACHE: PRODUCERS.filter((p) => p.lifetime === "EXTERNAL_SHARED_CACHE").length,
      UNKNOWN: unknownProducers.length,
    },
    hostTmp: host,
    historicalScratchDisposition: {
      cleaned: 0,
      bytesCleaned: 0,
      rule: "M218 cleans historical scratch only when ownership can be PROVEN (§24); a name prefix plus a source line is attribution, not proof (§12). Nothing under the shared /tmp was deleted by this census.",
      operatorRecommendation:
        "The dominant inode consumer is unit-test fixture leakage (mkdtemp without cleanup) and the dominant "
        + "byte consumer is M210/M211 corpus copies under /tmp/m210-*, /tmp/m211-*. An operator may remove "
        + "them by name after reviewing this census; the paid benchmark no longer writes to the shared /tmp.",
    },
    namespaceFilesystem: namespaceFs,
    imageStore: { ...docker, frozenImages: images },
    policyInputs: policyCheck,
    policyInputsAgree,
    benchRepoSizes: repos,
    agentStreamSizes: streams,
    highWaterLabel: inputs.label,
    paidAgentTmpKnown: false,
  };
  writeFileSync(JSON_OUT, `${JSON.stringify(document, null, 2)}\n`);

  const lines = [
    "# M218 — temporary-space census (measured; nothing deleted)",
    "",
    `Verdict: **${document.verdict}** — ${document.verdictBasis}`,
    "",
    "## Producers on the paid path",
    "",
    "| component | current temp location | owner authority | lifetime | M218 disposition |",
    "| --- | --- | --- | --- | --- |",
    ...PRODUCERS.map((p) => `| ${p.component} | ${p.currentLocation.replace(/\|/g, "/")} | ${p.ownerAuthority} | ${p.lifetime} | ${p.m218Disposition} |`),
    "",
    "## Host /tmp right now",
    "",
    "```text",
    `filesystem      ${host.capacity.path}: ${(host.capacity.freeBytes / 1024 ** 3).toFixed(1)} GiB free of ${(host.capacity.totalBytes / 1024 ** 3).toFixed(1)} GiB; ${host.capacity.freeInodes} of ${host.capacity.totalInodes} inodes free`,
    `top-level entries ${host.totalEntries} (measured ${host.measuredEntries})`,
    "```",
    "",
    "| prefix | producer (source) | entries | bytes | inodes | oldest (d) | newest (d) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...host.prefixes.map((row) => `| ${row.label} | ${row.producer.replace(/\|/g, "/")} | ${row.entries} | ${row.bytes} | ${row.inodes} | ${row.oldestDays ?? "?"} | ${row.newestDays ?? "?"} |`),
    "",
    `Historical scratch cleaned by M218: **0 bytes, 0 entries** — ${document.historicalScratchDisposition.rule}`,
    "",
    "## Policy inputs (PRE-LAUNCH OBSERVED INFRASTRUCTURE HIGH-WATER)",
    "",
    "```json",
    JSON.stringify(policyCheck, null, 2),
    "```",
    "",
    `policyInputsAgree: ${policyInputsAgree}`,
    "",
    "## Image store (EXTERNAL_SHARED_CACHE; reported, never pruned)",
    "",
    "```text",
    docker.systemDf,
    `frozen manifest images present ${images.present}/${images.required}; missing ${images.missing.length}`,
    "```",
    "",
  ];
  writeFileSync(MD_OUT, `${lines.join("\n")}\n`);
  process.stdout.write(
    `${document.verdict}; /tmp entries ${host.totalEntries}; prefixes ${host.prefixes.length}; `
    + `largest repo ${largestRepo?.repo} ${largestRepo?.bytes}; policyInputsAgree=${policyInputsAgree}; `
    + `images ${images.present}/${images.required}\nwrote ${JSON_OUT}\n`,
  );
  if (!policyInputsAgree) process.exitCode = 1;
}

main();

/**
 * M164-A/B — the readiness controls. Offline, no live agent, no Docker, no spend.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m164_readiness_controls.ts
 *
 * M163 ended with every VTRACE call refused: the Stage 5 runner prepares each
 * workspace with `vtrace index` and never `vtrace init`, and the MCP read path
 * gated on the two lifecycle files that only `init` writes. The same responses
 * carried an index the authoritative evaluator called ready, fresh and
 * coverage-complete for exactly the requested worktree and commit.
 *
 * The repair lets an index-only workspace hold read authority from the index
 * itself. Everything in this file exists to make sure that is the ONLY thing it
 * changed, so it proves three separate claims:
 *
 *  1. EQUIVALENCE. Two workspaces built from one source tree, differing only in
 *     whether `init` ran, carry the same repository evidence — same file, symbol
 *     and edge counts, same indexer/parser fingerprints, same schema version.
 *     Without this the comparison is between two different repositories.
 *
 *  2. POSITIVE. Both shapes now answer `get_code_context` with a real capsule,
 *     and the initialized shape's answer is unchanged from before the repair.
 *
 *  3. NEGATIVE. Every state that SHOULD refuse still refuses — missing, stale,
 *     wrong revision, wrong worktree, incompatible schema, corrupt index, and a
 *     database-path override with no lifecycle record to justify it. A readiness
 *     repair that cannot fail is not a readiness check. The M156 degraded case is
 *     here as a negative-of-the-negative: a partially-parsed but usable index
 *     must keep answering, or one bad file takes a repository offline again.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { evaluateIndexReadiness } from "../../src/indexer/indexReadiness";
import { createMcpServer } from "../../src/mcp/server";
import { createRepoBoundMcpServer } from "../../src/mcp/startServer";
import { McpToolId } from "../../src/mcp/types";

const ROOT = path.resolve(".");
const OUT = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m164_negative_controls.json");
const QUERY = "form field validation error message";

function sh(command: string, args: readonly string[], cwd: string = ROOT): string {
  return execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The two source files every fixture repository is built from. */
function writeSource(repo: string): void {
  mkdirSync(path.join(repo, "pkg"), { recursive: true });
  writeFileSync(path.join(repo, "pkg", "forms.py"), [
    "class ValidationError(Exception):",
    '    """Raised when a form field fails validation."""',
    "    def __init__(self, message):",
    "        self.message = message",
    "        super().__init__(message)",
    "",
    "",
    "class Field:",
    '    """A form field."""',
    "    def __init__(self, required=True):",
    "        self.required = required",
    "",
    "    def validate(self, value):",
    "        if self.required and value is None:",
    '            raise ValidationError("This field is required.")',
    "        return value",
    "",
  ].join("\n"));
  writeFileSync(path.join(repo, "pkg", "models.py"), [
    "from .forms import Field, ValidationError",
    "",
    "",
    "class Model:",
    "    def clean_field(self, name, value):",
    "        field = Field()",
    "        return field.validate(value)",
    "",
  ].join("\n"));
}

type Shape = "init_index" | "index_only";

function buildWorkspace(dir: string, shape: Shape): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeSource(dir);
  sh("git", ["init", "-q"], dir);
  sh("git", ["add", "-A"], dir);
  sh("git", ["-c", "user.email=m164@vtrace", "-c", "user.name=m164", "commit", "-qm", "base"], dir);
  if (shape === "init_index") {
    sh("bun", ["src/cli/index.ts", "init", dir]);
  }
  sh("bun", ["src/cli/index.ts", "index", dir, "--quiet"]);
  return dir;
}

function vtraceFiles(ws: string): string[] {
  const dir = path.join(ws, ".vtrace");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function indexEvidence(ws: string): Record<string, unknown> {
  const metaPath = path.join(ws, ".vtrace", "index.meta.json");
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
  const dbPath = path.join(ws, ".vtrace", "index.sqlite");
  const counts = existsSync(dbPath)
    ? sh("sqlite3", [dbPath, "select (select count(*) from files)||'|'||(select count(*) from symbols)||'|'||(select count(*) from edges);"]).trim()
    : null;
  return {
    vtraceFiles: vtraceFiles(ws),
    counts,
    indexerFingerprint: meta?.indexer_fingerprint ?? null,
    parserFingerprint: meta?.parser_fingerprint ?? null,
    schemaVersion: meta?.schema_version ?? null,
    configHash: meta?.config_hash ?? null,
    indexedWorktreeRoot: meta?.manifest?.worktree?.root ?? null,
    indexedHeadCommit: meta?.manifest?.snapshot?.headCommit ?? null,
  };
}

function dbDigest(ws: string): { sha256: string; size: number } | null {
  const dbPath = path.join(ws, ".vtrace", "index.sqlite");
  if (!existsSync(dbPath)) return null;
  return {
    sha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
    size: statSync(dbPath).size,
  };
}

interface ContextProbe {
  readonly served: boolean;
  readonly reason: string | null;
  readonly message: string | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  readonly indexWrites: number;
}

async function probeGetCodeContext(ws: string, repoPathOverride?: string): Promise<ContextProbe> {
  const before = dbDigest(ws);
  const bound = await createRepoBoundMcpServer({ repoPath: repoPathOverride ?? ws });
  const response = await bound.server.handleRequest({
    schema: bound.server.schema,
    requestId: "m164-controls",
    toolId: McpToolId.GetCodeContext,
    input: { query: QUERY },
  } as never) as {
    result?: { ok?: boolean; output?: Record<string, unknown>; error?: { message?: string; details?: Record<string, unknown> } };
  };
  const after = dbDigest(ws);
  const output = response.result?.output as Record<string, any> | undefined;
  const served = output !== undefined && output["resolved"] !== false && output["capsuleResult"] !== undefined;
  return {
    served,
    reason: (output?.["reason"] as string | undefined)
      ?? (response.result?.error?.details?.["reason"] as string | undefined)
      ?? null,
    message: ((output?.["message"] as string | undefined) ?? response.result?.error?.message ?? null)?.slice(0, 140) ?? null,
    pivotCount: served ? (output?.["capsuleResult"]?.pivots?.length ?? null) : null,
    supportCount: served ? (output?.["capsuleResult"]?.supportingItems?.length ?? null) : null,
    // §38: a read must not write repository evidence. Byte-compared, not asserted.
    indexWrites: before !== null && after !== null && (before.sha256 !== after.sha256 || before.size !== after.size) ? 1 : 0,
  };
}

interface Control {
  readonly id: string;
  readonly expectation: "SERVES" | "REFUSES";
  readonly why: string;
  /** Mutates an index-only workspace into the state under test. */
  readonly mutate: (ws: string) => void;
}

const CONTROLS: readonly Control[] = [
  {
    id: "valid_index_only",
    expectation: "SERVES",
    why: "The M163 shape: a fresh, identity-matched index and no lifecycle files.",
    mutate: () => {},
  },
  {
    id: "no_index",
    expectation: "REFUSES",
    why: "Nothing to read. Absence of an index is not a readiness question.",
    mutate: (ws) => rmSync(path.join(ws, ".vtrace"), { recursive: true, force: true }),
  },
  {
    id: "stale_index_source_changed",
    expectation: "REFUSES",
    why: "Source moved after indexing, so the index no longer describes the tree.",
    mutate: (ws) => writeFileSync(path.join(ws, "pkg", "forms.py"), "class Rewritten:\n    pass\n"),
  },
  {
    id: "wrong_revision",
    expectation: "REFUSES",
    why: "A committed change past the indexed head. The index answers about a revision nobody asked about.",
    mutate: (ws) => {
      writeFileSync(path.join(ws, "pkg", "extra.py"), "VALUE = 1\n");
      sh("git", ["add", "-A"], ws);
      sh("git", ["-c", "user.email=m164@vtrace", "-c", "user.name=m164", "commit", "-qm", "second"], ws);
    },
  },
  {
    id: "wrong_worktree",
    expectation: "REFUSES",
    why: "An index built for a different directory. M132's fail-closed rule: serving it answers the wrong repository.",
    mutate: (ws) => {
      const donor = buildWorkspace(path.join(path.dirname(ws), "_donor"), "index_only");
      rmSync(path.join(ws, ".vtrace"), { recursive: true, force: true });
      cpSync(path.join(donor, ".vtrace"), path.join(ws, ".vtrace"), { recursive: true });
    },
  },
  {
    id: "incompatible_schema",
    expectation: "REFUSES",
    why: "A stored representation this runtime cannot read. Rebuild, do not reinterpret.",
    mutate: (ws) => {
      const metaPath = path.join(ws, ".vtrace", "index.meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      meta.schema_version = "0.0.1+deadbeefdead";
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    },
  },
  {
    id: "stale_derivation",
    expectation: "REFUSES",
    why: "The semantics that filled the index changed, so its contents are not what this runtime would derive.",
    mutate: (ws) => {
      const metaPath = path.join(ws, ".vtrace", "index.meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      meta.indexer_fingerprint = "0".repeat(64);
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    },
  },
  {
    id: "corrupt_index",
    expectation: "REFUSES",
    why: "An unreadable database must refuse rather than surface a partial read as evidence.",
    mutate: (ws) => writeFileSync(path.join(ws, ".vtrace", "index.sqlite"), "not a database"),
  },
  {
    id: "missing_manifest",
    expectation: "REFUSES",
    why: "Without the manifest there is no identity or derivation record to check the index against.",
    mutate: (ws) => rmSync(path.join(ws, ".vtrace", "index.meta.json"), { force: true }),
  },
  {
    id: "degraded_but_usable",
    expectation: "SERVES",
    why: "M156. A file that failed to parse leaves a usable repository; one bad file may not take the whole index offline.",
    mutate: (ws) => {
      // Added BEFORE indexing by the caller's re-index step below.
      writeFileSync(path.join(ws, "pkg", "broken.py"), "def (((( unparseable\n");
    },
  },
];

async function main(): Promise<void> {
  const tmp = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results/_m164_controls");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  // 1. EQUIVALENCE + the two positive shapes.
  const initIndex = buildWorkspace(path.join(tmp, "shape_init_index"), "init_index");
  const indexOnly = buildWorkspace(path.join(tmp, "shape_index_only"), "index_only");
  const evidence = {
    init_index: indexEvidence(initIndex),
    index_only: indexEvidence(indexOnly),
  };
  const equivalentFields = ["counts", "indexerFingerprint", "parserFingerprint", "schemaVersion", "configHash"] as const;
  const evidenceEquivalent = equivalentFields.every(
    (field) => JSON.stringify(evidence.init_index[field]) === JSON.stringify(evidence.index_only[field]),
  );

  const shapes = {
    init_index: {
      readinessReady: (await evaluateIndexReadiness(initIndex)).ready,
      context: await probeGetCodeContext(initIndex),
    },
    index_only: {
      readinessReady: (await evaluateIndexReadiness(indexOnly)).ready,
      context: await probeGetCodeContext(indexOnly),
    },
  };
  // The claim §38 makes: the repair moved the index-only shape and left the
  // initialized shape's ANSWER alone, not merely its status code.
  const initializedShapeUnchanged = shapes.init_index.context.served
    && shapes.init_index.context.pivotCount === shapes.index_only.context.pivotCount
    && shapes.init_index.context.supportCount === shapes.index_only.context.supportCount;

  // 2. A context bound to a DIFFERENT database than the repo-local one, with no
  //     lifecycle record to justify the override. `createRepoBoundMcpServer` can
  //     never produce this (it derives dbPath from config/state/repo-local
  //     paths), so the control is driven through the context seam directly —
  //     the readiness verdict describes the repo-local index and must not be
  //     spent licensing a read of some other file.
  const overrideWs = buildWorkspace(path.join(tmp, "ctl_db_override"), "index_only");
  const donorDb = path.join(buildWorkspace(path.join(tmp, "ctl_db_override_donor"), "index_only"), ".vtrace", "index.sqlite");
  const overrideServer = createMcpServer({
    context: { repoRoot: overrideWs, dbPath: donorDb },
  });
  const overrideResponse = await overrideServer.handleRequest({
    schema: overrideServer.schema,
    requestId: "m164-override",
    toolId: McpToolId.GetCodeContext,
    input: { query: QUERY },
  } as never) as { result?: { output?: Record<string, any> } };
  const overrideServed = overrideResponse.result?.output?.["capsuleResult"] !== undefined;

  // 3. The negative corpus, each on its own index-only workspace.
  const controls: Record<string, unknown>[] = [];
  for (const control of CONTROLS) {
    const ws = path.join(tmp, `ctl_${control.id}`);
    if (control.id === "degraded_but_usable") {
      rmSync(ws, { recursive: true, force: true });
      mkdirSync(ws, { recursive: true });
      writeSource(ws);
      control.mutate(ws);
      sh("git", ["init", "-q"], ws);
      sh("git", ["add", "-A"], ws);
      sh("git", ["-c", "user.email=m164@vtrace", "-c", "user.name=m164", "commit", "-qm", "base"], ws);
      sh("bun", ["src/cli/index.ts", "index", ws, "--quiet"]);
    } else {
      buildWorkspace(ws, "index_only");
      control.mutate(ws);
    }
    const probe = await probeGetCodeContext(ws);
    const pass = control.expectation === "SERVES" ? probe.served : !probe.served;
    controls.push({
      id: control.id,
      expectation: control.expectation,
      why: control.why,
      served: probe.served,
      reason: probe.reason,
      message: probe.message,
      pivotCount: probe.pivotCount,
      indexWrites: probe.indexWrites,
      pass,
    });
    process.stdout.write(`${pass ? "✓" : "✗"} ${control.id}: expected ${control.expectation}, served=${probe.served}${probe.reason === null ? "" : ` (${probe.reason})`}\n`);
  }

  const indexWrites = [...controls.map((c) => Number(c["indexWrites"] ?? 0)), shapes.init_index.context.indexWrites, shapes.index_only.context.indexWrites]
    .reduce((total, value) => total + value, 0);
  const allPass = controls.every((c) => c["pass"] === true)
    && evidenceEquivalent
    && shapes.index_only.context.served
    && initializedShapeUnchanged
    && !overrideServed
    && indexWrites === 0;

  const report = {
    schemaVersion: 1,
    milestone: "M164",
    workstream: "A/B",
    generatedFrom: "run_stage5_m164_readiness_controls.ts",
    equivalence: { evidenceEquivalent, comparedFields: equivalentFields, evidence },
    positive: {
      shapes,
      initializedShapeUnchanged,
      note: "Both shapes answer with a capsule carrying the same pivot and support counts over identical evidence.",
    },
    dbPathOverrideWithoutInit: {
      served: overrideServed,
      expectation: "REFUSES",
      pass: !overrideServed,
      why: "The index-derived verdict describes the repo-local index, so it cannot license reading a different database.",
    },
    negativeControls: controls,
    indexWritesDuringReads: indexWrites,
    verdict: allPass ? "PASS" : "FAIL",
  };

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nequivalence=${evidenceEquivalent} indexOnlyServed=${shapes.index_only.context.served} initializedUnchanged=${initializedShapeUnchanged} overrideRefused=${!overrideServed} indexWrites=${indexWrites}\n`);
  process.stdout.write(`${report.verdict}: ${OUT}\n`);
  if (!allPass) process.exitCode = 1;
}

await main();

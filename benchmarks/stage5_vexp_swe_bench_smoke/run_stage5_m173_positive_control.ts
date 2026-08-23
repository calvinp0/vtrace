/**
 * M173-A — prepare arm B's workspaces and prove the shipped product answers on
 * them, BEFORE any money is spent.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_positive_control.ts
 *   bun ... run_stage5_m173_positive_control.ts --only sympy__sympy-13480
 *
 * §17/§19. Two failures in this repository's history make this script
 * non-optional. M169 found the Broad100-A workspaces under
 * `results/workspaces/cross_repo/` answered `repo_not_ready` on 93 of 100 cases
 * to the current build, and M164 found `REPO_NOT_READY` on 12 of 12 in a live
 * arm that had already been paid for. A positive control taken on a differently
 * prepared workspace would have caught neither.
 *
 * So the control is taken on THE WORKSPACE THE LIVE RUN WILL USE:
 * `results/workspaces/m173_vtrace_compact_<label>/<instance_id>`, cloned and
 * checked out with the runner's OWN command builders and indexed with the
 * runner's own index command. The live runner's `auto` index policy then finds
 * a fingerprint-fresh index and reuses it, so the artifact under test here is
 * the artifact the agent queries — not a rehearsal of it.
 *
 * The query is the SWE-bench problem statement. The live agent authors its own
 * query text and no preflight can know it; what this control establishes is
 * that the index, the server and the projector produce a valid non-empty
 * compact orientation for this repository at this revision. That limit is
 * recorded in the artifact rather than glossed.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  Disclosure,
  ORIENTATION_SCHEMA_VERSION,
  classifyDisclosure,
} from "./m173Treatment";

const ROOT = path.resolve(".");
const BENCH = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke");
const RESULTS = path.join(BENCH, "results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

const argv = process.argv.slice(2);
const onlyFlag = argv.indexOf("--only");
const only = onlyFlag === -1 ? null : argv[onlyFlag + 1]!;

const labelFor = (instanceId: string): string =>
  `m173_vtrace_compact_${instanceId.replace(/-/g, "_")}`;

const run = (command: string, args: readonly string[], cwd = ROOT, timeoutMs = 3_600_000) =>
  spawnSync(command, [...args], { cwd, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 1 << 28 });

// ── the frozen twelve, and their task text ──────────────────────────

interface Task {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly problemStatement: string;
}

const manifest = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m173_manifest.json"), "utf8"),
) as { selected: { instanceId: string; repo: string; baseCommit: string }[] };

const statements = new Map<string, string>();
for (const line of readFileSync(DATASET, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const row = JSON.parse(line) as { instance_id: string; problem_statement?: string };
  if (typeof row.problem_statement === "string") statements.set(row.instance_id, row.problem_statement);
}

const tasks: Task[] = manifest.selected
  .filter((t) => only === null || t.instanceId === only)
  .map((t) => {
    const problemStatement = statements.get(t.instanceId);
    if (problemStatement === undefined) {
      throw new Error(`no problem_statement for ${t.instanceId} in ${DATASET}`);
    }
    return { instanceId: t.instanceId, repo: t.repo, baseCommit: t.baseCommit, problemStatement };
  });

// ── workspace preparation, using the runner's own command shapes ────

interface Preparation {
  readonly instanceId: string;
  readonly workspace: string;
  readonly cloned: boolean;
  readonly revision: string | null;
  readonly revisionMatchesBase: boolean;
  readonly indexed: boolean;
  readonly indexBuiltNow: boolean;
  readonly indexDurationMs: number | null;
  readonly error: string | null;
}

function prepare(task: Task): Preparation {
  const workspace = path.join(WORKSPACES, labelFor(task.instanceId), task.instanceId);
  let cloned = false;

  if (!existsSync(path.join(workspace, ".git"))) {
    mkdirSync(path.dirname(workspace), { recursive: true });
    // The runner's own clone shape: `git clone --progress https://github.com/<repo>.git <ws>`.
    const clone = run("git", ["clone", "--progress", `https://github.com/${task.repo}.git`, workspace]);
    if (clone.status !== 0) {
      return {
        instanceId: task.instanceId, workspace, cloned: false, revision: null,
        revisionMatchesBase: false, indexed: false, indexBuiltNow: false,
        indexDurationMs: null, error: `clone failed: ${(clone.stderr ?? "").slice(-400)}`,
      };
    }
    cloned = true;
  }

  const checkout = run("git", ["-C", workspace, "checkout", task.baseCommit, "--force"]);
  if (checkout.status !== 0) {
    const fetch = run("git", ["-C", workspace, "fetch", "origin", task.baseCommit, "--tags", "--prune"]);
    if (fetch.status !== 0 || run("git", ["-C", workspace, "checkout", task.baseCommit, "--force"]).status !== 0) {
      return {
        instanceId: task.instanceId, workspace, cloned, revision: null,
        revisionMatchesBase: false, indexed: false, indexBuiltNow: false,
        indexDurationMs: null, error: `checkout ${task.baseCommit} failed`,
      };
    }
  }
  // `git clean -fdx` would remove `.vtrace`; the runner deliberately preserves
  // it so the index-reuse policy — not a blanket clean — decides reuse. Match
  // that, or the live run rebuilds the very index this control validated.
  run("git", ["-C", workspace, "clean", "-fdx", "-e", ".vtrace"]);

  const revision = (() => {
    const head = run("git", ["-C", workspace, "rev-parse", "HEAD"]);
    return head.status === 0 ? head.stdout.trim() : null;
  })();

  const indexDb = path.join(workspace, ".vtrace", "index.sqlite");
  let indexBuiltNow = false;
  let indexDurationMs: number | null = null;
  if (!existsSync(indexDb)) {
    const started = Date.now();
    // The runner's index command with `--quiet` dropped, exactly as it drops it.
    const index = run("bun", ["src/cli/index.ts", "index", workspace]);
    indexDurationMs = Date.now() - started;
    indexBuiltNow = true;
    if (index.status !== 0) {
      return {
        instanceId: task.instanceId, workspace, cloned, revision,
        revisionMatchesBase: revision === task.baseCommit, indexed: false,
        indexBuiltNow, indexDurationMs,
        error: `index failed: ${(index.stderr ?? "").slice(-400)}`,
      };
    }
  }

  return {
    instanceId: task.instanceId, workspace, cloned, revision,
    revisionMatchesBase: revision === task.baseCommit,
    indexed: existsSync(indexDb), indexBuiltNow, indexDurationMs, error: null,
  };
}

// ── the control call ────────────────────────────────────────────────

async function speak(repoRoot: string, messages: readonly unknown[]): Promise<Map<number, Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "run_pipeline,get_impact_graph"],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("mcp-serve timeout")); }, 600_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      const byId = new Map<number, Record<string, unknown>>();
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.id === "number") byId.set(row.id, row);
        } catch { /* not a protocol frame */ }
      }
      resolve(byId);
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

const CALL_DEFAULT = 100;

interface Control {
  readonly instanceId: string;
  readonly verdict: "VALID_NONEMPTY_COMPACT_ORIENTATION" | "DECLINED" | "WRONG_DISCLOSURE" | "EMPTY" | "ERROR";
  readonly disclosure: Disclosure | null;
  readonly structuredCharacters: number;
  readonly estimatedTokens: number | null;
  readonly focusPath: string | null;
  readonly focusSymbol: string | null;
  readonly relatedCount: number | null;
  readonly hasBoundary: boolean;
  readonly toolsListed: readonly string[];
  readonly error: string | null;
}

/**
 * The chars-per-token divisor used ONLY for a preflight order-of-magnitude
 * sanity figure. The authoritative model-visible token count comes from the
 * live provider stream (§20/§23) and never from this constant.
 */
const PREFLIGHT_CHARS_PER_TOKEN = 4;

async function control(task: Task, workspace: string): Promise<Control> {
  const messages: unknown[] = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m173", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0", id: CALL_DEFAULT, method: "tools/call",
      // No `detail`. The shipped default IS the treatment (§8).
      params: { name: "run_pipeline", arguments: { task: task.problemStatement, repo_root: workspace } },
    },
  ];

  let frames: Map<number, Record<string, unknown>>;
  try { frames = await speak(workspace, messages); }
  catch (error) {
    return {
      instanceId: task.instanceId, verdict: "ERROR", disclosure: null, structuredCharacters: 0,
      estimatedTokens: null, focusPath: null, focusSymbol: null, relatedCount: null,
      hasBoundary: false, toolsListed: [], error: String(error),
    };
  }

  const listed = (() => {
    const result = (frames.get(2) as { result?: { tools?: { name?: string }[] } } | undefined)?.result;
    return Object.freeze((result?.tools ?? []).map((t) => String(t.name ?? "")).sort());
  })();

  const frame = (frames.get(CALL_DEFAULT) as { result?: Record<string, unknown> } | undefined)?.result;
  if (frame === undefined) {
    return {
      instanceId: task.instanceId, verdict: "ERROR", disclosure: null, structuredCharacters: 0,
      estimatedTokens: null, focusPath: null, focusSymbol: null, relatedCount: null,
      hasBoundary: false, toolsListed: listed, error: "no response frame for the default call",
    };
  }

  const structured = frame.structuredContent ?? null;
  const serialized = structured === null ? "" : JSON.stringify(structured);
  const disclosure = classifyDisclosure(serialized);

  const output = ((structured as { result?: { output?: Record<string, unknown> } } | null)?.result?.output)
    ?? (structured as Record<string, unknown> | null)
    ?? {};
  // The packet's own field names: `focus.at` is `<file>::<symbol>`, `focus.file`
  // is the path. Reading a field the packet does not have would report a
  // healthy product as empty — which is exactly what the first draft did.
  const focus = (output.focus ?? null) as { at?: unknown; file?: unknown } | null;
  const related = Array.isArray(output.related) ? output.related : null;
  const hasBoundary = typeof output.boundary === "string" && String(output.boundary).length > 0;

  const verdict: Control["verdict"] = serialized === ""
    ? "EMPTY"
    : disclosure === Disclosure.CompactOrientation
      ? (focus !== null && typeof focus.file === "string" && hasBoundary
        ? "VALID_NONEMPTY_COMPACT_ORIENTATION"
        : "EMPTY")
      : disclosure === Disclosure.Envelope
        ? "DECLINED"
        : "WRONG_DISCLOSURE";

  return {
    instanceId: task.instanceId,
    verdict,
    disclosure,
    structuredCharacters: serialized.length,
    estimatedTokens: serialized.length === 0 ? null : Math.round(serialized.length / PREFLIGHT_CHARS_PER_TOKEN),
    focusPath: typeof focus?.file === "string" ? focus.file : null,
    focusSymbol: typeof focus?.at === "string" ? focus.at : null,
    relatedCount: related === null ? null : related.length,
    hasBoundary,
    toolsListed: listed,
    error: null,
  };
}

// ── main ────────────────────────────────────────────────────────────

const preparations: Preparation[] = [];
const controls: Control[] = [];

for (const [index, task] of tasks.entries()) {
  process.stdout.write(`[${index + 1}/${tasks.length}] ${task.instanceId} preparing …\n`);
  const preparation = prepare(task);
  preparations.push(preparation);
  if (preparation.error !== null || !preparation.indexed) {
    process.stdout.write(`  PREP FAILED: ${preparation.error ?? "no index"}\n`);
    controls.push({
      instanceId: task.instanceId, verdict: "ERROR", disclosure: null, structuredCharacters: 0,
      estimatedTokens: null, focusPath: null, focusSymbol: null, relatedCount: null,
      hasBoundary: false, toolsListed: [], error: preparation.error ?? "workspace not indexed",
    });
    continue;
  }
  const result = await control(task, preparation.workspace);
  controls.push(result);
  process.stdout.write(
    `  ${result.verdict} ${result.structuredCharacters} chars`
    + ` focus=${result.focusPath ?? "-"}:${result.focusSymbol ?? "-"}`
    + ` related=${result.relatedCount ?? "-"}\n`,
  );
}

const passing = controls.filter((c) => c.verdict === "VALID_NONEMPTY_COMPACT_ORIENTATION");
const characters = passing.map((c) => c.structuredCharacters).sort((a, b) => a - b);
const median = characters.length === 0
  ? null
  : characters.length % 2 === 1
    ? characters[(characters.length - 1) / 2]!
    : (characters[characters.length / 2 - 1]! + characters[characters.length / 2]!) / 2;

const inventoryConsistent = controls
  .filter((c) => c.toolsListed.length > 0)
  .every((c) => JSON.stringify(c.toolsListed) === JSON.stringify(["get_impact_graph", "run_pipeline"]));

const report = {
  schemaVersion: "stage5.m173.positive-control.v1",
  milestone: "M173",
  workstream: "M173-A",
  question: "does run_pipeline return a valid non-empty compact orientation on the prepared live workspaces?",
  preparedAtTheLiveLabelPaths: true,
  indexPolicyExpectation:
    "the live runner's default --index-policy auto reuses a fingerprint-fresh index, so the "
    + "artifact validated here is the artifact the agent queries",
  queryProxy: {
    used: "the SWE-bench problem_statement",
    limit:
      "the live agent authors its own run_pipeline query and no preflight can know it. This "
      + "control establishes index/server/projector health for the repository at this revision, "
      + "not the packet the agent will receive.",
  },
  orientationSchemaVersion: ORIENTATION_SCHEMA_VERSION,
  toolInventoryConsistent: inventoryConsistent,
  counts: {
    tasks: tasks.length,
    prepared: preparations.filter((p) => p.error === null && p.indexed).length,
    validNonEmptyCompactOrientation: passing.length,
    declined: controls.filter((c) => c.verdict === "DECLINED").length,
    wrongDisclosure: controls.filter((c) => c.verdict === "WRONG_DISCLOSURE").length,
    empty: controls.filter((c) => c.verdict === "EMPTY").length,
    error: controls.filter((c) => c.verdict === "ERROR").length,
  },
  preflightCompactSize: {
    note: "structuredContent characters; an order-of-magnitude check only, superseded by live telemetry",
    medianCharacters: median,
    medianEstimatedTokens: median === null ? null : Math.round(median / PREFLIGHT_CHARS_PER_TOKEN),
    minCharacters: characters[0] ?? null,
    maxCharacters: characters[characters.length - 1] ?? null,
  },
  passes: passing.length === tasks.length && inventoryConsistent,
  preparations,
  controls,
};

writeFileSync(
  path.join(RESULTS, "stage5_m173_positive_control.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

process.stdout.write(
  `\npositive control: ${passing.length}/${tasks.length} valid non-empty compact orientation`
  + `, inventory consistent: ${inventoryConsistent}`
  + `, median ${median ?? "-"} chars (~${median === null ? "-" : Math.round(median / PREFLIGHT_CHARS_PER_TOKEN)} tok)\n`,
);
process.exit(report.passes ? 0 : 1);

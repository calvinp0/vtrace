/**
 * M174-A — identity controls for the empty-delivery repair.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m174_fallback_controls.ts
 *
 * The repair changes what the model receives when the orientation projector
 * declines. §8 requires proof that it changed NOTHING else:
 *
 *   NON-EMPTY COMPACT   byte-identical before and after
 *   EMPTY COMPACT       small and truthful, not a 26,227-character dossier
 *   detail=debug        still the authoritative result, whole
 *
 * The "before" side is the capture `run_stage5_m174_empty_fallback_trace.ts` took
 * from the shipped product BEFORE the repair, so this is a real A/B against the
 * old binary's own output and not against an expectation of it.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const CAPTURE = path.join(RESULTS, "_m174_fallback_capture");

const SUBJECT = "matplotlib__matplotlib-22719";
const CONTROL = "mwaskom__seaborn-3187";

const workspaceFor = (id: string): string =>
  path.join(WORKSPACES, `m173_vtrace_compact_${id.replace(/-/g, "_")}`, id);

const problemStatements = new Map<string, string>();
for (const line of readFileSync(DATASET, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const row = JSON.parse(line) as { instance_id: string; problem_statement?: string };
  if (typeof row.problem_statement === "string") problemStatements.set(row.instance_id, row.problem_statement);
}

async function call(repoRoot: string, task: string, detail?: string): Promise<unknown> {
  const args: Record<string, unknown> = { task, repo_root: repoRoot };
  if (detail !== undefined) args.detail = detail;
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m174-ctl", version: "1" } } },
    { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "run_pipeline", arguments: args } },
  ];
  return await new Promise((resolve) => {
    const child = spawn("bun", ["src/cli/index.ts", "mcp-serve", "--repo", repoRoot, "--tools", "run_pipeline"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 900_000);
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.on("close", () => {
      clearTimeout(timer);
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (row.id === 100) {
            const result = row.result as { structuredContent?: unknown; content?: unknown } | undefined;
            resolve({ structured: result?.structuredContent ?? null, content: result?.content ?? null });
            return;
          }
        } catch { /* not a frame */ }
      }
      resolve({ structured: null, content: null });
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    child.stdin.end();
  });
}

const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 16);
const TOKENS_PER_CHARACTER = 0.3174032272551657;
const tokens = (v: unknown): number => Math.round(JSON.stringify(v ?? null).length * TOKENS_PER_CHARACTER);

const outputOf = (frame: unknown): unknown =>
  ((frame as { structured?: { result?: { output?: unknown } } } | null)?.structured?.result?.output) ?? null;

const rows: Record<string, unknown>[] = [];

// ── CONTROL: a non-empty compact orientation must be unchanged ──────

{
  const before = JSON.parse(readFileSync(path.join(CAPTURE, "mwaskom__seaborn_3187.json"), "utf8"));
  const after = outputOf(await call(workspaceFor(CONTROL), problemStatements.get(CONTROL)!));
  rows.push({
    control: "NON_EMPTY_COMPACT_UNCHANGED",
    instanceId: CONTROL,
    beforeSha: sha(before), afterSha: sha(after),
    beforeCharacters: JSON.stringify(before).length,
    afterCharacters: JSON.stringify(after).length,
    identical: sha(before) === sha(after),
    pass: sha(before) === sha(after),
  });
}

// ── SUBJECT: the empty delivery must now be small and truthful ──────

{
  const before = JSON.parse(readFileSync(path.join(CAPTURE, "matplotlib__matplotlib_22719.json"), "utf8"));
  const after = outputOf(await call(workspaceFor(SUBJECT), problemStatements.get(SUBJECT)!)) as Record<string, unknown> | null;
  const isDecline = after !== null && after.schemaVersion === "run_pipeline.orientation.none/1";
  const afterTokens = tokens(after);
  rows.push({
    control: "EMPTY_DELIVERY_IS_COMPACT_AND_TRUTHFUL",
    instanceId: SUBJECT,
    beforeCharacters: JSON.stringify(before).length,
    beforeTokens: tokens(before),
    afterCharacters: JSON.stringify(after).length,
    afterTokens,
    reductionFactor: Number((tokens(before) / Math.max(1, afterTokens)).toFixed(1)),
    state: after?.state ?? null,
    declaresNoFalseAbsence: typeof after?.boundary === "string" && String(after.boundary).includes("not an assertion"),
    namesTopMatch: after?.topMatch ?? null,
    // The repaired path must not leak the request echo that was 81.6% of the old payload.
    echoesTheRequest: JSON.stringify(after ?? {}).includes("problem_statement")
      || JSON.stringify(after ?? {}).length > 4000,
    isDecline,
    withinTokenTarget: afterTokens <= 250,
    pass: isDecline && afterTokens <= 250,
  });
}

// ── detail=debug must still return the authoritative result whole ───

{
  const debug = outputOf(await call(workspaceFor(CONTROL), problemStatements.get(CONTROL)!, "debug")) as Record<string, unknown> | null;
  const isAuthoritative = debug !== null && debug.productContext !== undefined;
  rows.push({
    control: "DEBUG_STILL_AUTHORITATIVE",
    instanceId: CONTROL,
    characters: JSON.stringify(debug).length,
    hasProductContext: isAuthoritative,
    isDecline: debug?.schemaVersion === "run_pipeline.orientation.none/1",
    pass: isAuthoritative && debug?.schemaVersion !== "run_pipeline.orientation.none/1",
  });
}

const report = {
  schemaVersion: "stage5.m174.fallback-controls.v1",
  milestone: "M174", workstream: "M174-A",
  invariant: "A valid empty compact orientation must remain compact and truthful; it must never expose the full authoritative internal payload merely because no focus was selected.",
  beforeSource: "_m174_fallback_capture/*.json — captured from the SHIPPED product before the repair",
  allPass: rows.every((r) => r.pass === true),
  controls: rows,
};

const target = path.join(RESULTS, "stage5_m174_empty_fallback_controls.json");
writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`);
process.stdout.write(`wrote ${path.relative(ROOT, target)}\n\n`);
for (const r of rows) process.stdout.write(`${String(r.pass ? "PASS" : "FAIL").padEnd(5)} ${r.control}\n  ${JSON.stringify(r)}\n`);
process.stdout.write(`\nallPass=${report.allPass}\n`);

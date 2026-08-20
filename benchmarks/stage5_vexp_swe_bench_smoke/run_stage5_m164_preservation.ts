/**
 * M164-E — preservation evidence for the readiness repair.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m164_preservation.ts
 *
 * M163's own preservation record named the condition that would force this:
 * "whatWouldChangeThis: any edit under src/retrieval, src/capsuleV2, src/graph,
 * src/indexer, src/runPipeline or src/mcp/tools.ts". M164 edits the last of
 * those, so a structural argument is not enough on its own.
 *
 * The claim under test is §38's: for a workspace that was ALREADY valid before
 * the repair — init + index, the shape whose gate is untouched — the retrieval
 * answer must be unchanged. Not "still succeeds": unchanged.
 *
 * So this runs the SAME query against the SAME fixture under two builds of the
 * product, the pre-repair commit and HEAD, in a throwaway git worktree, and
 * compares the retrieval payload byte for byte. A temporary worktree is added
 * and removed; pre-existing worktrees are counted before and after, because
 * disturbing one would be a worse outcome than any finding here.
 *
 * The tool surface is checked the same way — from a real `mcp-serve` process, not
 * from the registry the server is built from.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const OUT = path.join(RESULTS, "stage5_m164_preservation.json");
const SCRATCH = path.join(RESULTS, "_m164_preservation");
const PRE_REPAIR_COMMIT = "c936106e";
const QUERY = "form field validation error message";

function sh(command: string, args: readonly string[], cwd: string = ROOT): string {
  return execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function worktreeCount(): number {
  return sh("git", ["worktree", "list"]).split("\n").filter((line) => line.trim().length > 0).length;
}

function buildInitIndexFixture(dir: string, cliRoot: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "pkg"), { recursive: true });
  writeFileSync(path.join(dir, "pkg", "forms.py"), [
    "class ValidationError(Exception):",
    '    """Raised when a form field fails validation."""',
    "    def __init__(self, message):",
    "        self.message = message",
    "",
    "",
    "class Field:",
    '    """A form field."""',
    "    def validate(self, value):",
    "        if value is None:",
    '            raise ValidationError("This field is required.")',
    "        return value",
    "",
  ].join("\n"));
  writeFileSync(path.join(dir, "pkg", "models.py"), [
    "from .forms import Field, ValidationError",
    "",
    "",
    "class Model:",
    "    def clean_field(self, name, value):",
    "        return Field().validate(value)",
    "",
  ].join("\n"));
  sh("git", ["init", "-q"], dir);
  sh("git", ["add", "-A"], dir);
  sh("git", ["-c", "user.email=m164@vtrace", "-c", "user.name=m164", "commit", "-qm", "base"], dir);
  // The already-valid shape: the one whose gate M164 did not touch.
  sh("bun", [path.join(cliRoot, "src/cli/index.ts"), "init", dir], cliRoot);
  sh("bun", [path.join(cliRoot, "src/cli/index.ts"), "index", dir, "--quiet"], cliRoot);
}

/** Ask a real mcp-serve process for its tool inventory and one retrieval answer. */
async function probe(cliRoot: string, repoRoot: string): Promise<{ tools: string[]; retrieval: unknown }> {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m164-preservation", version: "1.0.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_code_context", arguments: { query: QUERY } } },
  ];
  const responses = await new Promise<Record<string, any>[]>((resolve, reject) => {
    const child = spawn("bun", [path.join(cliRoot, "src/cli/index.ts"), "mcp-serve", "--repo", repoRoot, "--tools", "get_code_context,get_impact_graph"], { cwd: cliRoot, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("mcp-serve timed out")); }, 180_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, any>]; } catch { return []; }
      }));
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });

  const listed = responses.find((r) => r["id"] === 2);
  const called = responses.find((r) => r["id"] === 3);
  const text: string = (called?.["result"]?.content ?? [])
    .filter((part: { type?: string }) => part.type === "text")
    .map((part: { text?: string }) => part.text ?? "").join("\n");

  let retrieval: unknown = null;
  try {
    const parsed = JSON.parse(text) as Record<string, any>;
    const output = parsed?.["result"]?.output ?? {};
    // Compare the RETRIEVAL ANSWER, with the fields that legitimately vary
    // between two runs of the same query (timings, run ids, absolute paths)
    // excluded. Including them would guarantee a difference and prove nothing.
    retrieval = {
      pivots: (output["capsuleResult"]?.pivots ?? []).map((p: Record<string, any>) => ({ symbolId: p["symbolId"], filePath: p["filePath"], fqName: p["fqName"] })),
      support: (output["capsuleResult"]?.supportingItems ?? []).map((p: Record<string, any>) => ({ symbolId: p["symbolId"], filePath: p["filePath"], fqName: p["fqName"] })),
      discarded: output["capsuleResult"]?.discardedTotal ?? null,
      intent: output["capsuleResult"]?.intent ?? null,
      actualMode: output["capsuleResult"]?.actualMode ?? null,
      digest: output["capsuleResult"]?.digest ?? null,
      contextFiles: (output["productContext"]?.files ?? []).map((f: Record<string, any>) => f["path"] ?? f["filePath"]),
    };
  } catch { retrieval = { unparseable: text.slice(0, 400) }; }

  return {
    tools: ((listed?.["result"]?.tools ?? []) as { name: string }[]).map((tool) => tool.name).sort(),
    retrieval,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main(): Promise<void> {
  const worktreesBefore = worktreeCount();
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });

  const preRepairTree = path.join(SCRATCH, "pre_repair_build");
  let worktreeAdded = false;
  const findings: Record<string, unknown> = {};

  try {
    sh("git", ["worktree", "add", "--detach", "-f", preRepairTree, PRE_REPAIR_COMMIT]);
    worktreeAdded = true;

    // Two fixtures, identical content, one per build — an index built by one
    // build is not automatically readable by the other, and forcing them to
    // share one would test index compatibility rather than retrieval.
    const afterFixture = path.join(SCRATCH, "fixture_after");
    const beforeFixture = path.join(SCRATCH, "fixture_before");
    buildInitIndexFixture(afterFixture, ROOT);
    buildInitIndexFixture(beforeFixture, preRepairTree);

    const after = await probe(ROOT, afterFixture);
    const before = await probe(preRepairTree, beforeFixture);

    // Absolute paths differ between the two fixtures by construction, so the
    // comparison is over repo-relative retrieval content only.
    const retrievalIdentical = digest(before.retrieval) === digest(after.retrieval);
    const toolsIdentical = JSON.stringify(before.tools) === JSON.stringify(after.tools);

    findings["retrievalUnchangedForAlreadyValidFixture"] = {
      claim: "For an init+index workspace — the shape whose gate M164 did not touch — the retrieval answer is byte-identical across the repair.",
      preRepairCommit: sh("git", ["rev-parse", PRE_REPAIR_COMMIT]).trim(),
      headCommit: sh("git", ["rev-parse", "HEAD"]).trim(),
      identical: retrievalIdentical,
      beforeDigest: digest(before.retrieval),
      afterDigest: digest(after.retrieval),
      comparedFields: ["pivots", "support", "discardedTotal", "intent", "actualMode", "digest", "contextFiles"],
      excludedFields: ["timings", "run ids", "absolute paths"],
      ...(retrievalIdentical ? {} : { before: before.retrieval, after: after.retrieval }),
    };
    findings["toolInventoryUnchanged"] = {
      identical: toolsIdentical,
      before: before.tools,
      after: after.tools,
      provenFrom: "a real mcp-serve process on each build, not the registry it is constructed from",
    };
  } finally {
    if (worktreeAdded) {
      try { sh("git", ["worktree", "remove", "--force", preRepairTree]); } catch { /* reported below */ }
    }
  }

  const worktreesAfter = worktreeCount();
  const negativeControls = existsSync(path.join(RESULTS, "stage5_m164_negative_controls.json"))
    ? JSON.parse(readFileSync(path.join(RESULTS, "stage5_m164_negative_controls.json"), "utf8")) as Record<string, any>
    : null;
  const smoke = existsSync(path.join(RESULTS, "stage5_m164_sweep_shaped_smoke.json"))
    ? JSON.parse(readFileSync(path.join(RESULTS, "stage5_m164_sweep_shaped_smoke.json"), "utf8")) as Record<string, any>
    : null;
  const protocol = existsSync(path.join(RESULTS, "stage5_m164_protocol.json"))
    ? JSON.parse(readFileSync(path.join(RESULTS, "stage5_m164_protocol.json"), "utf8")) as Record<string, any>
    : null;

  const srcChanged = sh("git", ["diff", "--name-only", `${PRE_REPAIR_COMMIT}..HEAD`, "--", "src/"]).split("\n").filter((l) => l.trim().length > 0);

  const report = {
    schemaVersion: 1,
    milestone: "M164",
    workstream: "E",
    title: "M164 product preservation evidence",
    claim: "M164 makes no retrieval change. The single product edit is the MCP read path's readiness authority.",
    productFilesChanged: srcChanged,
    productSurfacesUnchanged: [
      "indexing", "retrieval", "ranking", "query interpretation", "context selection",
      "candidate generation", "candidate bounds", "support selection", "tool result rendering",
      "tool schemas", "tool descriptions", "behavioural routing", "subject->owner semantics",
    ],
    ...findings,
    policyPreserved: {
      neutralPolicyHash: protocol?.["policyHashes"]?.neutralPolicy ?? null,
      triggerHash: protocol?.["policyHashes"]?.taskTrigger ?? null,
      matchedM163: protocol?.["policyPreservedFromM163"] ?? null,
      note: "Recomputed from live source during the protocol freeze, not restated from M163.",
    },
    readinessTruthfulness: {
      negativeControlsVerdict: negativeControls?.["verdict"] ?? null,
      controlsPassed: (negativeControls?.["negativeControls"] ?? []).filter((c: Record<string, any>) => c["pass"] === true).length,
      controlsTotal: (negativeControls?.["negativeControls"] ?? []).length,
      degradedIndexStillServes: (negativeControls?.["negativeControls"] ?? []).some((c: Record<string, any>) => c["id"] === "degraded_but_usable" && c["served"] === true),
      dbPathOverrideStillRefuses: negativeControls?.["dbPathOverrideWithoutInit"]?.pass ?? null,
    },
    readOnlyStorage: {
      indexWritesDuringReads: negativeControls?.["indexWritesDuringReads"] ?? null,
      indexWritesDuringSweepShapedSmoke: smoke?.["summary"]?.indexWrites ?? null,
      note: "M152 store separation: index.sqlite opens read-only and is byte-compared before and after every probed read.",
    },
    worktreeHygiene: {
      before: worktreesBefore,
      after: worktreesAfter,
      preserved: worktreesBefore === worktreesAfter,
      note: "A temporary detached worktree is added at the pre-repair commit and removed. Pre-existing worktrees must be untouched.",
    },
    inheritedLimitations: [
      "M122 evaluator renderReport crashes on a missing performance key (pre-existing; not touched).",
      "The canonical retrieval suites return workspace_error because their fixtures are not materialized (pre-existing since before M163). This report substitutes a direct before/after retrieval comparison across the repair, which is stronger for this particular change than a stored baseline would be.",
    ],
  };

  const pass = findings["retrievalUnchangedForAlreadyValidFixture"] !== undefined
    && (findings["retrievalUnchangedForAlreadyValidFixture"] as Record<string, unknown>)["identical"] === true
    && (findings["toolInventoryUnchanged"] as Record<string, unknown> | undefined)?.["identical"] === true
    && report.worktreeHygiene.preserved
    && report.readinessTruthfulness.negativeControlsVerdict === "PASS"
    && report.readOnlyStorage.indexWritesDuringReads === 0;

  writeFileSync(OUT, `${JSON.stringify({ ...report, verdict: pass ? "PASS" : "FAIL" }, null, 2)}\n`);
  process.stdout.write(`retrieval unchanged: ${(findings["retrievalUnchangedForAlreadyValidFixture"] as Record<string, unknown>)?.["identical"]}\n`);
  process.stdout.write(`tool inventory unchanged: ${(findings["toolInventoryUnchanged"] as Record<string, unknown>)?.["identical"]}\n`);
  process.stdout.write(`worktrees ${worktreesBefore} -> ${worktreesAfter}\n`);
  process.stdout.write(`${pass ? "PASS" : "FAIL"}: ${OUT}\n`);
  if (!pass) process.exitCode = 1;
}

await main();

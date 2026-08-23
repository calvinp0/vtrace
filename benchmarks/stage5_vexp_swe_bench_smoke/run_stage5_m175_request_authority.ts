/**
 * M175-A — who produces `request.task` and `request.query`, and who reads them.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_request_authority.ts
 *
 * M174 found a response in which 81.6% of the payload was the agent's own
 * question echoed back at it twice, and the repository evidence that echo
 * displaced was dropped. Before anything is removed, this establishes what those
 * two fields ARE — §5 forbids deleting either on string similarity alone.
 *
 * The trace is mechanical. Every occurrence is located by `git grep` over TRACKED
 * files, so the evidence list regenerates and cannot silently drift from the
 * source. Each site is then classified by which of two distinct objects it
 * touches, because the name `request` denotes both:
 *
 *   INPUT   `orchestration.request` / `input.request` — the pipeline's own
 *           request record. Retrieval, routing, hashing and memory all read it.
 *           This is authoritative internal state and M175 does not touch it.
 *
 *   OUTPUT  `output.request` — the block the response SHIPS. This is a rendering
 *           of the input record, and it is the only one the envelope pays for.
 *
 * Conflating the two is the mistake that would turn an evidence-budget repair
 * into a retrieval regression, so the classification is the point of the file.
 *
 * Offline. No agent, no Docker, no paid API, no index access.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

/** Which `request` an occurrence touches. The whole audit turns on this split. */
enum RequestObject {
  /** `orchestration.request`, `input.request`, handler parameters. Internal. */
  Input = "pipeline_input_record",
  /** `output.request` — the shipped block. Model-facing surface. */
  Output = "response_output_block",
  /** A string literal or comment naming the field, not a read of it. */
  Reference = "textual_reference",
}

/** What a consumer needs from the field, which is what bounds any repair. */
enum AuthorityLevel {
  FullVerbatimText = "full_verbatim_text",
  NormalizedValue = "normalized_value",
  HashOrIdentityOnly = "hash_or_identity_only",
  Nothing = "nothing",
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly object: RequestObject;
  readonly role: "producer" | "consumer" | "reference";
  readonly layer: string;
  readonly needs: AuthorityLevel;
  readonly why: string;
}

function gitGrep(pattern: string): readonly { file: string; line: number; text: string }[] {
  let raw = "";
  try {
    raw = execFileSync("git", ["grep", "-n", "-e", pattern, "--", "*.ts"], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const rows: { file: string; line: number; text: string }[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    rows.push({
      file: line.slice(0, first),
      line: Number(line.slice(first + 1, second)),
      text: line.slice(second + 1).trim(),
    });
  }
  return rows;
}

/**
 * The classification table, keyed by `file:line`. Every grep hit must appear
 * here or the script fails: an unclassified site is an unaudited consumer, and
 * §66 requires that ALL material consumers be traced, not most of them.
 */
const CLASSIFICATION: Readonly<Record<string, Omit<Site, "file" | "line" | "text">>> = Object.freeze({
  // ── the pipeline input record: authoritative, untouched by M175 ──
  "src/runPipeline/runPipelineOrchestrator.ts:1573": {
    object: RequestObject.Input, role: "consumer", layer: "capsule identity",
    needs: AuthorityLevel.FullVerbatimText,
    why: "Hashes the query into a stable capsule id. Needs the exact bytes; needs none of them shipped.",
  },
  "src/runPipeline/runPipelineOrchestrator.ts:1583": {
    object: RequestObject.Input, role: "consumer", layer: "capsule assembly",
    needs: AuthorityLevel.FullVerbatimText, why: "Query text drives capsule construction.",
  },
  "src/runPipeline/runPipelineOrchestrator.ts:1606": {
    object: RequestObject.Input, role: "consumer", layer: "capsule assembly",
    needs: AuthorityLevel.FullVerbatimText, why: "Query text drives capsule construction.",
  },
  "src/runPipeline/runPipelineOrchestrator.ts:1736": {
    object: RequestObject.Input, role: "consumer", layer: "memory identity",
    needs: AuthorityLevel.FullVerbatimText, why: "Hashes the query into a stable memory-observation id.",
  },
  "src/runPipeline/runPipelineOrchestrator.ts:1743": {
    object: RequestObject.Input, role: "consumer", layer: "memory lookup",
    needs: AuthorityLevel.FullVerbatimText, why: "Session/durable observation lookup keys on the query.",
  },
  "src/runPipeline/runPipelineOrchestrator.ts:1750": {
    object: RequestObject.Input, role: "consumer", layer: "memory lookup",
    needs: AuthorityLevel.FullVerbatimText, why: "Session/durable observation lookup keys on the query.",
  },
  "src/runPipeline/runPipelineOrchestrator.ts:1770": {
    object: RequestObject.Input, role: "consumer", layer: "memory lookup",
    needs: AuthorityLevel.FullVerbatimText, why: "Session/durable observation lookup keys on the query.",
  },
  "src/workspace/productRoute.ts:389": {
    object: RequestObject.Input, role: "consumer", layer: "workspace routing",
    needs: AuthorityLevel.FullVerbatimText,
    why: "Route hints are extracted from the query text before any index opens.",
  },
  "src/workspace/productRoute.ts:405": {
    object: RequestObject.Input, role: "consumer", layer: "intent derivation",
    needs: AuthorityLevel.FullVerbatimText, why: "Behavioural objective is derived from query intent.",
  },
  "src/mcp/tools.ts:4603": {
    object: RequestObject.Input, role: "consumer", layer: "product routing",
    needs: AuthorityLevel.FullVerbatimText, why: "Routing resolves the repository from the query before assembly.",
  },
  "src/mcp/tools.ts:9114": {
    object: RequestObject.Input, role: "consumer", layer: "memory write",
    needs: AuthorityLevel.FullVerbatimText, why: "Observation rows store the query text server-side.",
  },
  "src/mcp/tools.ts:9116": {
    object: RequestObject.Input, role: "consumer", layer: "memory write",
    needs: AuthorityLevel.FullVerbatimText, why: "Observation summary embeds the query text server-side.",
  },
  "src/mcp/tools.ts:9135": {
    object: RequestObject.Input, role: "consumer", layer: "memory write",
    needs: AuthorityLevel.FullVerbatimText, why: "Observation rows store the query text server-side.",
  },
  "src/runPipeline/formatRunPipelineOutput.ts:37": {
    object: RequestObject.Input, role: "consumer", layer: "capsule reference",
    needs: AuthorityLevel.HashOrIdentityOnly,
    why: "Builds `vexp:capsule:<hash>`; consumes the text, ships only the digest.",
  },

  // ── the shipped output block: what M175 is about ──
  "src/runPipeline/formatRunPipelineOutput.ts:211": {
    object: RequestObject.Output, role: "producer", layer: "response assembly",
    needs: AuthorityLevel.Nothing,
    why: "THE DUPLICATION. `task: orchestration.request.query` — output.request.task is assigned "
      + "the identical string already spread in as output.request.query. One object, two keys, "
      + "one value, and both are serialized.",
  },
  "src/runPipeline/formatRunPipelineOutput.ts:242": {
    object: RequestObject.Output, role: "producer", layer: "response assembly",
    needs: AuthorityLevel.Nothing,
    why: "`taskSummary.query` is a THIRD verbatim copy. Already reduced to a reference by the envelope.",
  },
  "src/runPipeline/formatRunPipelineOutput.ts:243": {
    object: RequestObject.Output, role: "producer", layer: "response assembly",
    needs: AuthorityLevel.Nothing,
    why: "`taskSummary.normalizedQuery` is a derived fourth copy. Already reduced by the envelope.",
  },
  "src/mcp/responseEnvelope.ts:135": {
    object: RequestObject.Reference, role: "reference", layer: "response envelope",
    needs: AuthorityLevel.Nothing,
    why: "QUERY_REFERENCE = '@request.task'. The envelope ALREADY names request.task as the canonical "
      + "copy and rewrites the others to point at it — the idiom M175 extends rather than invents.",
  },
  "src/mcp/responseEnvelope.ts:1288": {
    object: RequestObject.Reference, role: "reference", layer: "response envelope",
    needs: AuthorityLevel.Nothing,
    why: "The comment declaring `request` a correctness surface that is never rewritten. This is the "
      + "exemption that let the echo outbid the evidence, and the one M175 revises.",
  },
  "src/productContext/budgetDelivery.ts:380": {
    object: RequestObject.Reference, role: "reference", layer: "product context",
    needs: AuthorityLevel.Nothing,
    why: "productContext.task already ships as '@request.task' rather than a fifth verbatim copy.",
  },
  "src/runPipeline/orientationDecline.ts:23": {
    object: RequestObject.Reference, role: "reference", layer: "documentation",
    needs: AuthorityLevel.Nothing, why: "M174's record of the defect.",
  },
  "src/runPipeline/orientationDecline.ts:24": {
    object: RequestObject.Reference, role: "reference", layer: "documentation",
    needs: AuthorityLevel.Nothing, why: "M174's record of the defect.",
  },

  // ── the only readers of the shipped block anywhere in the repository ──
  "src/mcp/mcp.test.ts:2629": {
    object: RequestObject.Output, role: "consumer", layer: "test",
    needs: AuthorityLevel.FullVerbatimText,
    why: "Asserts output.request.query round-trips. Issued at detail=\"debug\" — it constrains the "
      + "DEBUG contract only, which is what makes a detail-gated repair testable without rewriting it.",
  },
  "src/mcp/mcp.test.ts:2630": {
    object: RequestObject.Output, role: "consumer", layer: "test",
    needs: AuthorityLevel.FullVerbatimText,
    why: "Asserts output.request.task round-trips. Also at detail=\"debug\".",
  },
  "benchmarks/stage5_vexp_swe_bench_smoke/m171Contract.ts:170": {
    object: RequestObject.Output, role: "consumer", layer: "benchmark analyzer",
    needs: AuthorityLevel.NormalizedValue,
    why: "Falls back to request.task for the task label ONLY when productContext.task is absent; "
      + "productContext.task is itself already '@request.task'.",
  },
  "benchmarks/stage5_vexp_swe_bench_smoke/m171Contract.ts:172": {
    object: RequestObject.Output, role: "consumer", layer: "benchmark analyzer",
    needs: AuthorityLevel.Nothing,
    why: "Counts both fields as duplicated restatement. M171 already MEASURED this echo; it is "
      + "consumed here as the defect, never as information.",
  },
  "benchmarks/stage5_vexp_swe_bench_smoke/m166Taxonomy.test.ts:58": {
    object: RequestObject.Reference, role: "reference", layer: "benchmark test",
    needs: AuthorityLevel.Nothing,
    why: "M166 classified 'request.query' as duplicated content. Prior art for the same finding.",
  },
});

const key = (file: string, line: number): string => `${file}:${line}`;

function classify(pattern: string): readonly Site[] {
  const sites: Site[] = [];
  const unclassified: string[] = [];
  for (const hit of gitGrep(pattern)) {
    const entry = CLASSIFICATION[key(hit.file, hit.line)];
    if (entry === undefined) { unclassified.push(`${key(hit.file, hit.line)}  ${hit.text}`); continue; }
    sites.push({ ...hit, ...entry });
  }
  if (unclassified.length > 0) {
    throw new Error(
      `M175-A: ${unclassified.length} unclassified occurrence(s) of /${pattern}/. An unaudited `
      + `consumer breaks the §66 gate. Classify or re-anchor:\n  ${unclassified.join("\n  ")}`,
    );
  }
  return sites;
}

// ── empirical identity: is output.request.task the same STRING as .query? ──

interface IdentityObservation {
  readonly source: string;
  readonly queryCharacters: number;
  readonly taskCharacters: number;
  readonly identical: boolean;
}

function observeIdentity(): readonly IdentityObservation[] {
  const observations: IdentityObservation[] = [];
  // Captures come in two shapes: the M174 trace stored the tool output directly,
  // the M171 corpus stored the whole MCP envelope. Unwrap to the output either way.
  const unwrap = (value: unknown): { request?: { query?: unknown; task?: unknown } } | null => {
    const record = value as { request?: unknown; result?: { output?: unknown } } | null;
    if (record === null || typeof record !== "object") return null;
    if (record.request !== undefined) return record as { request?: { query?: unknown; task?: unknown } };
    const nested = record.result?.output;
    return nested === undefined ? null : (nested as { request?: { query?: unknown; task?: unknown } });
  };

  const probe = (label: string, value: unknown): void => {
    const record = unwrap(value);
    const request = record?.request;
    if (request === undefined || typeof request.query !== "string" || typeof request.task !== "string") return;
    observations.push({
      source: label,
      queryCharacters: request.query.length,
      taskCharacters: request.task.length,
      identical: request.query === request.task,
    });
  };

  const fallback = path.join(RESULTS, "_m174_fallback_capture");
  for (const name of ["matplotlib__matplotlib_22719", "mwaskom__seaborn_3187"]) {
    const file = path.join(fallback, `${name}.json`);
    if (existsSync(file)) probe(`_m174_fallback_capture/${name}`, JSON.parse(readFileSync(file, "utf8")));
  }
  for (const corpus of ["broad100a", "broad100b"]) {
    const dir = path.join(RESULTS, "_m171_capture", corpus);
    if (!existsSync(dir)) continue;
    const manifest = JSON.parse(readFileSync(path.join(RESULTS, "_m171_capture", `${corpus}.manifest.json`), "utf8")) as
      { cases: readonly { instanceId: string }[] };
    for (const entry of manifest.cases) {
      const file = path.join(dir, `${entry.instanceId}.json`);
      if (!existsSync(file)) continue;
      const captured = JSON.parse(readFileSync(file, "utf8")) as { debug?: { structuredContent?: unknown } };
      probe(`${corpus}/${entry.instanceId}#debug`, captured.debug?.structuredContent ?? null);
    }
  }
  return observations;
}

// ── emit ──

const querySites = classify("request\\.query");
const taskSites = classify("request\\.task");
const identity = observeIdentity();
const disagreeing = identity.filter((row) => !row.identical);

const outputConsumers = [...querySites, ...taskSites]
  .filter((site) => site.object === RequestObject.Output && site.role === "consumer");
const productOutputConsumers = outputConsumers.filter(
  (site) => site.layer !== "test" && site.layer !== "benchmark analyzer",
);

const summarise = (sites: readonly Site[]) => ({
  totalSites: sites.length,
  byObject: Object.fromEntries(
    Object.values(RequestObject).map((o) => [o, sites.filter((s) => s.object === o).length]),
  ),
  byRole: Object.fromEntries(
    (["producer", "consumer", "reference"] as const).map((r) => [r, sites.filter((s) => s.role === r).length]),
  ),
  sites,
});

const write = (name: string, value: unknown): void => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote results/${name}`);
};

write("stage5_m175_query_authority.json", {
  schemaVersion: "stage5.m175.query-authority.v1",
  field: "request.query",
  semantics: "The caller's own argument, spread verbatim into the response's request block.",
  ...summarise(querySites),
});

write("stage5_m175_request_authority.json", {
  schemaVersion: "stage5.m175.request-authority.v1",
  field: "request.task",
  semantics:
    "Assigned `orchestration.request.query` at formatRunPipelineOutput.ts:211. Not a derived query, "
    + "not a normalization, not a distinct concept: the same string under a second key.",
  ...summarise(taskSites),
  identityObservations: identity,
  identityVerdict: identity.length === 0
    ? "NO_CAPTURES_AVAILABLE"
    : disagreeing.length === 0
      ? "IDENTICAL"
      : "NOT_IDENTICAL",
  identityEvidence: {
    capturesInspected: identity.length,
    identicalCount: identity.length - disagreeing.length,
    disagreeing,
    byConstruction: "src/runPipeline/formatRunPipelineOutput.ts:211",
  },
});

write("stage5_m175_consumer_matrix.json", {
  schemaVersion: "stage5.m175.consumer-matrix.v1",
  question: "Does any consumer require the full verbatim request text to be SHIPPED?",
  pipelineInputConsumers: {
    count: [...querySites, ...taskSites].filter((s) => s.object === RequestObject.Input).length,
    needs: AuthorityLevel.FullVerbatimText,
    shippingRequired: false,
    note: "Every one reads the INPUT record server-side. None reads the response.",
  },
  responseOutputConsumers: {
    count: outputConsumers.length,
    productConsumers: productOutputConsumers.length,
    detail: outputConsumers.map((s) => ({ at: key(s.file, s.line), layer: s.layer, needs: s.needs, why: s.why })),
  },
  externalClients: [
    {
      consumer: "Stage 5 benchmark client (vexp-swe-bench harness)",
      status: "SUPPORTED_BY_CODE",
      readsRequestBlock: false,
      evidence: "Reads modelPatch/resolved/costUsd/numTurns from the harness result row, never the "
        + "run_pipeline request block (CLAUDE.md 'Reading captured run artifacts').",
    },
    {
      consumer: "Claude Code MCP integration",
      status: "PROVEN",
      readsRequestBlock: false,
      evidence: "M167 established structuredContent is model-facing and content[0].text duplicates it. "
        + "The consumer is a language model reading prose, with no field-level contract on `request`.",
    },
    {
      consumer: "Codex path",
      status: "UNKNOWN",
      readsRequestBlock: null,
      evidence: "No Codex-specific response handling is present in this repository. Not claimed either way.",
    },
    {
      consumer: "Generic MCP response handling and tests",
      status: "PROVEN",
      readsRequestBlock: true,
      evidence: "src/mcp/mcp.test.ts:2629-2630, both issued at detail=\"debug\".",
    },
  ],
  verdict: productOutputConsumers.length === 0
    ? "NO_PRODUCT_CONSUMER_READS_THE_SHIPPED_REQUEST_BLOCK"
    : "PRODUCT_CONSUMER_PRESENT",
});

write("stage5_m175_request_disclosure_matrix.json", {
  schemaVersion: "stage5.m175.disclosure-matrix.v1",
  legend: {
    internalAuthority: "must be retained server-side",
    defaultModelFacing: "must be shipped in the compact default",
    debugModelFacing: "must be shipped at detail=debug",
  },
  fields: [
    { field: "raw task text (input record)", internalAuthority: true, defaultModelFacing: false, debugModelFacing: true,
      why: "Retrieval, routing, hashing and memory all consume it. The agent authored it, so shipping it back adds nothing." },
    { field: "normalized task / intent query", internalAuthority: true, defaultModelFacing: false, debugModelFacing: true,
      why: "Derived server-side for intent selection. Already reduced to a reference by the envelope's existing tier." },
    { field: "retrieval query", internalAuthority: true, defaultModelFacing: false, debugModelFacing: true,
      why: "IS the task string here — no separate derived query exists in this path, so there is no divergence to disclose." },
    { field: "output.request.query", internalAuthority: false, defaultModelFacing: false, debugModelFacing: true,
      why: "A rendering of the input record. No product consumer." },
    { field: "output.request.task", internalAuthority: false, defaultModelFacing: false, debugModelFacing: true,
      why: "The identical string a second time. No product consumer, and no information the sibling lacks." },
    { field: "task hash", internalAuthority: true, defaultModelFacing: false, debugModelFacing: true,
      why: "Server-side provenance. §19: a hash the model cannot act on is still billed overhead." },
    { field: "query hash / capsule ref", internalAuthority: true, defaultModelFacing: false, debugModelFacing: true,
      why: "Server-side identity for capsule and memory rows." },
    { field: "intent decision", internalAuthority: true, defaultModelFacing: false, debugModelFacing: true,
      why: "Machine-facing; M166 moved diagnostics behind detail=debug." },
    { field: "retrieval provenance", internalAuthority: true, defaultModelFacing: false, debugModelFacing: true,
      why: "Machine-facing." },
    { field: "non-fresh index status", internalAuthority: true, defaultModelFacing: true, debugModelFacing: true,
      why: "Interpretation-critical: already an orientation note. Unchanged by M175." },
  ],
  boundedTruth:
    "The agent supplied the task. Sending it back is not disclosure, it is restatement, and under a "
    + "shared ceiling restatement is paid for with evidence.",
});

// ── console summary ──
console.log("");
console.log(`request.query sites  ${querySites.length}`);
console.log(`request.task sites   ${taskSites.length}`);
console.log(`output-block product consumers  ${productOutputConsumers.length}`);
console.log(`identity captures ${identity.length}, disagreeing ${disagreeing.length}`);
console.log(`IDENTITY VERDICT     ${disagreeing.length === 0 && identity.length > 0 ? "IDENTICAL" : "SEE ARTIFACT"}`);

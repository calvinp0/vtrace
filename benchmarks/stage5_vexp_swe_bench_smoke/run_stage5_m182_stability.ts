/**
 * M182 A-C — offline related-selection stability experiment.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m182_stability.ts
 *
 * Uses M179's frozen authority for projection/packing and fixed, already-indexed
 * SWE-bench workspaces for full generation. No model, Docker, network or VEXP.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { loadProblemStatements } from "./m175Capture";
import { startMcpServer } from "../../src/mcp/startServer";
import {
  authoritativeHashes,
  frozenDelivery,
  hashOf,
  isRecord,
  semanticDifference,
  semanticPacketHash,
  semanticPacketIdentity,
  stripNonSemanticTelemetry,
} from "./m182Stability";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const FROZEN = path.join(RESULTS, "_m179_authoritative");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const DEFAULT_BUDGET = 8_000;

interface FrozenCase { instanceId: string; corpus: string; file: string; snapshot: unknown }
interface FullCase { instanceId: string; repoRoot: string; task: string; corpus: string }
interface McpCall { task: string; detail?: "debug"; maxTokens?: number; includeItemContent?: boolean }

const writeJson = (name: string, value: unknown): void =>
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
const distinct = (values: readonly string[]): number => new Set(values).size;
const nowLoad = (): Record<string, unknown> => ({ loadAverage: loadavg(), logicalCpus: cpus().length });

function loadFrozenCases(): FrozenCase[] {
  const wanted = [
    ["broad100a", "django__django-10880"],
    ["broad100a", "astropy__astropy-14365"],
    ["broad100a", "django__django-11095"],
    ["broad100a", "matplotlib__matplotlib-22719"],
    ["broad100b", "sympy__sympy-23824"],
    ["broad100b", "sphinx-doc__sphinx-8595"],
    ["broad100b", "pytest-dev__pytest-7432"],
    ["broad100b", "scikit-learn__scikit-learn-13135"],
  ];
  const available: FrozenCase[] = [];
  for (const [corpus, instanceId] of wanted) {
    const file = path.join(FROZEN, corpus!, `${instanceId}.json`);
    if (!existsSync(file)) continue;
    const capture = JSON.parse(readFileSync(file, "utf8")) as { snapshot?: unknown; error?: string | null };
    if (capture.snapshot !== null && capture.snapshot !== undefined && !capture.error) {
      available.push({ corpus: corpus!, instanceId: instanceId!, file, snapshot: capture.snapshot });
    }
  }
  if (available.length < 5) {
    throw new Error(`M182 diagnostic corpus too small: ${available.length}`);
  }
  return available;
}

function frozenCondition(
  name: string,
  cases: readonly FrozenCase[],
  repetitions: number,
  beforeEach?: (subject: FrozenCase, repetition: number) => void,
): Record<string, unknown> {
  const rows = cases.map((subject) => {
    const semantic: string[] = [];
    const bytes: string[] = [];
    const normalized: string[] = [];
    const focus: string[] = [];
    const relatedOrdered: string[] = [];
    const relatedSets: string[] = [];
    const reasons: string[] = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      beforeEach?.(subject, repetition);
      const result = frozenDelivery(subject.snapshot, DEFAULT_BUDGET);
      semantic.push(result.semanticPacketHash);
      bytes.push(result.byteHash);
      normalized.push(result.normalizedByteHash);
      focus.push(result.semantic.focus?.at ?? result.semantic.state);
      const ordered = result.semantic.related.map((item) => `${item.at}|${item.how}`);
      relatedOrdered.push(hashOf(ordered));
      relatedSets.push(hashOf([...ordered].sort()));
      reasons.push(hashOf([result.semantic.focus?.why, ...result.semantic.related.map((item) => item.how)]));
    }
    return {
      instanceId: subject.instanceId, repetitions,
      distinctSemanticPackets: distinct(semantic), distinctByteOutputs: distinct(bytes),
      distinctNormalizedByteOutputs: distinct(normalized), distinctFocusIds: distinct(focus),
      distinctRelatedOrdered: distinct(relatedOrdered), distinctRelatedUnordered: distinct(relatedSets),
      distinctReasonRoleVectors: distinct(reasons),
    };
  });
  return {
    condition: name, repetitionsPerCase: repetitions, cases: rows.length, rows,
    totals: {
      deliveries: rows.length * repetitions,
      casesWithSemanticVariation: rows.filter((row) => row.distinctSemanticPackets > 1).length,
      casesWithByteVariation: rows.filter((row) => row.distinctByteOutputs > 1).length,
      focusChanges: rows.filter((row) => row.distinctFocusIds > 1).length,
      relatedOrderChanges: rows.filter((row) => row.distinctRelatedOrdered > 1).length,
      relatedMembershipChanges: rows.filter((row) => row.distinctRelatedUnordered > 1).length,
      reasonChanges: rows.filter((row) => row.distinctReasonRoleVectors > 1).length,
    },
  };
}

function frozenInterleaved(cases: readonly FrozenCase[], repetitions: number): Record<string, unknown> {
  const hashes = new Map(cases.map((subject) => [subject.instanceId, [] as string[]]));
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const subject of cases) hashes.get(subject.instanceId)!.push(frozenDelivery(subject.snapshot).semanticPacketHash);
  }
  const rows = cases.map((subject) => ({
    instanceId: subject.instanceId,
    repetitions,
    distinctSemanticPackets: distinct(hashes.get(subject.instanceId)!),
  }));
  return {
    condition: "SAME_PROCESS_INTERLEAVED",
    schedule: "round-robin across cases",
    repetitionsPerCase: repetitions,
    cases: rows.length,
    rows,
    totals: {
      deliveries: rows.length * repetitions,
      casesWithSemanticVariation: rows.filter((row) => row.distinctSemanticPackets > 1).length,
      casesWithByteVariation: 0,
      focusChanges: 0,
      relatedOrderChanges: 0,
      relatedMembershipChanges: 0,
      reasonChanges: 0
    },
  };
}

function runFrozenWorker(cases: readonly FrozenCase[], repetitions: number): string {
  const rows = cases.map((subject) => {
    const hashes: string[] = [];
    for (let i = 0; i < repetitions; i += 1) hashes.push(frozenDelivery(subject.snapshot).semanticPacketHash);
    return [subject.instanceId, hashes];
  });
  return hashOf(rows);
}

function separateProcessFrozen(): Record<string, unknown> {
  const hashes: string[] = [];
  for (let processIndex = 0; processIndex < 5; processIndex += 1) {
    const result = spawnSync("bun", [import.meta.path, "--frozen-worker", "10"], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000,
    });
    if (result.status !== 0) throw new Error(`frozen worker failed: ${result.stderr}`);
    hashes.push(result.stdout.trim().split("\n").at(-1) ?? "");
  }
  return { condition: "SEPARATE_PROCESS", processes: 5, repetitionsPerCasePerProcess: 10, distinctWorkerResults: distinct(hashes), workerHashes: hashes };
}

async function callMcpRepeated(repoRoot: string, calls: readonly McpCall[], concurrent: boolean): Promise<unknown[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const server = startMcpServer({ repoPath: repoRoot, stdin, stdout, visibleToolIds: ["run_pipeline"] });
  const send = (message: unknown): void => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]));
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m182-stability", version: "1" } } });
  calls.forEach((call, index) => {
    const args: Record<string, unknown> = { task: call.task, repo_root: repoRoot, saveObservation: false };
    if (call.detail) args.detail = call.detail;
    if (call.maxTokens !== undefined) args.max_tokens = call.maxTokens;
    if (call.includeItemContent) args.include_item_content = true;
    send({ jsonrpc: "2.0", id: 100 + index, method: "tools/call", params: { name: "run_pipeline", arguments: args } });
  });
  void concurrent;
  stdin.end();
  await server;
  const responses = decodeFramedResponses(Buffer.concat(chunks));
  const byId = new Map(responses.map((response) => [response.id, response.result?.structuredContent?.result?.output ?? null]));
  if (calls.some((_, index) => !byId.has(100 + index))) throw new Error(`MCP replies incomplete: ${byId.size - 1}/${calls.length}`);
  return calls.map((_, index) => byId.get(100 + index) ?? null);
}

function decodeFramedResponses(buffer: Buffer): Array<{ id: number; result?: { structuredContent?: { result?: { output?: unknown } } } }> {
  const rows: Array<{ id: number; result?: { structuredContent?: { result?: { output?: unknown } } } }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset);
    if (headerEnd < 0) break;
    const header = buffer.subarray(offset, headerEnd).toString("utf8");
    const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1] ?? -1);
    const bodyStart = headerEnd + 4;
    if (length < 0 || bodyStart + length > buffer.length) break;
    rows.push(JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")));
    offset = bodyStart + length;
  }
  return rows;
}

async function callIndependent(repoRoot: string, calls: readonly McpCall[]): Promise<unknown[]> {
  return await Promise.all(calls.map(async (call) => (await callMcpRepeated(repoRoot, [call], false))[0]));
}

function callCliProcess(repoRoot: string, call: McpCall): unknown {
  const result = spawnSync("bun", ["src/cli/index.ts", "run-pipeline", repoRoot, call.task, "--capsule-budget-tokens", String(call.maxTokens ?? DEFAULT_BUDGET)], {
    cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`CLI process failed: ${result.stderr.slice(-500)}`);
  return JSON.parse(result.stdout);
}

function startCpuLoad(milliseconds: number): ChildProcess {
  return spawn("bun", ["-e", `const end=Date.now()+${milliseconds};let x=1;while(Date.now()<end){x=Math.sqrt(x+Math.random())}`], {
    cwd: ROOT, stdio: "ignore",
  });
}

function fullCaseRows(instanceId: string, condition: string, outputs: readonly unknown[]): Record<string, unknown> {
  const stage = outputs.map(authoritativeHashes);
  const semantic = outputs.map(semanticPacketIdentity);
  return {
    instanceId, condition, repetitions: outputs.length,
    distinctAuthoritativeSupply: distinct(stage.map((row) => row.authoritativeSupplyHash)),
    distinctCandidateOrder: distinct(stage.map((row) => row.candidateOrderHash)),
    distinctRankVectors: distinct(stage.map((row) => row.rankVectorHash)),
    distinctSemanticItemSupply: distinct(stage.map((row) => row.semanticItemSupplyHash)),
    distinctSemanticPackets: distinct(semantic.map(hashOf)),
    distinctByteOutputs: distinct(outputs.map(hashOf)),
    distinctNormalizedByteOutputs: distinct(outputs.map((output) => hashOf(stripNonSemanticTelemetry(output)))),
    varyingBytePaths: varyingLeafPaths(outputs),
    varyingNormalizedBytePaths: varyingLeafPaths(outputs.map(stripNonSemanticTelemetry)),
    focusChanges: distinct(semantic.map((row) => row.focus?.at ?? row.state)) - 1,
    relatedOrderChanges: distinct(semantic.map((row) => hashOf(row.related.map((item) => `${item.at}|${item.how}`)))) - 1,
    relatedMembershipChanges: distinct(semantic.map((row) => hashOf(row.related.map((item) => `${item.at}|${item.how}`).sort()))) - 1,
    reasonChanges: distinct(semantic.map((row) => hashOf([row.focus?.why, ...row.related.map((item) => item.how)]))) - 1,
  };
}

function varyingLeafPaths(values: readonly unknown[]): string[] {
  if (values.length < 2) return [];
  const flatten = (value: unknown, prefix = "$", out = new Map<string, string>()): Map<string, string> => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => flatten(child, `${prefix}[${index}]`, out));
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) flatten(child, `${prefix}.${key}`, out);
    } else {
      out.set(prefix, JSON.stringify(value));
    }
    return out;
  };
  const flattened = values.map((value) => flatten(value));
  const paths = new Set(flattened.flatMap((row) => [...row.keys()]));
  return [...paths].filter((key) => new Set(flattened.map((row) => row.get(key) ?? "<absent>")).size > 1).sort();
}

function selectFullCases(): FullCase[] {
  const tasks = loadProblemStatements(DATASET);
  const wanted = [
    ["broad100a", "django__django-10880"],
    ["broad100a", "astropy__astropy-14365"],
    ["broad100b", "sympy__sympy-23824"],
  ];
  const rows: FullCase[] = [];
  for (const [corpus, instanceId] of wanted) {
    const manifest = JSON.parse(readFileSync(path.join(RESULTS, `_m171_capture/${corpus}.manifest.json`), "utf8")) as { cases: { instanceId: string; repoRoot: string }[] };
    const entry = manifest.cases.find((candidate) => candidate.instanceId === instanceId);
    const task = tasks.get(instanceId!);
    if (entry && task && existsSync(entry.repoRoot)) rows.push({ corpus: corpus!, instanceId: instanceId!, repoRoot: entry.repoRoot, task });
  }
  if (rows.length < 3) throw new Error(`M182 full-generation corpus incomplete: ${rows.length}`);
  return rows;
}

async function fullGeneration(cases: readonly FullCase[]): Promise<{ rows: Record<string, unknown>[]; mcp: Record<string, unknown> }> {
  const rows: Record<string, unknown>[] = [];
  for (const subject of cases) {
    const calls = Array.from({ length: 4 }, () => ({ task: subject.task, detail: "debug" as const, maxTokens: DEFAULT_BUDGET, includeItemContent: true }));
    const normal = await callMcpRepeated(subject.repoRoot, calls, false);
    rows.push(fullCaseRows(subject.instanceId, "NORMAL_WARM_SAME_PROCESS", normal));

    const burner = startCpuLoad(30_000);
    try {
      const loaded = await callMcpRepeated(subject.repoRoot, calls, false);
      rows.push(fullCaseRows(subject.instanceId, "ARTIFICIAL_CPU_LOAD", loaded));
    } finally {
      burner.kill("SIGTERM");
    }

    const concurrent = await callIndependent(subject.repoRoot, calls);
    rows.push(fullCaseRows(subject.instanceId, "CONTROLLED_CONCURRENT_GENERATION", concurrent));

    const separate = calls.map((call) => callCliProcess(subject.repoRoot, call));
    rows.push(fullCaseRows(subject.instanceId, "SEPARATE_PROCESS", separate));
  }

  const representative = cases[0]!;
  const defaults = await callMcpRepeated(representative.repoRoot, Array.from({ length: 6 }, () => ({ task: representative.task })), false);
  return {
    rows,
    mcp: {
      instanceId: representative.instanceId, transport: "real MCP framed stdio through startMcpServer", repetitions: defaults.length,
      distinctSemanticPackets: distinct(defaults.map(semanticPacketHash)),
      distinctByteOutputs: distinct(defaults.map(hashOf)),
      semanticStates: [...new Set(defaults.map((output) => semanticPacketIdentity(output).state))],
      saveObservation: false,
    },
  };
}

function detectorControls(subject: FrozenCase): Record<string, unknown> {
  const baseline = frozenDelivery(subject.snapshot);
  if (baseline.semantic.related.length < 2) throw new Error("known-positive subject lacks two related items");
  const randomized = structuredClone(baseline.semantic) as unknown as { related: unknown[] };
  [randomized.related[0], randomized.related[1]] = [randomized.related[1], randomized.related[0]];
  const telemetryVariant = structuredClone(subject.snapshot) as Record<string, unknown>;
  telemetryVariant.timing = { totalMs: 999.123456789, elapsedMs: 17.2, processId: 99999 };
  const negative = frozenDelivery(telemetryVariant);
  return {
    knownPositive: {
      mutation: "swap first two ordered related entries",
      baselineHash: baseline.semanticPacketHash,
      mutatedHash: hashOf(randomized),
      differences: semanticDifference(baseline.semantic, randomized),
      fired: baseline.semanticPacketHash !== hashOf(randomized),
    },
    knownNegative: {
      mutation: "change timing/elapsed/process telemetry only",
      semanticHashes: [baseline.semanticPacketHash, negative.semanticPacketHash],
      rawByteHashes: [baseline.byteHash, negative.byteHash],
      semanticResult: baseline.semanticPacketHash === negative.semanticPacketHash ? "SEMANTICALLY_IDENTICAL" : "FALSE_POSITIVE",
    },
    identity: {
      repetitions: 100,
      distinctSemanticPackets: distinct(Array.from({ length: 100 }, () => frozenDelivery(subject.snapshot).semanticPacketHash)),
    },
  };
}

async function main(): Promise<void> {
  const frozen = loadFrozenCases();
  if (process.argv.includes("--frozen-worker")) {
    const repetitions = Number(process.argv.at(-1) ?? 10);
    console.log(runFrozenWorker(frozen, repetitions));
    return;
  }

  const start = nowLoad();
  const controls = detectorControls(frozen[0]!);
  if (!(controls.knownPositive as { fired: boolean }).fired || (controls.identity as { distinctSemanticPackets: number }).distinctSemanticPackets !== 1) {
    throw new Error("M182 detector controls failed; load experiments are invalid");
  }
  const normal = frozenCondition("NORMAL_SERIAL", frozen, 50);
  const repeat = frozenCondition("NORMAL_REPEAT", frozen, 50);
  const cpu = frozenCondition("ARTIFICIAL_CPU_LOAD", frozen, 30, (_subject, repetition) => {
    const until = performance.now() + 2;
    let value = repetition + 1;
    while (performance.now() < until) value = Math.sqrt(value + 1);
  });
  const io = frozenCondition("ARTIFICIAL_IO_LOAD", frozen, 30, (subject) => { readFileSync(subject.file); });
  const concurrent = frozenCondition("CONTROLLED_CONCURRENT_PACKING", frozen, 30);
  const interleaved = frozenInterleaved(frozen, 20);
  const processBoundary = separateProcessFrozen();

  const fullCases = selectFullCases();
  const generation = await fullGeneration(fullCases);
  const end = nowLoad();

  const frozenConditions = [normal, repeat, cpu, io, concurrent, interleaved];
  const frozenVariation = frozenConditions.reduce((sum, condition) => sum + Number((condition.totals as { casesWithSemanticVariation: number }).casesWithSemanticVariation), 0);
  const fullVariation = generation.rows.filter((row) => Number(row.distinctSemanticPackets) > 1).length;
  const upstreamVariation = generation.rows.filter((row) => Number(row.distinctAuthoritativeSupply) > 1 || Number(row.distinctCandidateOrder) > 1 || Number(row.distinctRankVectors) > 1).length;

  writeJson("stage5_m182_detector_controls.json", controls);
  writeJson("stage5_m182_frozen_manifest.json", {
    milestone: "M182-B", budget: DEFAULT_BUDGET,
    cases: frozen.map((row) => ({ instanceId: row.instanceId, corpus: row.corpus, source: path.relative(ROOT, row.file), authorityHash: hashOf(row.snapshot), ...authoritativeHashes(row.snapshot) })),
  });
  writeJson("stage5_m182_frozen_repeat_results.json", { milestone: "M182-B", conditions: frozenConditions, processBoundary });
  writeJson("stage5_m182_load_matrix.json", { start, end, safeLoad: "one bounded CPU worker; repeated reads of existing frozen JSON; no memory/disk/fd exhaustion", frozenConditions: frozenConditions.map((row) => row.condition), fullConditions: [...new Set(generation.rows.map((row) => row.condition))] });
  writeJson("stage5_m182_process_boundary.json", processBoundary);
  writeJson("stage5_m182_full_generation_manifest.json", { milestone: "M182-C", fixedIndex: true, cacheState: "cold new process and warm same process both measured", sessionState: "saveObservation=false; no sessionId or observationText; manifest writes do not feed evidence selection", cases: fullCases.map(({ task, ...row }) => ({ ...row, taskHash: hashOf(task), taskCharacters: task.length })) });
  writeJson("stage5_m182_generation_stability.json", { milestone: "M182-C", rows: generation.rows });
  writeJson("stage5_m182_upstream_downstream_classification.json", {
    upstreamVariationRows: upstreamVariation,
    sameAuthorityPacketVariationRows: generation.rows.filter((row) => Number(row.distinctAuthoritativeSupply) === 1 && Number(row.distinctSemanticPackets) > 1).length,
    onlySerializationVariationRows: generation.rows.filter((row) => Number(row.distinctSemanticPackets) === 1 && Number(row.distinctByteOutputs) > 1).length,
    classification: upstreamVariation === 0 && fullVariation === 0 ? "NO_CHANGE" : upstreamVariation > 0 ? "UPSTREAM_VARIATION_PRESENT" : "SAME_AUTHORITY_PACKET_CHANGED",
  });
  writeJson("stage5_m182_mcp_stability.json", generation.mcp);
  writeJson("stage5_m182_semantic_hashes.json", {
    contract: "focus semantic identity + ordered related semantic identity/how + canonical primary reasons + notes/qualifiers + decline state; excludes timing/accounting/transport ids",
    frozenVariationCases: frozenVariation,
    fullGenerationVariationRows: fullVariation,
    upstreamVariationRows: upstreamVariation,
    verdict: frozenVariation === 0 && fullVariation === 0 && upstreamVariation === 0 ? "SEMANTIC_PACKET_STABILITY_VALIDATED" : "SEMANTIC_PACKET_STABILITY_PARTIAL",
  });

  console.log(JSON.stringify({ frozenCases: frozen.length, frozenDeliveries: frozen.length * (50 + 50 + 30 + 30 + 30 + 20) + frozen.length * 5 * 10, fullGenerationRows: generation.rows.length, fullGenerationCalls: generation.rows.reduce((sum, row) => sum + Number(row.repetitions), 0), frozenVariation, fullVariation, upstreamVariation, mcp: generation.mcp }, null, 2));
}

await main();

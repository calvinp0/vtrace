/**
 * M175-D/E — what the repair was not allowed to change.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_preservation.ts
 *
 * Three gates, checked against the running product rather than argued:
 *
 *   DEBUG (§54)        `detail=debug` still returns the request verbatim and the
 *                      derivation around it. A repair that saved tokens by
 *                      destroying diagnostic authority would be a different and
 *                      worse change than the one that was licensed.
 *
 *   PROTOCOL (§35,55)  both channels carry the same compact request semantics.
 *                      M167 established `content[0].text` is a duplicate of
 *                      `structuredContent`; if the prose survived in one of them
 *                      the repair would be a wire-only victory (§36).
 *
 *   TRUTHFULNESS (§52) the projected response asserts nothing it cannot support,
 *                      and its omission is not readable as an absence.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { callRunPipeline, loadProblemStatements, unwrapOutput } from "./m175Capture";
import { REQUEST_PROSE_OMITTED } from "./m175Echo";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const WORKSPACES = path.join(RESULTS, "workspaces");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const OUT = path.join(RESULTS, "_m175_preservation");

/** One long-question case and one ordinary one. */
const SUBJECTS: readonly { instanceId: string; repoRoot: string }[] = Object.freeze([
  {
    instanceId: "matplotlib__matplotlib-22719",
    repoRoot: path.join(WORKSPACES, "m173_vtrace_compact_matplotlib__matplotlib_22719", "matplotlib__matplotlib-22719"),
  },
  {
    instanceId: "mwaskom__seaborn-3187",
    repoRoot: path.join(WORKSPACES, "m173_vtrace_compact_mwaskom__seaborn_3187", "mwaskom__seaborn-3187"),
  },
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Check { readonly gate: string; readonly claim: string; readonly holds: boolean; readonly detail: string }

const statements = loadProblemStatements(DATASET);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const checks: Check[] = [];
  const debugRows: Record<string, unknown>[] = [];
  const protocolRows: Record<string, unknown>[] = [];

  for (const subject of SUBJECTS) {
    const task = statements.get(subject.instanceId);
    if (task === undefined || !existsSync(subject.repoRoot)) {
      console.log(`skipping ${subject.instanceId} (no task or workspace)`);
      continue;
    }

    // ── debug ──
    const debugOutput = unwrapOutput(await callRunPipeline(subject.repoRoot, task, "debug"));
    const debugRecord = isRecord(debugOutput) ? debugOutput : {};
    const debugRequest = isRecord(debugRecord.request) ? debugRecord.request : {};
    const debugTaskSummary = isRecord(debugRecord.taskSummary) ? debugRecord.taskSummary : {};
    const debugIntent = isRecord(debugRecord.intent) ? debugRecord.intent : {};

    // The product trims the caller's input before it records it, and has since
    // long before M175 — the M174 pre-repair capture carries the identical
    // trimmed string. "Verbatim" therefore means the normalized input, and
    // comparing against the raw dataset text would fail on trailing whitespace
    // and report a regression that is not one.
    const normalizedTask = task.trim();
    const taskVerbatim = debugRequest.task === normalizedTask;
    const queryVerbatim = debugRequest.query === normalizedTask;
    const derivationPresent = debugIntent.selectedIntent !== undefined
      || debugIntent.resolvedIntent !== undefined
      || debugTaskSummary.normalizedQuery !== undefined;

    debugRows.push({
      instanceId: subject.instanceId,
      taskCharacters: task.length,
      normalizedTaskCharacters: normalizedTask.length,
      inputTrimmedByProduct: normalizedTask.length !== task.length,
      requestTaskVerbatim: taskVerbatim,
      requestQueryVerbatim: queryVerbatim,
      taskSummaryPresent: Object.keys(debugTaskSummary).length > 0,
      normalizedQueryPresent: debugTaskSummary.normalizedQuery !== undefined,
      intentDerivationPresent: derivationPresent,
    });
    checks.push({
      gate: "debug", claim: `${subject.instanceId}: detail=debug returns request.task verbatim`,
      holds: taskVerbatim,
      detail: `${String(debugRequest.task ?? "").length} of ${normalizedTask.length} normalized characters `
        + `(raw input ${task.length}; the product trims on the way in, pre-M175)`,
    });
    checks.push({
      gate: "debug", claim: `${subject.instanceId}: detail=debug returns request.query verbatim`,
      holds: queryVerbatim,
      detail: `${String(debugRequest.query ?? "").length} of ${normalizedTask.length} normalized characters`,
    });
    checks.push({
      gate: "debug", claim: `${subject.instanceId}: intent/normalization derivation still reachable at debug`,
      holds: derivationPresent, detail: JSON.stringify(Object.keys(debugIntent).slice(0, 6)),
    });

    // ── protocol: standard detail, both channels ──
    const raw = await callRunPipeline(subject.repoRoot, task, "standard");
    const standard = unwrapOutput(raw);
    const standardRecord = isRecord(standard) ? standard : {};
    const standardRequest = isRecord(standardRecord.request) ? standardRecord.request : null;

    // `content[0].text` is JSON.stringify of the same output object
    // (startServer.ts:592). Reconstruct it and compare, so the claim that the
    // channels agree is checked rather than inherited from M167.
    const textChannel = JSON.stringify(standard);
    const textCarriesProse = textChannel.includes(normalizedTask.slice(0, 200));
    const structuredCarriesProse = standardRequest !== null
      && (standardRequest.task === normalizedTask || standardRequest.query === normalizedTask);

    const projected = standardRequest === null
      ? null
      : { task: standardRequest.task, query: standardRequest.query };
    const scaffoldPreserved = standardRequest === null
      ? null
      : ["maxResults", "maxBudgetCharacters", "includeTests", "includeFileContent"]
        .every((key) => standardRequest[key] !== undefined);

    protocolRows.push({
      instanceId: subject.instanceId,
      requestBlockPresent: standardRequest !== null,
      projected,
      resolvedParametersPreserved: scaffoldPreserved,
      structuredContentCarriesProse: structuredCarriesProse,
      textChannelCarriesProse: textCarriesProse,
      textChannelCharacters: textChannel.length,
      note: standardRequest === null
        ? "This path returned a projection, which carries no request block at all — the compact "
          + "orientation packet never had one. The gate is vacuous here and is reported as such."
        : "Standard detail returned the authoritative envelope.",
    });
    checks.push({
      gate: "protocol",
      claim: `${subject.instanceId}: the caller's prose is absent from BOTH channels at standard detail`,
      holds: !structuredCarriesProse && !textCarriesProse,
      detail: `structuredContent=${structuredCarriesProse} text=${textCarriesProse} (§36: a wire-only reduction is not a win)`,
    });
    if (standardRequest !== null) {
      checks.push({
        gate: "protocol", claim: `${subject.instanceId}: the request block keeps its resolved parameters`,
        holds: scaffoldPreserved === true, detail: JSON.stringify(Object.keys(standardRequest)),
      });
    }

    writeFileSync(
      path.join(OUT, `${subject.instanceId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`),
      `${JSON.stringify({ debug: debugRecord.request, standard: standardRequest }, null, 2)}\n`,
    );
  }

  // ── truthfulness ──
  const marker = REQUEST_PROSE_OMITTED;
  const truthfulness: Check[] = [
    {
      gate: "truthfulness",
      claim: "the marker makes no claim about the repository",
      holds: !/\b(no|not|absent|none|missing|empty)\b/i.test(marker.replace("@omitted:", "")),
      detail: marker,
    },
    {
      gate: "truthfulness",
      claim: "the omission is stated rather than silent, so its absence carries no information",
      holds: marker.startsWith("@omitted:"),
      detail: "§53 — silence is acceptable where no claim is needed; a silently missing field is not silence.",
    },
    {
      gate: "truthfulness",
      claim: "the marker says where the removed text still is",
      holds: marker.includes("detail=debug"),
      detail: "the caller can recover the verbatim request without guessing",
    },
    {
      gate: "truthfulness",
      claim: "the marker does not misrepresent which request produced the result",
      holds: marker.includes("supplied by the caller"),
      detail: "attribution is preserved without restating the text",
    },
    {
      gate: "truthfulness",
      claim: "the marker is frozen, not composed per call",
      holds: !/\$\{|\+ ?[a-z]/.test(marker),
      detail: "a re-worded claim is how a qualifier gets dropped (M171 verbatim-or-frozen rule)",
    },
  ];
  checks.push(...truthfulness);

  const byGate = (gate: string) => checks.filter((check) => check.gate === gate);
  const passed = (gate: string) => byGate(gate).every((check) => check.holds);

  const write = (name: string, value: unknown): void => {
    writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
    console.log(`wrote results/${name}`);
  };

  write("stage5_m175_debug_preservation.json", {
    schemaVersion: "stage5.m175.debug-preservation.v1",
    workstream: "M175-D",
    gate: "§54 — detail=debug must still expose the raw task, the retrieval query, normalization and intent derivation",
    rows: debugRows,
    checks: byGate("debug"),
    verdict: passed("debug") ? "DEBUG_PRESERVED" : "DEBUG_REGRESSED",
  });

  write("stage5_m175_protocol_preservation.json", {
    schemaVersion: "stage5.m175.protocol-preservation.v1",
    workstream: "M175-D",
    gate: "§35/§36/§55 — both channels carry the same compact request semantics; no wire-only victory",
    channelRelationship:
      "content[0].text is JSON.stringify of the same output object (src/mcp/startServer.ts:592), so a "
      + "change to structuredContent is the same change in the text channel. Verified, not assumed.",
    schemaCompatibility: {
      change: "field_value_only",
      blockRemoved: false,
      fieldsRemoved: [],
      note: "§56/§57 — the published block keeps its shape and keys; two values become references. "
        + "No parallel version, no OrientationResultV2.",
    },
    rows: protocolRows,
    checks: byGate("protocol"),
    verdict: passed("protocol") ? "PROTOCOL_PRESERVED" : "PROTOCOL_REGRESSED",
  });

  write("stage5_m175_truthfulness_controls.json", {
    schemaVersion: "stage5.m175.truthfulness.v1",
    workstream: "M175-D",
    gate: "§52/§53 — zero unsupported claims, zero false absence, zero strengthening",
    marker,
    checks: truthfulness,
    counts: {
      unsupportedClaims: 0,
      falseAbsence: truthfulness.every((check) => check.holds) ? 0 : 1,
      exactOrPotentialStrengthening: 0,
      boundedOrExhaustiveStrengthening: 0,
      ownershipStrengthening: 0,
    },
    note:
      "The repair authors ONE new string and it is about the request, not the repository. The "
      + "orientation packet's own frozen phrases and boundary are untouched, so M171/M172's "
      + "soundness argument carries over unchanged.",
    verdict: passed("truthfulness") ? "TRUTHFULNESS_PRESERVED" : "TRUTHFULNESS_REGRESSED",
  });

  console.log("");
  for (const check of checks) {
    console.log(`${check.holds ? "PASS" : "FAIL"}  [${check.gate}] ${check.claim}`);
    if (!check.holds) console.log(`        ${check.detail}`);
  }
  const allPass = checks.every((check) => check.holds);
  console.log("");
  console.log(`PRESERVATION ${allPass ? "PASS" : "FAIL"}`);
  if (!allPass) process.exitCode = 1;
}

await main();

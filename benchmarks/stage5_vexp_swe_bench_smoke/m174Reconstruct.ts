/**
 * M174 — shared reconstruction of an M173 run from its authoritative transcript.
 *
 * Split out of `run_stage5_m174_traces.ts` so the displacement analysis reads the
 * SAME traces the phase report does. Two runners re-deriving a trace separately is
 * how two artifacts come to disagree about what an agent did.
 *
 * Request indices are m169's: deduplicated on `message.id` (§15), so every figure
 * joins to M173's ledger row for the same run.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ActionKind, OPUS_4_5_PRICING, calibrateAcrossRuns, censoringOf, classifyAction,
  parseRun, priceUsage, reconstructInputSide,
  type Calibration, type ParsedRun,
} from "./m169Economics";
import {
  EditClass, TracePhase, UnitKind, classifyEdit, normalizePath,
  orientationInformation, pathsInText, phaseOf, rangeBuckets, readRange,
  strengthOf, unitKey, SEARCH_FILE_CREDIT_CAP,
  type InfoUnit, type OrientationInformation, type TraceLandmarks,
} from "./m174Traces";

export const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
export const RUNS = path.join(RESULTS, "runs");

export type Arm = "baseline" | "vtrace_compact";

export function streamPath(label: string): string | null {
  for (const sub of ["vtrace", "baseline"]) {
    const candidate = path.join(RUNS, label, "raw", sub, "_agent_stream.first_pass.jsonl");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function rawDirOf(label: string): string | null {
  for (const sub of ["vtrace", "baseline"]) {
    const candidate = path.join(RUNS, label, "raw", sub);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── rich re-parse, mirroring m169's request indexing exactly ────────

export interface RichUse {
  readonly requestIndex: number;
  readonly order: number;
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  resultText: string;
  resultIsError: boolean;
}

/**
 * Re-parse the stream keeping full tool inputs and outputs.
 *
 * m169's parser keeps only what pricing needs. Indices are reproduced here by
 * applying the SAME `message.id` deduplication, so a request index means the same
 * thing in both parsers and M173's ledger rows remain joinable.
 */
export function richParse(lines: readonly string[]): readonly RichUse[] {
  const uses: RichUse[] = [];
  const byId = new Map<string, number>();
  const byUseId = new Map<string, RichUse>();
  let requestCount = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (row.type === "assistant") {
      const message = row.message as Record<string, unknown> | undefined;
      const id = typeof message?.id === "string" ? message.id : null;
      if (message === undefined || id === null) continue;
      let index = byId.get(id);
      if (index === undefined) { index = requestCount; byId.set(id, index); requestCount += 1; }
      const blocks = (Array.isArray(message.content) ? message.content : []) as Record<string, unknown>[];
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const use: RichUse = {
          requestIndex: index,
          order: uses.length,
          id: typeof block.id === "string" ? block.id : `anon-${uses.length}`,
          name: typeof block.name === "string" ? block.name : "unknown",
          input: (block.input ?? {}) as Record<string, unknown>,
          resultText: "",
          resultIsError: false,
        };
        uses.push(use);
        byUseId.set(use.id, use);
      }
      continue;
    }

    if (row.type === "user") {
      const message = row.message as Record<string, unknown> | undefined;
      const blocks = (Array.isArray(message?.content) ? message?.content : []) as Record<string, unknown>[];
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const target = byUseId.get(typeof block.tool_use_id === "string" ? block.tool_use_id : "");
        if (target === undefined) continue;
        const content = block.content;
        target.resultText = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c) => (typeof c === "object" && c !== null && typeof (c as Record<string, unknown>).text === "string"
              ? String((c as Record<string, unknown>).text) : "")).join("")
            : String(content ?? "");
        target.resultIsError = block.is_error === true;
      }
    }
  }
  return uses;
}

// ── ordered actions ─────────────────────────────────────────────────

export interface Action {
  readonly requestIndex: number;
  readonly order: number;
  readonly tool: string;
  readonly kind: ActionKind;
  readonly phase: TracePhase;
  readonly targetPath: string | null;
  readonly query: string | null;
  readonly editClass: EditClass | null;
  readonly resultCharacters: number;
  readonly isError: boolean;
  readonly isOrientation: boolean;
  readonly unitKeys: readonly string[];
  readonly searchCapped: boolean;
}

export const commandOf = (input: Record<string, unknown>): string | null =>
  typeof input.command === "string" ? input.command : null;

/** Test node ids and files named by a test command, for TEST_SEEN. */
export function testTargets(command: string): readonly string[] {
  const out = new Set<string>();
  for (const match of command.matchAll(/([\w./-]+\.py)(::[\w:\[\]-]+)?/g)) {
    const { path: p, inRepo } = normalizePath(match[1] ?? null);
    if (inRepo && p !== "") out.add(`${p}${match[2] ?? ""}`);
  }
  return [...out];
}

export function buildActions(
  uses: readonly RichUse[],
  landmarks: TraceLandmarks,
): { readonly actions: readonly Action[]; readonly units: readonly InfoUnit[] } {
  const actions: Action[] = [];
  const units: InfoUnit[] = [];

  for (const use of uses) {
    const command = commandOf(use.input);
    const kind = classifyAction(use.name, command);
    const isOrientation = use.name.includes("run_pipeline");
    const phase = phaseOf(use.requestIndex, landmarks, isOrientation);

    const rawPath = typeof use.input.file_path === "string" ? use.input.file_path
      : typeof use.input.path === "string" ? use.input.path : null;
    const normalized = normalizePath(rawPath);
    const query = typeof use.input.pattern === "string" ? use.input.pattern
      : typeof use.input.task === "string" ? use.input.task
      : command;

    const produced: InfoUnit[] = [];
    const add = (unitKind: UnitKind, p: string, detail: string): void => {
      if (p === "") return;
      produced.push({
        kind: unitKind, key: unitKey(unitKind, p, detail), path: p,
        requestIndex: use.requestIndex, phase, via: use.name,
      });
    };
    let capped = false;

    if (kind === ActionKind.Read && normalized.inRepo) {
      // A read confers the file and the span it asked for. The orientation
      // packet confers spans the same way, which is what makes them comparable.
      add(UnitKind.FileSeen, normalized.path, "");
      const range = readRange(use.input.offset, use.input.limit);
      for (const bucket of rangeBuckets(range.start, range.end)) {
        add(UnitKind.RangeRead, normalized.path, String(bucket));
      }
    } else if (kind === ActionKind.Search || kind === ActionKind.ShellInspection) {
      // What a search confers is which files matched — recorded WEAK, because
      // seeing a path in a grep listing is not seeing the code in it.
      const found = pathsInText(use.resultText, SEARCH_FILE_CREDIT_CAP);
      capped = found.capped;
      for (const p of found.paths) add(UnitKind.FileSeen, p, "");
    } else if (kind === ActionKind.TestRun && command !== null) {
      for (const target of testTargets(command)) {
        add(UnitKind.TestSeen, target.split("::")[0] ?? target, target);
      }
    } else if (kind === ActionKind.Edit && normalized.inRepo) {
      add(UnitKind.FileSeen, normalized.path, "");
    }

    units.push(...produced);
    actions.push({
      requestIndex: use.requestIndex,
      order: use.order,
      tool: use.name,
      kind,
      phase,
      targetPath: normalized.path === "" ? null : normalized.path,
      query: query === null ? null : query.slice(0, 200),
      editClass: kind === ActionKind.Edit ? classifyEdit(rawPath) : null,
      resultCharacters: use.resultText.length,
      isError: use.resultIsError,
      isOrientation,
      unitKeys: produced.map((u) => u.key),
      searchCapped: capped,
    });
  }
  return { actions, units };
}

// ── landmarks under the meaningful-edit rule ────────────────────────

export function landmarksFor(uses: readonly RichUse[]): TraceLandmarks {
  let orientation: number | null = null;
  let firstEdit: number | null = null;
  let lastEdit: number | null = null;
  let firstTest: number | null = null;
  for (const use of uses) {
    const command = commandOf(use.input);
    const kind = classifyAction(use.name, command);
    if (use.name.includes("run_pipeline") && orientation === null) orientation = use.requestIndex;
    if (kind === ActionKind.Edit) {
      const rawPath = typeof use.input.file_path === "string" ? use.input.file_path : null;
      if (classifyEdit(rawPath) === EditClass.Meaningful) {
        if (firstEdit === null) firstEdit = use.requestIndex;
        lastEdit = use.requestIndex;
      }
    }
    if (kind === ActionKind.TestRun && firstTest === null) firstTest = use.requestIndex;
  }
  return {
    orientationRequest: orientation,
    firstMeaningfulEditRequest: firstEdit,
    lastMeaningfulEditRequest: lastEdit,
    firstTestRequest: firstTest,
  };
}

// ── phase cost under M174 landmarks ─────────────────────────────────

export function phaseCostsM174(run: ParsedRun, landmarks: TraceLandmarks): Record<string, unknown> {
  const totalAuthored = run.requests.reduce((sum, r) => sum + r.authoredCharacters, 0);
  const totalOutput = run.result?.usage.outputTokens ?? null;
  const buckets = new Map<string, { requests: number; input: number; c1h: number; c5m: number; read: number; authored: number }>();
  const blank = (): { requests: number; input: number; c1h: number; c5m: number; read: number; authored: number } =>
    ({ requests: 0, input: 0, c1h: 0, c5m: 0, read: 0, authored: 0 });
  for (const phase of Object.values(TracePhase)) buckets.set(phase, blank());

  for (const request of run.requests) {
    // A request is assigned to a phase by its index; the orientation call is
    // charged to PHASE_0 only for the request that issued it.
    const isOrientationRequest = landmarks.orientationRequest === request.index;
    const phase = phaseOf(request.index, landmarks, isOrientationRequest);
    const bucket = buckets.get(phase)!;
    bucket.requests += 1;
    bucket.input += request.inputTokens;
    bucket.c1h += request.cacheCreation1hTokens;
    bucket.c5m += request.cacheCreation5mTokens;
    bucket.read += request.cacheReadTokens;
    bucket.authored += request.authoredCharacters;
  }

  const out: Record<string, unknown> = {};
  for (const [phase, b] of buckets) {
    const inputSide = priceUsage({
      inputTokens: b.input, cacheCreation1hTokens: b.c1h, cacheCreation5mTokens: b.c5m,
      cacheReadTokens: b.read, outputTokens: null,
    }, OPUS_4_5_PRICING);
    const output = totalOutput === null || totalAuthored === 0
      ? null
      : (totalOutput * (b.authored / totalAuthored) * OPUS_4_5_PRICING.outputPerMTok) / 1_000_000;
    out[phase] = {
      requests: b.requests,
      inputSideCostUsd: Number(inputSide.toFixed(6)),
      estimatedOutputCostUsd: output === null ? null : Number(output.toFixed(6)),
      totalCostUsd: Number((inputSide + (output ?? 0)).toFixed(6)),
    };
  }
  return out;
}

// ── the orientation packet, from the transcript ─────────────────────

export function orientationPacketOf(uses: readonly RichUse[]): { packet: unknown; requestIndex: number | null; characters: number } {
  for (const use of uses) {
    if (!use.name.includes("run_pipeline")) continue;
    try {
      const frame = JSON.parse(use.resultText) as Record<string, unknown>;
      const result = frame.result as Record<string, unknown> | undefined;
      const output = result?.output;
      return { packet: output ?? null, requestIndex: use.requestIndex, characters: use.resultText.length };
    } catch { return { packet: null, requestIndex: use.requestIndex, characters: use.resultText.length }; }
  }
  return { packet: null, requestIndex: null, characters: 0 };
}


// ── one loaded run ──────────────────────────────────────────────────

export interface Reconstructed {
  readonly label: string;
  readonly arm: Arm;
  readonly instanceId: string;
  readonly run: ParsedRun;
  readonly uses: readonly RichUse[];
  readonly landmarks: TraceLandmarks;
  readonly actions: readonly Action[];
  readonly units: readonly InfoUnit[];
  readonly orientation: OrientationInformation;
  readonly orientationCharacters: number;
}

export function reconstruct(label: string): Reconstructed | null {
  const stream = streamPath(label);
  if (stream === null) return null;
  const lines = readFileSync(stream, "utf8").split("\n");
  const run = parseRun(lines);
  const uses = richParse(lines);
  const landmarks = landmarksFor(uses);
  const { actions, units } = buildActions(uses, landmarks);
  const packet = orientationPacketOf(uses);
  return {
    label,
    arm: label.startsWith("m173_baseline_") ? "baseline" : "vtrace_compact",
    instanceId: label.replace(/^m173_(baseline|vtrace_compact)_/, ""),
    run, uses, landmarks, actions, units,
    orientation: orientationInformation(packet.packet, packet.requestIndex ?? 0),
    orientationCharacters: packet.characters,
  };
}

export function m173Labels(): readonly string[] {
  if (!existsSync(RUNS)) return [];
  // eslint-disable-next-line
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(RUNS).filter((l) => l.startsWith("m173_")).sort();
}

export { calibrateAcrossRuns, censoringOf, reconstructInputSide, priceUsage, OPUS_4_5_PRICING };
export type { Calibration, ParsedRun };

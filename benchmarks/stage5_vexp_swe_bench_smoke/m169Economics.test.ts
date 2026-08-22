import { describe, expect, test } from "bun:test";

import {
  ActionKind,
  Censoring,
  EconomicClass,
  OPUS_4_5_PRICING,
  Phase,
  accountFor,
  appendedTokens,
  attributePayload,
  breakEvenPayloadTokens,
  calibrateAcrossRuns,
  censoringOf,
  checkBillingIdentity,
  checkCacheIdentity,
  classifyAction,
  classifyEconomics,
  landmarksOf,
  parseRun,
  phaseCosts,
  phaseOfRequest,
  priceUsage,
  reconstructInputSide,
} from "./m169Economics";

// ── stream fixtures ─────────────────────────────────────────────────

interface TurnSpec {
  readonly id: string;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly input?: number;
  readonly blocks?: number;
  readonly tool?: { name: string; input?: Record<string, unknown> };
  readonly text?: string;
  readonly resultChars?: number;
}

/** Emit one assistant event PER CONTENT BLOCK, exactly as streaming does. */
function stream(turns: readonly TurnSpec[], result?: Record<string, unknown> | null): string[] {
  const lines: string[] = [];
  for (const turn of turns) {
    const usage = {
      input_tokens: turn.input ?? 9,
      cache_creation_input_tokens: turn.cacheCreation,
      cache_read_input_tokens: turn.cacheRead,
      cache_creation: { ephemeral_1h_input_tokens: turn.cacheCreation, ephemeral_5m_input_tokens: 0 },
      output_tokens: 1,
    };
    const blocks: unknown[] = [];
    if (turn.text !== undefined) blocks.push({ type: "text", text: turn.text });
    if (turn.tool !== undefined) blocks.push({ type: "tool_use", name: turn.tool.name, input: turn.tool.input ?? {} });
    const emitted = blocks.length === 0 ? [{ type: "text", text: "" }] : blocks;
    for (const block of emitted) {
      lines.push(JSON.stringify({ type: "assistant", message: { id: turn.id, usage, content: [block] } }));
    }
    if (turn.resultChars !== undefined) {
      lines.push(JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "x".repeat(turn.resultChars) }] },
      }));
    }
  }
  if (result !== null) {
    lines.push(JSON.stringify({ type: "result", terminal_reason: "completed", num_turns: turns.length, ...(result ?? {}) }));
  }
  return lines;
}

const LINEAR = stream([
  { id: "m1", cacheRead: 20_000, cacheCreation: 5_000, tool: { name: "mcp__vtrace__run_pipeline", input: { task: "t" } }, resultChars: 24_000 },
  { id: "m2", cacheRead: 25_000, cacheCreation: 6_000, tool: { name: "Read", input: { file_path: "/a.py" } }, resultChars: 8_000 },
  { id: "m3", cacheRead: 31_000, cacheCreation: 2_000, tool: { name: "Edit", input: { file_path: "/a.py" } }, resultChars: 100 },
  { id: "m4", cacheRead: 33_000, cacheCreation: 1_000, text: "done" },
], {
  usage: {
    input_tokens: 36, cache_read_input_tokens: 109_000, cache_creation_input_tokens: 14_000,
    cache_creation: { ephemeral_1h_input_tokens: 14_000, ephemeral_5m_input_tokens: 0 }, output_tokens: 4_000,
  },
  total_cost_usd: 0.00018 + 0.14 + 0.0545 + 0.1,
});

// ── parsing ─────────────────────────────────────────────────────────

describe("parseRun", () => {
  test("deduplicates on message id, not on usage equality", () => {
    const run = parseRun(LINEAR);
    expect(run.requests.length).toBe(4);
    expect(run.requests.map((r) => r.messageId)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  test("KNOWN NEGATIVE: two distinct requests that both cached nothing stay two requests", () => {
    // The usage-equality heuristic fuses these. Message-id dedup must not.
    const run = parseRun(stream([
      { id: "a", cacheRead: 40_000, cacheCreation: 0, tool: { name: "Bash", input: { command: "ls" } }, resultChars: 10 },
      { id: "b", cacheRead: 40_000, cacheCreation: 0, tool: { name: "Bash", input: { command: "ls" } }, resultChars: 10 },
    ]));
    expect(run.requests.length).toBe(2);
  });

  test("merges the content blocks of one request into one record", () => {
    const run = parseRun(stream([
      { id: "solo", cacheRead: 100, cacheCreation: 10, text: "hello", tool: { name: "Read", input: { file_path: "/x" } } },
    ]));
    expect(run.requests.length).toBe(1);
    expect(run.requests[0]!.toolUses.length).toBe(1);
    expect(run.requests[0]!.authoredCharacters).toBeGreaterThan("hello".length);
  });

  test("tool results are attached to the request that issued the call", () => {
    const run = parseRun(LINEAR);
    expect(run.toolResults.map((r) => r.afterRequestIndex)).toEqual([0, 1, 2]);
  });
});

// ── billing identity ────────────────────────────────────────────────

describe("billing identity", () => {
  test("IDENTITY CONTROL: the model reproduces a real provider figure exactly", () => {
    // astropy-14369 vtrace_clean, verbatim from its own result event.
    const report = checkBillingIdentity(
      { inputTokens: 129, cacheCreation1hTokens: 40_105, cacheCreation5mTokens: 0, cacheReadTokens: 819_267, outputTokens: 17_724 },
      1.2544285,
    );
    expect(report.holds).toBe(true);
    expect(report.deltaUsd!).toBeLessThan(1e-9);
  });

  test("KNOWN NEGATIVE: the 5m cache-write rate does NOT reproduce it", () => {
    const wrong = priceUsage(
      { inputTokens: 129, cacheCreation1hTokens: 0, cacheCreation5mTokens: 40_105, cacheReadTokens: 819_267, outputTokens: 17_724 },
      OPUS_4_5_PRICING,
    );
    expect(Math.abs(wrong - 1.2544285)).toBeGreaterThan(0.1);
  });

  test("a censored run has no reported cost and the identity cannot hold", () => {
    const report = checkBillingIdentity(
      { inputTokens: 1, cacheCreation1hTokens: 1, cacheCreation5mTokens: 0, cacheReadTokens: 1, outputTokens: null },
      null,
    );
    expect(report.holds).toBe(false);
    expect(report.deltaUsd).toBeNull();
  });
});

describe("censoring", () => {
  test("a run with a result event is uncensored", () => {
    expect(censoringOf(parseRun(LINEAR))).toBe(Censoring.Uncensored);
  });

  test("KNOWN POSITIVE: a run killed mid-stream is COST_CENSORED, not zero", () => {
    const run = parseRun(stream([{ id: "k", cacheRead: 500, cacheCreation: 100, tool: { name: "Read" }, resultChars: 40 }], null));
    expect(censoringOf(run)).toBe(Censoring.CostCensored);
    expect(run.result).toBeNull();
    // The input side is still exact.
    expect(reconstructInputSide(run.requests).cacheReadTokens).toBe(500);
    expect(reconstructInputSide(run.requests).outputTokens).toBeNull();
  });
});

// ── cache identity and appended tokens ──────────────────────────────

describe("cache identity", () => {
  test("holds on a well-formed run", () => {
    expect(checkCacheIdentity(parseRun(LINEAR).requests).holdsEverywhere).toBe(true);
  });

  test("KNOWN POSITIVE: a broken prefix is reported, not smoothed over", () => {
    const broken = parseRun(stream([
      { id: "a", cacheRead: 1_000, cacheCreation: 100 },
      { id: "b", cacheRead: 9_999, cacheCreation: 100 },
    ]));
    const report = checkCacheIdentity(broken.requests);
    expect(report.holdsEverywhere).toBe(false);
    expect(report.violations).toEqual([1]);
  });

  test("appended tokens are the measured difference of two prompt sizes", () => {
    const run = parseRun(LINEAR);
    // prompt(0) = 9 + 5000 + 20000 = 25009; prompt(1) = 9 + 6000 + 25000 = 31009.
    expect(appendedTokens(run.requests, 0)).toBe(6_000);
    expect(appendedTokens(run.requests, 3)).toBeNull();
  });
});

// ── taxonomy ────────────────────────────────────────────────────────

describe("classifyAction", () => {
  test("KNOWN POSITIVES across every kind", () => {
    expect(classifyAction("mcp__vtrace__run_pipeline", null)).toBe(ActionKind.Pipeline);
    expect(classifyAction("Grep", null)).toBe(ActionKind.Search);
    expect(classifyAction("Glob", null)).toBe(ActionKind.Search);
    expect(classifyAction("Read", null)).toBe(ActionKind.Read);
    expect(classifyAction("Edit", null)).toBe(ActionKind.Edit);
    expect(classifyAction("Bash", "grep -rn 'foo' src/")).toBe(ActionKind.ShellInspection);
    expect(classifyAction("Bash", "git log --oneline -30 -- xarray/core/computation.py")).toBe(ActionKind.ShellInspection);
    expect(classifyAction("Bash", "git blame -L 1920,1949 xarray/core/computation.py")).toBe(ActionKind.ShellInspection);
    expect(classifyAction("Bash", "python -m pytest tests/test_a.py -x")).toBe(ActionKind.TestRun);
    expect(classifyAction("Bash", "pip install -e . --quiet")).toBe(ActionKind.Environment);
    expect(classifyAction("Bash", "python3 -c \"import astropy; print(1)\"")).toBe(ActionKind.Execute);
  });

  test("KNOWN NEGATIVE: an install that also runs a test is environment work, not a test run", () => {
    expect(classifyAction("Bash", "pip install -e . -q && python -m pytest -q")).toBe(ActionKind.Environment);
  });

  test("KNOWN NEGATIVE: a test piped into head is a test run, not an inspection", () => {
    expect(classifyAction("Bash", "python -m pytest -q 2>&1 | head -30")).toBe(ActionKind.TestRun);
  });

  test("KNOWN NEGATIVE: a Bash call with no command is OTHER, never silently an inspection", () => {
    expect(classifyAction("Bash", null)).toBe(ActionKind.Other);
  });
});

// ── attribution ─────────────────────────────────────────────────────

describe("attributePayload", () => {
  const calibration = calibrateAcrossRuns([parseRun(LINEAR), parseRun(stream([
    { id: "x1", cacheRead: 1_000, cacheCreation: 400, tool: { name: "Read" }, resultChars: 1_200 },
    { id: "x2", cacheRead: 1_400, cacheCreation: 800, tool: { name: "Read" }, resultChars: 2_800 },
    { id: "x3", cacheRead: 2_200, cacheCreation: 300, text: "ok" },
  ]))]);

  test("calibration is derivable from real steps", () => {
    expect(calibration).not.toBeNull();
    expect(calibration!.samples).toBeGreaterThanOrEqual(3);
  });

  test("the pipeline payload is priced as one write plus every later re-read", () => {
    const run = parseRun(LINEAR);
    const attributed = attributePayload(run, 0, calibration)!;
    expect(attributed.kind).toBe(ActionKind.Pipeline);
    expect(attributed.derivable).toBe(true);
    // Written at request 1; re-read by requests 2 and 3.
    expect(attributed.amplificationRequests).toBe(2);
    expect(attributed.totalAttributableCostUsd).toBeCloseTo(
      attributed.writeCostUsd! + attributed.amplificationCostUsd!,
      12,
    );
  });

  test("the estimate is bracketed by the measured appended block", () => {
    const run = parseRun(LINEAR);
    const attributed = attributePayload(run, 0, calibration)!;
    expect(attributed.payloadTokensLowerBound!).toBeLessThanOrEqual(attributed.payloadTokensEstimated!);
    expect(attributed.payloadTokensUpperBound!).toBeGreaterThanOrEqual(attributed.payloadTokensEstimated!);
  });

  test("IDENTITY CONTROL: with no calibration nothing is invented", () => {
    const attributed = attributePayload(parseRun(LINEAR), 0, null)!;
    expect(attributed.derivable).toBe(false);
    expect(attributed.payloadTokensEstimated).toBeNull();
    expect(attributed.totalAttributableCostUsd).toBeNull();
    // The measured upper bound survives — it needed no calibration.
    expect(attributed.appendedTokensMeasured).toBe(6_000);
  });

  test("accountFor sums only the actions the predicate admits", () => {
    const run = parseRun(LINEAR);
    const pipelineOnly = accountFor(run, calibration, (kind) => kind === ActionKind.Pipeline);
    const everything = accountFor(run, calibration, () => true);
    expect(pipelineOnly.calls).toBe(1);
    expect(everything.calls).toBe(3);
    expect(pipelineOnly.attributableCostUsd).toBeLessThan(everything.attributableCostUsd);
  });
});

// ── phases ──────────────────────────────────────────────────────────

describe("phases", () => {
  test("landmarks come from observable actions only", () => {
    const landmarks = landmarksOf(parseRun(LINEAR));
    expect(landmarks.firstRepositoryActionRequest).toBe(0);
    expect(landmarks.firstEditRequest).toBe(2);
    expect(landmarks.lastEditRequest).toBe(2);
    expect(landmarks.firstTestRequest).toBeNull();
  });

  test("requests before the first edit are pre-edit investigation", () => {
    const landmarks = landmarksOf(parseRun(LINEAR));
    expect(phaseOfRequest(0, landmarks)).toBe(Phase.PreEdit);
    expect(phaseOfRequest(2, landmarks)).toBe(Phase.Implementation);
    expect(phaseOfRequest(3, landmarks)).toBe(Phase.DebugTest);
  });

  test("KNOWN NEGATIVE: a run that never edits is entirely pre-edit, not entirely debug", () => {
    const run = parseRun(stream([{ id: "n", cacheRead: 10, cacheCreation: 5, tool: { name: "Read" }, resultChars: 20 }]));
    expect(phaseOfRequest(0, landmarksOf(run))).toBe(Phase.PreEdit);
  });

  test("phase input-side costs sum to the run's input-side cost", () => {
    const run = parseRun(LINEAR);
    const perPhase = phaseCosts(run);
    const summed = perPhase.reduce((total, phase) => total + phase.inputSideCostUsd, 0);
    const whole = priceUsage({ ...reconstructInputSide(run.requests), outputTokens: null });
    expect(summed).toBeCloseTo(whole, 12);
  });

  test("output is apportioned, and labelled as apportioned, never per-request measured", () => {
    const perPhase = phaseCosts(parseRun(LINEAR));
    const apportioned = perPhase.reduce((total, phase) => total + (phase.estimatedOutputCostUsd ?? 0), 0);
    expect(apportioned).toBeCloseTo((4_000 * 25) / 1_000_000, 9);
    // A censored run cannot apportion what was never reported.
    const censored = phaseCosts(parseRun(stream([{ id: "c", cacheRead: 1, cacheCreation: 1, text: "x" }], null)));
    expect(censored.every((phase) => phase.estimatedOutputCostUsd === null)).toBe(true);
  });
});

// ── economic classification ─────────────────────────────────────────

describe("classifyEconomics", () => {
  test("frozen thresholds, checked at both edges", () => {
    expect(classifyEconomics(0.80, 1.0, true).economicClass).toBe(EconomicClass.Win);
    expect(classifyEconomics(0.81, 1.0, true).economicClass).toBe(EconomicClass.BreakEven);
    expect(classifyEconomics(1.25, 1.0, true).economicClass).toBe(EconomicClass.BreakEven);
    expect(classifyEconomics(1.26, 1.0, true).economicClass).toBe(EconomicClass.Loss);
  });

  test("KNOWN POSITIVE: displacing nothing while spending something is a loss, not a gap", () => {
    const verdict = classifyEconomics(0.2, 0, true);
    expect(verdict.economicClass).toBe(EconomicClass.Loss);
    expect(verdict.ratioLabel).toBe("DISPLACED_NOTHING");
  });

  test("KNOWN NEGATIVE: a censored pair is NOT_MEASURABLE and carries no ratio", () => {
    const verdict = classifyEconomics(0.5, 0.5, false);
    expect(verdict.economicClass).toBe(EconomicClass.NotMeasurable);
    expect(verdict.ratio).toBeNull();
  });
});

describe("breakEvenPayloadTokens", () => {
  test("more later requests means a smaller affordable payload", () => {
    const short = breakEvenPayloadTokens(0.05, 2);
    const long = breakEvenPayloadTokens(0.05, 40);
    expect(long).toBeLessThan(short);
  });

  test("IDENTITY CONTROL: the break-even payload costs exactly the displaced amount", () => {
    const budget = 0.05;
    const tokens = breakEvenPayloadTokens(budget, 10);
    const cost = (tokens * OPUS_4_5_PRICING.cacheWrite1hPerMTok
      + tokens * 10 * OPUS_4_5_PRICING.cacheReadPerMTok) / 1_000_000;
    expect(cost).toBeLessThanOrEqual(budget);
    expect(cost).toBeGreaterThan(budget * 0.999);
  });
});

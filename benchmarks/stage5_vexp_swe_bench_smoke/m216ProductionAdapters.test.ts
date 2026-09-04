/**
 * M216 §32 — contract tests for the production adapters.
 *
 * These test the parts that are PURE: argv construction, the stream parser,
 * termination classification, the binding's derivation, the reduction audit and
 * the research fixture's isolation. Everything that needs Docker, the CLI or
 * swebench is exercised by `run_stage5_m216_real_substrate.ts` against the real
 * substrate, because a mocked Docker would test the mock.
 *
 * §32 also asks what "equivalence" between the production and synthetic adapters
 * actually means. It means they satisfy the same INTERFACE and the same
 * lifecycle contract — the executor calls the same methods in the same order and
 * gets the same shapes back — and it does not mean their behaviour matches. The
 * production container really pulls an image; the synthetic one does not. The
 * properties actually tested are enumerated in ADAPTER_CONTRACT_PROPERTIES.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_AGENT,
  M214_BUDGET,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  M214_VTRACE_TREATMENT_CATALOG,
  type M214Arm,
  mcpToolName,
} from "./m214Preregistration";
import {
  auditProviderModelIdentity,
  auditTreatmentCatalogue,
  treatmentCatalogSha256,
} from "./m215LaunchExecutor";
import type { AgentRunSpec } from "./m215LaunchExecutor";
import {
  buildAgentArgv,
  buildArmEnvironment,
  classifyTermination,
  parseAgentStream,
  pinnedAgentBinary,
  resolveAgentBinary,
  telemetryKindFor,
} from "./m216ProductionAdapters";
import { dockerSwebenchBindingEvidence } from "./m216BindingEvidence";
import { M216_SUBSTRATE_REDUCTION, reductionVerdict } from "./m216SubstrateAudit";
import {
  M216_RESEARCH_INSTANCES,
  buildResearchManifest,
  frozenInstanceIds,
  researchAuthorities,
} from "./m216ResearchFixture";
import { CohortLedger } from "./m215CohortLedger";
import { auditSpendProjection } from "./m216RealSubstrate";

const RECORDED = join(import.meta.dir, "m216RecordedInit.jsonl");
const recordedLines = readFileSync(RECORDED, "utf8").split("\n");

/** §32 — the properties these tests actually establish, named rather than implied. */
export const ADAPTER_CONTRACT_PROPERTIES: readonly string[] = Object.freeze([
  "container lifecycle: method set and call order (interface only; behaviour is real-substrate)",
  "source identity: digest is a measurement, tested on the real substrate",
  "process launch: argv and environment construction, tested here",
  "event parsing: model identity, ordered telemetry, usage, termination, tested here",
  "patch capture: derivation rule, tested here and against real git",
  "evaluation: outcome shape, tested on the real substrate",
  "teardown: tested on the real substrate",
]);

function specFor(arm: M214Arm): AgentRunSpec {
  const manifest = buildResearchManifest(
    [[M216_RESEARCH_INSTANCES[0]!.instanceId, [arm] as readonly M214Arm[]]],
    "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
  );
  return {
    row: manifest.rows[0]!,
    attemptId: "test",
    workingDirectory: "/testbed",
    modelTarget: M214_MODEL.model,
    agentBinary: M214_AGENT.binary,
    agentVersion: M214_AGENT.version,
    nativeTools: M214_NATIVE_TOOLS,
    mcpServers: arm === "vtrace" ? ["vtrace"] : [],
    maxTurns: M214_BUDGET.maxTurns,
    perRunCostCapUsd: M214_BUDGET.perRunCostCapUsd,
    wallClockTimeoutSeconds: M214_BUDGET.wallClockTimeoutSecondsPerRun,
    userPromptTemplate: M214_AGENT.userPromptText,
  };
}

describe("the recorded provider init event", () => {
  test("carries the frozen model identity and passes the gate", () => {
    const parsed = parseAgentStream(recordedLines);
    expect(parsed.providerModelIdentity).toBe(M214_MODEL.model);
    expect(auditProviderModelIdentity(parsed.providerModelIdentity)).toEqual([]);
  });

  test("is parsed identically every time, so a run's semantics do not depend on when it is read", () => {
    const digest = (): string => JSON.stringify(parseAgentStream(recordedLines));
    expect(digest()).toBe(digest());
    expect(digest()).toBe(digest());
  });

  test("produces ordered telemetry whose first event is the agent init", () => {
    const parsed = parseAgentStream(recordedLines);
    expect(parsed.telemetry[0]?.kind).toBe("AGENT_INIT");
    expect(parsed.telemetry[1]?.kind).toBe("MODEL_IDENTITY");
    expect(parsed.telemetry.map((event) => event.ordinal))
      .toEqual(parsed.telemetry.map((_event, index) => index));
  });

  test("distinguishes the tool categories the ledger reports separately", () => {
    const kinds = new Set(parseAgentStream(recordedLines).telemetry.map((event) => event.kind));
    expect(kinds.has("EDIT")).toBe(true);
    expect(kinds.has("FILE_READ")).toBe(true);
    expect(kinds.has("TERMINATION")).toBe(true);
  });

  test("reports the provider's cost and usage rather than inferring them", () => {
    const parsed = parseAgentStream(recordedLines);
    expect(parsed.costUsd).toBeGreaterThan(0);
    expect(parsed.outputTokens).toBeGreaterThan(0);
    expect(parsed.sawResultEvent).toBe(true);
  });
});

describe("the model-identity gate's inputs", () => {
  test("an init event naming another model is a failure", () => {
    const mutated = recordedLines.map((line) =>
      line.includes("\"subtype\": \"init\"")
        ? line.replace(M214_MODEL.model, "claude-sonnet-4-5-20250929")
        : line);
    const parsed = parseAgentStream(mutated);
    expect(auditProviderModelIdentity(parsed.providerModelIdentity).length).toBeGreaterThan(0);
  });

  test("an absent identity is a failure, not a pass", () => {
    expect(auditProviderModelIdentity(null).length).toBeGreaterThan(0);
    expect(auditProviderModelIdentity("   ").length).toBeGreaterThan(0);
  });
});

describe("termination classification", () => {
  test("a stream with no result event is a model-service failure, not an unresolved task", () => {
    const parsed = parseAgentStream(
      recordedLines.filter((line) => !line.includes("\"type\": \"result\"")),
    );
    const outcome = classifyTermination(parsed, false, true, M214_BUDGET.perRunCostCapUsd);
    expect(outcome.failureCategory).toBe("MODEL_SERVICE_FAILURE");
  });

  test("a process that never started is a harness failure, not an agent error", () => {
    const outcome = classifyTermination(
      parseAgentStream([]), false, false, M214_BUDGET.perRunCostCapUsd,
    );
    expect(outcome.reason).toBe("HARNESS_ABORT");
    expect(outcome.failureCategory)
      .toBe("AGENT_INFRASTRUCTURE_FAILURE_BEFORE_TREATMENT_EXPOSURE");
  });

  test("a completed run is valid with no infrastructure category", () => {
    const outcome = classifyTermination(
      parseAgentStream(recordedLines), false, true, M214_BUDGET.perRunCostCapUsd,
    );
    expect(outcome.reason).toBe("AGENT_COMPLETED");
    expect(outcome.failureCategory).toBeNull();
  });

  test("a timeout is not collapsed into an agent error", () => {
    const outcome = classifyTermination(
      parseAgentStream(recordedLines), true, true, M214_BUDGET.perRunCostCapUsd,
    );
    expect(outcome.reason).toBe("WALL_CLOCK_TIMEOUT");
  });
});

describe("telemetry categories", () => {
  test("a treatment tool is never counted as a native one", () => {
    expect(telemetryKindFor(mcpToolName("vtrace", "get_code_context"), {}))
      .toBe("TREATMENT_TOOL_CALL");
  });

  test("a test invocation is distinguished from an ordinary shell command", () => {
    expect(telemetryKindFor("Bash", { command: "python -m pytest tests/" })).toBe("TEST_RUN");
    expect(telemetryKindFor("Bash", { command: "ls -la" })).toBe("SHELL_COMMAND");
  });
});

describe("the production invocation", () => {
  test("launches the versioned binary rather than the symlink", () => {
    const resolution = resolveAgentBinary();
    expect(resolution.binary).toBe(pinnedAgentBinary());
    const spec = specFor("baseline");
    const environment = buildArmEnvironment(
      spec.row, `/tmp/m216-test-${process.pid}-baseline`, undefined, process.env, "testnonce",
    );
    expect(buildAgentArgv(spec, environment.isolationArgv, "P", resolution.binary)[0])
      .toBe(pinnedAgentBinary());
  });

  test("refuses a version the installed binary does not satisfy", () => {
    expect(resolveAgentBinary(M214_AGENT.binary, "0.0.0-not-installed").issues.length)
      .toBeGreaterThan(0);
  });

  test("carries the frozen model, native tools and budgets", () => {
    const spec = specFor("baseline");
    const environment = buildArmEnvironment(
      spec.row, `/tmp/m216-test-${process.pid}-argv`, undefined, process.env, "testnonce2",
    );
    const argv = buildAgentArgv(spec, environment.isolationArgv, "P", pinnedAgentBinary());
    expect(argv[argv.indexOf("--model") + 1]).toBe(M214_MODEL.model);
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(M214_NATIVE_TOOLS.join(","));
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe(String(M214_BUDGET.maxTurns));
    expect(argv[argv.indexOf("--max-budget-usd") + 1])
      .toBe(String(M214_BUDGET.perRunCostCapUsd));
    expect(argv).toContain("--strict-mcp-config");
  });

  test("the two arms differ in the MCP configuration and nothing else", () => {
    const baseline = buildArmEnvironment(
      specFor("baseline").row, `/tmp/m216-test-${process.pid}-b`, undefined, process.env, "n1",
    );
    const vtrace = buildArmEnvironment(
      specFor("vtrace").row, `/tmp/m216-test-${process.pid}-v`, undefined, process.env, "n2",
    );
    expect(baseline.isolationArgv[0]).toBe(vtrace.isolationArgv[0]);
    expect(baseline.isolationArgv[1]).toBe(vtrace.isolationArgv[1]);
    expect(baseline.isolationArgv[2]).not.toBe(vtrace.isolationArgv[2]);
    expect(JSON.parse(baseline.isolationArgv[2]!)).toEqual({ mcpServers: {} });
    expect(Object.keys((JSON.parse(vtrace.isolationArgv[2]!) as { mcpServers: object }).mcpServers))
      .toEqual(["vtrace"]);
  });

  test("no arm environment carries a VTRACE, VEXP or ANTHROPIC variable", () => {
    for (const arm of ["baseline", "vtrace"] as const) {
      const environment = buildArmEnvironment(
        specFor(arm).row, `/tmp/m216-test-${process.pid}-env-${arm}`, undefined, {
          ...process.env,
          VTRACE_DEBUG: "1",
          VEXP_LICENCE: "secret",
          ANTHROPIC_API_KEY: "sk-should-not-survive",
        }, `env${arm}`,
      );
      expect(Object.keys(environment.env).filter((name) => /^(VTRACE|VEXP|ANTHROPIC)/.test(name)))
        .toEqual([]);
    }
  });
});

describe("the treatment catalogue", () => {
  test("the frozen catalogue is fourteen product tools, digested by M215's one authority", () => {
    expect(M214_VTRACE_TREATMENT_CATALOG.length).toBe(14);
    expect(treatmentCatalogSha256(M214_VTRACE_TREATMENT_CATALOG))
      .toBe(treatmentCatalogSha256());
  });

  test("a baseline arm exposing one treatment tool is rejected", () => {
    expect(auditTreatmentCatalogue("baseline", [mcpToolName("vtrace", "get_code_context")]).length)
      .toBeGreaterThan(0);
  });

  test("a vtrace arm missing one treatment tool is rejected", () => {
    const short = M214_VTRACE_TREATMENT_CATALOG.slice(1).map((id) => mcpToolName("vtrace", id));
    expect(auditTreatmentCatalogue("vtrace", short).length).toBeGreaterThan(0);
  });
});

describe("the research population", () => {
  test("no research instance is one of M214's frozen 100", () => {
    const manifest = JSON.parse(readFileSync(
      join(import.meta.dir, "results", "stage5_m214_run_manifest.json"), "utf8",
    )) as { rows: { instanceId: string }[] };
    const frozen = frozenInstanceIds(manifest.rows as never);
    for (const instance of M216_RESEARCH_INSTANCES) {
      expect(frozen.has(instance.instanceId)).toBe(false);
    }
  });

  test("a research manifest hashes differently from the frozen one", () => {
    const research = buildResearchManifest(
      [[M216_RESEARCH_INSTANCES[0]!.instanceId, ["baseline", "vtrace"] as readonly M214Arm[]]],
      "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
    );
    const frozenManifest = JSON.parse(readFileSync(
      join(import.meta.dir, "results", "stage5_m214_run_manifest.json"), "utf8",
    )) as { manifestHash: string };
    expect(research.manifestHash).not.toBe(frozenManifest.manifestHash);
  });

  test("a research result cannot enter a COHORT ledger", () => {
    const ledger = new CohortLedger("COHORT", "prereg", "frozen-manifest");
    expect(() => ledger.append(
      { mode: "SYNTHETIC", preregistrationHash: "prereg", manifestHash: "research-manifest" } as never,
      "2026-09-05T00:00:00.000Z",
    )).toThrow();
  });

  test("research authorities keep the real preregistration and swap only the manifest", () => {
    const research = buildResearchManifest(
      [[M216_RESEARCH_INSTANCES[0]!.instanceId, ["baseline"] as readonly M214Arm[]]],
      "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
    );
    const frozen = {
      preregistration: {}, manifest: [], externalReference: {},
      preregistrationHash: { artifact: "p", expected: "x", actual: "x", verified: true },
      manifestHash: { artifact: "m", expected: "y", actual: "y", verified: true },
      externalReferenceHash: { artifact: "e", expected: "z", actual: "z", verified: true },
      verified: true, issues: [],
    };
    const authorities = researchAuthorities(frozen as never, research);
    expect(authorities.preregistrationHash.actual).toBe("x");
    expect(authorities.manifestHash.actual).toBe(research.manifestHash);
    expect(authorities.manifestHash.artifact).toContain("NON_EVALUATION");
  });
});

describe("the binding is derived, not declared", () => {
  test("a missing adapter makes the binding unusable", () => {
    for (const name of ["container", "agent", "evaluator"] as const) {
      const evidence = dockerSwebenchBindingEvidence({
        adapters: { [name]: undefined } as Record<string, unknown>,
      });
      expect(evidence.exercised).toBe(false);
      expect(evidence.reasons.join(" ")).toContain(name);
    }
  });

  test("absent evidence makes the binding unusable even with every adapter present", () => {
    const evidence = dockerSwebenchBindingEvidence({ resultsDir: "/nonexistent/m216" });
    expect(evidence.exercised).toBe(false);
    expect(evidence.evidencePresent).toBe(false);
  });
});

describe("the substrate reduction audit", () => {
  test("every obligation is classified and names an authority", () => {
    const verdict = reductionVerdict();
    expect(verdict.verdict).toBe("M216_SUBSTRATE_REDUCTION_COMPLETE");
    expect(verdict.unclassified).toEqual([]);
    expect(verdict.rows).toBe(M216_SUBSTRATE_REDUCTION.length);
  });

  test("an obligation with no named authority makes the audit incomplete", () => {
    const verdict = reductionVerdict([
      ...M216_SUBSTRATE_REDUCTION,
      {
        obligation: "something nobody looked at", m215Interface: "?", existingAuthority: "",
        strategy: "DIRECT_REUSE", note: "",
      },
    ]);
    expect(verdict.verdict).toBe("M216_SUBSTRATE_REDUCTION_INCOMPLETE");
  });
});

describe("the spend projection", () => {
  test("first attempts fit the ceiling exactly, with no retry headroom", () => {
    const audit = auditSpendProjection();
    expect(audit.firstAttemptMaximumUsd).toBe(audit.ceilingUsd);
    expect(audit.firstAttemptFitsCeiling).toBe(true);
    expect(audit.retryHeadroomUsd).toBe(0);
  });

  test("a fully retried cohort exceeds the ceiling, which is why the guard halts rather than funds", () => {
    const audit = auditSpendProjection();
    expect(audit.mathematicalMaximumUsd).toBeGreaterThan(audit.ceilingUsd);
    expect(audit.guardBoundsActualSpend).toBe(true);
  });
});

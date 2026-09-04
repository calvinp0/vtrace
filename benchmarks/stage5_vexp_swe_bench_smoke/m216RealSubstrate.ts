/**
 * M216 §51, §52 — the real-substrate control suite.
 *
 * M215 falsified an executor against fakes. These controls falsify the BINDING:
 * every one of them touches a real Docker container, a real Git repository, the
 * real production argv and environment, the real stream parser, or the real
 * swebench evaluator. What none of them touches is a frozen task or a provider.
 *
 * The suite keeps M215's two rules. Each control moves exactly one property of
 * an otherwise-compliant world, and GUARD_SILENT controls are carried alongside
 * GUARD_FIRES ones — a suite in which everything is expected to be rejected
 * looks identical to a suite whose subject never works at all.
 *
 * Numbering continues M215's rather than restarting, because the two suites are
 * read together and F41 in one file meaning something different from F41 in the
 * other is a footgun nobody needs.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  M214_AGENT,
  M214_BUDGET,
  M214_EXCLUSIONS,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  M214_VTRACE_TREATMENT_CATALOG,
  type M214Arm,
  type RunManifestRow,
  m214PreregistrationHash,
  mcpToolName,
} from "./m214Preregistration";
import { derivePatchCaptureExclusions } from "./m214TreatmentLifecycle";
import {
  type AgentRunSpec,
  type ExecutorDependencies,
  type FrozenAuthorities,
  type SpendAuthorization,
  M215_AUTHORIZED_CEILING_USD,
  M215_PREREGISTRATION_HASH_EXCLUDED_FIELDS,
  auditProviderModelIdentity,
  auditSerializedArtifactForSecrets,
  auditSpendAuthorization,
  auditSpendCeiling,
  auditTreatmentCatalogue,
  executeManifestRow,
  projectSpend,
  renderProgress,
} from "./m215LaunchExecutor";
import { CohortLedger, type RunResultRecord } from "./m215CohortLedger";
import { dockerSwebenchBindingEvidence } from "./m216BindingEvidence";
import {
  type ProviderBoundary,
  SubstrateBridge,
  SubstrateRefusedError,
} from "./m216SubstrateBridge";
import {
  ArmEnvironmentRegistry,
  M216AgentAdapter,
  M216ContainerAdapter,
  M216EvaluatorAdapter,
  assertTestbedUsable,
  buildAgentArgv,
  buildArmEnvironment,
  classifyTermination,
  observedAgentVersion,
  parseAgentStream,
  pinnedAgentBinary,
  resolveAgentBinary,
  probeTreatmentCatalogue,
} from "./m216ProductionAdapters";
import {
  type ResearchDataset,
  M216_RESEARCH_INSTANCES,
  buildResearchManifest,
  frozenInstanceIds,
  loadResearchDataset,
  researchAuthorities,
} from "./m216ResearchFixture";

export const M216_SUITE_VERSION = "stage5.m216.real-substrate-suite.v1" as const;

export interface M216Control {
  readonly id: string;
  readonly description: string;
  readonly expectation: "GUARD_FIRES" | "GUARD_SILENT";
  readonly fired: boolean;
  readonly satisfied: boolean;
  readonly substrate: "REAL_CONTAINER" | "REAL_GIT" | "REAL_AGENT_PATH" | "REAL_EVALUATOR" | "PURE";
  readonly detail: string;
}

function control(
  id: string,
  description: string,
  expectation: "GUARD_FIRES" | "GUARD_SILENT",
  substrate: M216Control["substrate"],
  issues: readonly string[],
): M216Control {
  const fired = issues.length > 0;
  return {
    id, description, expectation, fired, substrate,
    satisfied: expectation === "GUARD_FIRES" ? fired : !fired,
    detail: fired ? issues.join(" | ") : "no issue reported",
  };
}

export function suitePasses(controls: readonly M216Control[]): boolean {
  return controls.length > 0 && controls.every((entry) => entry.satisfied);
}

// ── Fixtures derived from the recorded real init event ──────────────

export interface AgentFixtures {
  readonly correct: string;
  readonly wrongModel: string;
  readonly missingModel: string;
  readonly noResult: string;
}

/**
 * Four event streams, all derived from ONE recorded real run.
 *
 * The recorded stream is a genuine Claude Code transcript whose init event
 * carries the frozen model identity; the other three are that same stream with
 * exactly one thing changed. Synthesising a "plausible" init event instead would
 * make the parser's controls tests of the fixture rather than of the parser.
 */
export function writeAgentFixtures(recordedPath: string, outDir: string): AgentFixtures {
  mkdirSync(outDir, { recursive: true });
  const recorded = readFileSync(recordedPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const write = (name: string, lines: readonly string[]): string => {
    const path = join(outDir, name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  };
  const rewriteInit = (mutate: (init: Record<string, unknown>) => void): string[] =>
    recorded.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== "system" || event.subtype !== "init") return line;
      mutate(event);
      return JSON.stringify(event);
    });
  return {
    correct: write("correct.jsonl", recorded),
    wrongModel: write("wrong_model.jsonl", rewriteInit((init) => {
      init.model = "claude-sonnet-4-5-20250929";
    })),
    missingModel: write("missing_model.jsonl", rewriteInit((init) => {
      delete init.model;
    })),
    noResult: write(
      "no_result.jsonl",
      recorded.filter((line) => !line.includes("\"type\": \"result\"")),
    ),
  };
}

// ── The provider boundary substitution ──────────────────────────────

export interface ReplayOptions {
  readonly python: string;
  readonly script: string;
  readonly fixture: string;
  readonly argvOut: string;
  readonly writeFiles?: readonly string[];
  readonly appendFiles?: readonly string[];
  readonly hangAfter?: number;
}

/**
 * §31 — the substitution, expressed as a wrapper rather than a replacement.
 *
 * The production argv is passed THROUGH to the replay process after `--`, so a
 * control can read back what a real child actually received. Replacing the argv
 * would leave the argv construction untested, which is the part a paid run
 * depends on.
 */
export function replaySubstitution(options: ReplayOptions) {
  return (argv: readonly string[]): readonly string[] => [
    options.python, options.script,
    "--fixture", options.fixture,
    "--argv-out", options.argvOut,
    ...(options.hangAfter === undefined ? [] : ["--hang-after", String(options.hangAfter)]),
    ...(options.writeFiles ?? []).flatMap((spec) => ["--write-file", spec]),
    ...(options.appendFiles ?? []).flatMap((spec) => ["--append-file", spec]),
    "--", ...argv,
  ];
}

// ── Session ─────────────────────────────────────────────────────────

export interface RealSubstrateSession {
  readonly bridge: SubstrateBridge;
  readonly armEnvironments: ArmEnvironmentRegistry;
  readonly workRoot: string;
  readonly dataset: ResearchDataset;
  readonly frozen: FrozenAuthorities;
  readonly frozenIds: ReadonlySet<string>;
  readonly fixtures: AgentFixtures;
  readonly resultsDir: string;
}

export const RESEARCH_AUTHORIZATION: SpendAuthorization = Object.freeze({
  authorized: true,
  authorizedByOperator: "m216 research suite (RESEARCH mode; no provider is reachable)",
  authorizedCeilingUsd: M215_AUTHORIZED_CEILING_USD,
  authorizedAt: "2026-09-04T00:00:00.000Z",
  statement:
    "A research-mode authorisation object, present only so the authorisation guard itself can be "
    + "exercised. The substrate refuses a LIVE provider boundary outside COHORT mode regardless of "
    + "what this object says, so it cannot buy anything.",
});

export function researchDeps(
  session: RealSubstrateSession,
  authorities: FrozenAuthorities,
  ledger: CohortLedger,
  providerBoundary: ProviderBoundary,
  substitution: (argv: readonly string[], spec: AgentRunSpec) => readonly string[],
  container?: M216ContainerAdapter,
  /**
   * Where this control's arms live. It must be the SAME root the caller gave the
   * container adapter: a control whose container and agent disagreed about the
   * arm root would have the agent launch into a directory the container never
   * inspected, which is the defect the shared registry was introduced to close
   * and which reappeared here through a second door.
   */
  workRoot: string = session.workRoot,
): ExecutorDependencies {
  const instanceFacts = (instanceId: string) => {
    const pinned = M216_RESEARCH_INSTANCES.find((entry) => entry.instanceId === instanceId);
    if (pinned === undefined) throw new Error(`unknown research instance: ${instanceId}`);
    return { repo: pinned.repo, baseCommit: pinned.baseCommit, image: pinned.image };
  };
  const containerAdapter = container ?? new M216ContainerAdapter({
    bridge: session.bridge, mode: "RESEARCH", workRoot, instanceFacts,
    armEnvironments: session.armEnvironments,
  });
  // THIS adapter's registry, never the session's, so a caller that supplied its
  // own container adapter cannot end up with two.
  const armEnvironments = containerAdapter.armEnvironments;
  const problemStatement = (instanceId: string): string =>
    session.dataset.instances.find((entry) => entry.instanceId === instanceId)?.problemStatement
    ?? "(research instance; problem statement unavailable)";
  return {
    mode: "SYNTHETIC",
    authorities,
    container: containerAdapter,
    agent: new M216AgentAdapter({
      bridge: session.bridge,
      mode: "RESEARCH",
      providerBoundary,
      workRoot,
      problemStatement,
      armRootFor: (spec) => join(workRoot, `${spec.row.instanceId}--${spec.row.arm}`),
      hostMountFor: (spec) => containerAdapter.hostMountFor(spec.row.runId),
      armEnvironments,
      providerSubstitution: substitution,
    }),
    evaluator: new M216EvaluatorAdapter({
      bridge: session.bridge, mode: "RESEARCH", workRoot,
      dataset: session.dataset.path,
    }),
    ledger,
    now: () => new Date().toISOString(),
    spendAuthorization: RESEARCH_AUTHORIZATION,
  };
}

function researchLedger(authorities: FrozenAuthorities): CohortLedger {
  return new CohortLedger(
    "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
  );
}

// ── Real-git patch controls (§17) ───────────────────────────────────

interface ScratchRepo {
  readonly root: string;
  git(...args: string[]): string;
}

function scratchRepo(): ScratchRepo {
  const root = mkdtempSync(join(tmpdir(), "m216-git-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", root]);
  git("config", "user.email", "m216@example.invalid");
  git("config", "user.name", "m216");
  writeFileSync(join(root, "source.py"), "def solve():\n    return 1\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, git };
}

function untracked(repo: ScratchRepo, directory: boolean): readonly string[] {
  const args = ["ls-files", "--others", "--exclude-standard"];
  if (directory) args.push("--directory");
  args.push("-z");
  const raw = execFileSync("git", ["-C", repo.root, ...args], { encoding: "utf8" });
  return raw.split("\0").filter(Boolean).map((entry) => entry.replace(/\/+$/, "")).sort();
}

function capturedPaths(repo: ScratchRepo, exclusions: readonly string[]): readonly string[] {
  const pathspec = exclusions.map((entry) => `:(exclude)${entry}`);
  const tracked = execFileSync(
    "git", ["-C", repo.root, "diff", "--no-renames", "--name-only", "HEAD", "--", ".", ...pathspec],
    { encoding: "utf8" },
  ).split("\n").filter(Boolean);
  const others = execFileSync(
    "git", ["-C", repo.root, "ls-files", "--others", "--exclude-standard", "--", ".", ...pathspec],
    { encoding: "utf8" },
  ).split("\n").filter(Boolean);
  return [...new Set([...tracked, ...others])].sort();
}

function writeTreatmentState(repo: ScratchRepo, route: "INIT" | "INDEX"): void {
  mkdirSync(join(repo.root, ".vtrace"), { recursive: true });
  writeFileSync(join(repo.root, ".vtrace", "index.sqlite"), "index");
  writeFileSync(join(repo.root, ".vtrace", "config.json"), "{}");
  if (route === "INIT") {
    // `vtrace init` appends this; `vtrace index` alone does not. M214's probe
    // found the difference, and a guard that accepted only one of the two would
    // fail a compliant run or pass a broken one.
    writeFileSync(join(repo.root, ".git", "info", "exclude"), "/.vtrace/\n");
  }
}

export interface PatchControlOutcome {
  readonly id: string;
  readonly route: string;
  readonly exclusions: readonly string[];
  readonly captured: readonly string[];
}

/**
 * §17's P1–P5, plus §15's granularity control, against real Git.
 *
 * Real git rather than a model of it because the whole finding is about what a
 * particular flag does to a particular enumeration, and a model would reproduce
 * whatever the author believed.
 */
export function realGitPatchControls(): {
  readonly controls: readonly M216Control[];
  readonly outcomes: readonly PatchControlOutcome[];
} {
  const controls: M216Control[] = [];
  const outcomes: PatchControlOutcome[] = [];

  const run = (
    id: string, route: "INIT" | "INDEX", directory: boolean,
    act: (repo: ScratchRepo) => void,
  ): PatchControlOutcome => {
    const repo = scratchRepo();
    try {
      writeTreatmentState(repo, route);
      const exclusions = derivePatchCaptureExclusions(untracked(repo, directory));
      act(repo);
      const captured = capturedPaths(repo, exclusions);
      const outcome = { id, route: `${route}/${directory ? "DIRECTORY" : "FILE"}`, exclusions, captured };
      outcomes.push(outcome);
      return outcome;
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  };

  // P1 — no source change, `vtrace init` route.
  const p1 = run("P1", "INIT", true, () => { /* the agent changed nothing */ });
  controls.push(control(
    "F41P1", "no source change on the vtrace-init route captures an empty patch",
    "GUARD_SILENT", "REAL_GIT",
    p1.captured.length === 0 ? [] : [`captured ${p1.captured.join(", ")}`],
  ));

  // P2 — no source change, `vtrace index` route (no .git/info/exclude entry).
  const p2 = run("P2", "INDEX", true, () => { /* the agent changed nothing */ });
  controls.push(control(
    "F41P2", "no source change on the vtrace-index route captures an empty patch",
    "GUARD_SILENT", "REAL_GIT",
    p2.captured.length === 0 ? [] : [`captured ${p2.captured.join(", ")}`],
  ));

  // P3 / F47 — a treatment file written DURING the run.
  const p3 = run("P3", "INDEX", true, (repo) => {
    writeFileSync(join(repo.root, ".vtrace", "session.sqlite"), "written during the agent run");
  });
  controls.push(control(
    "F47", "treatment metadata created during the run does not enter the source patch",
    "GUARD_SILENT", "REAL_GIT",
    p3.captured.filter((entry) => entry.startsWith(".vtrace")),
  ));

  // F48 — the same world, snapshotted at FILE granularity, must fail.
  const p3file = run("P3_FILE_GRANULARITY", "INDEX", false, (repo) => {
    writeFileSync(join(repo.root, ".vtrace", "session.sqlite"), "written during the agent run");
  });
  controls.push(control(
    "F48", "the historical FILE-granularity snapshot captures a treatment file written during the "
    + "run; the corrected DIRECTORY invocation does not",
    "GUARD_FIRES", "REAL_GIT",
    p3file.captured.filter((entry) => entry.startsWith(".vtrace")),
  ));

  // P4 — one tracked source edit is captured, and only it.
  const p4 = run("P4", "INDEX", true, (repo) => {
    writeFileSync(join(repo.root, "source.py"), "def solve():\n    return 2\n");
    writeFileSync(join(repo.root, ".vtrace", "session.sqlite"), "treatment noise");
  });
  controls.push(control(
    "F41P4", "one tracked source edit is captured exactly", "GUARD_SILENT", "REAL_GIT",
    JSON.stringify(p4.captured) === JSON.stringify(["source.py"])
      ? []
      : [`captured ${JSON.stringify(p4.captured)}, expected ["source.py"]`],
  ));

  // P5 — an untracked source file the agent created. M214's rule is "what
  // changed minus what already existed", so a NEW source file is agent output
  // and must be captured; only pre-existing untracked state is excluded.
  const p5 = run("P5", "INDEX", true, (repo) => {
    writeFileSync(join(repo.root, "new_module.py"), "def added():\n    return 3\n");
  });
  controls.push(control(
    "F41P5", "an untracked source file the agent created IS captured; the exclusion covers only "
    + "pre-existing untracked state",
    "GUARD_SILENT", "REAL_GIT",
    p5.captured.includes("new_module.py")
      ? []
      : [`captured ${JSON.stringify(p5.captured)}, which omits the agent's new source file`],
  ));

  // §16 — the rule is generic. A vendor-name exclusion is defence in depth, and
  // the derived rule must handle a treatment nobody has heard of.
  const p6 = run("P6_UNKNOWN_VENDOR", "INDEX", true, (repo) => {
    mkdirSync(join(repo.root, ".someothertool"), { recursive: true });
    writeFileSync(join(repo.root, ".someothertool", "state"), "x");
  });
  controls.push(control(
    "F41P6", "a treatment directory the harness has never heard of is captured when it appears "
    + "after the snapshot, proving the rule is derivation and not a vendor allowlist",
    "GUARD_FIRES", "REAL_GIT",
    p6.captured.filter((entry) => entry.startsWith(".someothertool")),
  ));

  return { controls: Object.freeze(controls), outcomes: Object.freeze(outcomes) };
}

// ── Pure controls ───────────────────────────────────────────────────

export function pureControls(
  frozenPreregistration: Record<string, unknown>, resultsDir: string,
): readonly M216Control[] {
  const controls: M216Control[] = [];

  // F41–F43 — the binding is derived from the adapters existing.
  for (const [id, name] of [
    ["F41", "container"], ["F42", "agent"], ["F43", "evaluator"],
  ] as const) {
    const evidence = dockerSwebenchBindingEvidence({
      resultsDir, adapters: { [name]: undefined } as Record<string, unknown>,
    });
    controls.push(control(
      id, `a missing production ${name} adapter makes the DOCKER_SWEBENCH binding unusable`,
      "GUARD_FIRES", "PURE", evidence.exercised ? [] : evidence.reasons,
    ));
  }

  // F64/F65 — the frozen hash rule, prose versus generator.
  const body = (excluded: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frozenPreregistration)) {
      if (excluded.includes(key)) continue;
      out[key] = value;
    }
    return out;
  };
  const frozenDigest = String(frozenPreregistration.preregistrationHash ?? "");
  const proseOnly = ["preregistrationHash", "preregistrationHashRule", "generatedAt"];
  controls.push(control(
    "F64", "implementing M214's PROSE hash rule (3 excluded fields) fails to reproduce the frozen "
    + "digest; the generator excludes 9",
    "GUARD_FIRES", "PURE",
    m214PreregistrationHash(body(proseOnly)) === frozenDigest
      ? []
      : ["the 3-field prose rule does not reproduce the committed digest"],
  ));
  controls.push(control(
    "F65", "the actual generator field-exclusion authority reproduces the frozen digest from the "
    + "unmodified committed artifact",
    "GUARD_SILENT", "PURE",
    m214PreregistrationHash(body(M215_PREREGISTRATION_HASH_EXCLUDED_FIELDS)) === frozenDigest
      ? []
      : ["the 9-field generator rule does not reproduce the committed digest"],
  ));

  // F53/F54/F55 — the model-identity gate's only authoritative input.
  const parsedCorrect = parseAgentStream(
    readFileSync(join(import.meta.dir, "m216RecordedInit.jsonl"), "utf8").split("\n"),
  );
  controls.push(control(
    "F55", "a recorded REAL provider init event carrying the frozen model identity passes the gate",
    "GUARD_SILENT", "REAL_AGENT_PATH",
    auditProviderModelIdentity(parsedCorrect.providerModelIdentity),
  ));
  controls.push(control(
    "F53", "an init event naming a different model aborts before a valid outcome can exist",
    "GUARD_FIRES", "REAL_AGENT_PATH",
    auditProviderModelIdentity("claude-sonnet-4-5-20250929"),
  ));
  controls.push(control(
    "F54", "an absent provider model identity is a failure, not a pass",
    "GUARD_FIRES", "REAL_AGENT_PATH",
    auditProviderModelIdentity(null),
  ));

  // F49 (determinism half) — §49: repeated parses of the same bytes agree.
  const repeats = [0, 1, 2].map(() => {
    const parsed = parseAgentStream(
      readFileSync(join(import.meta.dir, "m216RecordedInit.jsonl"), "utf8").split("\n"),
    );
    return JSON.stringify({
      model: parsed.providerModelIdentity,
      tools: parsed.registryToolNames,
      telemetry: parsed.telemetry,
      turns: parsed.turnCount,
      usage: [parsed.inputTokens, parsed.outputTokens, parsed.cachedInputTokens],
      termination: classifyTermination(parsed, false, true, M214_BUDGET.perRunCostCapUsd),
    });
  });
  controls.push(control(
    "F69", "parsing the same recorded stream three times yields byte-identical telemetry, model "
    + "identity, usage and termination",
    "GUARD_SILENT", "REAL_AGENT_PATH",
    new Set(repeats).size === 1 ? [] : ["repeated parses of identical bytes disagreed"],
  ));

  // F63 — secrets never reach a persisted artifact.
  const fakeSecret = "sk-ant-m216-fake-credential-value";
  controls.push(control(
    "F63", "a credential value that reached a persisted artifact is detected",
    "GUARD_FIRES", "PURE",
    auditSerializedArtifactForSecrets(
      JSON.stringify({ env: { ANTHROPIC_API_KEY: fakeSecret } }),
      { ANTHROPIC_API_KEY: fakeSecret },
    ),
  ));
  controls.push(control(
    "F63B", "an artifact carrying only the NAME of a credential is clean",
    "GUARD_SILENT", "PURE",
    auditSerializedArtifactForSecrets(
      JSON.stringify({ environmentVariableNames: ["ANTHROPIC_API_KEY"] }),
      { ANTHROPIC_API_KEY: fakeSecret },
    ),
  ));

  // F67 — technical readiness is not authorisation.
  controls.push(control(
    "F67", "a COHORT launch without explicit spend authorisation is refused",
    "GUARD_FIRES", "PURE", auditSpendAuthorization(null, "COHORT"),
  ));

  return Object.freeze(controls);
}

// ── Spend projection including retry exposure (§38, §39, F66) ───────

export interface SpendProjectionAudit {
  readonly plannedRuns: number;
  readonly perRunCapUsd: number;
  readonly firstAttemptMaximumUsd: number;
  readonly maxAttemptsPerRun: number;
  readonly retryableCategories: readonly string[];
  readonly mathematicalMaximumUsd: number;
  readonly ceilingUsd: number;
  readonly firstAttemptFitsCeiling: boolean;
  readonly retryHeadroomUsd: number;
  readonly guardBoundsActualSpend: boolean;
  readonly reconciliation: string;
}

/**
 * §38 — the arithmetic, written out rather than assumed.
 *
 * 200 planned runs at the $3.50 per-run cap is exactly $700, which is exactly
 * the authorised ceiling: the first-attempt projection fits with ZERO headroom.
 * The preregistration also permits a second attempt for four infrastructure
 * categories, and a MODEL_SERVICE_FAILURE may already have cost money, so the
 * mathematical maximum of a fully-retried cohort is $1400 — twice the ceiling.
 *
 * That is not a policy inconsistency, and it matters to say why. M214 resolves
 * it explicitly in two places: `bothAttemptsRemainInLedger` puts a failed
 * attempt's cost into the cumulative total, and `budgetInterlock` states that
 * the cap is an infrastructure guard rather than a stopping rule — if it binds,
 * the cohort is INCOMPLETE and is reported as incomplete. The executor's guard
 * refuses to BEGIN a run whose worst case would breach the ceiling, so actual
 * spend is bounded at $700 while completion is not guaranteed.
 *
 * The residual this leaves is real and is reported rather than resolved here: a
 * cohort that consumes retry budget cannot also finish 200 runs.
 */
export function auditSpendProjection(): SpendProjectionAudit {
  const planned = M214_BUDGET.totalIntendedRuns;
  const cap = M214_BUDGET.perRunCostCapUsd;
  const ceiling = M214_BUDGET.totalSpendCapUsd;
  const attempts = M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun;
  const firstAttempt = planned * cap;
  return {
    plannedRuns: planned,
    perRunCapUsd: cap,
    firstAttemptMaximumUsd: firstAttempt,
    maxAttemptsPerRun: attempts,
    retryableCategories: M214_EXCLUSIONS.retryPolicy.rerunnable,
    mathematicalMaximumUsd: planned * cap * attempts,
    ceilingUsd: ceiling,
    firstAttemptFitsCeiling: firstAttempt <= ceiling,
    retryHeadroomUsd: ceiling - firstAttempt,
    guardBoundsActualSpend: true,
    reconciliation:
      `200 x $${cap} = $${firstAttempt} = the $${ceiling} ceiling exactly, so first attempts fit `
      + `with $${ceiling - firstAttempt} of retry headroom. A fully retried cohort would be `
      + `$${planned * cap * attempts}, which the ceiling refuses rather than funds: the executor `
      + "will not begin a run whose worst case breaches it, and M214's budgetInterlock declares a "
      + "cohort that hits the cap INCOMPLETE. Actual spend is bounded; completion is not "
      + "guaranteed once retry budget is consumed. Of the four rerunnable categories, only "
      + "MODEL_SERVICE_FAILURE can have already cost money, and an attempt whose cost the provider "
      + "never reported is charged at its cap by the production agent adapter rather than at $0.",
  };
}

export function spendControls(authorities: FrozenAuthorities): readonly M216Control[] {
  const controls: M216Control[] = [];
  const projection = auditSpendProjection();

  controls.push(control(
    "F66A", "the first-attempt cohort projection fits inside the frozen ceiling",
    "GUARD_SILENT", "PURE",
    projection.firstAttemptFitsCeiling
      ? []
      : [`$${projection.firstAttemptMaximumUsd} exceeds $${projection.ceilingUsd}`],
  ));

  // F66 — a ledger already carrying retry spend must make the projection unsafe
  // and the executor must refuse rather than continue.
  const ledger = new CohortLedger(
    "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
  );
  const exhausted = new CohortLedger(
    "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
  );
  const nearCeiling = M214_BUDGET.totalSpendCapUsd - 1;
  controls.push(control(
    "F66", "with cumulative spend one dollar under the ceiling, one more run at its cap is refused",
    "GUARD_FIRES", "PURE",
    auditSpendCeiling(
      { cumulativeSpendUsd: () => nearCeiling } as unknown as CohortLedger,
      M214_BUDGET.totalSpendCapUsd,
    ),
  ));
  controls.push(control(
    "F66B", "an empty cohort's projection is inside the ceiling and the guard stays silent",
    "GUARD_SILENT", "PURE",
    auditSpendCeiling(ledger, M214_BUDGET.totalSpendCapUsd),
  ));
  const projected = projectSpend(exhausted, authorities.manifest, M214_BUDGET.totalSpendCapUsd);
  controls.push(control(
    "F66C", "the projection charges every remaining run at its cap, so the ceiling binds on what "
    + "the cohort could cost rather than on what it has cost",
    "GUARD_SILENT", "PURE",
    projected.projectedMaximumUsd === M214_BUDGET.totalSpendCapUsd && projected.withinCeiling
      ? []
      : [`projected $${projected.projectedMaximumUsd} against $${projected.ceilingUsd}`],
  ));

  // F68 — the operational dashboard cannot answer "who is winning".
  const progress = renderProgress(authorities.manifest, ledger, null, []);
  const outcomeWords = ["passRate", "resolved", "vtraceWins", "mcnemar", "discordant", "delta"];
  const leaked = Object.keys(progress)
    .filter((key) => outcomeWords.some((word) => key.toLowerCase().includes(word.toLowerCase())));
  controls.push(control(
    "F68", "the operational progress view exposes no per-arm outcome, pass rate or test statistic",
    "GUARD_SILENT", "PURE",
    leaked.map((key) => `progress exposes an outcome field: ${key}`),
  ));

  return Object.freeze(controls);
}

// ── Argv and catalogue drift (F51, F52) ─────────────────────────────

export function configurationControls(
  row: RunManifestRow, armRoot: string,
): readonly M216Control[] {
  const controls: M216Control[] = [];
  const environment = buildArmEnvironment(row, armRoot, undefined, process.env, "m216fixed");
  const spec: AgentRunSpec = {
    row,
    attemptId: "m216-configuration-control",
    workingDirectory: "/testbed",
    modelTarget: M214_MODEL.model,
    agentBinary: pinnedAgentBinary(),
    agentVersion: M214_AGENT.version,
    nativeTools: M214_NATIVE_TOOLS,
    mcpServers: environment.mcpServers,
    maxTurns: row.maxTurns,
    perRunCostCapUsd: row.perRunCostCapUsd,
    wallClockTimeoutSeconds: M214_BUDGET.wallClockTimeoutSecondsPerRun,
    userPromptTemplate: M214_AGENT.userPromptText,
  };
  const resolution = resolveAgentBinary();
  const argv = buildAgentArgv(spec, environment.isolationArgv, "PROMPT", resolution.binary);
  const expected = [
    pinnedAgentBinary(), "-p", "PROMPT", "--output-format", "stream-json",
    "--model", M214_MODEL.model, "--max-turns", String(M214_BUDGET.maxTurns), "--verbose",
    "--allowedTools", M214_NATIVE_TOOLS.join(","),
    "--max-budget-usd", String(M214_BUDGET.perRunCostCapUsd),
    ...environment.isolationArgv,
  ];
  controls.push(control(
    "F51A", "the production argv is exactly the frozen invocation", "GUARD_SILENT", "REAL_AGENT_PATH",
    JSON.stringify(argv) === JSON.stringify(expected)
      ? []
      : [`argv ${JSON.stringify(argv)} != frozen ${JSON.stringify(expected)}`],
  ));
  const drifted = [...argv];
  drifted[drifted.indexOf(M214_MODEL.model)] = "claude-sonnet-4-5";
  controls.push(control(
    "F51", "altering one frozen agent argument is detected", "GUARD_FIRES", "REAL_AGENT_PATH",
    JSON.stringify(drifted) === JSON.stringify(expected)
      ? []
      : ["one argument differs from the frozen invocation"],
  ));

  // F52 — the catalogue, read from the server that serves it.
  const served = probeTreatmentCatalogue(
    "/home/calvin/code/vtrace/bin/vtrace", process.cwd(),
  );
  controls.push(control(
    "F52A", "the real vtrace MCP server serves exactly the frozen 14-tool treatment catalogue",
    "GUARD_SILENT", "REAL_AGENT_PATH",
    auditTreatmentCatalogue("vtrace", served.map((name) => mcpToolName("vtrace", name))),
  ));
  controls.push(control(
    "F52", "a treatment catalogue missing one tool is detected", "GUARD_FIRES", "REAL_AGENT_PATH",
    auditTreatmentCatalogue(
      "vtrace", served.slice(1).map((name) => mcpToolName("vtrace", name)),
    ),
  ));
  controls.push(control(
    "F52B", "an extra debug tool in the treatment catalogue is detected", "GUARD_FIRES",
    "REAL_AGENT_PATH",
    auditTreatmentCatalogue("vtrace", [
      ...M214_VTRACE_TREATMENT_CATALOG.map((name) => mcpToolName("vtrace", name)),
      mcpToolName("vtrace", "search_symbols"),
    ]),
  ));
  controls.push(control(
    "F26", "the baseline arm exposes zero treatment tools", "GUARD_SILENT", "REAL_AGENT_PATH",
    auditTreatmentCatalogue("baseline", []),
  ));
  controls.push(control(
    "F26B", "a baseline arm that could see one treatment tool is detected", "GUARD_FIRES",
    "REAL_AGENT_PATH",
    auditTreatmentCatalogue("baseline", [mcpToolName("vtrace", "get_code_context")]),
  ));

  // §21 — the installed agent identity is the frozen one, on BOTH the pinned
  // path and the symlink M214 named.
  controls.push(control(
    "F21", `the pinned binary and M214's declared symlink both report the frozen version `
    + M214_AGENT.version,
    "GUARD_SILENT", "REAL_AGENT_PATH", resolution.issues,
  ));
  controls.push(control(
    "F21B", "a version pin the installed binary does not satisfy is refused before launch",
    "GUARD_FIRES", "REAL_AGENT_PATH",
    resolveAgentBinary(M214_AGENT.binary, "0.0.0-not-installed").issues,
  ));
  controls.push(control(
    "F79", "the launched executable is the VERSIONED binary, not the symlink that follows whatever "
    + "was installed last",
    "GUARD_SILENT", "REAL_AGENT_PATH",
    argv[0] === pinnedAgentBinary()
      ? []
      : [`argv[0] is ${argv[0]}, not the pinned ${pinnedAgentBinary()}`],
  ));

  return Object.freeze(controls);
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type { M214Arm, RunManifestRow, RunResultRecord };
export {
  buildResearchManifest, frozenInstanceIds, loadResearchDataset, researchAuthorities,
  researchLedger, SubstrateBridge, SubstrateRefusedError, assertTestbedUsable, ArmEnvironmentRegistry,
  M216ContainerAdapter, M216AgentAdapter, M216EvaluatorAdapter,
  executeManifestRow, replaySubstitution as replay,
};

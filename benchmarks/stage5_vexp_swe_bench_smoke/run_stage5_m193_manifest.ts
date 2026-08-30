/**
 * M193 §55 — emit the frozen task fixture and the hashed live-experiment
 * manifest. This is the authority M194 must follow exactly if authorised.
 *
 * Deterministic. Reads the dataset and the committed spend model; invokes no
 * model and starts no container.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_manifest.ts
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  M193_ADEQUACY,
  M193_EXCLUSION_CATEGORIES,
  M193_EXPERIMENT_ID,
  M193_LIMITS,
  M193_RERUNNABLE,
  M193_ROUTING,
  M193_SCHEMA_VERSION,
  selectFixture,
  type DatasetRow,
} from "./m193Acquisition";

const HERE = import.meta.dir;
const RESULTS = join(HERE, "results");
const DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const FIXTURE_OUT = join(RESULTS, "stage5_m193_task_fixture.json");
const MANIFEST_OUT = join(RESULTS, "stage5_m193_manifest.json");

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function blobHash(relPath: string): string | null {
  try {
    return execFileSync("git", ["hash-object", relPath], { cwd: join(HERE, "..", "..") }).toString().trim();
  } catch {
    return null;
  }
}

/** Canonical JSON: keys sorted at every level, so the manifest hash is stable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

// ── task fixture ────────────────────────────────────────────────────

const datasetText = readFileSync(DATASET, "utf8");
const rows: DatasetRow[] = datasetText
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as DatasetRow);

const fixture = selectFixture(rows, M193_LIMITS.maxArms);
const reserve = selectFixture(rows, rows.length).slice(M193_LIMITS.maxArms);

const fixtureDoc = {
  schemaVersion: "stage5.m193.task-fixture.v1",
  milestone: "M193",
  experimentId: M193_EXPERIMENT_ID,
  frozenBeforeAnyLiveResult: true,
  dataset: DATASET,
  datasetSha256: sha256(datasetText),
  datasetInstanceCount: rows.length,
  datasetRepositoryCount: new Set(rows.map((r) => r.repo)).size,
  selectionRule:
    "Stratified round-robin over repositories: repositories sorted lexicographically, instances sorted lexicographically within a repository, emitted rank-1-of-every-repository first, then rank-2, and so on, truncated at maxArms. Every prefix of the ordering is therefore maximally cross-repository, and §32 has a single deterministic next instance.",
  selectionRuleIsOutcomeIndependent: true,
  selectionInputsUsed: ["repository", "instance_id", "dataset membership"],
  selectionInputsRefused: [
    "gold patch topology",
    "FAIL_TO_PASS size or content",
    "historical resolution outcome",
    "M189/M190 attention",
    "known multi-file tasks",
    "Docker image already pulled locally",
    "anything an agent produced",
  ],
  maxArms: M193_LIMITS.maxArms,
  minArms: M193_LIMITS.minArms,
  armCount: fixture.length,
  repositoriesRepresented: new Set(fixture.map((f) => f.repo)).size,
  perRepositoryCounts: [...new Set(fixture.map((f) => f.repo))].sort().map((repo) => ({
    repo,
    arms: fixture.filter((f) => f.repo === repo).length,
  })),
  instances: fixture,
  replacementReserveOrdering:
    "On PREFLIGHT_FAILED the next unattempted instance in this reserve list is taken, in order. No manual selection is permitted.",
  replacementReserve: reserve.map((r) => ({ ordinal: r.ordinal, instanceId: r.instanceId, repo: r.repo })),
};

writeFileSync(FIXTURE_OUT, `${JSON.stringify(fixtureDoc, null, 2)}\n`);
const fixtureSha = sha256(readFileSync(FIXTURE_OUT));

// ── manifest ────────────────────────────────────────────────────────

const spendModelPath = join(RESULTS, "stage5_m193_spend_model.json");
const spendModel = existsSync(spendModelPath)
  ? (JSON.parse(readFileSync(spendModelPath, "utf8")) as Record<string, unknown>)
  : null;
const spendCosts = (spendModel?.costUsd ?? {}) as Record<string, number>;
const spendProjection = (spendModel?.projectedTotalSpendUsd ?? {}) as Record<string, number>;

const body = {
  schemaVersion: "stage5.m193.experiment-manifest.v1",
  milestone: "M193",
  experimentId: M193_EXPERIMENT_ID,
  purpose:
    "A baseline-only observational acquisition of natural edit / validation / result / revision behaviour on SWE-bench tasks, run on the M192 per-instance container substrate. It tests no hypothesis. It is captured once so that later, separately preregistered analyses can be run against it.",
  frozenBeforeAnyLiveResult: true,
  liveSpendDuringM193Usd: 0,
  authorityNote:
    "The existence of this manifest is not permission to spend. M194 may execute it only after the project owner explicitly authorises the frozen budget.",

  condition: {
    arms: ["BASELINE_ONLY"],
    treatmentArms: [],
    description:
      "A strong coding agent with its normal unrestricted repository tools, working against a per-instance SWE-bench validation substrate.",
    prohibited: [
      "VTRACE orientation of any kind",
      "VTRACE MCP server or any MCP server",
      "VTRACE hooks or post-edit warnings",
      "test recommendations",
      "forced or suggested validation",
      "workflow mandates",
      "tool-use-discipline injection",
      "M163 orientation trigger",
      "runtime instrumentation of any kind (§45)",
    ],
    validationIsNotRequired:
      "Whether the agent validates at all is part of what is being measured. No instruction encourages it (§15).",
  },

  agent: {
    implementation: "Anthropic Claude Code CLI, headless",
    binary: "/home/calvin/.local/bin/claude",
    version: "2.1.251",
    versionPinning:
      "The CLI is a self-contained versioned binary under ~/.local/share/claude/versions/<version>. M194 must assert this exact version before launching any arm and abort if it differs.",
    model: "claude-opus-4-5-20251101",
    modelRationale:
      "The model every untreated historical baseline arm used, so the frozen cost ceilings are derived from this model's own economics.",
    maxTurns: 250,
    maxTurnsRationale:
      "The vexp-swe-bench shipped default. The most turn-hungry untreated arm on record used 94, so this bound is non-binding in practice and is not a hidden treatment.",
    samplingConfiguration: {
      temperature: "not exposed by the Claude Code CLI; provider default",
      thinkingBudget: 0,
      effortFlag: "omitted (vexp passes --effort only when thinkingBudget > 0)",
    },
    tools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite"],
    toolsRationale:
      "vexp-swe-bench's DEFAULT_ALLOWED_TOOLS, unchanged. M168-E showed that removing Grep/Glob is itself a treatment that lost tasks, so the tool set is not narrowed.",
    mcp: {
      configuration: "an empty {\"mcpServers\":{}} config passed with --strict-mcp-config",
      rationale: "guarantees no MCP server, VTRACE's included, can reach the agent",
    },
    systemPrompt: "CLI default; no --append-system-prompt, no --system-prompt",
    userPrompt: {
      source: "vexp-swe-bench src/harness/loader.ts buildPrompt, verbatim",
      text: [
        "You are working on the {repo} repository (Python).",
        "Fix the following issue by making the necessary code changes.",
        "Do NOT write or modify tests — only fix the source code.",
        "",
        "{problem_statement}",
      ].join("\n"),
      containsValidationInstruction: false,
      containsOrientationInstruction: false,
      containsRepositoryContext: false,
    },
    outputFormat: "stream-json --verbose (the ordered telemetry source)",
  },

  substrate: {
    harness: "swebench==4.1.0",
    harnessAuthority: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m192_harness_authority.json",
    imageNamespace: "swebench",
    instanceImageTag: "latest",
    checkoutRoot: M193_ROUTING.checkoutRoot,
    containerUser: "root",
    containerCommand: "tail -f /dev/null",
    executionPath: "docker.APIClient.exec_create + exec_start (the same seam swebench's own container.exec_run uses)",
    authoritativeCheckout: "SINGLE_BIND_MOUNTED_TREE",
    authoritativeCheckoutNote:
      "/testbed is extracted from the instance image to a host directory once, then bind-mounted back at /testbed. Host file tools and container execution address the same inodes at the same path, so there is exactly one mutable task source state and no synchronisation step (§26).",
    routing: M193_ROUTING,
  },

  limits: {
    ...M193_LIMITS,
    concurrency: {
      maxConcurrentLiveArms: M193_LIMITS.maxConcurrentArms,
      rationale:
        "M192 drove 12 repositories three-way parallel in 122s on this host. Three concurrent arms keeps peak container memory and Docker disk churn well inside headroom and stays clear of model rate limits.",
      diskGuard: {
        rule: "refuse to launch an arm when free space on the Docker filesystem is below the floor",
        freeSpaceFloorGb: 60,
        rationale: "instance images are 3.6-10.8 GB each and the fixture spans 40 distinct images",
      },
    },
    timeouts: {
      containerStartSeconds: 120,
      individualCommandSeconds: 600,
      validationCommandSeconds: 600,
      agentTotalSeconds: 3600,
      officialEvaluatorSeconds: 1800,
      rationale:
        "M192 measured container start at a 628 ms median and full benchmark validation at a 3 s median (2-29 s max). The command ceiling is set at the Claude Code Bash tool's own maximum so the adapter never becomes the shorter of the two, because a short generic Bash timeout would convert slow historical suites into artificial failures (§37).",
    },
  },

  spend: {
    historicalBasis: {
      source: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193_spend_model.json",
      stratum: "UNTREATED_CONFIRMED baseline arms on the pinned model",
      n: spendCosts.n ?? null,
      medianUsd: spendCosts.p50 ?? null,
      p90Usd: spendCosts.p90 ?? null,
      p95Usd: spendCosts.p95 ?? null,
      maxUsd: spendCosts.max ?? null,
      meanUsd: spendCosts.mean ?? null,
    },
    perRunCostCapUsd: M193_LIMITS.perRunCostCapUsd,
    perRunCapEnforcement:
      "--max-budget-usd on the Claude Code CLI, cross-checked against the provider-reported usage in the stream-json result event. An arm that hits the cap terminates as COST_CAP_REACHED, which is a valid run and is not rerunnable.",
    totalSpendCapUsd: M193_LIMITS.totalSpendCapUsd,
    projectedTotalUsd: {
      atUntreatedMean: spendProjection.atUntreatedMean ?? null,
      atUntreatedP90: spendProjection.atUntreatedP90 ?? null,
      atUntreatedP95: spendProjection.atUntreatedP95 ?? null,
    },
    dockerEvaluationCostUsd: 0,
  },

  stoppingRule: {
    statement:
      "After each completed arm, continue unless: total spend has reached the total cap; or the maximum arm count has been reached; or at least minArms have been launched AND the corpus holds at least targetI6UsableArms I6-usable arms spanning at least targetRepositoriesAmongI6Usable repositories.",
    implementation: "stopDecision() in m193Acquisition.ts",
    inputs: ["armsLaunched", "spendUsd", "i6UsableArms", "repositoriesAmongI6Usable"],
    refusedInputs: [
      "task resolution",
      "whether I6 looks promising",
      "whether runtime diagnosis looks promising",
      "whether a preferred mechanism appeared",
    ],
    minArms: M193_LIMITS.minArms,
    maxArms: M193_LIMITS.maxArms,
    targetI6UsableArms: M193_LIMITS.targetI6UsableArms,
    targetRepositoriesAmongI6Usable: M193_LIMITS.targetRepositoriesAmongI6Usable,
    minArmsRationale:
      "A lucky early run of usable episodes must not yield a corpus too small to describe. The minimum is outcome-independent.",
  },

  preflight: {
    statement: "Runs before every paid arm. Deterministic, model-free, and it never sees the task's gold data.",
    implementation: "run_stage5_m193_preflight.py",
    checks: [
      "instance image available locally or pullable",
      "container starts and accepts exec",
      "checkout root exists",
      "base commit is reachable and checks out cleanly",
      "workdir resolves to the checkout root",
      "source tree is writable",
      "a controlled mutation persists across a separate command",
      "the import resolves under the checkout root",
      "provenance robustness classified (EDITABLE_INSTALL or CWD_DEPENDENT)",
      "a runtime sentinel written into the checkout is executed by the validation process",
      "the test runner starts",
      "pre-existing untracked paths recorded, so environment build output cannot enter the patch",
      "cleanup removes the container and restores the source",
      "free Docker disk above the floor",
    ],
    onFailure: "do not launch the model; record the instance as PREFLIGHT_FAILED and apply the replacement policy",
  },

  replacementPolicy: {
    rule: "NEXT_IN_FROZEN_ORDER",
    statement:
      "A PREFLIGHT_FAILED instance is replaced by the next unattempted instance in the frozen reserve ordering. No manual selection. A preflight failure costs $0 and therefore does not consume a live arm slot, but every failure stays visible in the ledger with its repository, so a bias toward easy environments would be readable rather than hidden.",
    maxReplacements: M193_LIMITS.maxPreflightReplacements,
    onExhaustion: "stop the acquisition and report the shortfall; do not relax preflight",
  },

  retryPolicy: {
    rerunnable: M193_RERUNNABLE,
    notRerunnable: [
      "the agent produced a bad patch",
      "the agent chose not to test",
      "the agent exhausted its turns",
      "the agent hit the per-run cost cap",
      "the agent timed out",
      "the evaluator judged the task unresolved",
    ],
    maxAttemptsPerArm: 2,
    bothAttemptsRemainInLedger: true,
    statement:
      "Only infrastructure and model-service failures may be rerun, at most once. Selective reruns of substantive failures would be a treatment (§41), so the categories are frozen here rather than judged later.",
  },

  exclusionCategories: M193_EXCLUSION_CATEGORIES,
  exclusionsRemainVisible: true,

  runValidity: {
    implementation: "classifyRunValidity() in m193Acquisition.ts",
    requires: [
      "preflight passed for this exact instance",
      "agent started",
      "one authoritative mutable checkout maintained throughout",
      "treatment-absence audit passed",
      "telemetry complete and trace ordering well-formed",
      "final patch extractable, or a truthful empty patch",
      "official evaluator executed",
      "no infrastructure termination",
    ],
    explicitlyNotRequired: [
      "a validation attempt — the agent is allowed to choose not to test",
      "a non-empty patch",
      "task resolution",
    ],
  },

  i6UsableDefinition: {
    implementation: "classifyArmLifecycle() in m193Acquisition.ts",
    requires: [
      "RUN_VALID",
      "at least one source edit",
      "at least one post-edit validation attempt",
      "runner-start truth known",
      "a validation event whose provenance is EDITED_CHECKOUT_CONFIRMED",
      "a semantic test result that is not UNKNOWN",
      "ordered trace and diff state preserved",
    ],
    note:
      "Post-validation revision is NOT part of this definition. It is counted separately as postValidationRevisions so that a stronger sub-analysis can be defined later without moving this bar (§43).",
  },

  runtimeDiagnosisUsableDefinition: {
    implementation: "classifyArmLifecycle() in m193Acquisition.ts",
    requires: [
      "RUN_VALID",
      "at least one source edit",
      "a trustworthy validation event whose semantic result is FAILED or MIXED",
      "failure evidence preserved",
      "diff state at the moment of failure preserved",
      "at least one subsequent observable agent decision",
    ],
    note: "A corpus capability label only. No runtime instrumentation is added and no hypothesis is being tested (§44/§45).",
  },

  corpusAdequacy: {
    implementation: "assessAdequacy() in m193Acquisition.ts",
    thresholds: M193_ADEQUACY,
    note: "Expressed entirely in lifecycle events. Pass rate cannot reach ADEQUATE on its own (§14).",
  },

  telemetryContract: {
    schemaVersion: M193_SCHEMA_VERSION,
    document: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193_execution_contract.md",
  },

  treatmentIsolation: {
    audit: "run_stage5_m193_treatment_audit.ts, executed immediately before each arm",
    mustProveAbsentAtAgentStartup: [
      "any CLAUDE.md or AGENTS.md reachable from the agent's working directory or its ancestors, other than instruction files native to the benchmark repository itself",
      "any MCP server",
      "any hook other than the declared execution adapter",
      "VTRACE_* environment variables",
      "the vexp-swe-bench Stage 5 agent shim",
      "shell aliases or startup files injecting instructions",
      "a reachable VTRACE daemon socket",
    ],
    benchmarkNativeInstructionFiles:
      "Instruction files that are part of the benchmark repository at its base commit are the benchmark's normal condition and are preserved. They are recorded separately from experimental injection so the two can never be confused (§33).",
    declaredAdapter:
      "A PreToolUse hook that routes Bash execution into the instance container and a PostToolUse/Stop hook that records diff snapshots. Neither adds text to the model's context, neither is visible to the agent, and both apply identically to every arm. They are the execution substrate, not a treatment, and are declared here rather than left implicit.",
  },

  credentials: {
    modelClientLocation: "host",
    repositoryExecutionLocation: "instance container",
    trustBoundary:
      "The Claude Code CLI holds the credentials and runs on the host. The container receives only shell command text and returns only bytes. No API key, credential file or token is copied into a SWE-bench image, and none appears in any committed artifact (§35).",
  },

  analysisBoundary: {
    m194MayDo: [
      "execute exactly this manifest after explicit authorisation",
      "ingest the resulting artifacts through the frozen classifier",
      "report the preregistered corpus accounting",
    ],
    m194MayNotDo: [
      "perform I6 mechanism analysis",
      "perform runtime-grounded repair analysis",
      "reopen I5",
      "change any classifier except to correct a genuine implementation bug, under a preregistered invalidation policy",
      "add or remove instances from the fixture",
      "relax preflight, caps, or the stopping rule",
    ],
    classifierInvalidationPolicy:
      "If a classifier defect is found after live data exists, the defect, the corrected code and the before/after counts for every affected arm must all be reported together, and the synthetic fixtures must be extended with a case that reproduces the defect.",
  },

  frozenSources: [
    "benchmarks/stage5_vexp_swe_bench_smoke/m193Acquisition.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/m193Fixtures.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/m193Acquisition.test.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/m193_container_adapter.py",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_preflight.py",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_dry_run.py",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_manifest.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_spend_model.ts",
  ].map((p) => ({ path: p, gitBlobSha1: blobHash(p) })),

  taskFixture: {
    path: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193_task_fixture.json",
    sha256: fixtureSha,
    armCount: fixture.length,
    repositoriesRepresented: new Set(fixture.map((f) => f.repo)).size,
    instanceIds: fixture.map((f) => f.instanceId),
  },
};

const manifestHash = sha256(canonical(body));
const manifest = { ...body, manifestHash, manifestHashRule: "sha256 over the canonical (recursively key-sorted) JSON of every field except manifestHash and manifestHashRule" };

writeFileSync(MANIFEST_OUT, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`wrote ${FIXTURE_OUT}`);
console.log(`  arms ${fixture.length}  repositories ${new Set(fixture.map((f) => f.repo)).size}  sha256 ${fixtureSha}`);
console.log(`wrote ${MANIFEST_OUT}`);
console.log(`  manifestHash ${manifestHash}`);

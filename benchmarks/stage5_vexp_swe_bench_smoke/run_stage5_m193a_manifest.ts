/**
 * M193A §32 — re-freeze the acquisition manifest around the integrity closure.
 *
 * Derived from the committed M193 manifest rather than regenerated beside it,
 * for one reason: "the task fixture, model, caps and stopping rule did not
 * change" should be a mechanical fact, not a claim in a report. This script
 * verifies M193's own manifest hash, deep-copies it, applies exactly the
 * integrity fields, and then diffs the two canonical forms so every difference
 * has to appear in the output.
 *
 * If it ever reports a difference outside the integrity keys, that is a defect
 * in this script or an unauthorised change, and either way the acquisition is
 * not re-frozen.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193a_manifest.ts
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M193_ADEQUACY, M193_LIMITS } from "./m193Acquisition";
import { BASELINE_CONFIG_ALLOWLIST, BASELINE_ISOLATION_SETTINGS, ENV_ALLOWLIST, FORBIDDEN_ENV_PREFIXES } from "./m193aArmEnvironment";

const HERE = import.meta.dir;
const RESULTS = join(HERE, "results");
const M193_MANIFEST = join(RESULTS, "stage5_m193_manifest.json");
const OUT = join(RESULTS, "stage5_m193a_manifest.json");
const DIFF_OUT = join(RESULTS, "stage5_m193a_manifest_diff.json");

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function blobHash(relPath: string): string | null {
  try {
    return execFileSync("git", ["hash-object", relPath], { cwd: join(HERE, "..", "..") }).toString().trim();
  } catch {
    return null;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** Every leaf path in a nested object, so the diff is exhaustive rather than shallow. */
function leaves(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (value === null || typeof value !== "object") {
    out.set(prefix, JSON.stringify(value));
    return out;
  }
  if (Array.isArray(value)) {
    out.set(prefix, canonical(value));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    for (const [p, s] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, s);
  }
  return out;
}

// ── the M193 manifest, verified rather than trusted ──────────────────

const m193 = JSON.parse(readFileSync(M193_MANIFEST, "utf8")) as Record<string, unknown>;
const declaredHash = m193.manifestHash as string;
const { manifestHash: _h, manifestHashRule: _r, ...m193Body } = m193;
const recomputed = sha256(canonical(m193Body));
if (recomputed !== declaredHash) {
  console.error(`M193 manifest hash does not verify: declared ${declaredHash}, recomputed ${recomputed}`);
  process.exit(1);
}

const body = JSON.parse(JSON.stringify(m193Body)) as Record<string, unknown>;

// ── the integrity closure, and nothing else ──────────────────────────

body.schemaVersion = "stage5.m193a.experiment-manifest.v1";
body.milestone = "M193A";
body.derivedFrom = {
  milestone: "M193",
  manifestPath: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193_manifest.json",
  manifestHash: declaredHash,
  hashVerifiedAtGeneration: true,
  statement:
    "The task fixture, model, agent, tool set, prompt, caps, concurrency, timeouts, preflight, replacement policy, retry policy, run-validity rule, adequacy thresholds and stopping rule are carried over unchanged. M193A adds source-version provenance to the usability rule and replaces the treatment-isolation precondition with a construction.",
};

body.sourceVersionAuthority = {
  question: "Did this validation execute the bytes that are on disk now, or a compilation of earlier bytes?",
  motivation:
    "Path provenance says which FILE the interpreter resolved. It cannot say which BYTES of that file it ran. CPython validates a timestamp-based .pyc against the source's (mtime_seconds, size) alone, so an edit preserving the size within one whole second is invisible to the interpreter while __file__ still names the edited checkout.",
  reproduction: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193a_bytecode_reproduction.json",
  reproductionFinding:
    "With the clock race removed, all five dry-run repositories executed stale code under CPython 3.6, 3.9 and 3.11 while every path witness reported EDITED_CHECKOUT_CONFIRMED. The natural (unforced) hazard is a race against the wall clock and its affected set differs between runs on identical repositories, so it is a property of edit timing and not of a repository.",
  states: ["CURRENT_EDITED_STATE_CONFIRMED", "SOURCE_VERSION_AMBIGUOUS", "STALE_EXECUTION_CONFIRMED", "NOT_APPLICABLE", "UNKNOWN"],
  fileStates: ["COMPILED_FROM_CURRENT_SOURCE", "CACHE_MATCHES_CURRENT_SOURCE", "CACHE_STALE_AND_ACCEPTED", "NON_CACHED_ASSET", "COMPILED_ARTIFACT_REQUIRED", "INDETERMINATE"],
  implementation: "classifySourceVersion() in m193Acquisition.ts, over evidence from m193a_source_version_probe.py",
  probe: {
    path: "benchmarks/stage5_vexp_swe_bench_smoke/m193a_source_version_probe.py",
    runsInside: "the instance container, out-of-band, after the agent's command",
    method:
      "reads the source and its compiled caches; reconstructs whether CPython would accept each cache from the same header fields CPython compares; where a cache would be accepted, unmarshals it and compares a recursive structural fingerprint of the code object against a fresh compile of the current source",
    neverDoes: [
      "import the file it is judging",
      "delete or rewrite a cache",
      "set PYTHONDONTWRITEBYTECODE or invoke python -B",
      "touch an mtime",
      "modify the test runner",
    ],
    limitations: [
      "raw marshal bytes are NOT used as an identity test: they differ for identical programs because of marshal's reference-sharing encoding, which was observed on every interpreter measured",
      "a third-party import cache that maintains its own compiled form (pytest's assertion rewriter) cannot be compared against a plain compilation; such a file is INDETERMINATE unless the cache was written during the validation being judged",
      "a C extension or other build artifact is never claimed fresh",
    ],
  },
  changedSourceScope: {
    rule: "every path in the working tree's current diff against the base commit, excluding the environment's own pre-agent untracked output",
    rationale:
      "A whole-repository freshness proof is neither necessary nor affordable. What a validation event is evidence ABOUT is the edited program, and the edited program is exactly this set (§16).",
    derivedFrom: "git diff --cached --name-only, read from the checkout rather than from the harness's own bookkeeping",
  },
  stabilityGuard:
    "The probe necessarily runs after the command. The BEFORE_VALIDATION and AFTER_VALIDATION diff hashes must agree, or freshness is not established.",
  environmentIsNotAltered:
    "The hazard is measured, never suppressed. Deleting __pycache__, exporting PYTHONDONTWRITEBYTECODE, running python -B or touching source files before every validation would each change the environment the baseline agent faces, and the acquisition would then be measuring a condition no agent will ever meet (§6).",
};

body.i6UsableDefinition = {
  ...(body.i6UsableDefinition as Record<string, unknown>),
  requires: [
    ...((body.i6UsableDefinition as { requires: string[] }).requires ?? []),
    "the validation's source-version provenance is CURRENT_EDITED_STATE_CONFIRMED",
  ],
  sourceVersionRequirement:
    "EDITED_CHECKOUT_CONFIRMED combined with SOURCE_VERSION_AMBIGUOUS or STALE_EXECUTION_CONFIRMED is I6-unusable even when the test result reads normally. Freshness is never inferred from a validation having succeeded (§8).",
  i6UnusableReasons: [
    "RUN_INVALID",
    "NO_SOURCE_EDIT",
    "NO_POST_EDIT_VALIDATION_ATTEMPT",
    "NO_TRUSTWORTHY_VALIDATION_RESULT",
    "I6_UNUSABLE_SOURCE_VERSION",
    "TRACE_ORDERING_CORRUPT",
  ],
  visibilityRule:
    "A run whose only defect is source-version provenance remains RUN_VALID and is counted in validButI6UnusableSourceVersionArms, with sourceVersionAmbiguousEvents and staleExecutionEvents reported separately (§17).",
};

body.treatmentIsolation = {
  ...(body.treatmentIsolation as Record<string, unknown>),
  guaranteeKind: "CONSTRUCTED_PER_ARM",
  supersedes:
    "M193's per-arm precondition. A precondition is an instruction to an operator; this is a property of the object the launcher builds.",
  implementation: "constructArmEnvironment() in m193aArmEnvironment.ts",
  construction: [
    "create a private configuration directory that did not exist a moment earlier, mode 0700, unique per arm",
    "copy exactly the files in the baseline allow-list into it",
    "write the isolation settings, which are constructed rather than inherited",
    "build the process environment from an allow-list, never from the parent",
    "audit the constructed directory, environment and argv, and measure the effective MCP server count",
    "refuse to launch the model unless the audit is clean",
  ],
  baselineConfigAllowlist: [...BASELINE_CONFIG_ALLOWLIST],
  constructedSettings: { ...BASELINE_ISOLATION_SETTINGS },
  environmentAllowlist: [...ENV_ALLOWLIST],
  forbiddenEnvironmentPrefixes: [...FORBIDDEN_ENV_PREFIXES],
  measuredFinding:
    "M193's manifest stated that an empty --mcp-config with --strict-mcp-config guarantees no MCP server can reach the agent. Measured on this host, that is true of file-based registrations only: a private directory containing credentials alone still resolved three claude.ai account connectors, and they survived --strict-mcp-config, because they arrive with the authenticated account rather than from a file. disableClaudeAiConnectors reduces that to zero.",
  measurementUncertainty:
    "The measurement is `claude mcp list`, which resolves configuration and exits without a provider request. Whether a strict session would have loaded those connectors as tools could only be confirmed by a provider call, which §6 forbids; the connectors are therefore closed rather than argued about (§28).",
  evidence: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193a_isolation_evidence.json",
  onFailure:
    "TREATMENT_ISOLATION_FAILED. The model is not launched and the arm is recorded under the existing TREATMENT_CONTAMINATION exclusion category. Launching and recording the contamination alongside the result is not permitted (§24).",
  repositoryNativeFilesPreserved:
    "Instruction files belonging to the benchmark repository at its base commit are untouched. Only experiment-injected configuration is excluded (§26).",
};

body.armLaunchRecord = {
  implementation: "launchRecord() in m193aArmEnvironment.ts",
  fields: [
    "cliVersion", "cliBinary", "model", "configDir", "configDirFreshlyCreated", "baselineContentsHash",
    "allowedFilesCopied", "strictMcpConfig", "claudeAiConnectorsDisabled", "effectiveMcpServerCount",
    "experimentalHooksPresent", "experimentalInstructionFilePresent", "allowedTools", "envKeys",
    "treatmentIsolationStatus",
  ],
  secretsPolicy:
    "Environment keys without values; a baseline contents hash over file names and sizes, never over file content. The one file copied into an arm is a credential (§23).",
};

body.frozenSources = [
  "benchmarks/stage5_vexp_swe_bench_smoke/m193Acquisition.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/m193Fixtures.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/m193Acquisition.test.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/m193aArmEnvironment.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/m193aArmEnvironment.test.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/m193a_source_version_probe.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/m193_container_adapter.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_preflight.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_dry_run.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_manifest.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_spend_model.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193a_manifest.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193a_bytecode_reproduction.py",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193a_isolation_evidence.ts",
  "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193a_analyze.ts",
].map((p) => ({ path: p, gitBlobSha1: blobHash(p) }));

// ── the difference, computed rather than described ───────────────────

const before = leaves(m193Body);
const after = leaves(body);
const changed: string[] = [];
const added: string[] = [];
const removed: string[] = [];
for (const [k, v] of after) {
  if (!before.has(k)) added.push(k);
  else if (before.get(k) !== v) changed.push(k);
}
for (const k of before.keys()) if (!after.has(k)) removed.push(k);

/** Top-level keys the integrity closure is allowed to touch. */
const INTEGRITY_KEYS = new Set([
  "schemaVersion", "milestone", "derivedFrom", "sourceVersionAuthority",
  "i6UsableDefinition", "treatmentIsolation", "armLaunchRecord", "frozenSources",
]);
const outsideIntegrity = [...changed, ...added, ...removed].filter((k) => !INTEGRITY_KEYS.has(k.split(".")[0] ?? k));

// Explicit re-assertion of the things §19–§21 forbid moving, checked against
// the code rather than against the old manifest, so a drift in either is caught.
const invariants = {
  taskFixtureSha256Unchanged:
    (body.taskFixture as { sha256: string }).sha256 === (m193Body.taskFixture as { sha256: string }).sha256,
  armCountUnchanged: (body.taskFixture as { armCount: number }).armCount === 40,
  repositoriesUnchanged: (body.taskFixture as { repositoriesRepresented: number }).repositoriesRepresented === 12,
  modelUnchanged: (body.agent as { model: string }).model === "claude-opus-4-5-20251101",
  cliVersionUnchanged: (body.agent as { version: string }).version === "2.1.251",
  maxTurnsUnchanged: (body.agent as { maxTurns: number }).maxTurns === 250,
  perRunCapUnchanged: (body.limits as { perRunCostCapUsd: number }).perRunCostCapUsd === M193_LIMITS.perRunCostCapUsd && M193_LIMITS.perRunCostCapUsd === 3.5,
  totalCapUnchanged: (body.limits as { totalSpendCapUsd: number }).totalSpendCapUsd === M193_LIMITS.totalSpendCapUsd && M193_LIMITS.totalSpendCapUsd === 90,
  armBoundsUnchanged: M193_LIMITS.minArms === 20 && M193_LIMITS.maxArms === 40,
  concurrencyUnchanged: M193_LIMITS.maxConcurrentArms === 3,
  adequacyUnchanged:
    M193_ADEQUACY.adequate.i6UsableArms === 12 &&
    M193_ADEQUACY.adequate.repositoriesAmongI6Usable === 6 &&
    M193_ADEQUACY.adequate.validRuns === 30 &&
    M193_ADEQUACY.partial.i6UsableArms === 6 &&
    M193_ADEQUACY.partial.repositoriesAmongI6Usable === 4 &&
    M193_ADEQUACY.partial.validRuns === 15,
  stoppingRuleUnchanged: canonical(body.stoppingRule) === canonical(m193Body.stoppingRule),
  promptUnchanged: canonical((body.agent as { userPrompt: unknown }).userPrompt) === canonical((m193Body.agent as { userPrompt: unknown }).userPrompt),
  toolsUnchanged: canonical((body.agent as { tools: unknown }).tools) === canonical((m193Body.agent as { tools: unknown }).tools),
  differencesConfinedToIntegrity: outsideIntegrity.length === 0,
};

const manifestHash = sha256(canonical(body));
const manifest = {
  ...body,
  manifestHash,
  manifestHashRule: "sha256 over the canonical (recursively key-sorted) JSON of every field except manifestHash and manifestHashRule",
};
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);

const diff = {
  schemaVersion: "stage5.m193a.manifest-diff.v1",
  milestone: "M193A",
  oldManifestHash: declaredHash,
  newManifestHash: manifestHash,
  oldManifestHashVerified: true,
  addedLeaves: added.sort(),
  changedLeaves: changed.sort(),
  removedLeaves: removed.sort(),
  leavesOutsideIntegrityScope: outsideIntegrity.sort(),
  invariants,
  allInvariantsHold: Object.values(invariants).every(Boolean),
};
writeFileSync(DIFF_OUT, `${JSON.stringify(diff, null, 2)}\n`);

console.log(`wrote ${OUT}`);
console.log(`  old M193  manifestHash ${declaredHash}`);
console.log(`  new M193A manifestHash ${manifestHash}`);
console.log(`wrote ${DIFF_OUT}`);
console.log(`  added ${added.length}  changed ${changed.length}  removed ${removed.length}  outside integrity scope ${outsideIntegrity.length}`);
for (const [k, v] of Object.entries(invariants)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);

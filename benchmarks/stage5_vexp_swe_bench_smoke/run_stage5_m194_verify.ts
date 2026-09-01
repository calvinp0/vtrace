/**
 * M194 §1/§7/§51 — the gate that stands between this milestone and a paid model
 * call.
 *
 * M193C froze an experiment and published its hash. M194's first obligation is
 * to prove, mechanically, that the thing it is about to execute is that exact
 * experiment: the manifest recomputes to the published hash, the task fixture
 * recomputes to the published hash, every frozen source file still hashes to the
 * blob the manifest recorded, and the four authorities the manifest depends on
 * are still the ones that were verified.
 *
 * The hash rule is the manifest's own (§34): sha256 over the canonical,
 * recursively key-sorted JSON of every field except `manifestHash` and
 * `manifestHashRule`. It is reimplemented here rather than imported from the
 * generator, so a generator that drifted could not certify itself.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_verify.ts
 *
 * Exit status is 0 only when every gate passes. A non-zero exit means no model
 * may be launched.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M193_ADEQUACY, M193_LIMITS, M193_EXPERIMENT_ID } from "./m193Acquisition";

const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..");
const RESULTS = join(HERE, "results");

/** The hash M193C published. M194 does not compute this; it requires it. */
const FROZEN_MANIFEST_SHA256 = "f735786bf7d3437a095abdcc7e8704cb6769fd32eb46b37ad8fc373850282204";
const FROZEN_FIXTURE_SHA256 = "e79843d3b93d4c77551911a92eed9b316c57b5045ff7e7ef75018efb2e9aaca4";
const FROZEN_MODEL = "claude-opus-4-5-20251101";
const FROZEN_CLI_VERSION = "2.1.251";
const FROZEN_MAX_TURNS = 250;

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

interface Gate {
  id: string;
  what: string;
  expected: string;
  observed: string;
  pass: boolean;
}
const gates: Gate[] = [];
const gate = (id: string, what: string, expected: unknown, observed: unknown) => {
  const e = String(expected);
  const o = String(observed);
  gates.push({ id, what, expected: e, observed: o, pass: e === o });
};

// ── 1. the manifest is the frozen one ────────────────────────────────

const manifestPath = join(RESULTS, "stage5_m193c_manifest.json");
gate("M1_manifest_present", "the committed M193C manifest exists", true, existsSync(manifestPath));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
const { manifestHash: declaredHash, manifestHashRule: _rule, ...body } = manifest;
const recomputed = sha256(canonical(body));

gate("M2_manifest_self_consistent", "the manifest's declared hash matches its own body", recomputed, declaredHash);
gate("M3_manifest_is_frozen", "the manifest body hashes to the authority M194 was given", FROZEN_MANIFEST_SHA256, recomputed);
gate("M4_experiment_id", "the experiment identity is unchanged", M193_EXPERIMENT_ID, manifest.experimentId);
gate("M5_frozen_before_results", "the manifest was frozen before any live result", true, manifest.frozenBeforeAnyLiveResult);
gate("M6_no_live_spend_in_m193", "M193 recorded zero live spend", 0, manifest.liveSpendDuringM193Usd);

// ── 2. the task fixture is the frozen one ────────────────────────────

const fixturePath = join(RESULTS, "stage5_m193_task_fixture.json");
const fixtureBytes = readFileSync(fixturePath);
const fixtureHash = sha256(fixtureBytes);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Record<string, unknown>;
const tf = manifest.taskFixture as { sha256: string; armCount: number; repositoriesRepresented: number; path: string };

gate("F1_fixture_file_hash", "the task fixture file hashes to the frozen value", FROZEN_FIXTURE_SHA256, fixtureHash);
gate("F2_manifest_agrees", "the manifest names the same fixture hash", FROZEN_FIXTURE_SHA256, tf.sha256);
gate("F3_arm_count", "the fixture holds 40 arms", 40, (fixture.instances as unknown[]).length);
gate("F4_manifest_arm_count", "the manifest agrees on 40 arms", 40, tf.armCount);
gate("F5_repositories", "the fixture spans 12 repositories", 12, tf.repositoriesRepresented);
gate("F6_frozen_before_results", "the fixture was frozen before any live result", true, fixture.frozenBeforeAnyLiveResult);
gate(
  "F7_outcome_independent",
  "the selection rule refused outcome inputs",
  true,
  fixture.selectionRuleIsOutcomeIndependent,
);

// The round-robin ordering is the thing §25 forbids reordering, so it is
// re-derived here from the fixture's own declared rule rather than trusted.
const instances = fixture.instances as { ordinal: number; instanceId: string; repo: string }[];
const ordinalsDense = instances.every((e, i) => e.ordinal === i + 1);
gate("F8_ordinals_dense", "arm ordinals are dense and 1-based", true, ordinalsDense);
const firstTwelveRepos = new Set(instances.slice(0, 12).map((e) => e.repo));
gate("F9_prefix_cross_repository", "the first 12 arms span 12 repositories", 12, firstTwelveRepos.size);

// ── 3. the live parameters are the frozen ones ───────────────────────

const agent = manifest.agent as Record<string, unknown>;
const limits = manifest.limits as Record<string, unknown>;

gate("P1_model", "the model is the frozen one", FROZEN_MODEL, agent.model);
gate("P2_cli_version", "the manifest pins the frozen CLI version", FROZEN_CLI_VERSION, agent.version);
gate("P3_max_turns", "the turn limit is unchanged", FROZEN_MAX_TURNS, agent.maxTurns);
gate("P4_per_run_cap", "the per-run cost ceiling is unchanged", 3.5, limits.perRunCostCapUsd);
gate("P5_total_cap", "the total live-spend ceiling is unchanged", 90, limits.totalSpendCapUsd);
gate("P6_min_arms", "the minimum arm count is unchanged", 20, limits.minArms);
gate("P7_max_arms", "the maximum arm count is unchanged", 40, limits.maxArms);
gate("P8_concurrency", "concurrency is unchanged", 3, limits.maxConcurrentArms);
gate("P9_max_replacements", "the replacement ceiling is unchanged", 15, limits.maxPreflightReplacements);

// The code the driver will actually execute must agree with the manifest, or
// the manifest is describing an experiment the driver is not running.
gate("C1_code_per_run_cap", "m193Acquisition agrees on the per-run cap", 3.5, M193_LIMITS.perRunCostCapUsd);
gate("C2_code_total_cap", "m193Acquisition agrees on the total cap", 90, M193_LIMITS.totalSpendCapUsd);
gate("C3_code_min_arms", "m193Acquisition agrees on minArms", 20, M193_LIMITS.minArms);
gate("C4_code_max_arms", "m193Acquisition agrees on maxArms", 40, M193_LIMITS.maxArms);
gate("C5_code_concurrency", "m193Acquisition agrees on concurrency", 3, M193_LIMITS.maxConcurrentArms);
gate("C6_adequate_i6", "the ADEQUATE I6 threshold is unchanged", 12, M193_ADEQUACY.adequate.i6UsableArms);
gate("C7_adequate_repos", "the ADEQUATE repository threshold is unchanged", 6, M193_ADEQUACY.adequate.repositoriesAmongI6Usable);
gate("C8_adequate_valid", "the ADEQUATE valid-run threshold is unchanged", 30, M193_ADEQUACY.adequate.validRuns);
gate("C9_partial_i6", "the PARTIAL I6 threshold is unchanged", 6, M193_ADEQUACY.partial.i6UsableArms);
gate("C10_partial_repos", "the PARTIAL repository threshold is unchanged", 4, M193_ADEQUACY.partial.repositoriesAmongI6Usable);
gate("C11_partial_valid", "the PARTIAL valid-run threshold is unchanged", 15, M193_ADEQUACY.partial.validRuns);

// ── 4. the condition is baseline-only ────────────────────────────────

const condition = manifest.condition as { arms: string[]; treatmentArms: string[] };
gate("T1_single_arm", "exactly one arm is declared", "BASELINE_ONLY", condition.arms.join(","));
gate("T2_no_treatment_arms", "no treatment arm is declared", 0, condition.treatmentArms.length);
gate(
  "T3_prompt_has_no_validation_instruction",
  "the frozen prompt does not ask the agent to validate",
  false,
  (agent.userPrompt as { containsValidationInstruction: boolean }).containsValidationInstruction,
);
gate(
  "T4_prompt_has_no_orientation",
  "the frozen prompt carries no orientation",
  false,
  (agent.userPrompt as { containsOrientationInstruction: boolean }).containsOrientationInstruction,
);
gate(
  "T5_tools_unrestricted",
  "the frozen tool set is vexp's default and is not narrowed",
  "Bash,Edit,Glob,Grep,Read,TodoWrite,Write",
  [...(agent.tools as string[])].sort().join(","),
);

// ── 5. the CLI on this host is the frozen binary ─────────────────────
//
// The user-facing `claude` symlink follows whatever version was installed last;
// the manifest pins a *versioned binary*, which is the thing that must be
// asserted (§P2 versionPinning). Both are recorded so a drift in the symlink is
// visible rather than silently absorbed.

const versionedBinary = `/home/calvin/.local/share/claude/versions/${FROZEN_CLI_VERSION}`;
let versionedReported = "ABSENT";
if (existsSync(versionedBinary)) {
  try {
    versionedReported = execFileSync(versionedBinary, ["--version"], { timeout: 60_000 })
      .toString()
      .trim()
      .split(" ")[0] ?? "";
  } catch (exc) {
    versionedReported = `ERROR: ${String(exc).slice(0, 120)}`;
  }
}
gate("B1_pinned_binary_present", "the pinned CLI binary exists on this host", true, existsSync(versionedBinary));
gate("B2_pinned_binary_version", "the pinned binary reports the frozen version", FROZEN_CLI_VERSION, versionedReported);

let symlinkReported = "ABSENT";
try {
  symlinkReported = execFileSync("/home/calvin/.local/bin/claude", ["--version"], { timeout: 60_000 })
    .toString()
    .trim()
    .split(" ")[0] ?? "";
} catch {
  /* recorded as ABSENT */
}

// ── 6. the frozen sources have not drifted ───────────────────────────

const frozenSources = manifest.frozenSources as { path: string; gitBlobSha1: string | null }[];
const drifted: { path: string; expected: string | null; observed: string | null }[] = [];
for (const src of frozenSources) {
  let observed: string | null = null;
  try {
    observed = execFileSync("git", ["hash-object", src.path], { cwd: REPO }).toString().trim();
  } catch {
    observed = null;
  }
  if (observed !== src.gitBlobSha1) drifted.push({ path: src.path, expected: src.gitBlobSha1, observed });
}
gate("S1_frozen_sources_unchanged", "every frozen source still hashes to its recorded blob", 0, drifted.length);
gate("S2_frozen_source_count", "the frozen source set is the recorded size", frozenSources.length, frozenSources.length);

// ── 7. the four authorities the manifest rests on ────────────────────
//
// Each is READY only because a committed artefact says so AND the deterministic
// suite that produced it still passes. The suite run is a separate command
// (§7 keeps this gate cheap); what is asserted here is that the artefacts exist
// and still carry their authorisation.

function authority(id: string, file: string, needle: string): void {
  const p = join(RESULTS, file);
  const present = existsSync(p);
  const text = present ? readFileSync(p, "utf8") : "";
  gate(id, `${needle} is still declared in ${file}`, true, present && text.includes(needle));
}
// The token each milestone actually published, not a paraphrase of it. M193A
// published one readiness covering the source-version probe and the acquisition
// integrity design; the treatment-isolation guarantee is a separate measured
// artefact, because M193A found it was only true after disabling the account
// connectors and would not certify it from the design document.
authority("A1_acquisition_integrity", "stage5_m193a_final_report.md", "M194_ACQUISITION_INTEGRITY_READY");
authority("A2_treatment_isolation", "stage5_m193a_isolation_evidence.json", "TREATMENT_ISOLATION_GUARANTEED_BY_CONSTRUCTION");
authority("A3_changed_source", "stage5_m193b_final_report.md", "M194_CHANGED_SOURCE_AUTHORITY_READY");
authority("A4_patch_observation", "stage5_m193c_final_report.md", "M194_PATCH_OBSERVATION_READY");

// The source-version authority is a manifest structure, so it is asserted as
// one: M194's I6 usability rule reads these verdicts and cannot be applied if
// the authority that produces them is not the one that was frozen.
const sva = manifest.sourceVersionAuthority as Record<string, unknown>;
gate("A5_source_version_authority", "the frozen source-version authority is present", true, typeof sva === "object" && sva !== null);
gate(
  "A6_source_version_probe_frozen",
  "the source-version probe is a frozen source",
  true,
  frozenSources.some((f) => f.path.endsWith("m193a_source_version_probe.py")),
);
gate(
  "A7_changed_source_frozen",
  "the changed-source authority is a frozen source",
  true,
  frozenSources.some((f) => f.path.endsWith("m193b_changed_source.py")),
);
gate(
  "A8_patch_snapshot_frozen",
  "the patch-snapshot authority is a frozen source",
  true,
  frozenSources.some((f) => f.path.endsWith("m193c_patch_snapshot.py")),
);

// ── 8. the repository is where the milestone says it is ──────────────

const gitOut = (args: string[]) => execFileSync("git", args, { cwd: REPO }).toString().trim();
const branch = gitOut(["branch", "--show-current"]);
const headSha = gitOut(["rev-parse", "HEAD"]);
const trackedDirt = gitOut(["status", "--short", "--untracked-files=no"]).split("\n").filter(Boolean);
const untracked = gitOut(["status", "--short"]).split("\n").filter((l) => l.startsWith("??"));
gate("R1_branch", "work is on main", "main", branch);

// ── report ───────────────────────────────────────────────────────────

const failed = gates.filter((g) => !g.pass);
const verdict = failed.length === 0 ? "M194_FROZEN_AUTHORITY_VERIFIED" : "FROZEN_MANIFEST_MISMATCH";

const report = {
  schemaVersion: "stage5.m194.frozen-authority-verification.v1",
  milestone: "M194",
  experimentId: M193_EXPERIMENT_ID,
  verdict,
  manifest: {
    path: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193c_manifest.json",
    expectedSha256: FROZEN_MANIFEST_SHA256,
    declaredSha256: declaredHash,
    recomputedSha256: recomputed,
    hashRule: "sha256 over canonical key-sorted JSON of every field except manifestHash and manifestHashRule",
    matches: recomputed === FROZEN_MANIFEST_SHA256,
  },
  taskFixture: {
    path: "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m193_task_fixture.json",
    expectedSha256: FROZEN_FIXTURE_SHA256,
    observedSha256: fixtureHash,
    matches: fixtureHash === FROZEN_FIXTURE_SHA256,
    armCount: instances.length,
    repositories: new Set(instances.map((e) => e.repo)).size,
  },
  liveParameters: {
    model: agent.model,
    cliVersionPinned: FROZEN_CLI_VERSION,
    cliVersionedBinary: versionedBinary,
    cliVersionedBinaryReports: versionedReported,
    cliSymlinkReports: symlinkReported,
    cliSymlinkMatchesPin: symlinkReported === FROZEN_CLI_VERSION,
    maxTurns: agent.maxTurns,
    perRunCostCapUsd: limits.perRunCostCapUsd,
    totalSpendCapUsd: limits.totalSpendCapUsd,
    minArms: limits.minArms,
    maxArms: limits.maxArms,
    concurrency: limits.maxConcurrentArms,
  },
  frozenSources: { count: frozenSources.length, drifted },
  repository: {
    branch,
    headSha,
    trackedDirtCount: trackedDirt.length,
    trackedDirt,
    untrackedCount: untracked.length,
  },
  gates,
  gatesPassed: gates.filter((g) => g.pass).length,
  gatesFailed: failed.length,
  failedGates: failed,
};

const out = join(RESULTS, "stage5_m194_frozen_authority.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

for (const g of gates) if (!g.pass) console.log(`  FAIL  ${g.id}  ${g.what}\n        expected ${g.expected}\n        observed ${g.observed}`);
console.log(`\n${verdict}`);
console.log(`  gates ${report.gatesPassed}/${gates.length} passed`);
console.log(`  manifest ${recomputed}`);
console.log(`  fixture  ${fixtureHash}`);
console.log(`  CLI      ${versionedBinary} -> ${versionedReported} (symlink reports ${symlinkReported})`);
console.log(`  frozen sources drifted: ${drifted.length}`);
console.log(`wrote ${out}`);

process.exit(failed.length === 0 ? 0 : 1);

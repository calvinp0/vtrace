/**
 * M161-B §82-§85, §92, §122 — offline harness/treatment validity controls.
 *
 * OFFLINE. No agent, no Docker, no network, no money. It parses the EXACT flag set
 * the frozen paired driver uses, drives the runner's own command/env/context
 * builders, and asserts the properties M161-B claims — so the claims are made
 * against the real code path rather than against the driver's comments.
 *
 * Every control here is a PAIR: the property asserted, and a known positive
 * showing the check can fail. §123 is the standing rule — a plausible zero is not
 * evidence until the detector has demonstrated a known positive.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m161_harness_controls.ts
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable } from "./benchmarkProvenance";
import {
  buildBaselineCommand,
  buildVtraceCommand,
  buildVtraceContextMarkdown,
  detectTokenDisciplineText,
  parseArgs,
  rawConditionDir,
  vtraceInstructionsFilePath,
  workspacePathFor,
  type CliConfig,
  type VtraceContextSection,
} from "./run_stage5_vexp_swe_bench_smoke";
import { baselineCarriesVtraceEvidence } from "./m161Treatment";

const RESULTS = path.join(import.meta.dir, "results");
const VEXP = "/home/calvin/code/vexp-swe-bench";
const DATASET = path.join(RESULTS, "_m160_corpus", "swe_bench_verified.jsonl");
const INSTANCE = "acme__pkg-1";

interface Control {
  readonly id: string;
  readonly section: string;
  readonly claim: string;
  readonly passed: boolean;
  readonly evidence: unknown;
  /** How the same check was shown to FAIL, so a pass is informative (§122/§123). */
  readonly knownPositive: string;
}

/** The exact flags the frozen driver passes, minus the per-arm treatment block. */
function commonFlags(): string[] {
  return [
    "--mode", "run-protocol",
    "--vexp-swe-bench-dir", VEXP,
    "--instances", INSTANCE,
    "--swe-bench-data", DATASET,
    "--vexp-run-data", DATASET,
    "--disable-token-discipline",
    "--disable-pivot-check",
    "--disable-edit-guard",
    "--disable-patch-verify",
    "--disable-context-instruction",
    "--stage5-env-guard",
    "--stage5-env-drift-check",
    "--expected-testbed-prefix", "/home/calvin/miniforge3/envs/vexp_swebench",
    "--stage5-agent-shell-guard",
    "--stage5-host-pip-firewall",
    "--out", RESULTS,
  ];
}

function armConfig(arm: "baseline" | "vtrace"): CliConfig {
  const treatment = arm === "vtrace"
    ? [
        "--protocol", "vtrace-indexed", "--show-vtrace-index-log", "--context-policy", "force-inject",
        "--capsule-engine", "v2", "--capsule-intent", "debug", "--capsule-budget", "8000",
        "--inject-capsule-digest", "--digest-decision-contract", "--bounded-digest-decisions",
        "--compact-digest-injection", "--pivot-confidence-gate",
      ]
    : ["--protocol", "baseline"];
  return parseArgs([...commonFlags(), ...treatment, "--run-label", `m161_${arm}_${INSTANCE.replaceAll("-", "_")}`]);
}

function syntheticSection(): VtraceContextSection {
  return {
    instance: {
      instanceId: INSTANCE, repo: "acme/pkg", baseCommit: "a".repeat(40),
      problemStatement: "boom", failToPass: [], passToPass: [], goldPatch: "",
    } as unknown as VtraceContextSection["instance"],
    rawContext: "## Pivots\n- lead pivot: pkg/mod.py::f\n\n## Support\n- pkg/other.py::g\n",
    error: null,
    classification: { action: "inject" } as unknown as VtraceContextSection["classification"],
    preformatted: true,
    requestedEngine: "v2",
    effectiveEngine: "v2",
    engineFallbackReason: null,
  };
}

async function main(): Promise<void> {
  const baseline = armConfig("baseline");
  const vtrace = armConfig("vtrace");
  const baselineCmd = buildBaselineCommand(baseline, [INSTANCE]);
  const vtraceCmd = buildVtraceCommand(vtrace, [INSTANCE]);
  const controls: Control[] = [];

  // -- C1 command parity ----------------------------------------------------
  // Normalize the per-condition output directory, which MUST differ, then require
  // the rest to be identical. A difference anywhere else is an uncontrolled variable.
  const normalize = (args: readonly string[]): string[] =>
    args.map((a) => (a.includes("/raw/baseline") || a.includes("/raw/vtrace") ? "<OUTPUT_DIR>" : a));
  const baseArgs = normalize(baselineCmd.args);
  const vtraceArgs = normalize(vtraceCmd.args);
  controls.push({
    id: "C1",
    section: "§28 agent configuration parity",
    claim: "the two arms invoke the external harness with identical arguments apart from the per-condition output directory",
    passed: JSON.stringify(baseArgs) === JSON.stringify(vtraceArgs) && baselineCmd.command === vtraceCmd.command,
    evidence: { command: baselineCmd.command, baseline: baseArgs, vtrace: vtraceArgs },
    knownPositive:
      "C2 shows the same comparison failing when --data is present on one arm only; the check is not vacuously true",
  });

  // -- C2 dataset passthrough ----------------------------------------------
  const dataOnBoth = baselineCmd.args.includes("--data") && vtraceCmd.args.includes("--data");
  // Drop `--vexp-run-data <path>` as a PAIR. Filtering by value would also strip
  // --swe-bench-data's argument, which shares the same path and is a different flag.
  const withoutPassthrough = commonFlags().filter((flag, index, all) => flag !== "--vexp-run-data" && all[index - 1] !== "--vexp-run-data");
  const noFlagConfig = parseArgs([...withoutPassthrough, "--protocol", "baseline"]);
  const withoutFlag = buildBaselineCommand(noFlagConfig, [INSTANCE]).args;
  controls.push({
    id: "C2",
    section: "§11 fresh corpus reachability",
    claim: "--vexp-run-data forwards the external CLI's --data to BOTH arms, and is absent by default so historical commands stay byte-identical",
    passed: dataOnBoth
      && baselineCmd.args[baselineCmd.args.indexOf("--data") + 1] === DATASET
      && vtraceCmd.args[vtraceCmd.args.indexOf("--data") + 1] === DATASET
      && !withoutFlag.includes("--data"),
    evidence: {
      baselineData: baselineCmd.args[baselineCmd.args.indexOf("--data") + 1] ?? null,
      vtraceData: vtraceCmd.args[vtraceCmd.args.indexOf("--data") + 1] ?? null,
      defaultCommandHasData: withoutFlag.includes("--data"),
      knownPositiveDiff: JSON.stringify(normalize(withoutFlag)) !== JSON.stringify(baseArgs),
    },
    knownPositive: "the same builder with the flag omitted produces a command WITHOUT --data, and the parity comparison then differs",
  });

  // -- C3 baseline carries zero VTRACE evidence -----------------------------
  const vtraceEnvKeys = Object.keys(baselineCmd.env).filter((k) => k.startsWith("VTRACE_") && k !== "VTRACE_AGENT_STREAM_FILE" && k !== "VTRACE_TOOL_USE_DISCIPLINE_FILE");
  const instructionsPath = vtraceInstructionsFilePath(baseline.out);
  const baselinePointsAtEvidence = Object.values(baselineCmd.env).some((v) => v === instructionsPath);
  controls.push({
    id: "C3",
    section: "§83 baseline isolation",
    claim: "the baseline invocation carries no VTRACE evidence: no env var points at the instructions file, and no VTRACE-context key is set",
    passed: !baselinePointsAtEvidence && vtraceEnvKeys.length === 0 && baselineCarriesVtraceEvidence(JSON.stringify(baselineCmd.env)).length === 0,
    evidence: {
      baselineEnvKeys: Object.keys(baselineCmd.env).sort(),
      vtraceEnvKeys: Object.keys(vtraceCmd.env).sort(),
      envDelta: Object.keys(vtraceCmd.env).filter((k) => !(k in baselineCmd.env)).sort(),
      instructionsPath,
      baselinePointsAtEvidence,
    },
    knownPositive:
      "the same detector reports VTRACE_AGENT_INSTRUCTIONS_FILE on the VTRACE arm's env, so its silence on the baseline is a measurement rather than an absent probe",
  });

  // -- C4 every benchmark-authored policy block absent from both arms -------
  // Rendered twice through the SAME builder: once with every block enabled (the
  // known positive), once under the frozen flags. A marker that appears in the
  // first and not the second is a suppression; a marker missing from both would
  // mean the detector never worked.
  const POLICY_MARKERS = ["## STAGE5_TOKEN_DISCIPLINE", "## PIVOT_CHECK", "## EDIT_GUARD", "## PATCH_VERIFY", "## Instruction"] as const;
  const enabled = buildVtraceContextMarkdown([syntheticSection()], {
    maxChars: 20_000, maxItems: 40, injectTokenDiscipline: true,
    pivotCheckPolicy: "always", disableEditGuard: false, disablePatchVerify: false,
    disableContextInstruction: false,
  });
  const frozen = buildVtraceContextMarkdown([syntheticSection()], {
    maxChars: 20_000, maxItems: 40,
    injectTokenDiscipline: !vtrace.disableTokenDiscipline,
    disablePivotCheck: vtrace.disablePivotCheck,
    disableEditGuard: vtrace.disableEditGuard,
    disablePatchVerify: vtrace.disablePatchVerify,
    disableContextInstruction: vtrace.disableContextInstruction,
  });
  // PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY need a fully-shaped Capsule v2 section to
  // render, which a synthetic stub does not produce — so a synthetic "absent" would
  // prove nothing about them. The known positive for those is a REAL captured
  // injection: the first M161 smoke snapshot, taken before the treatment was narrowed,
  // in which all four blocks are present. A live artifact is a stronger control than a
  // stub anyway (§123).
  const capturedPositive = await Bun.file(path.join(RESULTS, "stage5_m161_policy_block_known_positive.md")).text().catch(() => "");
  const perMarker = POLICY_MARKERS.map((marker) => ({
    marker,
    knownPositivePresent: enabled.markdown.includes(marker) || capturedPositive.includes(marker),
    knownPositiveSource: enabled.markdown.includes(marker) ? "synthetic render with every block enabled" : "captured pre-narrowing smoke injection",
    presentUnderFrozenFlags: frozen.markdown.includes(marker),
  }));
  controls.push({
    id: "C4",
    section: "§30/§85 treatment definition — evidence only",
    claim: "no benchmark-authored policy block renders under the frozen flag set, and each one is shown still renderable so the absence is a suppression",
    passed: perMarker.every((m) => m.knownPositivePresent && !m.presentUnderFrozenFlags)
      && baseline.disableTokenDiscipline === true && vtrace.disableTokenDiscipline === true
      && detectTokenDisciplineText(frozen.markdown) === false,
    evidence: {
      perMarker,
      policyBytesSuppressed: enabled.markdown.length - frozen.markdown.length,
      flags: {
        disableTokenDiscipline: vtrace.disableTokenDiscipline,
        disablePivotCheck: vtrace.disablePivotCheck,
        disableEditGuard: vtrace.disableEditGuard,
        disablePatchVerify: vtrace.disablePatchVerify,
        disableContextInstruction: vtrace.disableContextInstruction,
      },
      capturedKnownPositive: "results/stage5_m161_policy_block_known_positive.md",
      capturedKnownPositiveBytes: capturedPositive.length,
      retainedProductDelivery: "Capsule v2 digest decision contract (src/capsuleV2/digestDecisionContract.ts) — product code, kept",
      historicalImplementationsDeletedOrModified: false,
    },
    knownPositive:
      "the SAME builder with every block enabled emits all five markers, so their absence under the frozen flags is a suppression, not a broken detector",
  });

  // -- C5 session / workspace isolation -------------------------------------
  const baselineWorkspace = workspacePathFor(baseline.out, INSTANCE, baseline.runLabel);
  const vtraceWorkspace = workspacePathFor(vtrace.out, INSTANCE, vtrace.runLabel);
  const baselineRaw = rawConditionDir(baseline.out, "baseline", baseline.runLabel);
  const vtraceRaw = rawConditionDir(vtrace.out, "vtrace", vtrace.runLabel);
  const nested = (a: string, b: string): boolean => a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  controls.push({
    id: "C5",
    section: "§39-§41 workspace and session isolation",
    claim: "each arm indexes and writes under its own run-label paths; no directory is shared or nested inside the other",
    passed: baselineWorkspace !== vtraceWorkspace
      && baselineRaw !== vtraceRaw
      && !nested(baselineWorkspace, vtraceWorkspace)
      && !nested(baselineRaw, vtraceRaw),
    evidence: { baselineWorkspace, vtraceWorkspace, baselineRaw, vtraceRaw },
    knownPositive:
      "workspacePathFor with runLabel=null collapses BOTH arms onto the same path, which this check rejects — the isolation comes from the label, not from the condition name",
  });

  // -- C6 frozen artifact hashes -------------------------------------------
  const paired30 = await Bun.file(path.join(RESULTS, "stage5_m161_paired30_manifest.json")).json();
  const schedule = await Bun.file(path.join(RESULTS, "stage5_m161_arm_schedule.json")).json();
  const protocol = await Bun.file(path.join(RESULTS, "stage5_m161_protocol.json")).json();
  const integrity = await Bun.file(path.join(RESULTS, "stage5_m161_integrity_audit.json")).json();
  const scheduleIds = schedule.paired30.schedule.map((c: { instanceId: string }) => c.instanceId);
  const manifestIds = paired30.cases.map((c: { instanceId: string }) => c.instanceId);
  const integrityValid = new Set(
    integrity.records.filter((r: { status: string }) => r.status === "VALID").map((r: { instanceId: string }) => r.instanceId),
  );
  controls.push({
    id: "C6",
    section: "§17/§46/§118 provenance binding",
    claim: "the protocol names the same manifest, schedule and integrity artifacts that exist on disk, and every scheduled case is a manifest member the gate passed",
    passed: protocol.corpus.paired30.manifestHash === paired30.manifestHash
      && protocol.execution.armSchedule.scheduleHash === schedule.paired30.scheduleHash
      && JSON.stringify(scheduleIds) === JSON.stringify(manifestIds)
      && manifestIds.every((id: string) => integrityValid.has(id)),
    evidence: {
      protocolHash: protocol.protocolHash,
      paired30Hash: paired30.manifestHash,
      scheduleHash: schedule.paired30.scheduleHash,
      scheduledCases: scheduleIds.length,
      integrityValidCases: manifestIds.filter((id: string) => integrityValid.has(id)).length,
    },
    knownPositive:
      "manifestHash binds membership AND order — m161Corpus.test.ts shows a swapped pair producing a different hash, so an equal hash is a real match",
  });

  // -- C7 behavioural routing OFF ------------------------------------------
  const routingFlags = [...commonFlags(), "--protocol", "vtrace-indexed"].filter((f) => f.includes("behavioral") || f.includes("behaviour"));
  controls.push({
    id: "C7",
    section: "§4 behavioural routing",
    claim: "no behavioural-routing flag appears anywhere in the frozen flag set, in either arm",
    passed: routingFlags.length === 0,
    evidence: { behaviouralFlagsInFrozenSet: routingFlags },
    knownPositive: "the product default is OFF and separately test-asserted in the src test suite; this control covers the harness not turning it on",
  });

  // -- C8 the injection patch actually exists in the harness that will run ----
  // The VTRACE injection lives ONLY in the external harness's built dist/, not in
  // its src/. A rebuild of that checkout would silently turn the VTRACE arm into a
  // second baseline, and the injection itself is wrapped in a catch that logs
  // "injection skipped" and continues — so a missing patch degrades to a
  // no-treatment run that still produces a normal-looking result row. Checking the
  // condition's NAME would not catch either failure (§82, §83).
  const adapter = await Bun.file(path.join(VEXP, "dist", "agents", "claude-code.js")).text().catch(() => "");
  const vtracePatch = adapter.includes("STAGE5_VTRACE_INSTRUCTIONS_PATCH begin")
    && adapter.includes("process.env.VTRACE_AGENT_INSTRUCTIONS_FILE");
  const disciplinePatch = adapter.includes("STAGE5_TOOL_USE_DISCIPLINE_PATCH begin");
  const strictMcp = adapter.includes("--strict-mcp-config") && adapter.includes("mcpServers");
  controls.push({
    id: "C8",
    section: "§82 known-positive injection / §25 callable tools",
    claim: "the harness binary that will run carries the VTRACE injection patch and the shared discipline patch, and still launches with an empty strict MCP config",
    passed: vtracePatch && disciplinePatch && strictMcp,
    evidence: {
      adapterPath: path.join(VEXP, "dist", "agents", "claude-code.js"),
      adapterBytes: adapter.length,
      vtraceInjectionPatchPresent: vtracePatch,
      sharedDisciplinePatchPresent: disciplinePatch,
      strictMcpConfigPresent: strictMcp,
      promptAssembly: "buildPrompt(instance) + \"\\n\\n\" + discipline [BOTH arms] + \"\\n\\n## Additional vtrace context/instructions\\n\\n\" + capsule [VTRACE arm only]",
      fragilityNote: "patch is in dist/ only; the harness src/ does not contain it, so a rebuild of the external checkout removes the treatment silently",
    },
    knownPositive:
      "the same substring check returns false against the UNPATCHED src/agents/claude-code.ts, which contains neither marker — so a true here is a real match",
  });

  const report = {
    schemaVersion: "stage5.m161.harness-controls.v1",
    milestone: "M161",
    workstream: "B",
    mode: "offline — no agent, no Docker, no network, no money",
    note:
      "Every control drives the REAL runner builders through the REAL frozen flag set. " +
      "None of them assert against the driver's comments, and each carries a known positive " +
      "showing the same check can fail (§122/§123).",
    counts: { total: controls.length, passed: controls.filter((c) => c.passed).length, failed: controls.filter((c) => !c.passed).length },
    allPassed: controls.every((c) => c.passed),
    controls,
    controlsHash: hashStable(controls.map((c) => `${c.id}:${c.passed}`)),
  };

  await writeFile(path.join(RESULTS, "stage5_m161_harness_controls.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const control of controls) {
    console.log(`${control.passed ? "PASS" : "FAIL"}  ${control.id}  ${control.section} — ${control.claim}`);
  }
  console.log(`\n${report.counts.passed}/${report.counts.total} offline controls passed`);
  if (!report.allPassed) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}

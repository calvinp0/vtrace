/**
 * M216 §8, §9 — the substrate reduction audit, done before any adapter was
 * written.
 *
 * The temptation this table exists to defeat is rewriting M193/M194's Python in
 * TypeScript for the sake of one language. That would produce a second
 * implementation of code that five milestones of controls were written against
 * — M192's workdir finding, M193's ancestry correction and bytecode-staleness
 * hazard, M193B's rename loss, M193C's index-destroying snapshot, M194's
 * termination categories — and every one of those defects would be re-openable
 * in the copy. Reuse is not an aesthetic preference here; it is what keeps the
 * audited behaviour audited.
 *
 * Each row names the M215 interface obligation, the authority that already
 * satisfies it, and how M216 reaches that authority.
 */

export type ReuseStrategy = "DIRECT_REUSE" | "THIN_ADAPTER" | "MISSING_PRIMITIVE";

export interface SubstrateReductionRow {
  readonly obligation: string;
  readonly m215Interface: string;
  readonly existingAuthority: string;
  readonly strategy: ReuseStrategy;
  readonly note: string;
}

export const M216_SUBSTRATE_REDUCTION: readonly SubstrateReductionRow[] = Object.freeze([
  Object.freeze({
    obligation: "container setup",
    m215Interface: "ContainerAdapter.start",
    existingAuthority: "m193_container_adapter.M193Container.setup()",
    strategy: "DIRECT_REUSE" as ReuseStrategy,
    note:
      "Image lookup, one docker-cp extraction of /testbed to the host, one bind-mounted container "
      + "over that tree, safe.directory, the base-commit ancestry check M192's V2 correction added, "
      + "and the pre-existing untracked record. Called unchanged; M216 adds only the /testbed "
      + "writability probe M215's contract asks for.",
  }),
  Object.freeze({
    obligation: "repository reset",
    m215Interface: "ContainerAdapter.resetToBaseCommit",
    existingAuthority: "M193Container.exec_raw + git checkout -f / git clean -xdff",
    strategy: "THIN_ADAPTER" as ReuseStrategy,
    note:
      "M193's setup() checks out the base commit once, at creation. §13 requires source state to be "
      + "ESTABLISHED deliberately for each run rather than inherited from whatever the previous step "
      + "left, so the reset is its own operation: checkout, a clean that removes untracked and "
      + "ignored paths, then re-observation of HEAD, tracked changes and untracked state. It reports "
      + "the state it reached instead of asserting success.",
  }),
  Object.freeze({
    obligation: "source snapshot / source identity",
    m215Interface: "ContainerAdapter.trackedSourceDigest, untrackedPaths, untrackedSourceAffectingPaths",
    existingAuthority: "m193b_changed_source.py enumeration semantics; M193C's status regions",
    strategy: "THIN_ADAPTER" as ReuseStrategy,
    note:
      "M193B answers 'what changed', not 'what is the source right now', and M215's contract needs "
      + "the second. The digest is git hash-object over tracked working-tree bytes — index blobs "
      + "would not change when a file is edited. The pre-agent snapshot is the same enumeration "
      + "M193B and M193C run, asked at DIRECTORY granularity; see the --directory row.",
  }),
  Object.freeze({
    obligation: "pre-agent untracked snapshot granularity",
    m215Interface: "ContainerAdapter.untrackedPaths",
    existingAuthority: "git ls-files --others --exclude-standard --directory",
    strategy: "THIN_ADAPTER" as ReuseStrategy,
    note:
      "M215's D4 measured that this flag decides whether a treatment file written DURING the run is "
      + "attributed to the agent. m193c_patch_snapshot.py enumerates WITHOUT it, and is right to: "
      + "that is the CAPTURE lane, which must reach each untracked file to diff it. M216 adds a "
      + "separate benchmark-owned snapshot command at the coarser granularity and does not modify "
      + "M193C, whose behaviour five milestones of controls were written against.",
  }),
  Object.freeze({
    obligation: "agent launch",
    m215Interface: "AgentAdapter.run",
    existingAuthority: "run_stage5_m194_acquire.launch_agent + m193aArmEnvironment.constructArmEnvironment",
    strategy: "THIN_ADAPTER" as ReuseStrategy,
    note:
      "The process mechanics — bwrap namespace, Popen, stderr drain, timeout kill, stream sink — are "
      + "M194's and are reused. What moves to TypeScript is what DEFINES the experiment: argv, "
      + "environment, arm MCP configuration, model target, budgets. A substrate that could choose "
      + "any of those would be a place for an arm difference to hide.",
  }),
  Object.freeze({
    obligation: "ordered telemetry",
    m215Interface: "AgentRunOutcome.telemetry",
    existingAuthority: "M194's stream-json result/tool_use extraction and termination categories",
    strategy: "THIN_ADAPTER" as ReuseStrategy,
    note:
      "M194 extracted a flat tool_use list and a result event. M215's ledger needs an ORDERED, "
      + "kinded event stream, so the parser is reimplemented against M194's frozen categories rather "
      + "than its data shape, and it is pure: bytes in, telemetry out, no clock, so §49's "
      + "determinism requirement is checkable.",
  }),
  Object.freeze({
    obligation: "patch capture",
    m215Interface: "ContainerAdapter.capturePatch",
    existingAuthority: "m193c_patch_snapshot.patch_snapshot_command + parse_patch_snapshot_output",
    strategy: "DIRECT_REUSE" as ReuseStrategy,
    note:
      "Called with the exclusion list the EXECUTOR derived from its own pre-agent snapshot. Nothing "
      + "in the substrate names a vendor directory: M214's rule is 'what changed minus what already "
      + "existed', and brand names are defence in depth, never the semantics.",
  }),
  Object.freeze({
    obligation: "evaluation",
    m215Interface: "EvaluatorAdapter.evaluate",
    existingAuthority: "run_stage5_m194_acquire.evaluate_arm over swebench.harness.run_evaluation",
    strategy: "DIRECT_REUSE" as ReuseStrategy,
    note:
      "The official harness, its report.json, and M194's separation of 'the evaluator did not run' "
      + "from 'the task did not resolve'. The dataset is a parameter so a non-frozen research "
      + "instance can be evaluated without the frozen dataset being involved.",
  }),
  Object.freeze({
    obligation: "teardown",
    m215Interface: "ContainerAdapter.stop",
    existingAuthority: "M193Container.teardown()",
    strategy: "DIRECT_REUSE" as ReuseStrategy,
    note:
      "Container removal plus host-mount removal. M216 additionally removes the arm's own scratch "
      + "root, which is where the treatment index and the agent's private configuration directory "
      + "live, because §43 asks that neither survive into the paired arm.",
  }),
  Object.freeze({
    obligation: "wrong-source detection",
    m215Interface: "preflightGates R6_SOURCE_STATE_EQUIVALENCE",
    existingAuthority: "run_stage5_m192_wrong_source_control.py; m193a_source_version_probe.py",
    strategy: "DIRECT_REUSE" as ReuseStrategy,
    note:
      "M192 established that an unpinned workdir silently resolves an installed copy, which is why "
      + "every exec pins its cwd. The gate itself is M214's own auditSourceStateEquivalence, called "
      + "by M215 on digests M216 supplies.",
  }),
  Object.freeze({
    obligation: "treatment initialisation and catalogue",
    m215Interface: "ContainerAdapter.initialiseTreatment, inspectArmSurface",
    existingAuthority: "none — the VTRACE arm has never been executed",
    strategy: "MISSING_PRIMITIVE" as ReuseStrategy,
    note:
      "M193/M194 acquired ONE untreated arm. There is no prior authority for building the index "
      + "before the agent starts, for measuring it separately from the model budget, or for reading "
      + "the served tool catalogue back. M216 implements it, and reads the catalogue from the server "
      + "that would actually serve it rather than from the configuration that was meant to start it.",
  }),
  Object.freeze({
    obligation: "provider-model identity assertion during initialisation",
    m215Interface: "AgentRunHooks.assertProviderModelIdentity",
    existingAuthority: "none — M194 read the init event after the fact",
    strategy: "MISSING_PRIMITIVE" as ReuseStrategy,
    note:
      "M194 parsed the stream after the process exited, which puts the check after the money. M216 "
      + "streams events across the boundary as they arrive so the hook fires on the init event, and "
      + "a failed assertion writes an abort sentinel a watchdog acts on.",
  }),
]);

export interface SubstrateReductionVerdict {
  readonly verdict: "M216_SUBSTRATE_REDUCTION_COMPLETE" | "M216_SUBSTRATE_REDUCTION_INCOMPLETE";
  readonly rows: number;
  readonly directReuse: number;
  readonly thinAdapter: number;
  readonly missingPrimitive: number;
  readonly unclassified: readonly string[];
}

/**
 * The audit is COMPLETE when every obligation has been classified, not when
 * every obligation was already solved.
 *
 * A MISSING_PRIMITIVE is an honest answer: it says the work exists and names it.
 * What would make the reduction incomplete is an obligation nobody looked at,
 * because that is the one that gets reimplemented by accident.
 */
export function reductionVerdict(
  rows: readonly SubstrateReductionRow[] = M216_SUBSTRATE_REDUCTION,
): SubstrateReductionVerdict {
  const strategies: readonly ReuseStrategy[] = ["DIRECT_REUSE", "THIN_ADAPTER", "MISSING_PRIMITIVE"];
  const unclassified = rows
    .filter((row) => !strategies.includes(row.strategy) || row.existingAuthority.trim().length === 0)
    .map((row) => row.obligation);
  const count = (strategy: ReuseStrategy): number =>
    rows.filter((row) => row.strategy === strategy).length;
  return {
    verdict: unclassified.length === 0
      ? "M216_SUBSTRATE_REDUCTION_COMPLETE"
      : "M216_SUBSTRATE_REDUCTION_INCOMPLETE",
    rows: rows.length,
    directReuse: count("DIRECT_REUSE"),
    thinAdapter: count("THIN_ADAPTER"),
    missingPrimitive: count("MISSING_PRIMITIVE"),
    unclassified: Object.freeze(unclassified),
  };
}

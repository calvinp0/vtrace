import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { CapsuleMode, type CapsuleMode as CapsuleModeT } from "../../src/capsule/capsuleModes";
import {
  RecommendedCapsuleMode,
  TargetConfidence,
  deriveModeSignals,
  recommendCapsuleMode,
  type RecommendedCapsuleMode as RecommendedCapsuleModeT,
  type TargetConfidence as TargetConfidenceT,
} from "../../src/capsule/recommendMode";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import {
  contextMentionsFile,
  contextMentionsSymbol,
  editedFilesFromPatch,
  mutationToolCallsIn,
  parsePivotCheckRows,
  primaryEditedFile,
  primaryEditedSymbol,
  type PivotForInspection,
} from "../../src/capsule/finalEditDiagnostics";
import {
  assistantTextFromStream,
  detectNeighborhoodMention,
  detectPivotChecklistEmitted,
  parseOrderedToolCalls,
  summarizeOrderedToolCalls,
  toInspectionToolCalls,
  type OrderedToolCallSummary,
} from "../../src/capsule/toolCallLog";
import {
  describeHardGateOutcome,
  hardGateMetaFields,
  orchestrateHardGate,
  type HardGatePhase1Outcome,
  type HardGatePhase2Outcome,
} from "./pivotCheckGateRunner";
import {
  DEFAULT_PRE_EDIT_BASH_BUDGET,
  DEFAULT_PRE_EDIT_SEARCH_BUDGET,
  DEFAULT_REPEATED_FILE_READ_LIMIT,
} from "../../src/capsule/turnCountWaste";
import { renderCapsuleV2Human } from "../../src/capsuleV2/renderHuman";
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";
import {
  renderPivotNeighborhoodsText,
  type PivotNeighborhoodContext,
} from "../../src/runPipeline/pivotNeighborhood";
import {
  buildInspectFirst,
  renderInspectFirstText,
} from "../../src/runPipeline/inspectFirst";
import { CapsuleV2Mode, parseCapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { pathIsUserLocalized, type LocalizationSignals } from "../../src/capsuleV2/localizationSignals";
import {
  type CapsuleV2ArtifactBundle,
  type CapsuleV2ArtifactMeta,
  capsuleV2ArtifactsNotPersistedMeta,
  writeCapsuleV2Artifacts,
} from "../../src/capsuleV2/stage5Artifacts";
import {
  buildExpectedIndexMeta,
  checkIndexFreshness,
  resolveIndexMetaPath,
  resolveVtraceDir,
  type IndexFreshness,
} from "../../src/indexer/indexMeta";
import {
  buildProductV2RunPipelineArgs,
  parseProductV2Response,
  productV2ProbeDir,
  productV2ProbeFilePath,
} from "./stage5_product_v2_probe";

// Stage 5 is a SMOKE integration harness around the external `vexp-swe-bench`
// benchmark. It proves the baseline-vs-vtrace measurement workflow on a tiny
// subset. It does not vendor vexp-swe-bench, does not run the full benchmark,
// and makes no public SWE-bench claim. See README.md for scope.

export type Stage5Mode =
  | "prepare"
  | "run-baseline"
  | "run-vtrace"
  | "run-vexp"
  | "run-protocol"
  | "evaluate"
  | "ingest"
  | "report"
  | "aggregate-runs"
  | "install-vtrace-patch"
  | "verify-vtrace-patch";
export type Stage5Condition = "baseline" | "vtrace" | "vexp";
export type VtraceMethod = "instructions-file" | "mcp" | "local-patch" | "indexed-context";
// Index-reuse policy for the vtrace `index` step (--index-policy):
//   auto   -> reuse an existing index when .vtrace/index.sqlite + index.meta.json
//             exist AND the stored fingerprints match; otherwise rebuild.
//   always -> delete .vtrace and rebuild the index even when it is fresh.
//   reuse  -> reuse an existing index if present even if its metadata mismatches
//             (warn loudly); rebuild only when no index is present at all.
export type Stage5IndexPolicy = "auto" | "always" | "reuse";
// Which capsule retrieval engine the indexed-context query uses. `legacy` is the
// original `--mode <micro|standard|full>` path; `v2` is the Capsule v2 product
// surface (`--intent <i> --budget <n>`), so live Stage 5 runs actually validate
// Capsule v2 retrieval. The legacy `--mode` flags are NEVER passed to v2.
export type CapsuleEngine = "legacy" | "v2";
// Capsule v2 intents, matching the `capsule --intent` CLI surface and the shared
// normalized intent model (debug/modify/refactor/impact/explain/test-failure +
// auto). Validated through `parseCapsuleIntent` so this never drifts from the
// canonical `CapsuleIntent` vocabulary.
export type CapsuleV2Intent =
  | "auto"
  | "debug"
  | "modify"
  | "refactor"
  | "impact"
  | "explain"
  | "test-failure";
// Deterministic PIVOT_CHECK injection policy (--pivot-check-policy). Controls WHEN
// the compact PIVOT_CHECK localization checklist (and the EDIT_GUARD / PATCH_VERIFY
// blocks that ride with it) is appended to a Capsule v2 section. A token-cost knob:
//   off                -> never inject PIVOT_CHECK.
//   multi_pivot        -> legacy behaviour: inject whenever the capsule has >= 2 pivots.
//   risk_gated         -> inject only when a deterministic high-risk signal is present
//                         — two ordinary pivots alone no longer qualify.
//   strict_risk_gated  -> token-reduction gate (DEFAULT): keep the multi-pivot floor
//                         but require a STRONG risk signal (>= 3 pivots, edit-risk
//                         directives, a known edit-relevant hidden pivot, or hidden_pivot
//                         corroborated by >= 1 additional signal). hidden_pivot ALONE is
//                         not sufficient. The internal Stage 5 default.
//   always             -> inject whenever Capsule v2 context exists (experiments only).
// --disable-pivot-check forces `off` regardless of this policy (compatibility).
export type PivotCheckPolicy = "off" | "multi_pivot" | "risk_gated" | "strict_risk_gated" | "always";
export const PIVOT_CHECK_POLICIES: readonly PivotCheckPolicy[] = [
  "off",
  "multi_pivot",
  "risk_gated",
  "strict_risk_gated",
  "always",
];
// Hard context-to-action gate mode (opt-in, default off). The matplotlib canary
// proved a SOFT injected PIVOT_CHECK is insufficient: the block reached the agent
// but it emitted no checklist. "hard" turns the injection into a deterministic
// two-phase gate — a Phase 1 inspect-only preflight whose checklist is verified
// before any Phase 2 solve runs (Phase 2 is skipped entirely on a failed gate, so
// no solve and no Docker evaluation happen). "off" preserves the existing
// single-shot path exactly. Orthogonal to --pivot-check-policy, which only governs
// the soft block's injection.
export type PivotCheckGateMode = "off" | "hard";
export const PIVOT_CHECK_GATE_MODES: readonly PivotCheckGateMode[] = ["off", "hard"];
// The mutation/unsafe tools denied during the Phase-1 read-only preflight. Passed
// to the patched adapter via VTRACE_AGENT_DISALLOWED_TOOLS; Claude Code deny rules
// take precedence over the orchestrator's hardcoded allow-list, so with these
// denied the preflight agent can Read/Grep/Glob but cannot Edit/Write/Bash. Bash
// is denied because a read-only preflight cannot cheaply prove a shell command is
// non-mutating (treat-as-unsafe). Phase 2 (the solve) is unaffected.
export const PHASE1_READONLY_DISALLOWED_TOOLS: readonly string[] = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash",
];
// Stage 5C named protocols. A protocol selects which condition(s) to run and how:
//   baseline       -> `run --no-vexp`
//   vtrace-indexed -> `run --no-vexp` + vtrace indexed-context injection
//   vexp           -> `run` (vexp ENABLED) — gated behind --allow-vexp, never default
//   all            -> baseline + vtrace-indexed (+ vexp only if --allow-vexp)
export type Stage5Protocol = "baseline" | "vtrace-indexed" | "vexp" | "all";
// vexp-swe-bench evaluation modes. Stage 5C invokes the EXTERNAL benchmark's
// separate `evaluate` step (see README "Stage 5C"); `run` alone always leaves
// `resolved: null`. "docker" runs the real SWE-bench test suite; "lightweight"
// only checks patch non-emptiness and is NOT a pass/fail signal.
export type EvalMode = "docker" | "lightweight";
export const STAGE5_CONDITIONS: readonly Stage5Condition[] = ["baseline", "vtrace", "vexp"];
export type Outcome =
  | "both_resolved"
  | "vtrace_only_resolved"
  | "baseline_only_resolved"
  | "both_failed"
  | "unpaired"
  | "unknown";

// Per-row run classification. This separates the THREE distinct situations that
// were previously collapsed into a vague "no condition results" message:
//   infra_failed           — Claude/API infrastructure error (e.g. 529 overloaded);
//                            not a vtrace treatment or model-solving failure.
//   agent_failed           — the agent run errored (non-infra), no patch produced.
//   policy_skip            — vtrace deliberately injected no context (valid policy).
//   completed_patch        — a real run that produced a model patch.
//   completed_no_patch     — a real run that completed but produced no patch.
//   missing_condition_result — no result row was written (run failed before/at spawn).
// infra_failed rows are excluded from every benchmark metric; they appear only in
// the failure/rerun diagnostics so an overloaded API never reads as a vtrace loss.
export type RunStatus =
  | "infra_failed"
  | "agent_failed"
  | "policy_skip"
  | "completed_patch"
  | "completed_no_patch"
  | "missing_condition_result";

// Most numeric/boolean fields can be genuinely absent in benchmark output. We
// never guess a value; an absent field is recorded as the literal "unknown".
export type Unknownable<T> = T | "unknown";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    // Inherit this process's stdio for the child instead of capturing it, so the
    // child sees a real TTY and renders its native interactive output (the
    // vtrace index progress BAR, not the plain per-file fallback). The captured
    // stdout/stderr come back empty in this mode.
    readonly inheritStdio?: boolean;
    // Tee mode: capture stdout/stderr AND echo them live to our terminal. Keeps the
    // captured buffers populated (unlike inheritStdio), so telemetry/archival still
    // work while the operator sees progress. Used for the agent child and the
    // non-TTY index/clone fallback.
    readonly streamToTerminal?: boolean;
  },
) => Promise<ProcessResult>;

export interface RunDeps {
  readonly runProcess?: ProcessRunner;
  // Injectable backoff sleep for git-retry tests (default: real setTimeout). Tests
  // pass a no-op so retries are deterministic and instant.
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CliConfig {
  readonly mode: Stage5Mode;
  readonly vexpSweBenchDir: string | null;
  readonly instances: readonly string[];
  readonly instancesFile: string;
  readonly out: string;
  readonly nodeCommand: string;
  readonly cliEntry: string;
  readonly vtraceMethod: VtraceMethod;
  readonly yes: boolean;
  // Stage 5B (indexed-context) configuration.
  readonly vtraceCommand: string;
  readonly vtraceIndexArgs: string;
  readonly vtraceQueryArgs: string;
  readonly skipVtraceIndexIfPresent: boolean;
  // Workspace reuse policy. By default a labeled run RECREATES its workspace
  // (git clean -fdx + recheckout to the base commit + reindex) so a re-run never
  // evaluates against a stale index or leftover untracked state. --reuse-workspace
  // opts out: the existing checkout and index are reused as-is.
  readonly reuseWorkspace: boolean;
  // Index-reuse policy for the vtrace `index` step (see Stage5IndexPolicy). The
  // default `auto` reuses a fingerprint-fresh index and rebuilds a stale one, so
  // a fresh-workspace run still resets source files to the base commit without
  // forcing an unnecessary re-index when the stored index remains valid.
  readonly indexPolicy: Stage5IndexPolicy;
  // When true, show the vtrace `index` progress in the terminal: the runner drops
  // --quiet and inherits its stdio to the index child so it sees a real TTY and
  // draws its native progress bar (with VTRACE_PROGRESS_STREAM=1 as the non-TTY
  // fallback to a plain per-file stream). Absent, the index runs quietly as before.
  readonly showVtraceIndexLog: boolean;
  readonly vtraceContextMaxChars: number;
  readonly vtraceContextMaxItems: number;
  // Capsule retrieval engine for the indexed-context query (--capsule-engine).
  // `legacy` keeps the original `--mode` path; `v2` exercises Capsule v2 via
  // `--intent`/`--budget`. capsuleIntent/capsuleBudget only apply to `v2`.
  readonly capsuleEngine: CapsuleEngine;
  readonly capsuleIntent: CapsuleV2Intent;
  readonly capsuleBudget: number;
  // When true AND capsuleEngine === "v2", also probe the PRODUCT surface
  // (`run-pipeline --capsule-engine v2`) per instance and persist its accounting /
  // contextEngine / capsuleV2 signals. Default false: pure instrumentation for the
  // product-v2 turn-reduction gate, never alters retrieval or the injected context.
  readonly captureProductV2Accounting: boolean;
  // Operator override for the cost-aware context-injection gate (--context-policy).
  // "auto" (default) keeps decideContextPolicy in charge; the force-* values are
  // for Capsule v2 live validation. See ContextPolicyOverride.
  readonly contextPolicyOverride: ContextPolicyOverride;
  // Deterministic PIVOT_CHECK injection policy (--pivot-check-policy). Default
  // "strict_risk_gated": PIVOT_CHECK keeps the multi-pivot floor but injects only on a
  // STRONG risk signal — not merely a hidden pivot or two ordinary pivots (a further
  // token-reduction change over "risk_gated"). See PivotCheckPolicy. --disable-pivot-check
  // overrides this to "off".
  readonly pivotCheckPolicy: PivotCheckPolicy;
  // Benchmark-only PIVOT_CHECK suppression (--disable-pivot-check). Default false.
  // When true, the effective policy is forced to "off" (the compact PIVOT_CHECK
  // block is NOT appended), so a controlled "before" run (Capsule v2 injected,
  // PIVOT_CHECK off) can be compared against the default "after" run. Affects only
  // the PIVOT_CHECK block; normal VTRACE context, telemetry, and ordered tool-call
  // capture are untouched. Retained for compatibility alongside --pivot-check-policy.
  readonly disablePivotCheck: boolean;
  // Hard context-to-action gate (--pivot-check-gate). Default "off" — the existing
  // single-shot run path is unchanged. "hard" runs the two-phase enforcement
  // (Phase 1 inspect-only preflight → gate → Phase 2 solve only on pass) for the
  // vtrace-indexed Capsule v2 condition. See PivotCheckGateMode.
  readonly pivotCheckGate: PivotCheckGateMode;
  // Phase-1-only canary (--pivot-check-gate-phase1-only). Default false. When true
  // (and --pivot-check-gate hard), the harness runs the read-only Phase-1 preflight,
  // evaluates the gate, writes the result, and STOPS — Phase 2 never runs even on a
  // pass. Used to prove the read-only preflight can pass without editing before
  // committing to the full two-phase solve. No effect unless the hard gate is on.
  readonly pivotCheckGatePhase1Only: boolean;
  // Benchmark-only EDIT_GUARD suppression (--disable-edit-guard). Default false:
  // the compact EDIT_GUARD edit-discipline block rides with PIVOT_CHECK for
  // multi-pivot Capsule v2 runs (injected right after it). When true, EDIT_GUARD is
  // NOT appended, so a "PIVOT_CHECK only" before run can be compared against a
  // "PIVOT_CHECK + EDIT_GUARD" after run. Because EDIT_GUARD rides on the PIVOT_CHECK
  // block, --disable-pivot-check also removes EDIT_GUARD (no checklist => no guard).
  // Affects only the EDIT_GUARD block; retrieval, ranking, and telemetry are untouched.
  readonly disableEditGuard: boolean;
  // Benchmark-only PATCH_VERIFY suppression (--disable-patch-verify). Default false:
  // the compact PATCH_VERIFY patch-quality checkpoint rides with PIVOT_CHECK for
  // multi-pivot Capsule v2 runs and is appended AFTER EDIT_GUARD when both are
  // present. It is INDEPENDENT of EDIT_GUARD: --disable-edit-guard removes only the
  // guard and leaves PATCH_VERIFY, while this flag removes only PATCH_VERIFY. Because
  // it rides on the PIVOT_CHECK checklist gate, --disable-pivot-check removes it too
  // (no checklist => no checkpoint). PATCH_VERIFY is a patch-quality checkpoint, NOT
  // a retrieval/inspection mechanism; it changes no retrieval, ranking, or telemetry.
  readonly disablePatchVerify: boolean;
  // Benchmark/dev-only suppression of the shared anti-loop tool-use-discipline block
  // (--disable-tool-use-discipline). Default false: the generic anti-loop guidance is
  // injected into BOTH baseline and vtrace agent prompts. When true, the block is NOT
  // injected for any condition (so a controlled "before" run without anti-loop guidance
  // can be measured). This is a benchmark/dev override, NOT a user-facing product mode;
  // it changes only the appended discipline text — retrieval, ranking, PIVOT_CHECK,
  // Capsule generation, critic, repair, and evaluation are untouched.
  readonly disableToolUseDiscipline: boolean;
  // Benchmark/dev-only suppression of the vtrace-only STAGE5_TOKEN_DISCIPLINE block
  // (--disable-token-discipline). Default false: the active turn-count reduction
  // policy is injected on the live vtrace context path, conditional on per-section
  // capsule confidence (strong => patch-first, weak => exploratory). When true, no
  // token-discipline block is injected (a controlled "before" run). Like the
  // tool-use-discipline flag this is a benchmark/dev override, NOT a product mode;
  // it changes only the appended discipline text — retrieval, ranking, PIVOT_CHECK,
  // Capsule generation, critic, repair, and evaluation are untouched.
  readonly disableTokenDiscipline: boolean;
  readonly sweBenchDataFile: string | null;
  readonly runLabel: string | null;
  // Stage 5C aggregate-runs: the set of run-labels to combine into one report.
  // null unless --mode aggregate-runs --run-labels a,b,c is used.
  readonly runLabels: readonly string[] | null;
  // Stage 5C (evaluated protocol) configuration.
  readonly protocol: Stage5Protocol;
  // vexp is NEVER enabled unless this is explicitly set; guards every vexp run.
  readonly allowVexp: boolean;
  readonly evalMode: EvalMode;
  // Full SWE-bench dataset JSONL (or HF name) passed to the external Docker
  // evaluator as --dataset. null defers to the evaluator's own default.
  readonly evalDataset: string | null;
  readonly evalTimeout: number;
}

export interface SmokeInstancesFile {
  readonly instances: readonly string[];
  readonly notes: readonly string[];
}

// Stage 5B (indexed-context) fields. null on baseline rows / when not run; on
// vtrace rows they describe the actual vtrace indexing + query that produced the
// injected context. Shared between normalized rows and run-level evidence.
export interface IndexedContextFields {
  readonly vtraceIndexedContext: boolean | "unknown" | null;
  readonly vtraceIndexCommand: string | null;
  readonly vtraceQueryCommand: string | null;
  readonly vtraceWorkspacePath: string | null;
  readonly vtraceContextFile: string | null;
  readonly vtraceContextChars: number | null;
  readonly vtraceContextItems: number | null;
  readonly vtraceContextTruncated: boolean | null;
  readonly vtraceContextError: string | null;
  // Stage 5 vtrace policy fields. `skip` is a first-class, VALID policy decision
  // (vtrace recovered no high-confidence target for a small/local task), distinct
  // from an indexed-context treatment. null on baseline / non-indexed rows.
  readonly vtracePolicyAction: VtracePolicyAction | "unknown" | null;
  readonly vtraceContextInjected: boolean | null;
  readonly vtraceSkipReason: string | null;
  readonly vtracePivotCount: number | null;
  readonly vtraceSupportCount: number | null;
  // Cost-aware injection gate (decideContextPolicy). `vtraceContextPolicyAction`
  // is the gate's decision in its own vocabulary (`inject`|`no_context`); a
  // `no_context` decision is RECORDED via the existing `skip` mechanism above
  // (vtracePolicyAction === "skip"), so the two never disagree. The remaining
  // fields explain WHY the gate chose as it did. All null on baseline rows.
  readonly vtraceContextPolicyAction: ContextPolicyAction | "unknown" | null;
  // The operator override in effect for this run (--context-policy). "auto" on a
  // normal cost-aware run; null on baseline / non-indexed rows.
  readonly vtraceContextPolicyOverride: ContextPolicyOverride | "unknown" | null;
  readonly vtracePolicyReason: string | null;
  // The named signals behind the gate's decision (e.g. "edit_risk_directive_present").
  // null on baseline rows; empty list when the decider computed no named signals.
  readonly vtraceContextPolicyDecisionSignals: readonly string[] | null;
  readonly expectedContextValue: ExpectedLevel | null;
  readonly expectedOverheadRisk: ExpectedLevel | null;
  // Capsule engine that produced the query (--capsule-engine). intent/budget are
  // null on baseline rows and on the legacy engine. null engine on baseline rows.
  readonly vtraceCapsuleEngine: CapsuleEngine | "unknown" | null;
  readonly vtraceCapsuleIntent: string | null;
  readonly vtraceCapsuleBudget: number | null;
  // Engine-default migration audit. `vtraceCapsuleEngine` above is the EFFECTIVE
  // engine (kept for backward compatibility). These distinguish what was requested
  // (default v2) from what effectively produced the context after any v2 → legacy
  // fallback, the fallback reason, and whether compact inspect-first was the render
  // path. All null/"unknown" on older runs that predate these fields.
  readonly vtraceRequestedCapsuleEngine: CapsuleEngine | "unknown" | null;
  readonly vtraceEffectiveCapsuleEngine: CapsuleEngine | "unknown" | null;
  readonly vtraceCapsuleEngineFallbackReason: string | null;
  readonly vtraceCompactInspectFirst: boolean | null;
  // Capsule v2 selected-item audit (Requirement 2): the exact injected pivots /
  // support, the lead pivot file/symbol, the realised actual_mode, and the
  // capsule's token estimate. Empty/null off the v2 engine and on baseline rows.
  readonly vtraceCapsulePivots: readonly CapsuleAuditItem[] | null;
  readonly vtraceCapsuleSupport: readonly CapsuleAuditItem[] | null;
  readonly vtraceCapsuleTopPivotFile: string | null;
  readonly vtraceCapsuleTopPivotSymbol: string | null;
  readonly vtraceCapsuleActualMode: string | null;
  readonly vtraceCapsuleEstimatedTokens: number | null;
  // Lead-pivot focused-source audit (Requirement: pivots must inject focused
  // source bodies). Proves the snapshot carried the top pivot's body, not just
  // its path/symbol/reason. `hasSource` false + mode "missing" when none was
  // injected — never silently pretending a body was present. v2-only.
  readonly vtraceCapsuleTopPivotHasSource: boolean | null;
  readonly vtraceCapsulePivotSourceChars: number | null;
  readonly vtraceCapsulePivotSourceMode: CapsulePivotSourceMode | null;
  // Capsule v2 policy-evidence diagnostics: the edit-risk directive count and
  // whether the line-anchor / SQL-rendering recovery routes fired. These are the
  // engine's own signals the v2 cost-aware gate reads. null on baseline rows;
  // 0/false off the v2 engine.
  readonly vtraceCapsuleEditRiskDirectivesCount: number | null;
  readonly vtraceCapsuleLineAnchorResolutionUsed: boolean | null;
  readonly vtraceCapsuleSqlRenderingBackfillUsed: boolean | null;
  // PIVOT_CHECK state (Stage 5 before/after experiments). `Enabled` is false only
  // when --disable-pivot-check was passed; `DisabledByFlag` mirrors that flag;
  // `Injected` is whether the compact PIVOT_CHECK block actually entered the
  // injected context. A "before" run reads enabled=false / disabledByFlag=true /
  // injected=false; a single-pivot run reads enabled=true / disabledByFlag=false /
  // injected=false — so a controlled before run is never confused with a failed
  // injection. All null on baseline / non-indexed rows.
  readonly vtracePivotCheckEnabled: boolean | null;
  readonly vtracePivotCheckInjected: boolean | null;
  readonly vtracePivotCheckDisabledByFlag: boolean | null;
  // Deterministic PIVOT_CHECK policy state (--pivot-check-policy). `Policy` is the
  // effective policy ("off" when --disable-pivot-check forced it); `PolicyReason` is
  // the representative section's rationale; `RiskSignals` are the deterministic
  // high-risk signals present (empty when none / not v2); `WouldInjectUnderMultiPivot`
  // records whether the old >= 2-pivot behaviour would have injected — so a reader
  // can tell "absent because disabled" from "absent because risk_gated did not
  // trigger" and measure the token-cost change. All null on rows that predate them.
  readonly vtracePivotCheckPolicy: PivotCheckPolicy | null;
  readonly vtracePivotCheckPolicyReason: string | null;
  readonly vtracePivotCheckRiskSignals: readonly string[] | null;
  readonly vtracePivotCheckWouldInjectUnderMultiPivot: boolean | null;
  // EDIT_GUARD state (Stage 5 before/after experiments), recorded alongside
  // PIVOT_CHECK and kept strictly SEPARATE from inspection-conversion / edited-file /
  // patch / resolution signals — it is an observability flag, never an outcome.
  // `Enabled` is false only when --disable-edit-guard was passed; `DisabledByFlag`
  // mirrors that flag; `Injected` is whether the compact EDIT_GUARD block actually
  // entered the injected context (true only when enabled AND a PIVOT_CHECK block was
  // injected — the guard rides with the checklist). `TextPresent` independently
  // re-scans the assembled instruction snapshot for the EDIT_GUARD marker. All null
  // on baseline / non-indexed rows and on older runs that predate the field.
  readonly vtraceEditGuardEnabled: boolean | null;
  readonly vtraceEditGuardInjected: boolean | null;
  readonly vtraceEditGuardDisabledByFlag: boolean | null;
  readonly vtraceEditGuardTextPresent: boolean | null;
  // PATCH_VERIFY state (Stage 5 before/after experiments). A patch-quality checkpoint
  // recorded alongside PIVOT_CHECK / EDIT_GUARD and kept strictly SEPARATE from
  // inspection-conversion / edited-file / patch / resolution signals — it is an
  // observability flag, never an outcome, and is NOT a retrieval mechanism.
  // `Enabled` is false only when --disable-patch-verify was passed; `DisabledByFlag`
  // mirrors that flag; `Injected` is whether the compact PATCH_VERIFY block actually
  // entered the injected context (true only when enabled AND a PIVOT_CHECK block was
  // injected — the checkpoint rides with the checklist, after EDIT_GUARD).
  // `TextPresent` independently re-scans the assembled snapshot for the marker. All
  // null on baseline / non-indexed rows and on older runs that predate the field.
  readonly vtracePatchVerifyEnabled: boolean | null;
  readonly vtracePatchVerifyInjected: boolean | null;
  readonly vtracePatchVerifyDisabledByFlag: boolean | null;
  readonly vtracePatchVerifyTextPresent: boolean | null;
}

// Stage 5C evaluation evidence, normalized per instance. resolved itself stays
// on the row (it is the primary signal); these are the supporting fields proving
// HOW it was reached. All null/"unknown" until an `evaluate` run populates them —
// a generated-but-unevaluated patch never fabricates a pass/fail.
export interface EvaluationFields {
  readonly evaluationRan: boolean | null;
  readonly evaluationMethod: EvalMode | "unknown" | null;
  readonly failToPassPassed: Unknownable<boolean> | null;
  readonly passToPassPassed: Unknownable<boolean> | null;
  readonly testStatus: string | null;
  readonly dockerUsed: boolean | "unknown" | null;
  readonly evaluationError: string | null;
}

// Capsule-sizing diagnostics, per vtrace row. recommended/actual mode + the
// reason explain WHAT context vtrace decided to inject; final_edited_* (parsed
// from the model patch) + contains_* explain whether that context actually
// pointed at what the model ended up editing. All null on baseline rows and
// whenever the source data (dataset / patch / context) is unavailable — never
// coerced to a value, so a missing input reads as "unknown", not "no".
export interface CapsuleDiagnosticFields {
  readonly recommendedMode: string | null;
  readonly actualCapsuleMode: string | null;
  readonly targetConfidence: string | null;
  readonly retrievalReason: string | null;
  // How hard the agent should search before trusting the capsule (Requirement 5),
  // captured verbatim from the capsule diagnostics. null on baseline rows.
  readonly searchBudget: string | null;
  readonly searchBudgetReason: string | null;
  readonly topLikelyFile: string | null;
  readonly topLikelySymbol: string | null;
  readonly likelyTargetsCount: number | null;
  readonly finalEditedFile: string | null;
  readonly finalEditedSymbol: string | null;
  readonly containsFinalEditedFile: boolean | null;
  readonly containsFinalEditedSymbol: boolean | null;
}

// Agent-compliance diagnostics (Requirement 6): did the agent actually follow the
// capsule's "edit here first" directive? Derived from the agent's ORDERED tool
// calls when the raw result carries them. SWE-bench result records usually report
// only AGGREGATE tool counts (no ordering), so these honestly record "unknown"
// rather than guess — the parser activates only when an ordered list is present.
export interface AgentComplianceFields {
  /** The capsule's lead pivot file the directive pointed at; null if unknown. */
  readonly pivotFile: string | null;
  readonly firstReadFile: string | "unknown" | null;
  readonly firstEditFile: string | "unknown" | null;
  readonly didReadPivotBeforeSearch: Unknownable<boolean> | null;
  readonly didEditPivot: Unknownable<boolean> | null;
  readonly searchCallsBeforePivot: Unknownable<number> | null;
}

// Per-row run-status diagnostics (Requirements 1–6). runStatus is the single
// authoritative classification; the infra_* fields carry the API-failure detail
// when runStatus === "infra_failed". All default to null on freshly parsed rows
// and are (re)derived once vtrace policy + evaluation fields are stamped.
export interface RunStatusFields {
  readonly runStatus: RunStatus | null;
  readonly shouldRerun: boolean | null;
  readonly infraErrorStatus: number | null;
  readonly infraErrorKind: string | null;
  readonly infraErrorMessage: string | null;
}

export interface Stage5Row extends IndexedContextFields, EvaluationFields, CapsuleDiagnosticFields, AgentComplianceFields, RunStatusFields {
  readonly instanceId: string;
  readonly condition: Stage5Condition;
  readonly resolved: Unknownable<boolean>;
  readonly costUsd: Unknownable<number>;
  readonly durationMs: Unknownable<number>;
  readonly inputTokens: Unknownable<number>;
  readonly outputTokens: Unknownable<number>;
  readonly cacheReadTokens: Unknownable<number>;
  readonly cacheCreationTokens: Unknownable<number>;
  readonly totalTokens: Unknownable<number>;
  readonly tokenAccountingMethod: string;
  readonly numTurns: Unknownable<number>;
  readonly toolCallsTotal: Unknownable<number>;
  readonly toolCallsBreakdown: string | null;
  readonly patchAvailable: Unknownable<boolean>;
  readonly patchLines: Unknownable<number>;
  readonly model: string | null;
  readonly agent: string | null;
  readonly repo: string | null;
  // vtrace local-patch run context. null on baseline rows; populated on vtrace
  // rows from the recorded run metadata + captured stderr (see collectRunEvidence).
  readonly vtraceMethod: string | null;
  readonly vtraceInstructionsFile: string | null;
  readonly vtraceInstructionsFileExists: boolean | null;
  readonly vtraceInstructionsFileSize: number | null;
  // Immutable per-run snapshot of the injected instructions (audit-grade): the
  // exact content + SHA-256 captured at spawn time, distinct from the shared
  // active file which a later run can overwrite. null on baseline / no-context rows.
  readonly vtraceInstructionsSnapshotFile: string | null;
  readonly vtraceInstructionsSnapshotExists: boolean | null;
  readonly vtraceInstructionsSha256: string | null;
  readonly vtraceInjectionObserved: boolean | "unknown" | null;
  readonly vtraceInjectionError: string | null;
  readonly vtraceTreatmentValid: boolean | "unknown" | null;
  readonly error: string | null;
  readonly rawResultPath: string;
  readonly parserKind: string;
  readonly parsedFieldCount: number;
  readonly notes: readonly string[];
}

export interface PairComparison {
  readonly instanceId: string;
  readonly baselineResolved: Unknownable<boolean> | null;
  readonly vtraceResolved: Unknownable<boolean> | null;
  readonly outcome: Outcome;
  readonly baselineTotalTokens: Unknownable<number> | null;
  readonly vtraceTotalTokens: Unknownable<number> | null;
  readonly tokenReductionPct: number | null;
  readonly baselineCostUsd: Unknownable<number> | null;
  readonly vtraceCostUsd: Unknownable<number> | null;
  readonly costReductionPct: number | null;
  readonly baselineDurationMs: Unknownable<number> | null;
  readonly vtraceDurationMs: Unknownable<number> | null;
  readonly durationReductionPct: number | null;
  // From the vtrace row: false means the vtrace injection was skipped, so the
  // efficiency deltas must NOT be advertised as vtrace performance for this pair.
  readonly vtraceTreatmentValid: boolean | "unknown" | null;
  // Stage 5C: the vexp condition (null when the vexp protocol was not run), so a
  // single row can present baseline vs vtrace vs vexp side by side.
  readonly vexpResolved: Unknownable<boolean> | null;
  readonly vexpTotalTokens: Unknownable<number> | null;
  readonly vexpTokenReductionPct: number | null;
  // Whether at least two conditions produced a patch, so a diff/similarity could
  // be computed for this instance (we do not compute similarity here, only flag it).
  readonly patchDiffAvailable: boolean;
}

// Stage 5C per-condition aggregate. resolvedRate is over EVALUATED instances
// (resolved !== "unknown") only — unknown never counts as a pass or a fail.
export interface ConditionSummary {
  readonly condition: Stage5Condition;
  readonly instances: number;
  readonly resolvedCount: number;
  readonly evaluatedCount: number;
  readonly resolvedRate: number | null;
  readonly meanCost: number | null;
  readonly meanDuration: number | null;
  readonly meanTotalTokens: number | null;
  readonly meanTokensForResolved: number | null;
  readonly meanCostForResolved: number | null;
  readonly validTreatments: number;
  readonly invalidTreatments: number;
}

// Stage 5C per-condition evaluation evidence, reconstructed from the recorded
// `_eval.meta.json` an `evaluate` run writes next to each condition's results.
export interface EvaluationEvidence {
  readonly condition: Stage5Condition;
  readonly evaluationRan: boolean;
  readonly evaluationMethod: EvalMode | "unknown";
  readonly dockerUsed: boolean | "unknown";
  readonly evaluationError: string | null;
  readonly resultsFile: string | null;
  readonly instancesEvaluated: number;
  readonly resolvedCount: number;
  readonly notes: readonly string[];
}

export interface Stage5Summary {
  readonly instanceCount: number;
  readonly baselineRuns: number;
  readonly vtraceRuns: number;
  readonly bothResolved: number;
  readonly vtraceOnlyResolved: number;
  readonly baselineOnlyResolved: number;
  readonly bothFailed: number;
  readonly unpaired: number;
  readonly unknown: number;
  readonly meanTokenReductionBothResolved: number | null;
  readonly meanCostReductionBothResolved: number | null;
  readonly meanDurationReductionBothResolved: number | null;
  readonly vtraceConditionRun: boolean;
  // Stage 5 vtrace policy aggregates (over vtrace rows).
  readonly skipCount: number;
  readonly contextInjectedCount: number;
  // Cost-aware gate aggregates (Requirement 4): injected-context rows and
  // no-context rows are counted SEPARATELY so a no-context policy run is never
  // tallied as an injected-context win. `noContextCount` is the count of valid
  // no-context policy rows (recorded via the `skip` mechanism);
  // `injectedContextCount` mirrors `contextInjectedCount` under the gate's
  // vocabulary.
  readonly injectedContextCount: number;
  readonly noContextCount: number;
  readonly invalidTreatmentCount: number;
  // Run-status / failure aggregates (Requirement 5), over ALL rows plus the
  // missing-result detector. infra_failed rows are excluded from every metric
  // above and surface only through these counts and the failure diagnostics.
  readonly infraFailedCount: number;
  readonly policySkipCount: number;
  readonly agentFailedCount: number;
  readonly completedPatchCount: number;
  readonly completedNoPatchCount: number;
  readonly missingResultCount: number;
  readonly rerunRecommendedCount: number;
}

// A condition that has run artifacts (meta / stdout / stderr) but produced no
// usable result row, with an artifact-aware reason. Surfaced in the report so a
// missing JSONL is never silently dropped.
export interface MissingConditionResult {
  readonly condition: Stage5Condition;
  readonly reason: string;
}

// Run-level evidence reconstructed from the captured raw artifacts (run meta +
// stderr + patch manifest), NOT from the CLI config. The report trusts what the
// run actually recorded over what was requested.
export interface Stage5RunEvidence extends IndexedContextFields {
  // The vtrace method as recorded in the vtrace run meta. "unknown" if no vtrace
  // run was recorded; "mixed" if recorded vtrace runs disagree.
  readonly vtraceMethod: VtraceMethod | "unknown" | "mixed";
  readonly vtracePatchInstalled: boolean | "unknown";
  readonly vtraceInstructionsFile: string | null;
  readonly vtraceInstructionsFileExists: boolean;
  readonly vtraceInstructionsFileSize: number | null;
  // Per-run immutable snapshot of the injected instructions (see Stage5Row).
  readonly vtraceInstructionsSnapshotFile: string | null;
  readonly vtraceInstructionsSnapshotExists: boolean;
  readonly vtraceInstructionsSha256: string | null;
  // Whether "Stage5 vtrace instructions injected from ..." was seen in the
  // captured vtrace stderr. "unknown" if no vtrace run was captured.
  readonly vtraceInjectionObserved: boolean | "unknown";
  // The "Stage5 vtrace injection skipped: ..." line, if injection was skipped.
  readonly vtraceInjectionError: string | null;
  // True only for a local-patch vtrace run whose injection was actually observed.
  // false means the vtrace condition was a no-op (not a real vtrace treatment).
  readonly vtraceTreatmentValid: boolean | "unknown";
  readonly notes: readonly string[];
}

export interface NormalizedArtifact {
  readonly rows: readonly Stage5Row[];
  readonly pairs: readonly PairComparison[];
  readonly summary: Stage5Summary;
  readonly evidence: Stage5RunEvidence;
  // Stage 5C aggregate report fields.
  readonly conditionSummaries: readonly ConditionSummary[];
  readonly evaluations: readonly EvaluationEvidence[];
  // Conditions that ran but produced no usable result row (artifact-aware).
  readonly missingResults: readonly MissingConditionResult[];
}

// Capsule v2's default token budget — matches the CLI's CAPSULE_V2_DEFAULT_BUDGET
// (capsuleCommand.ts). Generous enough for a couple of pivots plus support.
const CAPSULE_V2_DEFAULT_BUDGET = 8000;

const DEFAULT_CONFIG: CliConfig = {
  mode: "prepare",
  vexpSweBenchDir: null,
  instances: [],
  instancesFile: "benchmarks/stage5_vexp_swe_bench_smoke/smoke_instances.json",
  out: "benchmarks/stage5_vexp_swe_bench_smoke/results",
  nodeCommand: "node",
  cliEntry: "dist/cli.js",
  vtraceMethod: "instructions-file",
  yes: false,
  // Stage 5B: the vtrace CLI invocation; index/query subcommands are appended.
  // Run Stage 5B from the vtrace repo root so `src/cli/index.ts` resolves.
  vtraceCommand: "bun src/cli/index.ts",
  vtraceIndexArgs: "--quiet",
  vtraceQueryArgs: "",
  skipVtraceIndexIfPresent: false,
  reuseWorkspace: false,
  indexPolicy: "auto",
  showVtraceIndexLog: false,
  vtraceContextMaxChars: 12000,
  vtraceContextMaxItems: 8,
  // Capsule v2 (compact inspect-first) is the DEFAULT injected engine: the
  // product-level validation showed large token/turn reductions with no
  // resolution loss where context is injected. Capsule v1 (legacy) is a fallback,
  // forced via `--capsule-engine v1` (alias `legacy`) and used automatically when
  // a v2 build fails. This is an engine-default migration only — it does NOT make
  // the hard pivot-check gate default (that stays diagnostic/off) and does NOT
  // change retrieval scoring/ranking or auto-policy thresholds.
  capsuleEngine: "v2",
  capsuleIntent: "auto",
  capsuleBudget: CAPSULE_V2_DEFAULT_BUDGET,
  captureProductV2Accounting: false,
  contextPolicyOverride: "auto",
  // PIVOT_CHECK is strict-risk-gated by default: it keeps the multi-pivot floor but
  // injects only on a STRONG risk signal (>= 3 pivots, edit-risk directives, a known
  // edit-relevant hidden pivot, or hidden_pivot corroborated by another signal) — a
  // hidden_pivot alone no longer qualifies. This is the internal Stage 5 default; it
  // cut first-pass token/cost overhead with no resolution regression in the controlled
  // 10-task comparison. Override with --pivot-check-policy (off|multi_pivot|risk_gated|
  // strict_risk_gated|always) for experiments.
  pivotCheckPolicy: "strict_risk_gated",
  // Hard gate is OFF by default: the standard single-shot run path is unchanged.
  pivotCheckGate: "off",
  pivotCheckGatePhase1Only: false,
  // --disable-pivot-check forces the effective policy to "off" (compatibility).
  disablePivotCheck: false,
  // EDIT_GUARD is ON by default (rides with PIVOT_CHECK; --disable-edit-guard turns
  // off only the guard block).
  disableEditGuard: false,
  // PATCH_VERIFY is ON by default (rides with PIVOT_CHECK, after EDIT_GUARD;
  // --disable-patch-verify turns off only the checkpoint, independent of EDIT_GUARD).
  disablePatchVerify: false,
  // The shared anti-loop tool-use-discipline block is ON by default for both baseline
  // and vtrace; --disable-tool-use-discipline is a benchmark/dev-only override.
  disableToolUseDiscipline: false,
  // The vtrace-only STAGE5_TOKEN_DISCIPLINE turn-count reduction policy is ON by
  // default; --disable-token-discipline is a benchmark/dev-only override.
  disableTokenDiscipline: false,
  sweBenchDataFile: null,
  runLabel: null,
  runLabels: null,
  // Stage 5C: baseline protocol by default; vexp stays off unless --allow-vexp.
  protocol: "baseline",
  allowVexp: false,
  evalMode: "docker",
  evalDataset: null,
  evalTimeout: 1800,
};

const CSV_COLUMNS = [
  "instance_id",
  "condition",
  "resolved",
  "cost_usd",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "total_tokens",
  "token_accounting_method",
  "num_turns",
  "tool_calls_total",
  "patch_available",
  "vtrace_method",
  "vtrace_injection_observed",
  "vtrace_indexed_context",
  "vtrace_treatment_valid",
  "vtrace_policy_action",
  "vtrace_context_policy_action",
  "vtrace_context_policy_override",
  "vtrace_capsule_engine",
  "vtrace_capsule_intent",
  "vtrace_capsule_budget",
  // Capsule v2 selected-item audit (same names the Markdown report and the
  // camelCase _run.meta.json expose): the realised mode, token estimate, lead
  // pivot file/symbol, and the compact pivots/support lists.
  "vtrace_capsule_actual_mode",
  "vtrace_capsule_estimated_tokens",
  "vtrace_capsule_top_pivot_file",
  "vtrace_capsule_top_pivot_symbol",
  // Lead-pivot focused-source audit: whether the snapshot carried the body, its
  // size, and the mode (focused/full/missing).
  "vtrace_capsule_top_pivot_has_source",
  "vtrace_capsule_pivot_source_chars",
  "vtrace_capsule_pivot_source_mode",
  // Capsule v2 policy-evidence diagnostics the cost-aware v2 gate reads.
  "vtrace_capsule_edit_risk_directives_count",
  "vtrace_capsule_line_anchor_resolution_used",
  "vtrace_capsule_sql_rendering_backfill_used",
  "vtrace_capsule_pivots",
  "vtrace_capsule_support",
  // The immutable injected-instructions snapshot: path + content hash.
  "vtrace_instructions_snapshot_file",
  "vtrace_instructions_sha256",
  "vtrace_policy_reason",
  "vtrace_context_policy_decision_signals",
  "expected_context_value",
  "expected_overhead_risk",
  "vtrace_context_injected",
  "vtrace_skip_reason",
  "pivot_count",
  "support_count",
  "recommended_mode",
  "actual_capsule_mode",
  "target_confidence",
  "retrieval_reason",
  "search_budget",
  "search_budget_reason",
  "top_likely_file",
  "top_likely_symbol",
  "likely_targets_count",
  "final_edited_file",
  "final_edited_symbol",
  "contains_final_edited_file",
  "contains_final_edited_symbol",
  "pivot_file",
  "first_read_file",
  "first_edit_file",
  "did_read_pivot_before_search",
  "did_edit_pivot",
  "search_calls_before_pivot",
  "context_chars",
  "context_items",
  "run_status",
  "should_rerun",
  "infra_error_status",
  "infra_error_kind",
  "infra_error_message",
  "error",
  "raw_result_path",
  "parser_kind",
  "notes",
];

export const NORMALIZED_FILENAME = "stage5_normalized.json";

// Idempotency / discoverability marker embedded in the patched external file and
// recorded in the manifest. Its presence means "already patched, do not touch".
export const STAGE5_VTRACE_PATCH_MARKER = "STAGE5_VTRACE_INSTRUCTIONS_PATCH";

// Marker for the SECOND (telemetry) patch block: it dumps the adapter's raw
// stream-json to VTRACE_AGENT_STREAM_FILE so the harness can recover an ordered
// tool-call log. Independent of the instructions block — inserted only when its
// anchor is present, so an adapter that lacks it still patches cleanly.
export const STAGE5_VTRACE_STREAM_MARKER = "STAGE5_VTRACE_STREAM_PATCH";

// Marker for the THIRD patch block: it appends the shared anti-loop
// tool-use-discipline file (VTRACE_TOOL_USE_DISCIPLINE_FILE) to the prompt for
// EVERY condition, so baseline and vtrace receive the identical block. Independent
// of the instructions/stream blocks (its own marker + anchor), so an adapter
// already carrying the earlier patches migrates this one in cleanly.
export const STAGE5_TOOL_USE_DISCIPLINE_MARKER = "STAGE5_TOOL_USE_DISCIPLINE_PATCH";

// Marker for the FOURTH patch block: it pushes `--disallowedTools` into the
// `claude` invocation when VTRACE_AGENT_DISALLOWED_TOOLS is set, so the Phase-1
// read-only preflight is INCAPABLE of mutating files (Claude Code deny rules take
// precedence over the orchestrator's hardcoded --allowedTools). Independent of the
// other blocks (own marker + anchor) so an already-patched adapter migrates it in.
export const STAGE5_VTRACE_DISALLOWED_TOOLS_MARKER = "STAGE5_VTRACE_DISALLOWED_TOOLS_PATCH";

// Stderr line the patched adapter logs when it denies the Phase-1 mutation tools.
export const STAGE5_VTRACE_DISALLOWED_TOOLS_LOG = "Stage5 vtrace phase-1 read-only: --disallowedTools";

// Stderr line the patched adapter logs when it appends the tool-use-discipline
// block at runtime. Purely observational (not load-bearing for treatment validity).
export const STAGE5_TOOL_USE_DISCIPLINE_LOG = "Stage5 tool-use-discipline injected from";

const VTRACE_PATCH_MANIFEST_FILENAME = "vtrace_patch_manifest.json";
const VTRACE_PATCH_BACKUP_SUFFIX = ".stage5-vtrace-backup";

// Stderr line the patched adapter logs when it actually injects the instructions
// at runtime. ingest greps the captured vtrace stderr for this exact prefix to
// prove the injection executed (not merely that the patch is installed on disk).
export const STAGE5_VTRACE_INJECTION_LOG = "Stage5 vtrace instructions injected from";

// Stderr line the patched adapter logs when the instructions file is set but
// could not be read (e.g. it was wiped from the output dir). Its presence proves
// the vtrace condition ran WITHOUT the injected context — i.e. a no-op.
export const STAGE5_VTRACE_INJECTION_SKIPPED = "Stage5 vtrace injection skipped";

// Candidate locations (relative to --vexp-swe-bench-dir) for the Claude Code
// adapter that builds the `claude -p <prompt>` invocation. dist/ is preferred
// because `node dist/cli.js run ...` executes the built output directly.
const CLAUDE_ADAPTER_CANDIDATES: readonly string[] = [
  "dist/agents/claude-code.js",
  "dist/agents/claude-code.mjs",
  "src/agents/claude-code.ts",
];

// Anchor line in the adapter's run() method; the injection block is inserted
// immediately after it, before the `claude -p` args array is assembled.
const VTRACE_PATCH_ANCHOR = "const startMs = Date.now();";

// Anchor for the telemetry block: by this line `rawOutput` (the full stream-json
// the agent emitted) is in scope, so the block can dump it. Optional — if the
// adapter layout changed and this line is absent, the stream block is skipped.
const VTRACE_STREAM_ANCHOR = "const durationMs = Date.now() - startMs;";

// Anchor for the disallowed-tools block: a stable comment in the adapter that sits
// AFTER the `args` array is declared and BEFORE the agent is spawned, so the block
// can push `--disallowedTools` onto `args`. Optional — skipped if the layout
// changed and the line is absent (Phase-1 read-only enforcement then unavailable).
const VTRACE_DISALLOWED_TOOLS_ANCHOR = "// Tool whitelist for SWE-bench (agent needs to write code)";

// Stderr line the patched adapter logs when it writes the raw stream for tool-call
// telemetry. Not load-bearing for treatment validity (purely observational).
export const STAGE5_VTRACE_STREAM_LOG = "Stage5 vtrace tool-call stream written to";

// Sentinel the stream block writes when it DID execute but `rawOutput` was not a
// usable string. It lets us tell three states apart from the captured artifact:
//   - file absent          → stream patch never executed (not installed / not run)
//   - file has sentinel     → stream patch executed, but rawOutput was not a string
//   - file has stream-json  → stream patch executed and captured a real stream
export const STAGE5_VTRACE_STREAM_SENTINEL = "__STAGE5_VTRACE_STREAM_SENTINEL__";

export interface VtracePatchManifest {
  readonly installed: boolean;
  readonly vexpSweBenchDir: string;
  readonly patchedFiles: readonly string[];
  readonly backupFiles: readonly string[];
  readonly patchMarker: string;
  readonly notes: readonly string[];
}

export interface VtracePatchVerification {
  readonly installed: boolean;
  readonly vexpSweBenchDir: string;
  readonly patchedFile: string | null;
  readonly backupPresent: boolean;
  readonly manifestPresent: boolean;
  readonly notes: readonly string[];
}

// vexp-swe-bench output files we write ourselves are prefixed with "_" so the
// tolerant parser skips them and never mistakes run metadata for results.
const RUNNER_ARTIFACT_PREFIX = "_";

const PUBLIC_CLAIM_DISCLAIMER =
  "This is a Stage 5 smoke run against a tiny subset of vexp-swe-bench. It checks integration and measurement workflow only. It is not a public SWE-bench claim and not a comparison against vexp unless an explicit vexp-enabled condition is also run.";

export async function loadSmokeInstances(filePath: string): Promise<SmokeInstancesFile> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("smoke_instances.json must be an object.");
  const instances = Array.isArray(parsed.instances) ? parsed.instances.filter(isString) : [];
  const notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isString) : [];
  return { instances, notes };
}

export async function resolveInstances(config: CliConfig): Promise<string[]> {
  if (config.instances.length > 0) return [...config.instances];
  const file = await loadSmokeInstances(config.instancesFile).catch(() => null);
  return file === null ? [] : [...file.instances];
}

// Per-condition raw output dir. With --run-label, runs are isolated under
// runs/<label>/ so multiple instances/protocols do not overwrite each other:
//   results/runs/<label>/raw/{baseline,vtrace,vexp}
// Without a label the legacy flat layout (results/raw/<condition>) is kept.
export function rawConditionDir(outDir: string, condition: Stage5Condition, runLabel: string | null = null): string {
  const root = runLabel === null ? outDir : path.join(outDir, "runs", runLabel);
  return path.join(root, "raw", condition);
}

export function buildRunArgs(
  config: CliConfig,
  instances: readonly string[],
  outputDir: string,
  enableVexp: boolean,
): string[] {
  const args = [config.cliEntry, "run", "--instances", instances.join(","), "--output", outputDir];
  // --no-vexp keeps vexp disabled for the baseline and vtrace conditions. Only
  // the explicit, --allow-vexp-gated vexp condition omits it to enable vexp.
  if (!enableVexp) args.splice(4, 0, "--no-vexp");
  return args;
}

export function buildBaselineCommand(
  config: CliConfig,
  instances: readonly string[],
): { command: string; args: string[]; cwd: string | null; env: Record<string, string> } {
  return {
    command: config.nodeCommand,
    args: buildRunArgs(config, instances, rawConditionDir(config.out, "baseline", config.runLabel), false),
    cwd: config.vexpSweBenchDir,
    // Baseline now also carries the shared anti-loop discipline block and the
    // ordered-telemetry stream env, so the anti-loop guidance is fair across arms
    // and every run captures ordered tool-call telemetry. No vtrace context is set.
    env: sharedConditionEnv(config),
  };
}

export function buildVtraceCommand(
  config: CliConfig,
  instances: readonly string[],
  injectContext = true,
): { command: string; args: string[]; cwd: string | null; env: Record<string, string> } {
  // The vtrace condition uses the IDENTICAL benchmark command as baseline
  // (still --no-vexp, same model/agent/budget). vtrace is injected out-of-band
  // via environment so vexp is never enabled and command parity is preserved.
  // A SKIP-policy run (injectContext=false) omits the instructions-file env, so
  // the benchmark runs WITHOUT any injected context — a real vtrace-policy row.
  return {
    command: config.nodeCommand,
    args: buildRunArgs(config, instances, rawConditionDir(config.out, "vtrace", config.runLabel), false),
    cwd: config.vexpSweBenchDir,
    env: vtraceEnv(config, injectContext),
  };
}

// The vexp condition runs the EXTERNAL benchmark with vexp ENABLED (no --no-vexp).
// It is the only condition that turns vexp on, and only callers that have already
// asserted --allow-vexp should build it. No vtrace env is attached.
export function buildVexpCommand(
  config: CliConfig,
  instances: readonly string[],
): { command: string; args: string[]; cwd: string | null; env: Record<string, string> } {
  return {
    command: config.nodeCommand,
    args: buildRunArgs(config, instances, rawConditionDir(config.out, "vexp", config.runLabel), true),
    cwd: config.vexpSweBenchDir,
    // vexp gets the same shared discipline + telemetry env (no vtrace context); it
    // is the only condition with vexp enabled, gated behind --allow-vexp.
    env: sharedConditionEnv(config),
  };
}

// The vtrace instructions file lives at the results ROOT, deliberately NOT under
// the per-condition raw/<condition> dir. vexp-swe-bench's `run` clears its
// `--output` dir (raw/vtrace) at start (cleanPreviousRun), which would delete an
// instructions file written there before the agent ever reads it — the original
// cause of the "injection skipped: ENOENT" no-op. The results root is never
// passed to vexp as --output, so the file survives the run.
export function vtraceInstructionsFilePath(outDir: string): string {
  return path.join(outDir, "_vtrace_instructions.md");
}

// The raw agent stream-json the patched adapter dumps for tool-call telemetry.
// Lives at the results ROOT (like the instructions file) so vexp's --output dir
// clean cannot delete it. It is overwritten each run; runCondition parses it into
// the per-run `_tool_calls.json` immediately after, so a later run cannot clobber
// captured evidence. This is the only artifact written for pivot-inspection
// telemetry; it is a raw log and is gitignored.
export function vtraceAgentStreamFilePath(outDir: string): string {
  return path.join(outDir, "_agent_stream.jsonl");
}

// The normalized, ordered tool-call log for one condition run, written next to
// that run's JSONL so the report can join it by run directory.
export function toolCallLogFilePath(rawDir: string): string {
  return path.join(rawDir, "_tool_calls.json");
}

// The diagnostic summary of a run's ordered tool-call log (counts + loop
// heuristics + run identity). Written next to `_tool_calls.json` so the
// telemetry audit can join it by run directory without re-parsing the stream.
export function toolCallSummaryFilePath(rawDir: string): string {
  return path.join(rawDir, "_tool_calls.summary.json");
}

// The shared anti-loop tool-use-discipline instructions file. Like the vtrace
// instructions and the agent stream, it lives at the results ROOT so vexp's
// --output clean cannot delete it. The patched adapter appends it to the prompt
// for EVERY condition (baseline and vtrace alike) when the env var points here,
// so the anti-loop guidance is identical and fair across conditions.
export function stage5ToolUseDisciplineFilePath(outDir: string): string {
  return path.join(outDir, "_stage5_tool_use_discipline.md");
}

// The ACTIVE instructions file (above) is a single shared path at the results
// root, so a later run overwrites it — making post-run auditing unreliable. The
// snapshot is an immutable per-run-label copy of exactly what was injected: it
// lives under the run-label directory (NOT raw/vtrace, which vexp wipes), so each
// labeled run keeps its own evidence and later runs cannot clobber an earlier one.
export function vtraceInstructionsSnapshotFilePath(outDir: string, runLabel: string | null): string {
  const dir = runLabel === null ? outDir : path.join(outDir, "runs", runLabel);
  return path.join(dir, "_vtrace_instructions.snapshot.md");
}

// Snapshot the active instructions file into the per-run-label snapshot path and
// return the audit metadata (path, existence, content SHA-256). Called only when
// context is actually injected, so a no-context policy run records no snapshot.
async function snapshotVtraceInstructions(
  config: CliConfig,
): Promise<{
  vtraceInstructionsSnapshotFile: string;
  vtraceInstructionsSnapshotExists: boolean;
  vtraceInstructionsSha256: string | null;
}> {
  const active = vtraceInstructionsFilePath(config.out);
  const snapshot = vtraceInstructionsSnapshotFilePath(config.out, config.runLabel);
  const content = await readFile(active, "utf8").catch(() => null);
  if (content === null) {
    // No active file to snapshot (should not happen on an injecting run); record
    // the intended path honestly without fabricating a hash.
    return { vtraceInstructionsSnapshotFile: snapshot, vtraceInstructionsSnapshotExists: false, vtraceInstructionsSha256: null };
  }
  await mkdir(path.dirname(snapshot), { recursive: true });
  await writeFile(snapshot, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { vtraceInstructionsSnapshotFile: snapshot, vtraceInstructionsSnapshotExists: true, vtraceInstructionsSha256: sha256 };
}

// Env shared by EVERY condition's agent run (baseline, vtrace, vexp): the raw
// stream dump for ordered tool-call telemetry (now universal, not vtrace-only) and
// the shared anti-loop tool-use-discipline file (unless suppressed by the
// benchmark/dev flag). Keeping these in one place guarantees baseline and vtrace
// receive the identical discipline block and both capture ordered telemetry.
function sharedConditionEnv(config: CliConfig): Record<string, string> {
  const env: Record<string, string> = {
    // Tool-call telemetry: the patched adapter dumps its raw stream-json here so
    // ordered tool-call telemetry can be recovered for ALL conditions.
    VTRACE_AGENT_STREAM_FILE: vtraceAgentStreamFilePath(config.out),
  };
  if (config.disableToolUseDiscipline !== true) {
    env.VTRACE_TOOL_USE_DISCIPLINE_FILE = stage5ToolUseDisciplineFilePath(config.out);
  }
  return env;
}

function vtraceEnv(config: CliConfig, injectContext = true): Record<string, string> {
  const env: Record<string, string> = {
    ...sharedConditionEnv(config),
    VTRACE_SMOKE: "1",
    VTRACE_METHOD: config.vtraceMethod,
  };
  // Only point the adapter at the instructions file when we actually inject. A
  // skip-policy run leaves it unset so nothing is injected.
  if (injectContext) {
    env.VTRACE_AGENT_INSTRUCTIONS_FILE = vtraceInstructionsFilePath(config.out);
  }
  return env;
}

function isVtracePolicyAction(value: unknown): value is VtracePolicyAction {
  return value === "inject" || value === "skip" || value === "error";
}

export function vtraceInstructionsText(): string {
  return [
    "# vtrace instructions",
    "",
    "You are running with vtrace assistance enabled.",
    "",
    "Before editing, use vtrace-oriented repository navigation when useful:",
    "- identify likely files/symbols before broad exploration",
    "- prefer compact symbol/context lookup over opening many files",
    "- use vtrace context if available in this repository",
    "- keep vexp disabled",
    "",
    "If vtrace tooling is unavailable in this task environment, continue normally",
    "but do not use vexp.",
  ].join("\n");
}

export function classifyOutcome(
  baselineResolved: Unknownable<boolean> | null,
  vtraceResolved: Unknownable<boolean> | null,
): Outcome {
  if (baselineResolved === null || vtraceResolved === null) return "unpaired";
  if (baselineResolved === "unknown" || vtraceResolved === "unknown") return "unknown";
  if (baselineResolved && vtraceResolved) return "both_resolved";
  if (!baselineResolved && vtraceResolved) return "vtrace_only_resolved";
  if (baselineResolved && !vtraceResolved) return "baseline_only_resolved";
  return "both_failed";
}

export function reductionPct(baseline: Unknownable<number> | null, vtrace: Unknownable<number> | null): number | null {
  if (!isNumber(baseline) || !isNumber(vtrace) || baseline <= 0) return null;
  return (100 * (baseline - vtrace)) / baseline;
}

export function comparePairs(rows: readonly Stage5Row[]): PairComparison[] {
  const byInstance = new Map<string, Map<Stage5Condition, Stage5Row>>();
  for (const row of rows) {
    const conditions = byInstance.get(row.instanceId) ?? new Map<Stage5Condition, Stage5Row>();
    conditions.set(row.condition, row);
    byInstance.set(row.instanceId, conditions);
  }

  const pairs: PairComparison[] = [];
  for (const [instanceId, conditions] of byInstance) {
    const baseline = conditions.get("baseline") ?? null;
    const vtrace = conditions.get("vtrace") ?? null;
    const vexp = conditions.get("vexp") ?? null;
    // A diff/similarity could be computed only if at least two conditions actually
    // produced a patch. We flag availability; we do not compute the diff here.
    const patchCount = [baseline, vtrace, vexp].filter((row) => row?.patchAvailable === true).length;
    pairs.push({
      instanceId,
      baselineResolved: baseline?.resolved ?? null,
      vtraceResolved: vtrace?.resolved ?? null,
      outcome: classifyOutcome(baseline?.resolved ?? null, vtrace?.resolved ?? null),
      baselineTotalTokens: baseline?.totalTokens ?? null,
      vtraceTotalTokens: vtrace?.totalTokens ?? null,
      tokenReductionPct: reductionPct(baseline?.totalTokens ?? null, vtrace?.totalTokens ?? null),
      baselineCostUsd: baseline?.costUsd ?? null,
      vtraceCostUsd: vtrace?.costUsd ?? null,
      costReductionPct: reductionPct(baseline?.costUsd ?? null, vtrace?.costUsd ?? null),
      baselineDurationMs: baseline?.durationMs ?? null,
      vtraceDurationMs: vtrace?.durationMs ?? null,
      durationReductionPct: reductionPct(baseline?.durationMs ?? null, vtrace?.durationMs ?? null),
      vtraceTreatmentValid: vtrace?.vtraceTreatmentValid ?? null,
      vexpResolved: vexp?.resolved ?? null,
      vexpTotalTokens: vexp?.totalTokens ?? null,
      vexpTokenReductionPct: reductionPct(baseline?.totalTokens ?? null, vexp?.totalTokens ?? null),
      patchDiffAvailable: patchCount >= 2,
    });
  }
  return pairs.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}

// ----- tolerant parsing of benchmark output -----------------------------------

const FIELD_ALIASES: Record<string, readonly string[]> = {
  instanceId: ["instance_id", "instanceId", "instance", "id"],
  resolved: ["resolved", "passed", "pass", "is_resolved", "success", "solved"],
  costUsd: ["cost_usd", "cost", "total_cost_usd", "costUSD", "totalCostUsd", "costUsd"],
  durationMs: ["duration_ms", "durationMs", "duration", "elapsed_ms", "wall_ms"],
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  outputTokens: ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
  cacheReadTokens: ["cache_read_tokens", "cacheReadTokens", "cache_read_input_tokens"],
  cacheCreationTokens: ["cache_creation_tokens", "cacheCreationTokens", "cache_creation_input_tokens"],
  totalTokens: ["total_tokens", "totalTokens", "tokens"],
  numTurns: ["num_turns", "numTurns", "turns", "iterations", "steps"],
  toolCalls: ["tool_calls", "toolCalls"],
  patch: ["modelPatch", "patch", "model_patch", "prediction", "patch_path", "model_patch_path"],
  model: ["model"],
  agent: ["agent"],
  repo: ["repo"],
  error: ["error", "error_message", "exception", "failure"],
};

function pick(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const key of aliases) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function asUnknownableNumber(value: unknown): Unknownable<number> {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return "unknown";
}

function asUnknownableBoolean(value: unknown): Unknownable<boolean> {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "resolved", "pass", "passed", "1"].includes(text)) return true;
    if (["false", "no", "unresolved", "fail", "failed", "0"].includes(text)) return false;
  }
  return "unknown";
}

// Sum input/output/cache token components for total_tokens, recording exactly
// which fields contributed (token_accounting_method) so the report never hides
// that cache tokens dominate. An explicit total_tokens is only trusted when no
// components are present.
function accountTokens(
  inputTokens: Unknownable<number>,
  outputTokens: Unknownable<number>,
  cacheReadTokens: Unknownable<number>,
  cacheCreationTokens: Unknownable<number>,
  explicitTotal: Unknownable<number>,
): { totalTokens: Unknownable<number>; method: string } {
  const components: Array<[string, Unknownable<number>]> = [
    ["input", inputTokens],
    ["output", outputTokens],
    ["cache_read", cacheReadTokens],
    ["cache_creation", cacheCreationTokens],
  ];
  const present = components.filter(([, value]) => isNumber(value)) as Array<[string, number]>;
  if (present.length > 0) {
    return {
      totalTokens: present.reduce((sum, [, value]) => sum + value, 0),
      method: present.map(([name]) => name).join("+"),
    };
  }
  if (isNumber(explicitTotal)) return { totalTokens: explicitTotal, method: "total_tokens" };
  return { totalTokens: "unknown", method: "unavailable" };
}

// vexp-swe-bench reports tool usage as an object of {ToolName: count}; the total
// is the sum of those counts. We also retain the raw breakdown as a JSON string.
function accountToolCalls(value: unknown): { total: Unknownable<number>; breakdown: string | null } {
  if (!isRecord(value)) return { total: "unknown", breakdown: null };
  const counts = Object.values(value).filter(isNumber);
  if (counts.length === 0) return { total: "unknown", breakdown: JSON.stringify(value) };
  return { total: counts.reduce((sum, count) => sum + count, 0), breakdown: JSON.stringify(value) };
}

// Tool-name classification for agent-compliance parsing (Requirement 6).
const READ_TOOLS = new Set(["read", "view", "open", "cat", "readfile"]);
const EDIT_TOOLS = new Set(["edit", "write", "str_replace", "str_replace_editor", "notebookedit", "apply_patch", "multiedit"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "search", "find", "ripgrep", "rg", "codebase_search", "ls"]);

interface OrderedToolCall {
  readonly tool: string;
  readonly target: string | null;
}

// Pull an ORDERED tool-call sequence out of a result record, if one is present.
// SWE-bench records usually carry only aggregate counts (an object), so this
// returns null in that common case — the caller then records "unknown".
function readOrderedToolCalls(record: Record<string, unknown>): OrderedToolCall[] | null {
  const raw = pick(record, ["tool_calls", "toolCalls", "tool_uses", "toolUses", "tool_call_log", "actions"]);
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const calls: OrderedToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = pick(entry, ["name", "tool", "tool_name", "type", "function"]);
    if (!isString(name)) continue;
    const input = pick(entry, ["input", "args", "arguments", "parameters", "params"]);
    const target = isRecord(input)
      ? (pick(input, ["file_path", "filePath", "path", "file", "filename", "notebook_path"]) as unknown)
      : null;
    calls.push({ tool: name.toLowerCase().trim(), target: isString(target) ? target : null });
  }
  return calls.length > 0 ? calls : null;
}

// True when `target` names the pivot file (exact, or by path-suffix so a relative
// vs absolute mismatch still matches).
function targetsFile(target: string | null, file: string): boolean {
  if (target === null) return false;
  return target === file || target.endsWith(`/${file}`) || file.endsWith(`/${target}`);
}

// Build the agent-compliance diagnostics for one result record (Requirement 6).
// When the record carries an ordered tool-call list we report whether the agent
// followed the capsule's "edit here first" directive; otherwise every signal is
// "unknown" — we never guess from aggregate counts.
export function buildAgentCompliance(
  record: Record<string, unknown>,
  pivotFile: string | null,
): AgentComplianceFields {
  const calls = readOrderedToolCalls(record);
  if (calls === null) {
    return { ...nullAgentComplianceFields(), pivotFile };
  }

  const firstReadFile = calls.find((call) => READ_TOOLS.has(call.tool) && call.target !== null)?.target ?? "unknown";
  const firstEditFile = calls.find((call) => EDIT_TOOLS.has(call.tool) && call.target !== null)?.target ?? "unknown";

  // Pivot-relative signals require knowing which file the directive pointed at.
  if (pivotFile === null) {
    return {
      pivotFile: null,
      firstReadFile,
      firstEditFile,
      didReadPivotBeforeSearch: "unknown",
      didEditPivot: "unknown",
      searchCallsBeforePivot: "unknown",
    };
  }

  const firstSearchIdx = calls.findIndex((call) => SEARCH_TOOLS.has(call.tool));
  const firstPivotTouchIdx = calls.findIndex(
    (call) => (READ_TOOLS.has(call.tool) || EDIT_TOOLS.has(call.tool)) && targetsFile(call.target, pivotFile),
  );
  const didEditPivot = calls.some((call) => EDIT_TOOLS.has(call.tool) && targetsFile(call.target, pivotFile));
  const didReadPivotBeforeSearch =
    firstPivotTouchIdx !== -1 && (firstSearchIdx === -1 || firstPivotTouchIdx < firstSearchIdx);
  const searchCallsBeforePivot = calls
    .slice(0, firstPivotTouchIdx === -1 ? calls.length : firstPivotTouchIdx)
    .filter((call) => SEARCH_TOOLS.has(call.tool)).length;

  return {
    pivotFile,
    firstReadFile,
    firstEditFile,
    didReadPivotBeforeSearch,
    didEditPivot,
    searchCallsBeforePivot,
  };
}

// Detail about a Claude/API infrastructure failure detected in a raw result.
// Distinct from an agent failure (the model ran but did not solve) and from a
// vtrace treatment failure — an infra failure means no real attempt happened.
export interface InfraFailure {
  // The HTTP-ish status when one was reported (e.g. 529), else null.
  readonly infraErrorStatus: number | null;
  // Coarse machine-readable kind: "api_overloaded" | "api_error" | "zero_cost_no_output".
  readonly infraErrorKind: string;
  readonly infraErrorMessage: string;
}

// Classify a raw vexp/Claude result record as an infrastructure failure when ANY
// of the documented signals are present (Requirement 1):
//   - api_error_status is present
//   - the error text contains "API Error"
//   - the error text contains "overloaded"
//   - error_status is 529
//   - total_cost_usd == 0 AND all token counts are 0 AND the patch is empty/null
// Returns null when none match (i.e. this is a real run, however it turned out).
export function classifyInfraFailure(record: Record<string, unknown>): InfraFailure | null {
  const apiErrorStatus = toNumberOrNull(record.api_error_status ?? record.apiErrorStatus);
  const errorStatus = toNumberOrNull(record.error_status ?? record.errorStatus);
  const status = apiErrorStatus ?? errorStatus;

  const errorValue = pick(record, FIELD_ALIASES.error!);
  const errorText = isString(errorValue) ? errorValue : null;
  const errorLower = (errorText ?? "").toLowerCase();

  const overloaded = errorLower.includes("overloaded") || status === 529;
  const apiError = apiErrorStatus !== null || errorLower.includes("api error");

  // Zero-cost / zero-token / no-patch: the run produced nothing chargeable, which
  // in practice means the API rejected the request before any real work happened.
  const cost = asUnknownableNumber(pick(record, FIELD_ALIASES.costUsd!));
  const inputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.inputTokens!));
  const outputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.outputTokens!));
  const patchValue = pick(record, FIELD_ALIASES.patch!);
  const patchEmpty =
    patchValue === undefined ||
    patchValue === null ||
    patchValue === false ||
    (isString(patchValue) && patchValue.trim().length === 0);
  const zeroCostNoOutput = cost === 0 && inputTokens === 0 && outputTokens === 0 && patchEmpty;

  if (!overloaded && !apiError && !zeroCostNoOutput && status === null) return null;

  const kind = overloaded ? "api_overloaded" : apiError ? "api_error" : "zero_cost_no_output";
  const message =
    errorText ??
    (apiErrorStatus !== null
      ? `api_error_status ${apiErrorStatus}`
      : status !== null
        ? `error_status ${status}`
        : "no tokens spent and no patch generated");
  return { infraErrorStatus: status, infraErrorKind: kind, infraErrorMessage: message };
}

// Number coercion that, unlike asUnknownableNumber, returns null (not "unknown")
// for absent/invalid values — used for the optional infra status fields.
function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// Derive the authoritative run status from the classification inputs. Precedence:
// infra failure first (never let an API error read as a model result), then a
// valid vtrace skip policy, then a non-infra agent error, then patch presence.
// Only infra failures recommend a rerun — an agent failure or a no-patch run is
// a real (if unsuccessful) attempt, not a transient infrastructure problem.
export function deriveRunStatus(opts: {
  infra: InfraFailure | null;
  error: string | null;
  patchAvailable: Unknownable<boolean>;
  policyAction: VtracePolicyAction | "unknown" | null;
}): { runStatus: RunStatus; shouldRerun: boolean } {
  if (opts.infra !== null) return { runStatus: "infra_failed", shouldRerun: true };
  if (opts.policyAction === "skip") return { runStatus: "policy_skip", shouldRerun: false };
  if (opts.error !== null) return { runStatus: "agent_failed", shouldRerun: false };
  if (opts.patchAvailable === true) return { runStatus: "completed_patch", shouldRerun: false };
  return { runStatus: "completed_no_patch", shouldRerun: false };
}

function nullRunStatusFields(): RunStatusFields {
  return {
    runStatus: null,
    shouldRerun: null,
    infraErrorStatus: null,
    infraErrorKind: null,
    infraErrorMessage: null,
  };
}

export function extractRow(
  record: Record<string, unknown>,
  condition: Stage5Condition,
  rawResultPath: string,
  parserKind = "json",
): Stage5Row | null {
  const instanceRaw = pick(record, FIELD_ALIASES.instanceId!);
  if (!isString(instanceRaw)) return null;

  const inputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.inputTokens!));
  const outputTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.outputTokens!));
  const cacheReadTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.cacheReadTokens!));
  const cacheCreationTokens = asUnknownableNumber(pick(record, FIELD_ALIASES.cacheCreationTokens!));
  const { totalTokens, method } = accountTokens(
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    asUnknownableNumber(pick(record, FIELD_ALIASES.totalTokens!)),
  );

  const toolCalls = accountToolCalls(pick(record, FIELD_ALIASES.toolCalls!));

  // resolved is left as "unknown" when null/absent: a generated-but-unevaluated
  // patch must never be coerced to a pass or a fail.
  const resolvedValue = pick(record, FIELD_ALIASES.resolved!);
  const resolved = resolvedValue === undefined ? "unknown" : asUnknownableBoolean(resolvedValue);

  const patchValue = pick(record, FIELD_ALIASES.patch!);
  const patchIsString = isString(patchValue);
  const patchAvailable: Unknownable<boolean> =
    patchValue === undefined ? "unknown" : patchIsString ? patchValue.trim().length > 0 : Boolean(patchValue);
  const patchLines: Unknownable<number> = patchIsString
    ? patchValue.replace(/\n$/, "").split(/\r?\n/).length
    : "unknown";
  // Parse the file/symbol the model actually edited straight from the patch. The
  // recommendation + containment diagnostics are filled later (post-merge), where
  // the dataset and injected context are available.
  const finalEditedFile = patchIsString ? primaryEditedFile(patchValue) : null;
  const finalEditedSymbol = patchIsString ? primaryEditedSymbol(patchValue) : null;

  const errorValue = pick(record, FIELD_ALIASES.error!);
  const modelValue = pick(record, FIELD_ALIASES.model!);
  const agentValue = pick(record, FIELD_ALIASES.agent!);
  const repoValue = pick(record, FIELD_ALIASES.repo!);

  // Detect API/infra failures straight from the raw record. The vtrace policy
  // action is unknown at parse time (it is stamped during ingest), so runStatus
  // is provisional here and re-derived once the policy is known.
  const infra = classifyInfraFailure(record);
  const provisionalStatus = deriveRunStatus({
    infra,
    error: isString(errorValue) ? errorValue : null,
    patchAvailable,
    policyAction: null,
  });

  const row: Stage5Row = {
    instanceId: instanceRaw,
    condition,
    resolved,
    costUsd: asUnknownableNumber(pick(record, FIELD_ALIASES.costUsd!)),
    durationMs: asUnknownableNumber(pick(record, FIELD_ALIASES.durationMs!)),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    tokenAccountingMethod: method,
    numTurns: asUnknownableNumber(pick(record, FIELD_ALIASES.numTurns!)),
    toolCallsTotal: toolCalls.total,
    toolCallsBreakdown: toolCalls.breakdown,
    patchAvailable,
    patchLines,
    model: isString(modelValue) ? modelValue : null,
    agent: isString(agentValue) ? agentValue : null,
    repo: isString(repoValue) ? repoValue : null,
    // vtrace run context is stamped onto vtrace rows during ingest, not parsed
    // from the per-instance result record; default to null here.
    vtraceMethod: null,
    vtraceInstructionsFile: null,
    vtraceInstructionsFileExists: null,
    vtraceInstructionsFileSize: null,
    vtraceInstructionsSnapshotFile: null,
    vtraceInstructionsSnapshotExists: null,
    vtraceInstructionsSha256: null,
    vtraceInjectionObserved: null,
    vtraceInjectionError: null,
    vtraceTreatmentValid: null,
    ...nullIndexedContextFields(),
    ...nullEvaluationFields(),
    ...nullCapsuleDiagnosticFields(),
    // Agent-compliance: parsed from the record's ordered tool calls when present
    // (pivot-relative fields are re-stamped once the pivot file is known).
    ...buildAgentCompliance(record, null),
    runStatus: provisionalStatus.runStatus,
    shouldRerun: provisionalStatus.shouldRerun,
    infraErrorStatus: infra?.infraErrorStatus ?? null,
    infraErrorKind: infra?.infraErrorKind ?? null,
    infraErrorMessage: infra?.infraErrorMessage ?? null,
    finalEditedFile,
    finalEditedSymbol,
    error: isString(errorValue) ? errorValue : null,
    rawResultPath,
    parserKind,
    parsedFieldCount: 0,
    notes: [],
  };
  return { ...row, parsedFieldCount: countParsedFields(row) };
}

// Count normalized fields that carry a concrete (non-"unknown", non-null) value,
// for the diagnostics block. instanceId is always present so it always counts.
function countParsedFields(row: Stage5Row): number {
  const values: Array<Unknownable<unknown> | string | null> = [
    row.instanceId,
    row.resolved,
    row.costUsd,
    row.durationMs,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheCreationTokens,
    row.totalTokens,
    row.numTurns,
    row.toolCallsTotal,
    row.patchAvailable,
    row.patchLines,
    row.model,
    row.agent,
    row.repo,
  ];
  return values.filter((value) => value !== "unknown" && value !== null).length;
}

// Pull candidate result records out of one file's contents, trying JSON, then
// JSONL, then CSV, then a GFM markdown table. Returns whatever records carry an
// instance id; files with none yield an empty list.
export function parseResultRecords(
  content: string,
  filename: string,
  condition: Stage5Condition,
  rawResultPath: string,
): Stage5Row[] {
  const records = collectRecords(content, filename);
  const parserKind = parserKindFor(filename);
  const rows: Stage5Row[] = [];
  for (const record of records) {
    const row = extractRow(record, condition, rawResultPath, parserKind);
    if (row !== null) rows.push(row);
  }
  return rows;
}

// Canonical vexp-swe-bench result logs are named `swebench-<date>.jsonl` and use
// the camelCase schema; tag them so the report records which reader was used.
export function parserKindFor(filename: string): string {
  const base = filename.toLowerCase();
  if (/^swebench-.*\.jsonl$/.test(base)) return "vexp_swebench_jsonl";
  const ext = path.extname(base);
  if (ext === ".jsonl") return "jsonl";
  if (ext === ".json") return "json";
  if (ext === ".csv") return "csv";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return "unknown";
}

// True when a file is a canonical vexp-swe-bench result log. When any are
// present in a condition dir we parse ONLY those, so run metadata/stdout never
// competes with the real result rows.
export function isCanonicalResultFile(filename: string): boolean {
  return /^swebench-.*\.jsonl$/i.test(filename);
}

function collectRecords(content: string, filename: string): Record<string, unknown>[] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".csv") return parseCsvRecords(content);
  if (ext === ".md" || ext === ".markdown") return parseMarkdownTableRecords(content);

  const whole = parseJson(content);
  if (whole !== null) return flattenJsonRecords(whole);

  // Fall back to JSONL: one JSON object per non-empty line.
  return parseJsonlRecords(content);
}

function flattenJsonRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["results", "predictions", "instances", "items", "runs"]) {
    if (Array.isArray(value[key])) return (value[key] as unknown[]).filter(isRecord);
  }
  // A single result object, or a map of instance_id -> result object.
  if (pick(value, FIELD_ALIASES.instanceId!) !== undefined) return [value];
  const mapValues = Object.entries(value)
    .filter(([, entry]) => isRecord(entry))
    .map(([instanceKey, entry]) => ({ instance_id: instanceKey, ...(entry as Record<string, unknown>) }));
  return mapValues.length > 0 ? mapValues : [];
}

function parseJsonlRecords(content: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = parseJson(line);
    if (isRecord(parsed)) records.push(parsed);
  }
  return records;
}

function parseCsvRecords(content: string): Record<string, unknown>[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const record: Record<string, unknown> = {};
    header.forEach((key, index) => {
      record[key] = cells[index] ?? "";
    });
    return record;
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseMarkdownTableRecords(content: string): Record<string, unknown>[] {
  const tableLines = content.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
  if (tableLines.length < 2) return [];
  const header = splitMarkdownRow(tableLines[0]!);
  const bodyStart = isMarkdownSeparator(tableLines[1]!) ? 2 : 1;
  return tableLines.slice(bodyStart).map((line) => {
    const cells = splitMarkdownRow(line);
    const record: Record<string, unknown> = {};
    header.forEach((key, index) => {
      record[normalizeHeaderKey(key)] = cells[index] ?? "";
    });
    return record;
  });
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

function normalizeHeaderKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "_");
}

// ----- modes ------------------------------------------------------------------

export async function runPrepare(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  void deps;
  await ensureOutputTree(config.out);
  const instances = await resolveInstances(config);
  const cliPath = config.vexpSweBenchDir === null ? null : path.join(config.vexpSweBenchDir, config.cliEntry);
  const plan = {
    mode: "prepare" as const,
    vexpSweBenchDir: config.vexpSweBenchDir,
    vexpSweBenchDirExists: config.vexpSweBenchDir === null ? false : await pathExists(config.vexpSweBenchDir),
    cliEntry: config.cliEntry,
    cliEntryPath: cliPath,
    cliEntryExists: cliPath === null ? false : await pathExists(cliPath),
    instances,
    instancesSelected: instances.length,
    vtraceMethod: config.vtraceMethod,
    protocol: config.protocol,
    allowVexp: config.allowVexp,
    runLabel: config.runLabel,
    outputDirs: {
      baselineRaw: rawConditionDir(config.out, "baseline", config.runLabel),
      vtraceRaw: rawConditionDir(config.out, "vtrace", config.runLabel),
      vexpRaw: rawConditionDir(config.out, "vexp", config.runLabel),
    },
    commands: {
      baseline: renderCommand(buildBaselineCommand(config, instances)),
      vtrace: renderCommand(buildVtraceCommand(config, instances)),
      // The vexp command is shown for transparency; it only RUNS with --allow-vexp.
      vexp: renderCommand(buildVexpCommand(config, instances)),
    },
    notes: [
      instances.length === 0 ? "No instances selected; pass --instances or populate smoke_instances.json." : "",
      config.vexpSweBenchDir === null ? "No --vexp-swe-bench-dir provided." : "",
      !config.allowVexp ? "vexp condition is gated: pass --allow-vexp to run the vexp protocol." : "",
    ].filter((note) => note.length > 0),
  };
  await writeFile(path.join(config.out, "run_plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
}

export async function runBaseline(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  await runCondition(config, "baseline", deps);
}

export async function runVtrace(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  await ensureOutputTree(config.out);
  // The instructions/context file lives at the results root (survives vexp's
  // --output wipe) so the patched adapter can read it at runtime.
  const instructionsPath = vtraceInstructionsFilePath(config.out);
  let extraVtraceMeta: Record<string, unknown> = {};
  // Whether to inject vtrace context into the spawned run. A valid SKIP policy
  // runs the benchmark WITHOUT injection (no instructions file env) — a real
  // vtrace-policy row, not an indexed-context treatment.
  let injectContext = true;
  // Capsule v2 evidence bundles to persist as raw artifacts (only the
  // indexed-context path builds a capsule; empty otherwise).
  let capsuleV2Bundles: readonly CapsuleV2ArtifactBundle[] = [];

  if (config.vtraceMethod === "indexed-context") {
    // Stage 5B: real vtrace indexing + query produces the injected context. The
    // local prompt patch is the injection mechanism, so require it first. Then
    // build the context; if it cannot be generated, abort BEFORE spawning vexp —
    // never silently fall back to generic instructions or spend tokens on a
    // non-treatment run — UNLESS vtrace deliberately skipped (a valid policy).
    await assertVtracePatchInstalled(config);
    const indexed = await prepareIndexedContext(config, deps);
    extraVtraceMeta = { ...indexedContextMetaFields(indexed), ...indexRunMetaFields(indexed) };
    capsuleV2Bundles = indexed.capsuleV2Bundles;
    if (indexed.policyAction === "skip") {
      // VALID no-context policy (cost-aware gate, decideContextPolicy): the
      // expected value of injected context did not exceed its overhead — either
      // vtrace recovered no high-confidence target, or the task is cheap/local
      // enough that even action-oriented context is net overhead. Run the
      // external benchmark with --no-vexp and NO instructions file, so we still
      // measure a real resolved/cost/tokens row for the vtrace-policy condition
      // while recording that nothing was injected.
      injectContext = false;
      process.stderr.write(
        `Stage5 vtrace policy: no_context (no context injected) — ${indexed.policyReason ?? indexed.skipReason ?? "no high-confidence actionable target recovered"}\n`,
      );
    } else if (!indexed.indexedContext) {
      throw new Error(
        `indexed-context preparation produced no vtrace context (${indexed.contextError ?? "unknown error"}); ` +
          "aborting before spawn so no tokens are spent on a non-treatment run.",
      );
    } else {
      await assertVtraceInstructionsFileValid(instructionsPath);
    }
  } else {
    // Generic instructions-file / local-patch: write the generic instructions.
    await writeFile(instructionsPath, `${vtraceInstructionsText()}\n`);
    if (config.vtraceMethod === "local-patch") {
      await assertVtraceInstructionsFileValid(instructionsPath);
      await assertVtracePatchInstalled(config);
    }
  }
  // Snapshot the exact injected instructions into an immutable per-run-label file
  // BEFORE the spawn, while the active file holds precisely what the agent reads.
  // A no-context policy run injects nothing, so it records no snapshot.
  if (injectContext) {
    extraVtraceMeta = { ...extraVtraceMeta, ...(await snapshotVtraceInstructions(config)) };
  }
  await runCondition(config, "vtrace", deps, extraVtraceMeta, injectContext, capsuleV2Bundles);
}

// Map Capsule v2 audit items to the inspection-shaped pivots the hard gate checks.
// `hidden` reuses the harness's own pivotIsHidden classification so the gate's
// "every pivot accounted for" requirement covers exactly the pivots the report
// already counts as hidden/visible.
function pivotsForInspection(
  items: readonly CapsuleAuditItem[],
  role: "pivot" | "support",
): PivotForInspection[] {
  return items.map((item) => ({
    path: item.path,
    symbol: item.symbol,
    role,
    hidden: pivotIsHidden(item.roleReason),
  }));
}

// Total injected neighborhood excerpts + the identifiers used to detect whether
// the Phase-1 agent engaged the neighborhood (excerpt fq-name/symbol/path and the
// owning pivot path), derived from the injected Capsule v2 bundles.
function neighborhoodFromBundles(bundles: readonly CapsuleV2ArtifactBundle[]): {
  count: number;
  identifiers: string[];
} {
  const identifiers = new Set<string>();
  let count = 0;
  for (const bundle of bundles) {
    for (const context of readPivotNeighborhood(bundle.result)) {
      if (context.pivot?.path) identifiers.add(context.pivot.path);
      for (const excerpt of context.excerpts ?? []) {
        count += 1;
        if (excerpt.fqName) identifiers.add(excerpt.fqName);
        if (excerpt.symbol) identifiers.add(excerpt.symbol);
        if (excerpt.filePath) identifiers.add(excerpt.filePath);
      }
    }
  }
  return { count, identifiers: [...identifiers] };
}

// Read the patch text emitted in a phase's canonical results JSONL (the agent's
// final diff). "" when no results file or no diff — used to detect a Phase-1
// edit-before-gate violation and to confirm a Phase-2 solve produced a patch.
async function readPhasePatchText(resultsFile: string | null): Promise<string> {
  if (resultsFile === null) return "";
  const content = await readFile(resultsFile, "utf8").catch(() => "");
  for (const record of parseJsonlRecords(content)) {
    const value = pick(record, FIELD_ALIASES.patch!);
    if (typeof value === "string" && value.includes("diff --git")) return value;
  }
  return "";
}

// Best-effort total tokens from a phase's results JSONL (null when unavailable).
// Sums input/output/cache components the SAME way accountTokens does for the
// condition rows — the swebench row carries components, not an explicit
// total_tokens, so a naive total-only lookup would (and did) record null and
// hide the phase's real spend (cache-read dominates).
async function readPhaseTokens(resultsFile: string | null): Promise<number | null> {
  if (resultsFile === null) return null;
  const content = await readFile(resultsFile, "utf8").catch(() => "");
  for (const record of parseJsonlRecords(content)) {
    const { totalTokens } = accountTokens(
      asUnknownableNumber(pick(record, FIELD_ALIASES.inputTokens!)),
      asUnknownableNumber(pick(record, FIELD_ALIASES.outputTokens!)),
      asUnknownableNumber(pick(record, FIELD_ALIASES.cacheReadTokens!)),
      asUnknownableNumber(pick(record, FIELD_ALIASES.cacheCreationTokens!)),
      asUnknownableNumber(pick(record, FIELD_ALIASES.totalTokens!)),
    );
    if (typeof totalTokens === "number") return totalTokens;
  }
  return null;
}

// Spawn one phase of the hard gate: a single external `run` (vexp disabled), with
// the instructions-file and stream-file env pointed at this phase's OWN paths so
// the two phases never share a transcript. Returns the exit/stream/results so the
// caller can parse the phase outcome.
async function spawnHardGatePhase(
  config: CliConfig,
  deps: RunDeps,
  args: {
    instances: readonly string[];
    outputDir: string;
    instructionsFile: string;
    streamFile: string;
    label: string;
    // When non-empty, the Phase's `claude` invocation denies these tools (read-only
    // preflight). The patched adapter reads VTRACE_AGENT_DISALLOWED_TOOLS; Phase 2
    // passes [] so the solve keeps the full tool-set.
    disallowedTools?: readonly string[];
  },
): Promise<{ exitCode: number; resultsFile: string | null; streamContent: string }> {
  await mkdir(args.outputDir, { recursive: true });
  const env: Record<string, string> = {
    ...vtraceEnv(config, true),
    VTRACE_AGENT_INSTRUCTIONS_FILE: args.instructionsFile,
    VTRACE_AGENT_STREAM_FILE: args.streamFile,
  };
  if (args.disallowedTools && args.disallowedTools.length > 0) {
    env.VTRACE_AGENT_DISALLOWED_TOOLS = args.disallowedTools.join(",");
  }
  const runArgs = buildRunArgs(config, args.instances, args.outputDir, false);
  process.stderr.write(
    `\n[stage5] hard-gate ${args.label}: running agent for ${config.runLabel ?? args.instances.join(",")} …\n`,
  );
  const result = await (deps.runProcess ?? runProcess)(config.nodeCommand, runArgs, {
    cwd: config.vexpSweBenchDir ?? undefined,
    env,
    streamToTerminal: true,
  });
  const resultsFile = await findCanonicalResultsFile(args.outputDir);
  const streamContent = await readFile(args.streamFile, "utf8").catch(() => "");
  return { exitCode: result.exitCode, resultsFile, streamContent };
}

// Stage 5: the LIVE two-phase hard context-to-action gate (opt-in via
// --pivot-check-gate hard). Phase 1 is an inspect-only preflight whose checklist
// the gate verifies; Phase 2 (the solve) runs ONLY on a passing gate. On a failed
// gate, Phase 2 never spawns — no solve, no Docker evaluation — and the run meta
// records the enforcement block so the report does not read it as a failed patch.
// Two separate `claude -p` invocations by design (clean, deterministic hard stop).
export async function runVtraceHardGate(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  if (config.capsuleEngine !== "v2") {
    throw new Error("--pivot-check-gate hard requires the Capsule v2 engine (--capsule-engine v2).");
  }
  if (config.vtraceMethod !== "indexed-context") {
    throw new Error("--pivot-check-gate hard requires the indexed-context vtrace method.");
  }
  await ensureOutputTree(config.out);
  await assertVtracePatchInstalled(config);

  // Phase 0: build the normal Capsule v2 injected context (incl. pivotNeighborhood)
  // exactly as a standard vtrace-indexed run would; this writes _vtrace_instructions.md.
  const indexed = await prepareIndexedContext(config, deps);
  const baseExtraMeta = { ...indexedContextMetaFields(indexed), ...indexRunMetaFields(indexed) };
  if (indexed.policyAction === "skip" || !indexed.indexedContext) {
    throw new Error(
      "--pivot-check-gate hard requires injected Capsule v2 context, but none was produced " +
        `(${indexed.policyReason ?? indexed.skipReason ?? indexed.contextError ?? "no actionable target"}). ` +
        "Re-run without the hard gate, or on an instance that yields context.",
    );
  }

  const instances = await resolveInstances(config);
  const contextFile = vtraceInstructionsFilePath(config.out);
  const baseContext = await readFile(contextFile, "utf8");
  const pivots = pivotsForInspection(indexed.capsulePivots, "pivot");
  const neighborhood = neighborhoodFromBundles(indexed.capsuleV2Bundles);

  // Distinct phase artifacts at the results ROOT (survive vexp's --output wipe) so
  // the two transcripts/prompts are never mixed. Phase 1 writes its results to a
  // SIBLING dir (not nested under raw/vtrace) so ingest never picks up the
  // inspect-only run as the condition's solve.
  const preflightFile = path.join(config.out, "_vtrace_pivot_check_preflight.md");
  const phase1StreamFile = path.join(config.out, "_agent_phase1_pivot_check_stream.jsonl");
  const phase2StreamFile = path.join(config.out, "_agent_phase2_solve_stream.jsonl");
  const phase2Dir = rawConditionDir(config.out, "vtrace", config.runLabel);
  const phase1Dir = path.join(path.dirname(phase2Dir), "vtrace_pivot_check_phase1");

  const runPhase1 = async (preflightPrompt: string): Promise<HardGatePhase1Outcome> => {
    await writeFile(preflightFile, `${baseContext}\n\n${preflightPrompt}\n`);
    const phase = await spawnHardGatePhase(config, deps, {
      instances,
      outputDir: phase1Dir,
      instructionsFile: preflightFile,
      streamFile: phase1StreamFile,
      label: "phase1 pivot-check (inspect-only, read-only)",
      // Read-only enforcement: deny mutation/unsafe tools so the preflight cannot edit.
      disallowedTools: PHASE1_READONLY_DISALLOWED_TOOLS,
    });
    const toolCalls = toInspectionToolCalls(parseOrderedToolCalls(phase.streamContent));
    return {
      assistantText: assistantTextFromStream(phase.streamContent),
      toolCalls,
      editedFiles: editedFilesFromPatch(await readPhasePatchText(phase.resultsFile)),
      // Any mutation/unsafe tool that slipped through the deny-list (should be none).
      mutationToolNames: mutationToolCallsIn(toolCalls),
      phase1Tokens: await readPhaseTokens(phase.resultsFile),
      streamFile: phase1StreamFile,
      promptFile: preflightFile,
    };
  };

  const runPhase2 = async (approvedChecklistSummary: string): Promise<HardGatePhase2Outcome> => {
    // Re-inject the normal context PLUS the approved checklist into the active
    // instructions file the patched adapter reads for the solve phase.
    await writeFile(contextFile, `${baseContext}\n\n${approvedChecklistSummary}\n`);
    const phase = await spawnHardGatePhase(config, deps, {
      instances,
      outputDir: phase2Dir,
      instructionsFile: contextFile,
      streamFile: phase2StreamFile,
      label: "phase2 solve",
    });
    const patch = await readPhasePatchText(phase.resultsFile);
    return {
      streamFile: phase2StreamFile,
      promptFile: contextFile,
      solveCompleted: phase.exitCode === 0 && patch.length > 0,
      // Docker evaluation stays the separate `--mode evaluate` step (Stage 5 always
      // separates run from evaluate); ingest flips resolved on the phase-2 JSONL.
      dockerEvaluated: false,
      resolved: null,
    };
  };

  const result = await orchestrateHardGate({
    pivots,
    neighborhoodExcerptCount: neighborhood.count,
    neighborhoodIdentifiers: neighborhood.identifiers,
    phase1ToolPolicy: "read-only",
    phase1DisallowedTools: PHASE1_READONLY_DISALLOWED_TOOLS,
    phase1Only: config.pivotCheckGatePhase1Only,
    runPhase1,
    runPhase2,
  });

  // Persist the gate evidence + phase outcomes into the vtrace condition's run meta
  // so ingest/report can read it. On a FAILED gate, Phase 2 never ran — the vtrace
  // condition dir holds no solve JSONL, so ingest sees no patch and never counts it
  // as an unresolved solve; the meta records the enforcement block explicitly.
  const gateMeta = hardGateMetaFields(result);
  const meta = {
    condition: "vtrace" as const,
    instances,
    vtraceMethod: config.vtraceMethod,
    ...baseExtraMeta,
    ...gateMeta,
  };
  await mkdir(phase2Dir, { recursive: true });
  await writeFile(path.join(phase2Dir, "_run.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  await writeFile(
    path.join(phase2Dir, "_pivot_check_gate.json"),
    `${JSON.stringify({ ...gateMeta, failReasons: result.gate.failReasons, rows: result.gate.rows }, null, 2)}\n`,
  );
  process.stdout.write(`\n[stage5] hard-gate outcome: ${describeHardGateOutcome(gateMeta)}\n`);
}

// Stage 5C: run the EXTERNAL benchmark with vexp ENABLED. This is the only
// condition that turns vexp on, so it is hard-gated behind --allow-vexp. The
// guard fires BEFORE any spawn so an accidental vexp run is impossible.
export async function runVexp(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  assertVexpAllowed(config);
  await ensureOutputTree(config.out);
  await runCondition(config, "vexp", deps);
}

// Throws unless --allow-vexp was explicitly passed. Centralized so every vexp
// entry point (run-vexp, protocol vexp/all) shares the identical guard.
export function assertVexpAllowed(config: CliConfig): void {
  if (!config.allowVexp) {
    throw new Error(
      "Refusing to run the vexp-enabled condition without --allow-vexp. The vexp protocol runs " +
        "`node dist/cli.js run` WITHOUT --no-vexp; pass --allow-vexp to opt in explicitly.",
    );
  }
}

// Stage 5C: dispatch a named protocol to the underlying condition runner(s).
// `all` runs baseline + vtrace-indexed always, and vexp only when --allow-vexp
// is set (otherwise it is skipped with a clear note rather than failing the run).
export async function runProtocol(config: CliConfig, deps: RunDeps = {}): Promise<void> {
  switch (config.protocol) {
    case "baseline":
      await runBaseline(config, deps);
      return;
    case "vtrace-indexed": {
      // The vtrace-indexed protocol always means the indexed-context method. With
      // the hard gate opted in, the two-phase enforcement runner replaces the
      // single-shot run; otherwise the standard path is unchanged.
      const vtraceConfig = { ...config, vtraceMethod: "indexed-context" as const };
      if (config.pivotCheckGate === "hard") {
        await runVtraceHardGate(vtraceConfig, deps);
      } else {
        await runVtrace(vtraceConfig, deps);
      }
      return;
    }
    case "vexp":
      await runVexp(config, deps);
      return;
    case "all": {
      await runBaseline(config, deps);
      await runVtrace({ ...config, vtraceMethod: "indexed-context" }, deps);
      if (config.allowVexp) {
        await runVexp(config, deps);
      } else {
        process.stderr.write(
          "Stage5 protocol all: skipping vexp condition (no --allow-vexp). Baseline and vtrace-indexed ran.\n",
        );
      }
      return;
    }
  }
}

// ----- Stage 5C: evaluate mode ------------------------------------------------

// Canonical evidence file written next to each condition's results when an
// evaluate run completes, so ingest can report HOW resolved was reached.
const EVAL_META_FILENAME = "_eval.meta.json";

// Build the external evaluator command. vexp-swe-bench evaluates as a SEPARATE
// step from `run` (which always leaves resolved=null): `evaluate <jsonl>` mutates
// `resolved` IN-PLACE in the same JSONL. docker mode runs the real SWE-bench
// suite; lightweight only checks patch non-emptiness and is NOT a pass/fail signal.
export function buildEvaluateCommand(
  config: CliConfig,
  resultsFile: string,
): { command: string; args: string[]; cwd: string | null } {
  const args = [config.cliEntry, "evaluate", resultsFile, "--mode", config.evalMode, "--timeout", String(config.evalTimeout)];
  if (config.evalMode === "docker" && config.evalDataset !== null) args.push("--dataset", config.evalDataset);
  return { command: config.nodeCommand, args, cwd: config.vexpSweBenchDir };
}

// Find the canonical `swebench-*.jsonl` result log in a condition dir (the file
// the evaluator reads and rewrites). Returns null when no result has been run.
export async function findCanonicalResultsFile(dir: string): Promise<string | null> {
  const files = await listFilesRecursive(dir).catch(() => [] as string[]);
  const canonical = files.filter((absolute) => isCanonicalResultFile(path.basename(absolute)));
  return canonical.sort().at(-1) ?? null;
}

// Count rows with a concrete resolved=true in a JSONL results file (post-eval),
// tolerating the same field aliases the row parser uses.
async function summarizeResolvedFromFile(resultsFile: string): Promise<{ evaluated: number; resolved: number }> {
  const content = await readFile(resultsFile, "utf8").catch(() => "");
  const records = parseJsonlRecords(content);
  let evaluated = 0;
  let resolved = 0;
  for (const record of records) {
    const value = pick(record, FIELD_ALIASES.resolved!);
    if (value === undefined || value === null) continue;
    const flag = asUnknownableBoolean(value);
    if (flag === "unknown") continue;
    evaluated += 1;
    if (flag === true) resolved += 1;
  }
  return { evaluated, resolved };
}

// Invoke the external evaluator for ONE condition's results file and capture
// per-condition evidence. The evaluator mutates `resolved` in-place; we re-read
// the file to count outcomes. Never throws on a non-zero evaluator exit — the
// failure is recorded as evaluation_error so a later run can be retried.
export async function evaluateCondition(
  config: CliConfig,
  condition: Stage5Condition,
  resultsFile: string,
  deps: RunDeps = {},
): Promise<EvaluationEvidence> {
  const spec = buildEvaluateCommand(config, resultsFile);
  const result = await (deps.runProcess ?? runProcess)(spec.command, spec.args, { cwd: spec.cwd ?? undefined });
  const ran = result.exitCode === 0;
  const evaluationError = ran ? null : `evaluate exited ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`;
  const counts = await summarizeResolvedFromFile(resultsFile);
  const notes: string[] = [];
  if (config.evalMode === "lightweight") {
    notes.push("Lightweight evaluation does NOT run tests; resolved=unknown patches stay unevaluated.");
  }
  if (!ran) notes.push("Evaluation command failed; resolved values were not updated.");
  return {
    condition,
    evaluationRan: ran,
    evaluationMethod: config.evalMode,
    // docker_used is true only when docker mode actually completed.
    dockerUsed: config.evalMode === "docker" ? ran : false,
    evaluationError,
    resultsFile,
    instancesEvaluated: counts.evaluated,
    resolvedCount: counts.resolved,
    notes,
  };
}

// The vague-but-only-honest-when-truly-empty fallback. Kept as a named constant
// so evaluate prints it ONLY when no artifacts of any kind exist for a condition.
const NO_ARTIFACTS_MESSAGE =
  "No condition results found to evaluate. Run a protocol/condition first, then --mode evaluate.";

// Artifact-aware diagnosis of why a condition can or cannot be evaluated
// (Requirement 3). Inspects the canonical JSONL plus the `_run.*` artifacts so
// the report distinguishes "ran but API-overloaded", "ran but no patch",
// "skipped by policy", "failed before spawn", and "never run".
export interface ConditionEvalDiagnosis {
  readonly hasArtifacts: boolean;
  readonly hasResultsFile: boolean;
  readonly infra: InfraFailure | null;
  // True only when a non-infra JSONL with at least one patch row is present.
  readonly evaluable: boolean;
  readonly message: string;
}

export async function diagnoseConditionEvaluability(dir: string): Promise<ConditionEvalDiagnosis> {
  const resultsFile = await findCanonicalResultsFile(dir);
  const meta = await readJsonIfExists(path.join(dir, "_run.meta.json"));
  const stderr = await readFile(path.join(dir, "_run.stderr.txt"), "utf8").catch(() => null);
  const stdout = await readFile(path.join(dir, "_run.stdout.txt"), "utf8").catch(() => null);
  const hasArtifacts = resultsFile !== null || meta !== null || stderr !== null || stdout !== null;

  if (resultsFile !== null) {
    const content = await readFile(resultsFile, "utf8").catch(() => "");
    const records = parseJsonlRecords(content);
    const infra = records.map((record) => classifyInfraFailure(record)).find((value): value is InfraFailure => value !== null) ?? null;
    if (infra !== null) {
      const statusText = infra.infraErrorStatus !== null ? `API ${infra.infraErrorStatus}` : "API error";
      const kindText = infra.infraErrorKind === "api_overloaded" ? "overloaded" : infra.infraErrorKind;
      return {
        hasArtifacts: true,
        hasResultsFile: true,
        infra,
        evaluable: false,
        message: `JSONL found but contains infra failure: ${statusText} ${kindText}. Rerun this label.`,
      };
    }
    const hasPatch = records.some((record) => {
      const patch = pick(record, FIELD_ALIASES.patch!);
      return isString(patch) ? patch.trim().length > 0 : Boolean(patch);
    });
    if (!hasPatch) {
      return {
        hasArtifacts: true,
        hasResultsFile: true,
        infra: null,
        evaluable: false,
        message: "JSONL found but contains no patch/model output.",
      };
    }
    return {
      hasArtifacts: true,
      hasResultsFile: true,
      infra: null,
      evaluable: true,
      message: "JSONL found with patch/model output; ready to evaluate.",
    };
  }

  // No canonical results file — decide why from the surrounding artifacts.
  if (!hasArtifacts) {
    return { hasArtifacts: false, hasResultsFile: false, infra: null, evaluable: false, message: NO_ARTIFACTS_MESSAGE };
  }
  if (isRecord(meta) && meta.vtracePolicyAction === "skip") {
    return {
      hasArtifacts: true,
      hasResultsFile: false,
      infra: null,
      evaluable: false,
      message: "No JSONL found because vtrace policy selected skip and no execution was requested.",
    };
  }
  return {
    hasArtifacts: true,
    hasResultsFile: false,
    infra: null,
    evaluable: false,
    message: "No JSONL found because run-protocol failed before spawn.",
  };
}

// Stage 5C evaluate mode: run the external evaluator for every condition that has
// an evaluable result file, writing per-condition `_eval.meta.json`. Conditions
// that cannot be evaluated get an artifact-aware explanation on stderr instead of
// a single vague message (Requirement 3). Returns the collected evidence.
export async function runEvaluate(config: CliConfig, deps: RunDeps = {}): Promise<EvaluationEvidence[]> {
  if (config.vexpSweBenchDir === null) throw new Error("--mode evaluate requires --vexp-swe-bench-dir.");
  const cliPath = path.join(config.vexpSweBenchDir, config.cliEntry);
  if (!(await pathExists(cliPath))) {
    throw new Error(`vexp-swe-bench CLI not found at ${cliPath}. Run ./setup.sh in the external checkout first.`);
  }
  await ensureOutputTree(config.out);
  const evaluations: EvaluationEvidence[] = [];
  const diagnoses: Array<{ condition: Stage5Condition; diagnosis: ConditionEvalDiagnosis }> = [];
  for (const condition of STAGE5_CONDITIONS) {
    const dir = rawConditionDir(config.out, condition, config.runLabel);
    const diagnosis = await diagnoseConditionEvaluability(dir);
    diagnoses.push({ condition, diagnosis });
    // Explain every condition that has artifacts but is not evaluable, so an
    // API-overloaded or no-patch run is never silently skipped.
    if (!diagnosis.evaluable) {
      if (diagnosis.hasArtifacts) process.stderr.write(`Stage5 evaluate [${condition}]: ${diagnosis.message}\n`);
      continue;
    }
    const resultsFile = await findCanonicalResultsFile(dir);
    if (resultsFile === null) continue; // defensive: evaluable implies a file exists
    const evidence = await evaluateCondition(config, condition, resultsFile, deps);
    await writeFile(path.join(dir, EVAL_META_FILENAME), `${JSON.stringify(evidence, null, 2)}\n`);
    evaluations.push(evidence);
  }
  if (evaluations.length === 0) {
    // Only fall back to the vague message when there are truly no artifacts for
    // any condition; otherwise surface the artifact-aware reasons we collected.
    const withArtifacts = diagnoses.filter((entry) => entry.diagnosis.hasArtifacts);
    if (withArtifacts.length === 0) throw new Error(NO_ARTIFACTS_MESSAGE);
    const detail = withArtifacts.map((entry) => `  ${entry.condition}: ${entry.diagnosis.message}`).join("\n");
    throw new Error(`No condition results were evaluable. Per-condition diagnosis:\n${detail}`);
  }
  return evaluations;
}

// Normalize one instance's evaluation evidence out of a SWE-bench per-instance
// report object (the structure swebench writes to report.json), keeping every
// field "unknown" when the report does not expose it. Pure + easily testable:
//
//   { "<id>": { resolved, tests_status: { FAIL_TO_PASS: {success, failure}, ... } } }
//
export function normalizeEvaluationEvidence(
  report: unknown,
  instanceId: string,
  method: EvalMode | "unknown",
): {
  resolved: Unknownable<boolean>;
  failToPassPassed: Unknownable<boolean>;
  passToPassPassed: Unknownable<boolean>;
  testStatus: string | null;
} {
  const unknown = { resolved: "unknown" as const, failToPassPassed: "unknown" as const, passToPassPassed: "unknown" as const, testStatus: null };
  if (!isRecord(report)) return unknown;
  // Reports may be keyed by instance id, or be the instance entry directly.
  const entry = isRecord(report[instanceId]) ? (report[instanceId] as Record<string, unknown>) : report;
  const resolved = typeof entry.resolved === "boolean" ? entry.resolved : ("unknown" as const);
  const status = isRecord(entry.tests_status) ? entry.tests_status : null;
  // A bucket "passed" iff it has at least one success and no failures.
  const bucketPassed = (name: string): Unknownable<boolean> => {
    if (status === null || !isRecord(status[name])) return "unknown";
    const bucket = status[name] as Record<string, unknown>;
    const success = Array.isArray(bucket.success) ? bucket.success.length : null;
    const failure = Array.isArray(bucket.failure) ? bucket.failure.length : null;
    if (success === null && failure === null) return "unknown";
    return (failure ?? 0) === 0 && (success ?? 0) > 0;
  };
  const failToPassPassed = bucketPassed("FAIL_TO_PASS");
  const passToPassPassed = bucketPassed("PASS_TO_PASS");
  const testStatus =
    status === null
      ? null
      : `FAIL_TO_PASS=${describeBucket(status.FAIL_TO_PASS)}; PASS_TO_PASS=${describeBucket(status.PASS_TO_PASS)} (${method})`;
  return { resolved, failToPassPassed, passToPassPassed, testStatus };
}

function describeBucket(bucket: unknown): string {
  if (!isRecord(bucket)) return "n/a";
  const success = Array.isArray(bucket.success) ? bucket.success.length : 0;
  const failure = Array.isArray(bucket.failure) ? bucket.failure.length : 0;
  return `${success} pass / ${failure} fail`;
}

// Reconstruct per-condition evaluation evidence from the recorded _eval.meta.json
// files. Returns [] when no evaluation has been run (resolved fields stay unknown).
async function collectEvaluationEvidence(outDir: string, runLabel: string | null = null): Promise<EvaluationEvidence[]> {
  const evaluations: EvaluationEvidence[] = [];
  for (const condition of STAGE5_CONDITIONS) {
    const dir = rawConditionDir(outDir, condition, runLabel);
    const meta = await readJsonIfExists(path.join(dir, EVAL_META_FILENAME));
    if (!isRecord(meta)) continue;
    evaluations.push(evaluationEvidenceFromMeta(meta, condition));
  }
  return evaluations;
}

function evaluationEvidenceFromMeta(meta: Record<string, unknown>, condition: Stage5Condition): EvaluationEvidence {
  const method = meta.evaluationMethod === "docker" || meta.evaluationMethod === "lightweight" ? meta.evaluationMethod : "unknown";
  return {
    condition,
    evaluationRan: meta.evaluationRan === true,
    evaluationMethod: method,
    dockerUsed: typeof meta.dockerUsed === "boolean" ? meta.dockerUsed : "unknown",
    evaluationError: isString(meta.evaluationError) ? meta.evaluationError : null,
    resultsFile: isString(meta.resultsFile) ? meta.resultsFile : null,
    instancesEvaluated: isNumber(meta.instancesEvaluated) ? meta.instancesEvaluated : 0,
    resolvedCount: isNumber(meta.resolvedCount) ? meta.resolvedCount : 0,
    notes: Array.isArray(meta.notes) ? meta.notes.filter(isString) : [],
  };
}

// Stamp the per-condition evaluation evidence onto each row so the normalized
// rows carry the run-level eval status. Per-instance test detail (FAIL_TO_PASS
// counts) stays "unknown" here: it lives in swebench's own report.json, which the
// evaluator does not surface into the JSONL, so we never fabricate it.
function stampEvaluationRows(rows: readonly Stage5Row[], evaluations: readonly EvaluationEvidence[]): Stage5Row[] {
  const byCondition = new Map<Stage5Condition, EvaluationEvidence>();
  for (const evidence of evaluations) byCondition.set(evidence.condition, evidence);
  return rows.map((row) => {
    const evidence = byCondition.get(row.condition);
    if (evidence === undefined) return row;
    return {
      ...row,
      evaluationRan: evidence.evaluationRan,
      evaluationMethod: evidence.evaluationMethod,
      dockerUsed: evidence.dockerUsed,
      evaluationError: evidence.evaluationError,
    };
  });
}

// Throws unless the vtrace instructions file exists and is non-empty. Called
// before spawning the external CLI so a no-op vtrace run is caught up front.
export async function assertVtraceInstructionsFileValid(instructionsPath: string): Promise<void> {
  const stats = await stat(instructionsPath).catch(() => null);
  if (stats === null || !stats.isFile()) {
    throw new Error(`vtrace instructions file is missing at ${instructionsPath}; aborting before spawn.`);
  }
  if (stats.size === 0) {
    throw new Error(`vtrace instructions file at ${instructionsPath} is empty; aborting before spawn.`);
  }
}

// ----- Stage 5B: indexed-context mode ----------------------------------------

const DEFAULT_SWE_BENCH_DATA_RELPATH = path.join("data", "swe-bench-100.jsonl");
// Hard cap on the query string passed to the vtrace CLI as an argv element.
const MAX_VTRACE_QUERY_CHARS = 8000;

export interface SweBenchInstance {
  readonly repo: string;
  readonly instanceId: string;
  readonly baseCommit: string;
  readonly problemStatement: string;
  readonly hintsText: string | null;
  readonly failToPass: readonly string[];
}

export interface IndexedContextResult {
  readonly indexedContext: boolean;
  readonly indexCommand: string | null;
  readonly queryCommand: string | null;
  readonly workspacePath: string | null;
  // Reusable-clean-workspace prep observability (see prepareWorkspaceForInstance).
  // All defaulted (false/0/null) when no indexed-context workspace prep ran.
  readonly workspaceReused: boolean;
  readonly workspaceResetToBaseCommit: boolean;
  readonly workspaceBaseCommit: string | null;
  readonly workspaceCleaned: boolean;
  readonly workspaceGitRetryCount: number;
  readonly workspaceGitFallbackUsed: boolean;
  readonly workspaceRecreatedAfterFailure: boolean;
  readonly workspacePreparationError: string | null;
  // Workspace/index run metadata, surfaced into the vtrace _run.meta.json.
  readonly freshWorkspace: boolean;
  readonly vtraceIndexQuiet: boolean;
  readonly vtraceIndexStartedAt: string | null;
  readonly vtraceIndexFinishedAt: string | null;
  readonly vtraceIndexDurationMs: number | null;
  // Index-reuse policy outcome (see Stage5IndexPolicy). `reused` is true when the
  // pre-existing index was kept rather than rebuilt; `fresh` is the freshness
  // verdict at decision time; `mismatches` lists the fields that disagreed (empty
  // when fresh); `metaFile` is the path to .vtrace/index.meta.json.
  readonly vtraceIndexPolicy: Stage5IndexPolicy;
  readonly vtraceIndexReused: boolean;
  readonly vtraceIndexFresh: boolean;
  readonly vtraceIndexFreshnessReason: string;
  readonly vtraceIndexMismatches: readonly string[];
  readonly vtraceIndexMetaFile: string | null;
  readonly contextFile: string;
  readonly contextChars: number;
  readonly contextItems: number;
  readonly contextTruncated: boolean;
  readonly contextError: string | null;
  // Run-level vtrace policy: "inject" when any real context was produced, "skip"
  // when none was AND every empty result was an intentional capsule skip (no hard
  // error), "error" when an empty result was a genuine failure.
  readonly policyAction: VtracePolicyAction;
  readonly contextInjected: boolean;
  readonly skipReason: string | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  readonly actualCapsuleMode: string | null;
  // Cost-aware gate decision + its rationale (see decideContextPolicy).
  readonly contextPolicyAction: ContextPolicyAction;
  // The operator override that was in effect (--context-policy); "auto" when the
  // cost-aware gate decided on its own.
  readonly contextPolicyOverride: ContextPolicyOverride;
  readonly policyReason: string | null;
  // The named signals behind the gate's decision (decideCapsuleV2ContextPolicy on
  // the v2 engine, decideContextPolicy on legacy). null on baseline / hard error.
  readonly contextPolicyDecisionSignals: readonly string[] | null;
  readonly expectedContextValue: ExpectedLevel | null;
  readonly expectedOverheadRisk: ExpectedLevel | null;
  // Which capsule engine produced the query. intent/budget are null on the legacy
  // engine (they are v2-only knobs). `capsuleEngine` is retained for backward
  // compatibility and equals the EFFECTIVE engine; the migration audit below
  // distinguishes requested vs effective and records any fallback reason.
  readonly capsuleEngine: CapsuleEngine;
  readonly capsuleIntent: CapsuleV2Intent | null;
  readonly capsuleBudget: number | null;
  // Engine-default migration audit. `requestedCapsuleEngine` is what the run asked
  // for (default v2); `effectiveCapsuleEngine` is what actually produced the
  // injected context after any v2 → legacy fallback; `capsuleEngineFallbackReason`
  // is the v2 failure message (null when no fallback occurred);
  // `compactInspectFirst` is true when the effective engine is v2 (the v2 injected
  // render uses compact inspect-first).
  readonly requestedCapsuleEngine: CapsuleEngine;
  readonly effectiveCapsuleEngine: CapsuleEngine;
  readonly capsuleEngineFallbackReason: string | null;
  readonly compactInspectFirst: boolean;
  // Capsule v2 selected-item audit: the exact pivots/support injected, the lead
  // pivot file/symbol, the realised actual_mode, and the capsule's token estimate.
  // Empty/null on the legacy engine and on no-context runs.
  readonly capsulePivots: readonly CapsuleAuditItem[];
  readonly capsuleSupport: readonly CapsuleAuditItem[];
  readonly capsuleTopPivotFile: string | null;
  readonly capsuleTopPivotSymbol: string | null;
  readonly capsuleActualMode: string | null;
  readonly capsuleEstimatedTokens: number | null;
  // Lead-pivot focused-source audit (v2): whether the injected snapshot carried
  // the top pivot's source body, its size in chars, and the mode. "missing" off
  // the v2 engine and whenever no body was injected.
  readonly capsuleTopPivotHasSource: boolean;
  readonly capsuleTopPivotSourceChars: number | null;
  readonly capsuleTopPivotSourceMode: CapsulePivotSourceMode;
  // Policy-relevant v2 diagnostics surfaced to the report (0/false off v2).
  readonly capsuleEditRiskDirectivesCount: number;
  readonly capsuleLineAnchorResolutionUsed: boolean;
  readonly capsuleSqlRenderingBackfillUsed: boolean;
  // Per-instance Capsule v2 evidence bundles (full result + exact injected
  // Markdown), used to persist the raw manifest/ranking/context artifacts into the
  // run directory. Empty off the v2 engine and when no v2 result was produced.
  readonly capsuleV2Bundles: readonly CapsuleV2ArtifactBundle[];
  // PIVOT_CHECK state for this run. `enabled` is the feature switch (false only
  // when --disable-pivot-check was passed); `disabledByFlag` mirrors that flag
  // explicitly so a before run is never mistaken for a failed injection;
  // `injected` is whether the block actually made it into the assembled context
  // (true only when enabled AND a multi-pivot v2 section qualified).
  readonly pivotCheckEnabled: boolean;
  readonly pivotCheckInjected: boolean;
  readonly pivotCheckDisabledByFlag: boolean;
  // Deterministic PIVOT_CHECK policy state. `policy` is the effective policy (forced
  // to "off" by --disable-pivot-check); `policyReason` is the representative section's
  // rationale; `riskSignals` are the deterministic high-risk signals that were present
  // (empty when none / not v2); `wouldInjectUnderMultiPivot` records whether the OLD
  // >= 2-pivot behaviour would have injected, for token-cost comparison.
  readonly pivotCheckPolicy: PivotCheckPolicy;
  readonly pivotCheckPolicyReason: string;
  readonly pivotCheckRiskSignals: readonly string[];
  readonly pivotCheckWouldInjectUnderMultiPivot: boolean;
  // EDIT_GUARD state for this run. `enabled` is the feature switch (false only when
  // --disable-edit-guard was passed); `disabledByFlag` mirrors that flag; `injected`
  // is whether the guard block actually entered the assembled context (true only when
  // enabled AND a PIVOT_CHECK block was injected); `textPresent` re-scans the final
  // snapshot for the marker.
  readonly editGuardEnabled: boolean;
  readonly editGuardInjected: boolean;
  readonly editGuardDisabledByFlag: boolean;
  readonly editGuardTextPresent: boolean;
  // PATCH_VERIFY state for this run, mirroring the EDIT_GUARD shape. `enabled` is the
  // feature switch (false only when --disable-patch-verify was passed); `disabledByFlag`
  // mirrors that flag; `injected` is whether the checkpoint block actually entered the
  // assembled context (true only when enabled AND a PIVOT_CHECK block was injected,
  // independent of EDIT_GUARD); `textPresent` re-scans the final snapshot for the marker.
  readonly patchVerifyEnabled: boolean;
  readonly patchVerifyInjected: boolean;
  readonly patchVerifyDisabledByFlag: boolean;
  readonly patchVerifyTextPresent: boolean;
}

// Resolve the bundled vexp-swe-bench dataset path (overridable via --swe-bench-data).
export function sweBenchDataPath(config: CliConfig): string {
  if (config.sweBenchDataFile !== null) return config.sweBenchDataFile;
  if (config.vexpSweBenchDir === null) {
    throw new Error("indexed-context requires --vexp-swe-bench-dir (or --swe-bench-data) to locate instance data.");
  }
  return path.join(config.vexpSweBenchDir, DEFAULT_SWE_BENCH_DATA_RELPATH);
}

// Parse the SWE-bench JSONL dataset into raw records (one JSON object per line).
export async function loadSweBenchData(dataPath: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(dataPath, "utf8").catch(() => null);
  if (content === null) throw new Error(`SWE-bench data file not found at ${dataPath}.`);
  return parseJsonlRecords(content);
}

export function findSweBenchRecord(
  records: readonly Record<string, unknown>[],
  instanceId: string,
): Record<string, unknown> | null {
  return records.find((record) => record.instance_id === instanceId || record.instanceId === instanceId) ?? null;
}

// Validate and normalize a raw record into a SweBenchInstance. Throws a clear
// error naming any missing required field — never fabricates data.
export function toSweBenchInstance(record: Record<string, unknown>): SweBenchInstance {
  const repo = pick(record, ["repo"]);
  const instanceId = pick(record, FIELD_ALIASES.instanceId!);
  const baseCommit = pick(record, ["base_commit", "baseCommit"]);
  const problemStatement = pick(record, ["problem_statement", "problemStatement"]);
  const missing = [
    !isString(repo) ? "repo" : "",
    !isString(instanceId) ? "instance_id" : "",
    !isString(baseCommit) ? "base_commit" : "",
    !isString(problemStatement) ? "problem_statement" : "",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`SWE-bench record is missing required field(s): ${missing.join(", ")}.`);
  }
  const hints = pick(record, ["hints_text", "hintsText"]);
  const failRaw = pick(record, ["FAIL_TO_PASS", "fail_to_pass", "failToPass"]);
  return {
    repo: repo as string,
    instanceId: instanceId as string,
    baseCommit: baseCommit as string,
    problemStatement: problemStatement as string,
    hintsText: isString(hints) ? hints : null,
    failToPass: normalizeTestList(failRaw),
  };
}

// FAIL_TO_PASS is sometimes a JSON array and sometimes a JSON-encoded string.
function normalizeTestList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(isString);
  if (isString(value)) {
    const parsed = parseJson(value);
    if (Array.isArray(parsed)) return parsed.filter(isString);
  }
  return [];
}

// Our own isolated checkout for an instance (Approach B), kept out of the per
// condition raw/<condition> dirs and out of vexp's .bench-repos.
export function workspacePathFor(outDir: string, instanceId: string, runLabel: string | null = null): string {
  const base = path.join(outDir, "workspaces");
  return runLabel === null ? path.join(base, instanceId) : path.join(base, runLabel, instanceId);
}

export function buildCloneCommand(repo: string, workspace: string): { command: string; args: string[] } {
  // `--progress` forces git to emit its clone progress to stderr even when stderr is
  // not a TTY (e.g. when we tee it through a pipe), so cloning is always visible.
  return { command: "git", args: ["clone", "--progress", `https://github.com/${repo}.git`, workspace] };
}

export function buildCheckoutCommand(workspace: string, baseCommit: string): { command: string; args: string[] } {
  return { command: "git", args: ["-C", workspace, "checkout", baseCommit, "--force"] };
}

function splitArgs(value: string): string[] {
  return value.split(/\s+/).filter((part) => part.length > 0);
}

export function buildVtraceIndexCommand(config: CliConfig, workspace: string): { command: string; args: string[] } {
  const [command, ...base] = splitArgs(config.vtraceCommand);
  if (command === undefined) throw new Error("--vtrace-command is empty; cannot build the vtrace index command.");
  // Index progress is always surfaced now, so `--quiet` (which would force the index
  // CLI's null progress reporter) is always dropped. The --show-vtrace-index-log flag
  // is retained for back-compat but no longer gates this.
  const indexArgs = splitArgs(config.vtraceIndexArgs).filter((arg) => arg !== "--quiet");
  return { command, args: [...base, "index", workspace, ...indexArgs] };
}

// The decision the index-reuse policy reaches for one workspace, before any
// index work runs. `reuse` true means keep the existing index; false means
// (re)build it. `fresh`/`reason`/`mismatches` describe the freshness verdict
// that drove the decision.
export interface IndexPolicyDecision {
  readonly reuse: boolean;
  readonly fresh: boolean;
  readonly reason: string;
  readonly mismatches: readonly string[];
}

// Resolve the index-reuse policy against the workspace's stored index metadata.
//   always -> never reuse (caller deletes .vtrace and rebuilds).
//   auto   -> reuse iff the stored index is fingerprint-fresh.
//   reuse  -> reuse whenever an index database is present, even if stale; the
//             caller warns loudly. Rebuild only when no index exists at all.
export async function decideIndexPolicy(
  policy: Stage5IndexPolicy,
  workspace: string,
): Promise<IndexPolicyDecision> {
  if (policy === "always") {
    return { reuse: false, fresh: false, reason: "index-policy always: forced rebuild", mismatches: [] };
  }

  const dbPresent = await pathExists(path.join(workspace, ".vtrace", "index.sqlite"));
  if (!dbPresent) {
    return { reuse: false, fresh: false, reason: "index database missing", mismatches: ["index_sqlite"] };
  }

  const expected = await buildExpectedIndexMeta(workspace);
  const freshness: IndexFreshness = await checkIndexFreshness(workspace, expected);

  if (policy === "reuse") {
    // Reuse the present index regardless of freshness; the verdict is recorded so
    // a stale-but-reused index is auditable in _run.meta.json.
    return { reuse: true, fresh: freshness.fresh, reason: freshness.reason, mismatches: freshness.mismatches };
  }

  // auto: reuse only a fingerprint-fresh index, otherwise rebuild.
  return { reuse: freshness.fresh, fresh: freshness.fresh, reason: freshness.reason, mismatches: freshness.mismatches };
}

export function buildVtraceQueryCommand(
  config: CliConfig,
  workspace: string,
  query: string,
  mode?: CapsuleModeT,
): { command: string; args: string[] } {
  const [command, ...base] = splitArgs(config.vtraceCommand);
  if (command === undefined) throw new Error("--vtrace-command is empty; cannot build the vtrace query command.");
  // Capsule v2 product surface: `--intent <i> --budget <n> --json`. The legacy
  // `--mode` flags are NEVER passed here — v2 selects its sizing from the budget,
  // and passing --mode would route the CLI back to the legacy path.
  const engineArgs =
    config.capsuleEngine === "v2"
      // `--pivot-neighborhood` makes the injected v2 `.context` carry the same
      // bounded neighborhood excerpts the run_pipeline product probe detects, so
      // the agent actually receives them (not just the report).
      ? ["--intent", config.capsuleIntent, "--budget", String(config.capsuleBudget), "--pivot-neighborhood", "--json"]
      // Legacy: when a mode is chosen, request the compact JSON capsule
      // (`--mode <m> --json`) so retrieved context — not the issue — is injected.
      : mode === undefined
        ? []
        : ["--mode", mode, "--json"];
  return {
    command,
    args: [...base, "capsule", workspace, query, ...engineArgs, ...splitArgs(config.vtraceQueryArgs)],
  };
}

// The capsule `--json` output is `{ diagnostics, context }`; older raw output is
// plain text. Extract the injectable context from either, tolerating non-JSON.
export function extractCapsuleContext(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { context?: unknown };
    return typeof parsed.context === "string" ? parsed.context.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

// The vtrace POLICY a capsule query expressed for one instance:
//  - inject: real retrieved context was produced → inject it (the treatment).
//  - skip:   vtrace deliberately recovered no high-confidence target → a VALID
//            no-context policy decision (small/local task), not an error.
//  - error:  empty/unusable output that is NOT an intentional skip → fail fast.
export type VtracePolicyAction = "inject" | "skip" | "error";

// One Capsule v2 selected item, reduced to the audit-relevant fields. Recorded
// per-run so a live run is auditable down to EXACTLY which pivots/support were
// injected (not just counts) — the snapshot shows the rendered text, this shows
// the structured selection.
export interface CapsuleAuditItem {
  readonly path: string;
  readonly symbol: string;
  readonly roleReason: string | null;
  readonly estimatedTokens: number | null;
}

// How a Capsule v2 pivot's focused source reached the injected snapshot:
//   * "full"    — the pivot's complete focused body was injected (the capsule's
//                 own `full` content mode; what the agent edits against);
//   * "focused" — a non-empty but budget-compressed/partial body was injected
//                 (reserved: the current v2 ladder only emits a body in `full`
//                 mode, so this guards a future partial-body content mode);
//   * "missing" — no source body was injected (a signature/skeleton pivot, or no
//                 pivot at all). Recorded honestly so a body-less run never reads
//                 as if it had source.
export type CapsulePivotSourceMode = "focused" | "full" | "missing";

// The top pivot's source audit: whether a focused body was injected, its size in
// chars, and the mode above. Derived from the capsule JSON, never inferred.
interface PivotSourceInfo {
  readonly hasSource: boolean;
  readonly chars: number | null;
  readonly mode: CapsulePivotSourceMode;
}

const MISSING_PIVOT_SOURCE: PivotSourceInfo = { hasSource: false, chars: null, mode: "missing" };

// Classify a Capsule v2 pivot's focused source. A pivot carries a `source` body
// only in `full` content mode; signature/skeleton pivots carry none. Tolerates
// partial JSON (a non-string source/content_mode degrades to "missing").
export function classifyPivotSource(pivot: unknown): PivotSourceInfo {
  if (!isRecord(pivot)) return MISSING_PIVOT_SOURCE;
  const source = isString(pivot.source) ? pivot.source : null;
  if (source === null || source.length === 0) return MISSING_PIVOT_SOURCE;
  const contentMode = isString(pivot.content_mode) ? pivot.content_mode : null;
  return { hasSource: true, chars: source.length, mode: contentMode === "full" ? "full" : "focused" };
}

export interface CapsuleClassification {
  readonly policyAction: VtracePolicyAction;
  readonly contextInjected: boolean;
  readonly context: string;
  readonly skipReason: string | null;
  readonly recommendedMode: string | null;
  readonly actualCapsuleMode: string | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  // How hard the agent should search before trusting the capsule (Requirement 5),
  // captured verbatim from the capsule diagnostics. null when not reported.
  readonly searchBudget: string | null;
  readonly searchBudgetReason: string | null;
  // Capsule v2 selected-item audit (null on the legacy engine, which emits no
  // structured items). estimatedTokens is the capsule's total token estimate.
  readonly capsulePivots: readonly CapsuleAuditItem[] | null;
  readonly capsuleSupport: readonly CapsuleAuditItem[] | null;
  readonly capsuleEstimatedTokens: number | null;
  // Top-pivot focused-source audit: whether the lead pivot carried a body, its
  // size, and the mode. Always present (defaults to "missing") so a body-less
  // capsule is recorded as missing rather than silently omitted.
  readonly capsuleTopPivotHasSource: boolean;
  readonly capsuleTopPivotSourceChars: number | null;
  readonly capsuleTopPivotSourceMode: CapsulePivotSourceMode;
  // Capsule v2 policy-relevant diagnostics, captured from the result so the
  // cost-aware v2 gate can read the engine's own edit-risk / anchor / SQL-backfill
  // evidence. All default to 0/false off the v2 engine (legacy emits none).
  readonly capsuleEditRiskDirectivesCount: number;
  readonly capsuleLineAnchorResolutionUsed: boolean;
  readonly capsuleSqlRenderingBackfillUsed: boolean;
  // The full Capsule v2 result (null on the legacy engine and on hard errors).
  // Used only to persist the raw manifest/ranking artifacts — never injected.
  readonly capsuleV2Result: CapsuleV2Result | null;
  /** Set only when policyAction === "error" (genuinely unusable output). */
  readonly error: string | null;
}

// The Capsule v2 audit payload threaded into a classification (null on legacy).
interface CapsuleV2Audit {
  readonly pivots: readonly CapsuleAuditItem[];
  readonly support: readonly CapsuleAuditItem[];
  readonly estimatedTokens: number | null;
  readonly topPivotSource: PivotSourceInfo;
  readonly editRiskDirectivesCount: number;
  readonly lineAnchorResolutionUsed: boolean;
  readonly sqlRenderingBackfillUsed: boolean;
  // The full Capsule v2 result the engine emitted. Carried losslessly so the
  // runner can persist the manifest/ranking artifacts (it is reduced to the audit
  // fields above for `_run.meta.json`, but the raw result drives the artifacts).
  readonly result: CapsuleV2Result;
}

// Classify a capsule `--json` (or raw) query output into a vtrace policy action.
// A capsule SKIP is recorded honestly as a valid policy, never thrown as fatal:
// it is detected from empty context paired with skip diagnostics — an explicit
// `recommended_mode`/`actual_mode` of `skip`, or `pivot_count === 0` accompanied
// by a retrieval reason. Empty context WITHOUT any of those signals is a real
// error (e.g. a broken index) and still fails fast.
export function classifyCapsuleOutput(stdout: string): CapsuleClassification {
  const trimmed = stdout.trim();

  // Non-JSON (legacy raw text): context iff non-empty, else an error.
  if (!trimmed.startsWith("{")) {
    return trimmed.length > 0
      ? injectClassification(trimmed, null, null, null, null)
      : errorClassification("vtrace query returned empty context.");
  }

  let parsed: { context?: unknown; diagnostics?: Record<string, unknown>; pivots?: unknown; actual_mode?: unknown };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    // Malformed JSON we cannot reason about: treat as injectable raw text if any.
    return trimmed.length > 0
      ? injectClassification(trimmed, null, null, null, null)
      : errorClassification("vtrace query returned empty context.");
  }

  // Capsule v2 output has a different shape than the legacy capsule: a top-level
  // `pivots` array + `actual_mode` and NO rendered `context` string. Detect and
  // classify it separately (rendering the injectable context from the result).
  if (Array.isArray(parsed.pivots) && isString(parsed.actual_mode)) {
    return classifyCapsuleV2Output(parsed as unknown as CapsuleV2Result);
  }

  const diagnostics = isRecord(parsed.diagnostics) ? parsed.diagnostics : {};
  const context = typeof parsed.context === "string" ? parsed.context.trim() : "";
  const recommendedMode = isString(diagnostics.recommended_mode) ? diagnostics.recommended_mode : null;
  const actualMode = isString(diagnostics.actual_mode) ? diagnostics.actual_mode : null;
  const pivotCount = isNumber(diagnostics.pivot_count) ? diagnostics.pivot_count : null;
  const supportCount = isNumber(diagnostics.support_count) ? diagnostics.support_count : null;
  const reason = isString(diagnostics.retrieval_reason) ? diagnostics.retrieval_reason : null;
  const searchBudget = isString(diagnostics.search_budget) ? diagnostics.search_budget : null;
  const searchBudgetReason = isString(diagnostics.search_budget_reason) ? diagnostics.search_budget_reason : null;

  // A `skip` mode is AUTHORITATIVE, even when the CLI emitted a human-facing
  // directive ("No high-confidence edit target recovered…") as the context body:
  // a skip injects no oriented context. Checked before the context test so the
  // skip directive is never mistaken for a real treatment.
  if (recommendedMode === "skip" || actualMode === "skip") {
    return skipClassification(reason, recommendedMode, actualMode, pivotCount, supportCount, searchBudget, searchBudgetReason);
  }

  // Real context present → inject it.
  if (context.length > 0) {
    return injectClassification(context, recommendedMode, actualMode, pivotCount, supportCount, searchBudget, searchBudgetReason);
  }

  // Empty context with no skip mode: a deliberate skip iff pivot_count 0 + reason.
  if (pivotCount === 0 && reason !== null) {
    return skipClassification(reason, recommendedMode, actualMode, pivotCount, supportCount, searchBudget, searchBudgetReason);
  }

  // Empty context with no skip signal: a genuine failure — fail fast.
  return errorClassification("vtrace query returned empty context.");
}

function skipClassification(
  reason: string | null,
  recommendedMode: string | null,
  actualMode: string | null,
  pivotCount: number | null,
  supportCount: number | null,
  searchBudget: string | null = "high",
  searchBudgetReason: string | null = null,
  v2: CapsuleV2Audit | null = null,
): CapsuleClassification {
  return {
    policyAction: "skip",
    contextInjected: false,
    context: "",
    skipReason: reason ?? "no high-confidence actionable target recovered",
    recommendedMode,
    actualCapsuleMode: actualMode ?? "skip",
    pivotCount: pivotCount ?? 0,
    supportCount: supportCount ?? 0,
    searchBudget,
    searchBudgetReason,
    capsulePivots: v2?.pivots ?? null,
    capsuleSupport: v2?.support ?? null,
    capsuleEstimatedTokens: v2?.estimatedTokens ?? null,
    capsuleTopPivotHasSource: v2?.topPivotSource.hasSource ?? false,
    capsuleTopPivotSourceChars: v2?.topPivotSource.chars ?? null,
    capsuleTopPivotSourceMode: v2?.topPivotSource.mode ?? "missing",
    capsuleEditRiskDirectivesCount: v2?.editRiskDirectivesCount ?? 0,
    capsuleLineAnchorResolutionUsed: v2?.lineAnchorResolutionUsed ?? false,
    capsuleSqlRenderingBackfillUsed: v2?.sqlRenderingBackfillUsed ?? false,
    capsuleV2Result: v2?.result ?? null,
    error: null,
  };
}

function injectClassification(
  context: string,
  recommendedMode: string | null,
  actualMode: string | null,
  pivotCount: number | null,
  supportCount: number | null,
  searchBudget: string | null = null,
  searchBudgetReason: string | null = null,
  v2: CapsuleV2Audit | null = null,
): CapsuleClassification {
  return {
    policyAction: "inject",
    contextInjected: true,
    context,
    skipReason: null,
    recommendedMode,
    actualCapsuleMode: actualMode,
    pivotCount,
    supportCount,
    searchBudget,
    searchBudgetReason,
    capsulePivots: v2?.pivots ?? null,
    capsuleSupport: v2?.support ?? null,
    capsuleEstimatedTokens: v2?.estimatedTokens ?? null,
    capsuleTopPivotHasSource: v2?.topPivotSource.hasSource ?? false,
    capsuleTopPivotSourceChars: v2?.topPivotSource.chars ?? null,
    capsuleTopPivotSourceMode: v2?.topPivotSource.mode ?? "missing",
    capsuleEditRiskDirectivesCount: v2?.editRiskDirectivesCount ?? 0,
    capsuleLineAnchorResolutionUsed: v2?.lineAnchorResolutionUsed ?? false,
    capsuleSqlRenderingBackfillUsed: v2?.sqlRenderingBackfillUsed ?? false,
    capsuleV2Result: v2?.result ?? null,
    error: null,
  };
}

function errorClassification(message: string): CapsuleClassification {
  return {
    policyAction: "error",
    contextInjected: false,
    context: "",
    skipReason: null,
    recommendedMode: null,
    actualCapsuleMode: null,
    pivotCount: null,
    supportCount: null,
    searchBudget: null,
    searchBudgetReason: null,
    capsulePivots: null,
    capsuleSupport: null,
    capsuleEstimatedTokens: null,
    capsuleTopPivotHasSource: false,
    capsuleTopPivotSourceChars: null,
    capsuleTopPivotSourceMode: "missing",
    capsuleEditRiskDirectivesCount: 0,
    capsuleLineAnchorResolutionUsed: false,
    capsuleSqlRenderingBackfillUsed: false,
    capsuleV2Result: null,
    error: message,
  };
}

// Classify a Capsule v2 result. v2 carries no rendered `context` string — the
// injectable text is produced from the result via the product's human renderer,
// so the agent sees exactly the Capsule v2 the CLI would print. A `no_context`
// actual_mode is a valid SKIP policy (the cost-aware gate's no_context analogue),
// never an error. Pivot/support counts come from the v2 diagnostics.
export function classifyCapsuleV2Output(result: CapsuleV2Result): CapsuleClassification {
  // Read defensively as an untyped record: the diagnostics surface is optional and
  // partial JSON must degrade to 0/false rather than throw (the guards below narrow).
  const diagnostics: Record<string, unknown> = isRecord(result.diagnostics) ? result.diagnostics : {};
  const pivots = toCapsuleAuditItems(result.pivots);
  const support = toCapsuleAuditItems(result.support);
  const pivotCount = isNumber(diagnostics.pivot_count) ? diagnostics.pivot_count : pivots.length;
  const supportCount = isNumber(diagnostics.support_count) ? diagnostics.support_count : support.length;
  const actualMode = isString(result.actual_mode) ? result.actual_mode : null;
  const estimatedTokens =
    isRecord(result.budget) && isNumber(result.budget.estimated_tokens) ? result.budget.estimated_tokens : null;
  // The lead pivot's focused source body (when the capsule rendered one). This is
  // the audit that proves the agent received enough to reason about the edit, not
  // just the pivot's path/symbol/reason.
  const topPivotSource = classifyPivotSource(Array.isArray(result.pivots) ? result.pivots[0] : undefined);
  // Policy-relevant v2 diagnostics: the edit-risk directive count, and whether the
  // line-anchor / SQL-rendering recovery routes fired. Read defensively from the
  // raw diagnostics so partial JSON degrades to 0/false rather than throwing.
  const editRiskDirectivesCount = Array.isArray(diagnostics.edit_risk_directives)
    ? diagnostics.edit_risk_directives.length
    : 0;
  const lineAnchorResolutionUsed = diagnostics.line_anchor_resolution_used === true;
  const sqlRenderingBackfillUsed = diagnostics.sql_rendering_backfill_used === true;
  const v2: CapsuleV2Audit = {
    pivots,
    support,
    estimatedTokens,
    topPivotSource,
    editRiskDirectivesCount,
    lineAnchorResolutionUsed,
    sqlRenderingBackfillUsed,
    result,
  };

  // No pivot recovered → a valid no-context skip (recorded as actual_mode
  // "no_context", surfaced through the same skip machinery as the legacy path).
  if (result.actual_mode === CapsuleV2Mode.NoContext) {
    // v2 does not emit a search_budget; leave it unset rather than guessing.
    return skipClassification(result.reason ?? null, null, actualMode, pivotCount, supportCount, null, null, v2);
  }

  // Append the bounded pivot-neighborhood block when the capsule CLI emitted one
  // (the `--pivot-neighborhood` opt-in the Stage 5 v2 query passes). This is the
  // ONLY way the neighborhood excerpts reach the agent — the injected context is
  // re-rendered here from the capsule result, not from run_pipeline.
  const neighborhood = readPivotNeighborhood(result);
  // Compact, action-oriented guidance at the TOP of the injected context: the
  // single most likely first file + at most two related items + one avoid-first
  // hint. Guidance only (no checklist, no gate); built from the already-assembled
  // v2 product response + neighborhood, never failing the run.
  const inspectFirstText = renderInspectFirstText(
    buildInspectFirst(toCapsuleV2ProductResponse(result), neighborhood),
  );
  const neighborhoodText = renderPivotNeighborhoodsText(neighborhood);
  const rendered = renderCapsuleV2Human(result).trim();
  const context = [inspectFirstText, rendered, neighborhoodText]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (context.length === 0) {
    return errorClassification("Capsule v2 returned no renderable context.");
  }
  return injectClassification(context, null, actualMode, pivotCount, supportCount, null, null, v2);
}

// Defensively read the optional `pivot_neighborhood` array the capsule CLI
// attaches under `--pivot-neighborhood`. The core CapsuleV2Result type does not
// carry it, so read it as an untyped record; a missing/malformed value degrades
// to an empty list (no neighborhood block injected).
function readPivotNeighborhood(result: CapsuleV2Result): PivotNeighborhoodContext[] {
  const raw = (result as unknown as Record<string, unknown>).pivot_neighborhood;
  return Array.isArray(raw) ? (raw as PivotNeighborhoodContext[]) : [];
}

// Total pivot-neighborhood excerpts carried by a classification's Capsule v2
// result (0 on the legacy engine, on a pre-neighborhood result, or when the
// `--pivot-neighborhood` opt-in was not used). Used as a PIVOT_CHECK trigger:
// neighborhood excerpts are context the agent must account for even for a
// single-pivot capsule.
function neighborhoodExcerptCountOf(classification: CapsuleClassification | null): number {
  const result = classification?.capsuleV2Result ?? null;
  if (result === null) return 0;
  return readPivotNeighborhood(result).reduce(
    (sum, context) => sum + (Array.isArray(context.excerpts) ? context.excerpts.length : 0),
    0,
  );
}

// Reduce Capsule v2 items to the audit-relevant fields, tolerating partially
// shaped JSON (a missing path/symbol degrades to "" rather than throwing).
function toCapsuleAuditItems(items: unknown): CapsuleAuditItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const item = isRecord(raw) ? raw : {};
    return {
      path: isString(item.path) ? item.path : "",
      symbol: isString(item.symbol) ? item.symbol : "",
      roleReason: isString(item.role_reason) ? item.role_reason : null,
      estimatedTokens: isNumber(item.estimated_tokens) ? item.estimated_tokens : null,
    };
  });
}

// Build the vtrace query string from an instance. Rather than dumping the whole
// problem statement, shape it into a compact, signal-first query (failing tests,
// explicit files/symbols, a short issue lead) via the shared shaping helper. The
// instance id is prepended so multi-instance context stays attributable.
export function buildInstanceQuery(instance: SweBenchInstance): string {
  const shaped = shapeSweQuery(instance, { maxQueryChars: MAX_VTRACE_QUERY_CHARS });
  const header = `instance: ${instance.instanceId}`;
  const query = shaped.query.length > 0 ? `${header}\n${shaped.query}` : header;
  return query.length > MAX_VTRACE_QUERY_CHARS ? query.slice(0, MAX_VTRACE_QUERY_CHARS) : query;
}

// Capsule v2 reads the raw task, not a packed retrieval query. Build a clean,
// human task description from the instance fields the planner uses: the issue
// text plus the repo / failing tests / hints that help intent detection. We do
// NOT include any evaluation labels (resolved/gold patch/condition) — only what
// a developer reading the issue would have.
export function buildCapsuleV2Task(instance: SweBenchInstance): string {
  const parts: string[] = [`instance: ${instance.instanceId}`, `repo: ${instance.repo}`];
  const problem = instance.problemStatement.trim();
  if (problem.length > 0) parts.push("", problem);
  if (instance.failToPass.length > 0) parts.push("", `failing tests: ${instance.failToPass.join(", ")}`);
  const hints = instance.hintsText?.trim() ?? "";
  if (hints.length > 0) parts.push("", `hints: ${hints}`);
  const task = parts.join("\n");
  return task.length > MAX_VTRACE_QUERY_CHARS ? task.slice(0, MAX_VTRACE_QUERY_CHARS) : task;
}

// The task/query text for the configured capsule engine: v2 gets the clean task,
// legacy gets the packed retrieval query.
export function capsuleQueryTextFor(config: CliConfig, instance: SweBenchInstance): string {
  return config.capsuleEngine === "v2" ? buildCapsuleV2Task(instance) : buildInstanceQuery(instance);
}

// Recommend a capsule mode for an instance from its shaped signals. Diagnostic
// first: navigation-heavy issues get `full`, small/local edits get `micro`.
export function recommendedCapsuleModeFor(instance: SweBenchInstance): RecommendedCapsuleModeT {
  const shaped = shapeSweQuery(instance);
  return recommendCapsuleMode(deriveModeSignals(instance, shaped)).recommendedMode;
}

// Map a recommendation onto a concrete capsule CLI mode. `skip` has no CLI
// equivalent, so it degrades to `micro` (the smallest real envelope).
export function capsuleModeForInstance(instance: SweBenchInstance): CapsuleModeT {
  const recommended = recommendedCapsuleModeFor(instance);
  return recommended === RecommendedCapsuleMode.Skip ? CapsuleMode.Micro : recommended;
}

// ---------------------------------------------------------------------------
// Cost-aware context-injection gate
// ---------------------------------------------------------------------------
//
// Stage 5C showed that vtrace helps large/navigation-heavy tasks but HURTS
// small/local tasks: even action-oriented micro context is net overhead when
// baseline Claude already solves the task cheaply. The gate below decides,
// BEFORE the agent prompt is modified, whether the expected value of injected
// context exceeds its overhead. When it does not, vtrace deliberately injects
// nothing (a valid no-context policy), instead of paying for context that does
// not earn its keep. This is product behaviour, not benchmark gaming.
export type ContextPolicyAction = "inject" | "no_context";
export type ExpectedLevel = "low" | "medium" | "high";

// Operator override for the cost-aware gate, set via --context-policy. `auto`
// (the default) runs decideContextPolicy unchanged. `force-inject` and
// `force-no-context` exist for Capsule v2 live validation: they let a run
// exercise the actual capsule retrieval instead of letting the cost-aware gate
// silently choose no_context (or, conversely, force a no-context baseline).
export type ContextPolicyOverride = "auto" | "force-inject" | "force-no-context";

// Recorded as vtrace_policy_reason when an override (not the cost-aware gate)
// determined the action, so the report says plainly why context was/ wasn't
// injected.
const FORCE_INJECT_REASON = "context policy forced to inject for validation";
const FORCE_NO_CONTEXT_REASON = "context policy forced to no_context for validation";

// Task-shape signals derived from the SWE instance (independent of what the
// capsule retrieved). These describe how "cheap/local" vs "navigation-heavy"
// the task looks before any context is produced.
export interface ContextPolicySignals {
  readonly failingTestCount: number;
  readonly problemStatementLength: number;
  readonly crossModule: boolean;
  readonly touchesComplexInternals: boolean;
  readonly likelyFileCount: number;
  readonly likelySymbolCount: number;
  readonly hasExplicitTargets: boolean;
  readonly recommendedMode: RecommendedCapsuleModeT;
  readonly targetConfidence: TargetConfidenceT;
}

// What the capsule actually retrieved — the evidence side of the trade-off. A
// strong pivot count is what turns a navigation-heavy task from "speculative"
// into "worth the overhead".
export interface CapsulePolicyDiagnostics {
  readonly capsuleAction: VtracePolicyAction;
  readonly hasContext: boolean;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  readonly actualMode: string | null;
}

export interface ContextPolicyDecision {
  readonly action: ContextPolicyAction;
  readonly reason: string;
  readonly expectedContextValue: ExpectedLevel;
  readonly expectedOverheadRisk: ExpectedLevel;
  // The named signals that fired for this decision (e.g. "edit_risk_directive_present",
  // "internal_subsystem_navigation", "micro_capsule"). Recorded so a decision is
  // auditable down to the exact evidence — never just an opaque action+reason.
  // Empty when the decider computed no named signals (the legacy gate).
  readonly decisionSignals: readonly string[];
  // The issue-localization evidence the conservative skip weighed (M7). Present on
  // Capsule v2 auto decisions; omitted by the legacy gate / overrides.
  readonly localizationSignals?: LocalizationSignals;
  // The vtrace-advantage signals that justified injecting OVER an already-localized
  // task (actionability hint, hidden pivot, multi-candidate). Empty/omitted when no
  // advantage was needed or the task was not localized.
  readonly vtraceAdvantageSignals?: readonly string[];
}

// A short problem statement is one cheap/local signal (mirrors the capsule
// recommender's SHORT_ISSUE_CHARS threshold).
const SHORT_PROBLEM_CHARS = 600;

// Derive the gate's task-shape signals from an instance, reusing the same
// shaping + mode recommendation the capsule itself runs on, so the gate and the
// capsule never disagree about what the task looks like.
export function deriveContextPolicySignals(instance: SweBenchInstance): ContextPolicySignals {
  const shaped = shapeSweQuery(instance);
  const signals = deriveModeSignals(instance, shaped);
  const recommendation = recommendCapsuleMode(signals);
  return {
    failingTestCount: signals.failingTestCount,
    problemStatementLength: signals.problemStatementLength,
    crossModule: signals.crossModule,
    touchesComplexInternals: signals.touchesComplexInternals,
    likelyFileCount: signals.likelyFileCount,
    likelySymbolCount: signals.likelySymbolCount,
    hasExplicitTargets: signals.hasExplicitTargets,
    recommendedMode: recommendation.recommendedMode,
    targetConfidence: recommendation.targetConfidence,
  };
}

// The cost-aware injection gate. Returns `inject` only when the expected value
// of oriented context plausibly exceeds the overhead of injecting it.
//
//  - no_context when the capsule recovered nothing actionable (low value).
//  - no_context for cheap/local tasks (one failing test, short problem, no
//    cross-module signal, micro capsule, no high-confidence test→impl edge):
//    baseline solves these cheaply, so context is pure overhead.
//  - inject for navigation-heavy tasks, but CONSERVATIVELY — only when the
//    capsule produced real pivot evidence; weak evidence on a big task is not
//    worth the overhead.
//  - inject for moderate tasks that retrieved real context.
export function decideContextPolicy(
  signals: ContextPolicySignals,
  capsule: CapsulePolicyDiagnostics,
): ContextPolicyDecision {
  // 1. The capsule itself recovered no high-confidence target → nothing to inject.
  if (capsule.capsuleAction === "skip" || !capsule.hasContext) {
    return {
      action: "no_context",
      reason: "Capsule recovered no high-confidence target; nothing actionable to inject.",
      expectedContextValue: "low",
      expectedOverheadRisk: "low",
      decisionSignals: ["capsule_no_context"],
    };
  }

  const strongPivot = (capsule.pivotCount ?? 0) >= 1;
  const microCapsule =
    signals.recommendedMode === RecommendedCapsuleMode.Micro
    || signals.recommendedMode === RecommendedCapsuleMode.Skip;
  const navigationHeavy =
    signals.recommendedMode === RecommendedCapsuleMode.Full
    || signals.touchesComplexInternals
    || signals.crossModule
    || signals.likelyFileCount >= 2;
  // A high-confidence DIRECT test→implementation edge: the capsule pinned a
  // confident pivot ON A TASK THAT ACTUALLY SPANS IMPLEMENTATION STRUCTURE.
  // Crucially this is NOT the recommender's issue-text `targetConfidence` alone
  // (a short issue naming three symbols reads "high" but is still a local edit);
  // it requires the task to be navigation-heavy AND the capsule to back it with
  // a real pivot. Cheap/local micro tasks never have one.
  const highConfidenceDirectEdge =
    navigationHeavy && strongPivot && signals.targetConfidence === TargetConfidence.High;

  // 2. Cheap/local task: one failing test, short problem statement, low
  //    cross-module signal, the capsule would be micro, and there is no
  //    high-confidence direct test→implementation edge — so likely baseline
  //    search/edit cost is low and injected context is net overhead.
  const cheapLocal =
    signals.failingTestCount <= 1
    && signals.problemStatementLength < SHORT_PROBLEM_CHARS
    && !signals.crossModule
    && !signals.touchesComplexInternals
    && microCapsule
    && !highConfidenceDirectEdge;
  if (cheapLocal) {
    return {
      action: "no_context",
      reason:
        "Cheap/local task: one failing test, short problem statement, low cross-module signal, micro capsule, "
        + "and no high-confidence test-to-implementation edge — injected context is likely net overhead.",
      expectedContextValue: "low",
      expectedOverheadRisk: "high",
      decisionSignals: ["cheap_local", "micro_capsule"],
    };
  }

  // 3. Navigation-heavy task: inject only with strong pivot evidence; otherwise
  //    stay conservative (the Stage 5 11740 lesson).
  if (navigationHeavy) {
    return strongPivot
      ? {
          action: "inject",
          reason: "Navigation-heavy task with strong pivot evidence; oriented context is expected to pay off.",
          expectedContextValue: "high",
          expectedOverheadRisk: "low",
          decisionSignals: ["navigation_heavy", "strong_pivot"],
        }
      : {
          action: "no_context",
          reason:
            "Navigation-heavy task but capsule pivot evidence is weak; injecting risks overhead without payoff.",
          expectedContextValue: "low",
          expectedOverheadRisk: "medium",
          decisionSignals: ["navigation_heavy", "weak_pivot"],
        };
  }

  // 4. Moderate task that retrieved real context → worth a standard injection.
  return {
    action: "inject",
    reason: "Moderate task with retrieved context and no strong cheap/local signal; a standard capsule is worthwhile.",
    expectedContextValue: "medium",
    expectedOverheadRisk: "medium",
    decisionSignals: ["moderate_task", "retrieved_context"],
  };
}

// ---------------------------------------------------------------------------
// Capsule v2 cost-aware context policy
// ---------------------------------------------------------------------------
//
// Capsule v2 emits richer diagnostics than the legacy capsule: it reports WHY
// the pivot is risky to edit blind (an edit-risk directive), whether an explicit
// source anchor or SQL-rendering backfill recovered the true edit site, and how
// much focused source it injected. The Stage 5 five-task force-inject validation
// gave us per-task ground truth on whether injection actually paid off:
//
//   * 11490 (compiler.get_combinator_sql): edit-risk directive + line-anchor +
//     SQL-rendering backfill, +76.6% tokens — context prevents a wrong local edit.
//   * 11728 (admindocs regex parser), 11740 (migrations autodetector): internal-
//     subsystem navigation with a real focused pivot body, +47% / +70.8% tokens.
//   * 11095 (ModelAdmin.get_inlines hook): a small/local additive API hook,
//     -20.7% tokens — injection was pure overhead.
//   * 10880 (aggregation Count+distinct): micro/local, only +10.9% tokens — within
//     noise, not worth guaranteed injection overhead across the cheap/local class.
//
// The policy below generalises that ground truth into SIGNALS (never instance
// ids): inject when the capsule's own evidence says context prevents a wrong edit
// or the task is internal-subsystem navigation with a real pivot body; prefer
// no_context when the task is a small/local edit a baseline agent solves cheaply.

// Capsule v2 evidence side of the decision — the diagnostics the v2 engine
// produces beyond pivot/support counts. Built from the per-section classification.
export interface CapsuleV2PolicyDiagnostics {
  readonly capsuleAction: VtracePolicyAction;
  readonly hasContext: boolean;
  /** Realised sizing tier: micro | standard | full | no_context. */
  readonly actualMode: string | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  /** The lead pivot carried a focused source body (the agent's edit target). */
  readonly topPivotHasSource: boolean;
  readonly topPivotSourceChars: number | null;
  /** How many edit-risk / patch-planning directives fired (guarded mutation, etc.). */
  readonly editRiskDirectiveCount: number;
  /** A task source anchor (file#Lx-Ly) resolved to a symbol that became a pivot. */
  readonly lineAnchorResolutionUsed: boolean;
  /** A SQL-rendering backfill recovered compiler/renderer candidates. */
  readonly sqlRenderingBackfillUsed: boolean;
  // --- M7 conservative-localization inputs (all optional; default to no-skip) ---
  /** Generated/co-edit actionability obligations the capsule attached (inject win). */
  readonly actionabilityHintCount?: number;
  /** The lead pivot's file path — compared against issue-localized files. */
  readonly topPivotPath?: string | null;
  /** How strongly the issue text already localizes the edit site (resolved). */
  readonly localization?: LocalizationSignals;
}

// A focused source body of at least this many chars is "meaningful" — enough that
// re-deriving it via blind agent search is real cost the capsule can save. 10880's
// 410-char pivot sits below this; the injecting tasks all clear it comfortably.
const MEANINGFUL_PIVOT_SOURCE_CHARS = 800;

// Decide the context policy for a Capsule v2 section. Same shape as
// decideContextPolicy, but driven by Capsule v2's richer evidence. Returns the
// named signals that fired so the decision is fully auditable.
/** Options for the v2 context-policy gate. */
export interface ContextPolicyOptions {
  /**
   * Enable the M7 conservative traceback-localized `inject -> no_context`
   * downgrade. DISABLED BY DEFAULT (M7.3): the clean-Docker M6 re-baseline
   * (`stage5_m7_clean_docker_rebaseline.md`) showed the downgrade fires on
   * exactly the two cases whose original "regression" was Docker contamination
   * (sympy-13372, xarray-3677) -- corrected, both are useful injections, so the
   * downgrade removed useful context with no resolution gain. The localization
   * detector + diagnostics are retained; only the skip ACTION is gated off.
   * Re-enable explicitly via this option or
   * `VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP=1`.
   */
  enableTracebackLocalizedSkip?: boolean;
}

export function decideCapsuleV2ContextPolicy(
  signals: ContextPolicySignals,
  capsule: CapsuleV2PolicyDiagnostics,
  options: ContextPolicyOptions = {},
): ContextPolicyDecision {
  // 1. The capsule recovered nothing actionable (no pivot / no_context mode) →
  //    there is no context to inject; declining is free.
  if (capsule.capsuleAction === "skip" || !capsule.hasContext || capsule.actualMode === "no_context") {
    return {
      action: "no_context",
      reason: "Capsule v2 recovered no high-confidence pivot; nothing actionable to inject.",
      expectedContextValue: "low",
      expectedOverheadRisk: "low",
      decisionSignals: ["capsule_no_context"],
    };
  }

  // The inject-positive evidence. `navigationHeavy` reuses the same task-shape
  // signals the capsule itself sizes from, so the gate and capsule never disagree.
  const editRisk = capsule.editRiskDirectiveCount > 0;
  const lineAnchorWithSource = capsule.lineAnchorResolutionUsed && capsule.topPivotHasSource;
  const sqlBackfill = capsule.sqlRenderingBackfillUsed;
  const navigationHeavy =
    signals.recommendedMode === RecommendedCapsuleMode.Full
    || signals.touchesComplexInternals
    || signals.crossModule
    || signals.likelyFileCount >= 2;
  const meaningfulSource =
    capsule.topPivotHasSource && (capsule.topPivotSourceChars ?? 0) >= MEANINGFUL_PIVOT_SOURCE_CHARS;
  // Internal-subsystem navigation WITH a real focused pivot body: a
  // compiler/parser/migrations/SQL/autodetector task where the capsule pinned the
  // implementation site and injected its source — re-deriving that by blind search
  // is exactly the cost vtrace removes (the 11728 / 11740 lesson).
  const internalSubsystemNav = signals.touchesComplexInternals && navigationHeavy && capsule.topPivotHasSource;
  // A broader navigation-heavy task that still carries a meaningful pivot body.
  const navHeavyWithSource = navigationHeavy && meaningfulSource;
  const strongCapsuleEvidence =
    editRisk || lineAnchorWithSource || sqlBackfill || internalSubsystemNav || navHeavyWithSource;

  // M7 vtrace-advantage signals — the evidence that injecting STILL pays off even
  // when the issue text already localizes the edit site. Derived from the issue's
  // localization confidence (resolved against the index, never gold) and the
  // capsule's own selection.
  const localization = capsule.localization;
  const strongLocalization = localization?.confidence === "strong";
  // Whether the lead pivot is a file the issue itself already names. When it is,
  // injecting only re-surfaces what a baseline agent localizes for free.
  const topPivotUserLocalized =
    localization !== undefined && pathIsUserLocalized(capsule.topPivotPath, localization.resolvedFiles);
  const actionabilityHintCount = capsule.actionabilityHintCount ?? 0;
  const actionabilityAdvantage = actionabilityHintCount > 0;
  // A hidden pivot: the issue strongly localizes elsewhere, yet the capsule's lead
  // edit site (with a real source body) is NOT a file the issue named — vtrace
  // surfaced a site the agent would not reach from the issue text alone.
  const hiddenPivotAdvantage =
    strongLocalization && capsule.topPivotHasSource && !topPivotUserLocalized;

  // The advantage signals that justify injecting OVER an already-localized task.
  // These BLOCK the conservative localization downgrade below — they are recorded
  // even when no downgrade was at stake, so a decision is auditable to its evidence.
  const advantageSignals: string[] = [];
  if (actionabilityAdvantage) advantageSignals.push("inject_actionability_hint");
  if (hiddenPivotAdvantage) advantageSignals.push("inject_hidden_pivot");
  if (editRisk || lineAnchorWithSource || sqlBackfill) advantageSignals.push("inject_edit_changing_evidence");

  const fired: string[] = [];
  if (editRisk) fired.push("edit_risk_directive_present");
  if (capsule.lineAnchorResolutionUsed) fired.push("line_anchor_resolution_used");
  if (lineAnchorWithSource) fired.push("line_anchor_with_pivot_source");
  if (sqlBackfill) fired.push("sql_rendering_backfill_used");
  if (signals.touchesComplexInternals) fired.push("internal_subsystem_task");
  if (navigationHeavy) fired.push("navigation_heavy");
  if (internalSubsystemNav) fired.push("internal_subsystem_navigation");
  if (capsule.topPivotHasSource) fired.push("top_pivot_has_source");
  if (meaningfulSource) fired.push("meaningful_pivot_source");
  if ((capsule.supportCount ?? 0) > 0) fired.push("support_present");
  if (localization !== undefined) fired.push(`localization_${localization.confidence}`);
  if (topPivotUserLocalized) fired.push("top_pivot_user_localized");
  if (actionabilityAdvantage) fired.push("actionability_hint_present");
  if (hiddenPivotAdvantage) fired.push("hidden_pivot_advantage");

  // M7 conservative localization downgrade. An inject-bound decision is turned to
  // no_context ONLY when the issue text TRACEBACK-localizes the edit site (a
  // `File "...", line N, in symbol` frame whose path resolves AND the capsule's lead
  // pivot is that named file), with NO vtrace advantage that changes the edit
  // itself: no actionability obligation, no hidden pivot, no edit-risk / line-anchor
  // / SQL-rendering evidence. A stack trace pointing at the lead edit site is the
  // strongest "a baseline agent localizes this for free" signal, so injecting
  // oriented context is the M6 inject-without-benefit overhead.
  //
  // Restricted to the TRACEBACK channel on purpose: M6 showed file-/symbol-named
  // localization does NOT separate inject-without-benefit cases (requests-5414,
  // astropy-14539) from genuine wins (matplotlib-25960, django-11728) on the
  // localization signal alone — so downgrading those would risk dropping useful
  // context. The downgrade is purely SUBTRACTIVE (only inject→no_context, never the
  // reverse), so it can never weaken an existing no_context / safe-skip decision.
  // A traceback-localized skip CANDIDATE: the conditions under which the M7
  // downgrade WOULD fire. Recorded as telemetry (decisionSignals) regardless of
  // whether the skip is enabled, so future policy work can see where a skip was
  // available without the gate having to act on it.
  const localizationSkipCandidate =
    strongLocalization
    && localization?.kind === "traceback"
    && topPivotUserLocalized
    && !actionabilityAdvantage
    && !editRisk
    && !lineAnchorWithSource
    && !sqlBackfill;
  if (localizationSkipCandidate) fired.push("traceback_localized_skip_candidate");
  // M7.3: the downgrade is DISABLED BY DEFAULT (see ContextPolicyOptions). It
  // only acts when explicitly enabled via the option or
  // VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP=1. Corrected clean-Docker M6 evidence
  // showed the skip removed useful injection (sympy-13372, xarray-3677) with no
  // resolution gain, so the lead-pivot traceback signal alone is not a safe skip.
  const tracebackLocalizedSkipEnabled =
    options.enableTracebackLocalizedSkip
    ?? process.env.VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP === "1";
  const localizationDowngrade = localizationSkipCandidate && tracebackLocalizedSkipEnabled;

  // Apply the downgrade to an inject decision (and ONLY an inject decision).
  const guardInject = (decision: ContextPolicyDecision): ContextPolicyDecision => {
    if (!localizationDowngrade) return decision;
    return {
      action: "no_context",
      reason:
        "Issue traceback-localizes the edit site (a resolved `File \"...\", in symbol` frame whose lead "
        + "pivot the issue already names) with no actionability / hidden-pivot / edit-changing advantage; "
        + "a baseline agent localizes it for free, so injected context is net overhead.",
      expectedContextValue: "low",
      expectedOverheadRisk: "high",
      decisionSignals: [...decision.decisionSignals, "skip_traceback_localized"],
      localizationSignals: localization,
      vtraceAdvantageSignals: [],
    };
  };

  // 2. Strong inject evidence: the capsule's own diagnostics say context prevents a
  //    wrong edit (edit-risk / line-anchor / SQL backfill), or the task is internal-
  //    subsystem navigation / navigation-heavy with a real pivot body. Subject to
  //    the conservative localization downgrade above.
  if (strongCapsuleEvidence) {
    const drivers = [
      editRisk ? "edit-risk directive" : null,
      lineAnchorWithSource ? "line-anchor resolution" : null,
      sqlBackfill ? "SQL-rendering backfill" : null,
      internalSubsystemNav ? "internal-subsystem navigation" : null,
      navHeavyWithSource && !internalSubsystemNav ? "navigation-heavy task" : null,
    ].filter((d): d is string => d !== null);
    return guardInject({
      action: "inject",
      reason:
        `High-value context: ${drivers.join(" + ")} with a focused pivot source; `
        + "injecting orients the agent and prevents a wrong local edit.",
      expectedContextValue: "high",
      expectedOverheadRisk: "low",
      decisionSignals: fired,
      localizationSignals: localization,
      vtraceAdvantageSignals: advantageSignals,
    });
  }

  // 3. Cheap/local task: a micro capsule on a non-internal, non-cross-module task
  //    with no edit-risk / line-anchor / SQL evidence and no navigation-heavy
  //    shape — a small/local edit (e.g. a narrow additive API hook) a baseline
  //    agent solves cheaply, where injected context is likely net overhead. The
  //    force-inject evidence (11095 −20.7%, 10880 +10.9% ≈ noise) backs declining.
  const microCapsule =
    signals.recommendedMode === RecommendedCapsuleMode.Micro
    || signals.recommendedMode === RecommendedCapsuleMode.Skip;
  const cheapLocal =
    microCapsule
    && !signals.touchesComplexInternals
    && !signals.crossModule
    && signals.likelyFileCount < 2
    && !editRisk
    && !capsule.lineAnchorResolutionUsed
    && !sqlBackfill
    && !navigationHeavy;
  if (cheapLocal) {
    fired.push(
      "micro_capsule",
      "not_internal_subsystem",
      "no_edit_risk_directive",
      "no_line_anchor",
      "no_sql_rendering_backfill",
    );
    return {
      action: "no_context",
      reason:
        "Small/local task with an obvious narrow target (micro capsule, not an internal subsystem, no "
        + "edit-risk / line-anchor / SQL-rendering evidence); a baseline agent solves it cheaply, so injected "
        + "context is likely net overhead — caution outweighs the marginal force-inject benefit.",
      expectedContextValue: "low",
      expectedOverheadRisk: "high",
      decisionSignals: fired,
      localizationSignals: localization,
      vtraceAdvantageSignals: advantageSignals,
    };
  }

  // 4. Moderate task that retrieved real context but lacks both strong inject
  //    evidence and a clear cheap/local shape → a standard injection is worthwhile.
  //    Subject to the same conservative localization downgrade.
  fired.push("moderate_task", "retrieved_context");
  return guardInject({
    action: "inject",
    reason:
      "Moderate task with retrieved context and no strong cheap/local signal; a standard Capsule v2 is worthwhile.",
    expectedContextValue: "medium",
    expectedOverheadRisk: "medium",
    decisionSignals: fired,
    localizationSignals: localization,
    vtraceAdvantageSignals: advantageSignals,
  });
}

// Apply the operator's --context-policy override to a per-section gate decision.
//
//  - auto: the cost-aware gate's decision stands.
//  - force-inject: inject the generated context regardless of the gate, so a run
//    actually exercises Capsule v2 retrieval. With NO context to inject the gate
//    decision is left untouched — there is nothing to force, and the run-level
//    logic still treats the absence of context as a failure (never a valid skip).
//  - force-no-context: always run no-context, regardless of what was retrieved.
//
// The expected value/overhead levels are preserved from the gate so the report
// still shows what the cost-aware model thought, alongside the override.
export function applyContextPolicyOverride(
  decision: ContextPolicyDecision,
  override: ContextPolicyOverride,
  hasContext: boolean,
): ContextPolicyDecision {
  if (override === "force-inject") {
    if (!hasContext) return decision;
    return {
      action: "inject",
      reason: FORCE_INJECT_REASON,
      expectedContextValue: decision.expectedContextValue,
      expectedOverheadRisk: decision.expectedOverheadRisk,
      decisionSignals: decision.decisionSignals,
    };
  }
  if (override === "force-no-context") {
    return {
      action: "no_context",
      reason: FORCE_NO_CONTEXT_REASON,
      expectedContextValue: decision.expectedContextValue,
      expectedOverheadRisk: decision.expectedOverheadRisk,
      decisionSignals: decision.decisionSignals,
    };
  }
  return decision;
}

// Truncate one instance's raw vtrace context by item count (non-empty lines) then
// by character budget, appending a clear marker when the char budget bites.
export function truncateContext(
  raw: string,
  maxChars: number,
  maxItems: number,
): { text: string; chars: number; items: number; truncated: boolean } {
  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  let truncated = false;
  let kept = lines;
  let items = nonEmpty.length;
  if (nonEmpty.length > maxItems) {
    // Keep lines up to and including the maxItems-th non-empty line.
    let seen = 0;
    const limited: string[] = [];
    for (const line of lines) {
      if (line.trim().length > 0) {
        if (seen >= maxItems) break;
        seen += 1;
      }
      limited.push(line);
    }
    kept = limited;
    items = maxItems;
    truncated = true;
  }
  let text = kept.join("\n").trimEnd();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[truncated to ${maxChars} chars]`;
    truncated = true;
  }
  return { text, chars: text.length, items, truncated };
}

export interface VtraceContextSection {
  readonly instance: SweBenchInstance;
  readonly rawContext: string;
  readonly error: string | null;
  /** The capsule policy classification for this instance (null on a hard error). */
  readonly classification: CapsuleClassification | null;
  // True when the context is already budget-shaped by the producer (Capsule v2
  // sizes its render to --budget). Such context is NOT line-item truncated — the
  // per-item line cap would decapitate a multi-line focused source body — only a
  // char-cap safety net applies. Legacy/undefined sections keep line truncation.
  readonly preformatted?: boolean;
  // Engine migration audit: the requested engine (config default is v2) and the
  // engine that EFFECTIVELY produced this section's context after any v2 → legacy
  // fallback, plus the fallback reason. Absent/legacy on older callers.
  readonly requestedEngine?: CapsuleEngine;
  readonly effectiveEngine?: CapsuleEngine;
  readonly engineFallbackReason?: string | null;
}

// Raised when a capsule query for a specific engine fails (non-zero exit or an
// unusable/empty classification). Distinct from workspace/index-prep failures so
// the v2 → legacy fallback only triggers on a genuine engine-query failure, never
// masking a clone/index error.
class EngineQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineQueryError";
  }
}

// Assemble the full _vtrace_instructions.md content (one section per instance)
// and report aggregate size/item/truncation metadata.
// A source-anchored pivot's role_reason names the issue/traceback line that
// pointed straight at it; everything else is a "hidden" pivot surfaced by
// symbol/graph/literal/test reasoning. Mirrors renderHuman.isSourceAnchoredPivot
// and the report's pivotIsHidden — the kind of pivot a traceback-following agent
// skips, which is exactly what PIVOT_CHECK exists to surface.
function pivotIsHidden(roleReason: string | null): boolean {
  return !(roleReason ?? "").includes("source line anchor");
}

// Deterministic high-risk signals that justify the extra PIVOT_CHECK inspection
// turns under the `risk_gated` policy. Computed null-safely from the capsule
// classification — absent metadata simply yields no signal (never a fabricated
// one). The v2 audit emits no per-pivot score, so the "ambiguous top-pivot score
// gap" rule is intentionally NOT evaluated here (no data to read) rather than
// guessed. Signals (stable string keys, surfaced in run metadata):
//   "hidden_pivot"          a pivot was NOT named directly by the traceback/problem
//                           path (surfaced by symbol/graph/literal/test evidence) —
//                           exactly the localization miss PIVOT_CHECK exists to catch.
//   "three_or_more_pivots"  >= 3 pivots (not merely two): a genuinely multi-site fix.
//   "edit_risk_directives"  the v2 engine attached >= 1 edit-risk directive to this
//                           task (its own edit-relevant / cross-file evidence).
export function pivotCheckRiskSignals(classification: CapsuleClassification | null): string[] {
  // Nullish-safe: a hard-error / legacy section may carry null (or an absent field).
  if (classification === null || classification === undefined) return [];
  const pivots = classification.capsulePivots ?? null;
  const signals: string[] = [];
  if (pivots !== null) {
    if (pivots.some((pivot) => pivotIsHidden(pivot.roleReason))) signals.push("hidden_pivot");
    if (pivots.length >= 3) signals.push("three_or_more_pivots");
  }
  if (classification.capsuleEditRiskDirectivesCount > 0) signals.push("edit_risk_directives");
  return signals;
}

// STRONG risk signals for the experimental `strict_risk_gated` policy, in which
// hidden_pivot ALONE is not sufficient. Null-safe over the deterministic signal list:
// it only reads signals that are actually present and never fabricates metadata.
//   "three_or_more_pivots"             a genuinely multi-site fix.
//   "edit_risk_directives"             the v2 engine attached edit-relevant evidence.
//   "known_edit_relevant_hidden_pivot" a hidden pivot already KNOWN to be edit-relevant
//                                      (only surfaced if such metadata is present — not
//                                      produced today, but tolerated when it appears).
//   "hidden_pivot+additional"          hidden_pivot corroborated by >= 1 other signal.
// Returns the labels that fired (empty => no strong signal => suppress under strict).
export function strongRiskSignals(riskSignals: readonly string[]): string[] {
  const out: string[] = [];
  if (riskSignals.includes("three_or_more_pivots")) out.push("three_or_more_pivots");
  if (riskSignals.includes("edit_risk_directives")) out.push("edit_risk_directives");
  if (riskSignals.includes("known_edit_relevant_hidden_pivot")) out.push("known_edit_relevant_hidden_pivot");
  // hidden_pivot is strong ONLY when corroborated by >= 1 additional signal. When a
  // strong signal was already captured above, that corroboration is implicit, so the
  // extra label is added only when nothing else fired (hidden_pivot + some other signal).
  if (out.length === 0 && riskSignals.includes("hidden_pivot") && riskSignals.length >= 2) {
    out.push("hidden_pivot+additional");
  }
  return out;
}

// A PIVOT_CHECK injection decision under a deterministic policy, carrying the
// rationale and risk signals so run metadata can distinguish "absent because
// disabled" from "absent because risk_gated did not trigger" from "injected because
// risk signals fired". `wouldInjectUnderMultiPivot` records whether the OLD behaviour
// (inject for >= 2 pivots) would have fired, so a token-cost comparison is auditable.
export interface PivotCheckDecision {
  readonly inject: boolean;
  readonly policy: PivotCheckPolicy;
  readonly reason: string;
  readonly riskSignals: readonly string[];
  readonly wouldInjectUnderMultiPivot: boolean;
}

// Decide whether PIVOT_CHECK should be injected for one Capsule v2 section under the
// given policy. Pure and deterministic — no agents, no I/O. The structural floor of
// >= 2 pivots (PIVOT_CHECK is a multi-row localization checklist) applies to every
// policy except `always`, which injects for any v2 context (single pivot included,
// experiments only). `risk_gated` additionally requires >= 1 deterministic risk
// signal; two ordinary pivots with no risk signal no longer qualify. `strict_risk_gated`
// is stricter still: it keeps the multi-pivot floor but requires a STRONG signal, so a
// hidden_pivot-only capsule (the common case) is suppressed.
export function decidePivotCheckInjection(
  policy: PivotCheckPolicy,
  classification: CapsuleClassification | null,
): PivotCheckDecision {
  const pivots = classification?.capsulePivots ?? null;
  const pivotCount = pivots?.length ?? 0;
  const multiPivot = pivotCount >= 2;
  const riskSignals = pivotCheckRiskSignals(classification);
  const base = { policy, riskSignals, wouldInjectUnderMultiPivot: multiPivot } as const;
  // Pivot-neighborhood excerpts are extra nearby source the agent must account for.
  // Their presence is a qualifying trigger on its own (single-pivot capsules
  // included): "multiple pivots OR pivotNeighborhood excerpts". This fires only on
  // the Capsule v2 product path that opts into `--pivot-neighborhood`, and never
  // under policy=off, so non-neighborhood runs keep their existing behaviour.
  const neighborhoodExcerpts = neighborhoodExcerptCountOf(classification);
  if (policy !== "off" && neighborhoodExcerpts > 0 && pivotCount >= 1) {
    return {
      ...base,
      inject: true,
      reason: `neighborhood_excerpts_present (${neighborhoodExcerpts} excerpt(s) over ${pivotCount} pivot(s))`,
    };
  }
  switch (policy) {
    case "off":
      return { ...base, inject: false, reason: "policy=off: PIVOT_CHECK never injected" };
    case "multi_pivot":
      return multiPivot
        ? { ...base, inject: true, reason: `multi_pivot: ${pivotCount} pivots (>= 2)` }
        : { ...base, inject: false, reason: `multi_pivot: ${pivotCount} pivot(s) (< 2 — no checklist)` };
    case "risk_gated":
      if (!multiPivot) {
        return { ...base, inject: false, reason: `risk_gated: ${pivotCount} pivot(s) (< 2 — below multi-pivot floor)` };
      }
      return riskSignals.length > 0
        ? { ...base, inject: true, reason: `risk_gated: risk signals [${riskSignals.join(", ")}]` }
        : { ...base, inject: false, reason: `risk_gated: ${pivotCount} pivots but no high-risk signal` };
    case "strict_risk_gated": {
      // Preserve the structural multi-pivot floor (the renderer needs >= 2 pivots), then
      // require a STRONG risk signal — hidden_pivot alone never qualifies.
      if (!multiPivot) {
        return { ...base, inject: false, reason: `strict_risk_gated: ${pivotCount} pivot(s) (< 2 — below multi-pivot floor)` };
      }
      const strong = strongRiskSignals(riskSignals);
      if (strong.length > 0) {
        return { ...base, inject: true, reason: `strict_risk_gated: strong risk signals [${strong.join(", ")}]` };
      }
      const hiddenOnlyNote = riskSignals.includes("hidden_pivot")
        ? " (hidden_pivot alone is insufficient)"
        : "";
      return { ...base, inject: false, reason: `strict_risk_gated: no strong risk signal${hiddenOnlyNote}` };
    }
    case "always":
      return pivotCount >= 1
        ? { ...base, inject: true, reason: `always: Capsule v2 context exists (${pivotCount} pivot(s))` }
        : { ...base, inject: false, reason: "always: no Capsule v2 pivots present" };
  }
}

// Build the compact, benchmark-only PIVOT_CHECK enforcement block, seeded from the
// actual Capsule v2 pivot list so the agent cannot accidentally omit a hidden
// pivot. Returns null (stay quiet) unless there are >= `minPivots` pivots (default
// 2 — single-pivot capsules need no localization checklist; the `always` policy
// passes 1). The block forces direct inspection (Read/open) of every pivot before
// editing; search/grep is explicitly NOT enough. It never orders the agent to edit
// every pivot — the smallest correct patch is still preferred. The pivot list is
// v2-only (legacy carries no audit items), so a non-null list also encodes the
// `capsule_engine == v2` gate.
export function buildPivotCheckBlock(
  pivots: readonly CapsuleAuditItem[] | null,
  minPivots = 2,
  neighborhood: readonly PivotNeighborhoodContext[] = [],
): string | null {
  const neighborhoodExcerpts = neighborhood.reduce(
    (sum, context) => sum + (Array.isArray(context.excerpts) ? context.excerpts.length : 0),
    0,
  );
  // Neighborhood excerpts are themselves accountable context, so a single-pivot
  // capsule that carries them still gets a checklist (one pivot row + the
  // neighborhood-use line). Otherwise the multi-row floor applies.
  const effectiveMin = neighborhoodExcerpts > 0 ? Math.min(minPivots, 1) : minPivots;
  if (pivots === null || pivots.length < effectiveMin) return null;
  const anyHidden = pivots.some((pivot) => pivotIsHidden(pivot.roleReason));

  const lines: string[] = [
    "## PIVOT_CHECK",
    "",
    "Before editing, directly inspect every pivot path listed below. Direct inspection "
      + "means Read, open, view, or equivalent file-content access. Search/Grep does NOT "
      + "count as inspection.",
    "",
    "Account for every pivot in the checklist below. You may rule out a pivot only after "
      + "directly inspecting it. Do not edit every pivot — the smallest correct patch is "
      + "still preferred.",
  ];
  if (anyHidden) {
    lines.push("");
    lines.push(
      "Some pivots below were not named directly by the traceback/problem path. They were "
        + "surfaced by VTRACE via symbol, graph, literal, or test evidence. Do not finalize "
        + "edits until these pivots have been directly inspected or ruled out with "
        + "source-based reasoning.",
    );
  }
  lines.push("");
  lines.push("| pivot | symbol | inspected | relevant | edit_needed | reason |");
  lines.push("|---|---|---:|---:|---:|---|");
  for (const pivot of pivots) {
    lines.push(`| ${pivot.path} | ${pivot.symbol || "?"} | yes/no | yes/no | yes/no | ... |`);
  }
  // Neighborhood-use line: the nearby relationship excerpts VTRACE supplied must be
  // accounted for too — which the agent used, and which it ruled out (with a
  // source-grounded reason). Rule-outs must cite inspected source, never a guess.
  if (neighborhoodExcerpts > 0) {
    lines.push("");
    lines.push(
      `neighborhood_use: ${neighborhoodExcerpts} pivot-neighborhood excerpt(s) were provided above. `
        + "State which you used and which you ruled out; ground each rule-out in source you inspected.",
    );
  }
  return lines.join("\n");
}

// Marker string that uniquely identifies the injected EDIT_GUARD block in a
// snapshot. Used by detectEditGuardText and tests; kept distinct from "PIVOT_CHECK".
export const EDIT_GUARD_MARKER = "## EDIT_GUARD";

// Build the compact, benchmark-only EDIT_GUARD block. This rides WITH PIVOT_CHECK
// (same multi-pivot Capsule v2 gate, appended right after the checklist) and targets
// the dominant Stage 5 loss mode: bad edits AFTER correct retrieval (wrong class
// scope, missed failing input, over-broad control-flow rewrites). It is pure edit
// discipline — it changes NO retrieval, ranking, or patch application, and it never
// orders the agent to edit any particular pivot. Returns a constant block; the
// multi-pivot gate lives at the call site (it is appended only when PIVOT_CHECK was).
export function buildEditGuardBlock(): string {
  return [
    "## EDIT_GUARD",
    "",
    "Good context is not enough: most failures here are bad edits made after correct "
      + "retrieval. Before editing any file, write a short edit plan:",
    "",
    "- SCOPE: name the exact enclosing class/function/module that will receive the edit; "
      + "read its boundary before inserting any method/helper.",
    "- FAILING BEHAVIOR: state the concrete failing input, exception, assertion, or "
      + "behavior from the issue/test that the patch must directly handle.",
    "- MINIMAL FIX: prefer the smallest additive guard/branch/validation; avoid broad "
      + "control-flow rewrites unless the issue requires them.",
    "- RULED OUT: name one nearby plausible edit you are NOT making, and why.",
    "",
    "Then apply the patch and run the narrowest relevant test/check available.",
  ].join("\n");
}

// Does an assembled instruction snapshot carry the EDIT_GUARD block? Independent
// re-scan of the final text (separate from the assembly-time `injected` flag), so a
// truncated/edited snapshot can be detected. Observability only.
export function detectEditGuardText(markdown: string): boolean {
  return markdown.includes(EDIT_GUARD_MARKER);
}

// Marker string that uniquely identifies the injected PATCH_VERIFY block in a
// snapshot. Used by detectPatchVerifyText and tests; distinct from the PIVOT_CHECK
// and EDIT_GUARD markers.
export const PATCH_VERIFY_MARKER = "## PATCH_VERIFY";

// Build the compact, benchmark-only PATCH_VERIFY checkpoint. This rides WITH
// PIVOT_CHECK (same multi-pivot Capsule v2 gate) and is appended AFTER EDIT_GUARD
// when both are present. Where EDIT_GUARD guides the agent BEFORE editing, this is a
// patch-quality checkpoint AFTER editing and before the final answer: it targets the
// observed Stage 5 loss modes that survived passive pre-edit prose (wrong class/
// function scope, patch that does not explicitly handle the failing behavior, broad
// control-flow rewrite instead of minimal additive validation, no narrow test/
// reproduction check). It is pure verification discipline — it changes NO retrieval,
// ranking, or patch application, and is NOT a retrieval mechanism. Returns a constant
// block; the multi-pivot gate lives at the call site (appended only when PIVOT_CHECK was).
export function buildPatchVerifyBlock(): string {
  return [
    "## PATCH_VERIFY",
    "",
    "Before finalizing the patch, check:",
    "- SCOPE LANDED: the edit landed in the intended enclosing class/function/module.",
    "- FAILING BEHAVIOR HANDLED: the patch directly handles the concrete failing "
      + "input/assertion/exception.",
    "- MINIMALITY: the change is additive/minimal unless a broader rewrite is explicitly "
      + "justified.",
    "- CHECK RUN: a narrow relevant test/reproduction/check was run, or the reason it "
      + "could not be run is stated.",
    "- RISK: name the remaining risk if the check did not prove the fix.",
    "If any item fails, revise the patch before finalizing.",
  ].join("\n");
}

// Does an assembled instruction snapshot carry the PATCH_VERIFY block? Independent
// re-scan of the final text (separate from the assembly-time `injected` flag), so a
// truncated/edited snapshot can be detected. Observability only.
export function detectPatchVerifyText(markdown: string): boolean {
  return markdown.includes(PATCH_VERIFY_MARKER);
}

// Version of the shared tool-use-discipline block. Bump when the wording changes
// so reports can tell which generation of the anti-loop guidance a run carried.
export const STAGE5_TOOL_USE_DISCIPLINE_VERSION = "v1";

// Marker string that uniquely identifies the injected tool-use-discipline block
// in a snapshot or prompt. Distinct from the PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY
// markers so detectors never cross-match.
export const TOOL_USE_DISCIPLINE_MARKER = "## STAGE5_TOOL_USE_DISCIPLINE";

// Build the shared, generic anti-loop tool-use-discipline block. Unlike PIVOT_CHECK /
// EDIT_GUARD / PATCH_VERIFY (which ride the multi-pivot Capsule v2 gate and are
// vtrace-only), this block is injected into BOTH the baseline and vtrace agent
// prompts, identically, so it is fair to both arms. It names no hidden internal
// policy and references no vtrace-only artifacts; it is pure tool-use discipline —
// it changes NO retrieval, ranking, candidate generation, or patch application.
// (Implementation recommendation 2: curb over-searching and long Bash loops.)
export function buildToolUseDisciplineBlock(): string {
  return [
    TOOL_USE_DISCIPLINE_MARKER,
    "",
    "Tool-use discipline:",
    "- Start by inspecting the most likely target files/functions before broad repository search.",
    "- Prefer one focused search over repeated broad Bash loops.",
    "- Do not run long grep/find loops after you have identified the relevant file and function.",
    "- After each search, state the concrete next file/function to inspect; do not keep searching without a new hypothesis.",
    "- Once the failing behavior and edit location are clear, stop searching and make the smallest patch that addresses the failure.",
    "- Avoid broad rewrites. Preserve existing behavior outside the failing case.",
    "- If several pivots are provided, inspect them directly before expanding outward.",
    "- Use deferred references only when needed; do not expand unrelated references just because they are available.",
  ].join("\n");
}

// Does an assembled prompt/snapshot carry the tool-use-discipline block? Independent
// re-scan of the final text (separate from the assembly-time `injected` flag), so a
// truncated/edited snapshot can be detected. Observability only.
export function detectToolUseDisciplineText(text: string): boolean {
  return text.includes(TOOL_USE_DISCIPLINE_MARKER);
}

// ---------------------------------------------------------------------------
// STAGE5_TOKEN_DISCIPLINE — active turn-count reduction policy (vtrace-only).
//
// The Stage 5 token-path audit found VTRACE's measured token overhead was
// primarily a TURN-COUNT / cache-read amplification problem, not a capsule-size
// problem: 96% of the positive token deltas were cache-read movement caused by
// extra agent turns (repeated Read/Grep/Bash search loops re-reading the prefix).
// matplotlib-22719 is the canonical blowup (+1.55M tokens, 30 tool calls, a
// 16-deep Bash loop, repeated Read/Grep) and VTRACE even lost a baseline-resolved
// task. This block converts that finding into an ACTIVE policy: when Capsule v2
// supplies a strong lead pivot, instruct the agent to patch from the capsule
// before broad rediscovery, with concrete pre-edit tool budgets.
//
// Unlike the generic, baseline+vtrace tool-use-discipline block, this rides the
// VTRACE-ONLY context path (it references the capsule the baseline never sees) and
// is conditional on capsule confidence. It changes NO retrieval, ranking, candidate
// generation, or patch application — it is pure tool-use discipline text.
// ---------------------------------------------------------------------------

// Version of the token-discipline block. Bump when the wording/budgets change so
// reports can tell which generation of the policy a run carried.
export const STAGE5_TOKEN_DISCIPLINE_VERSION = "v1";

// Marker uniquely identifying the injected token-discipline block. Distinct from
// the PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / tool-use-discipline markers so
// detectors never cross-match.
export const TOKEN_DISCIPLINE_MARKER = "## STAGE5_TOKEN_DISCIPLINE";

// Pre-edit tool budgets for the strong-context patch-first policy. Re-exported
// from the scorer module so the prose the agent reads and the budget the scorer
// checks share one source of truth.
export {
  DEFAULT_PRE_EDIT_BASH_BUDGET,
  DEFAULT_PRE_EDIT_SEARCH_BUDGET,
  DEFAULT_REPEATED_FILE_READ_LIMIT,
};

// strong_context_patch_first: Capsule v2 gave a strong lead — patch-first, low-search.
// weak_context_explore:      context is weak/absent — allow more exploration.
// disabled:                  the policy was suppressed (no block injected).
export type TokenDisciplineMode =
  | "strong_context_patch_first"
  | "weak_context_explore"
  | "disabled";

// The configurable budget numbers rendered into the block and recorded in metadata.
export interface TokenDisciplineBudgets {
  readonly preEditSearchBudget: number;
  readonly preEditBashBudget: number;
  readonly repeatedFileReadLimit: number;
}

export const DEFAULT_TOKEN_DISCIPLINE_BUDGETS: TokenDisciplineBudgets = {
  preEditSearchBudget: DEFAULT_PRE_EDIT_SEARCH_BUDGET,
  preEditBashBudget: DEFAULT_PRE_EDIT_BASH_BUDGET,
  repeatedFileReadLimit: DEFAULT_REPEATED_FILE_READ_LIMIT,
};

// Capsule-confidence assessment for one section. strong_context requires ALL of:
// a Capsule v2 lead pivot, that lead pivot naming a file, support snippets, and the
// context having actually been injected (no error / non-empty body). Anything else
// is weak context (more exploration allowed). Pure and null-safe.
export interface ContextStrength {
  readonly mode: TokenDisciplineMode;
  readonly strongContext: boolean;
  readonly leadPivotPresent: boolean;
  readonly leadPivotFilePresent: boolean;
  readonly supportSnippetsPresent: boolean;
  readonly contextInjected: boolean;
  readonly reason: string;
}

export function classifyContextStrength(section: VtraceContextSection): ContextStrength {
  const contextInjected = section.error === null && section.rawContext.trim().length > 0;
  const pivots = section.classification?.capsulePivots ?? null;
  const support = section.classification?.capsuleSupport ?? null;
  const leadPivot = pivots && pivots.length > 0 ? pivots[0] : null;
  const leadPivotPresent = leadPivot !== null;
  const leadPivotFilePresent = leadPivot !== null && (leadPivot.path ?? "").trim().length > 0;
  const supportSnippetsPresent = support !== null && support.length > 0;
  const strongContext =
    contextInjected && leadPivotPresent && leadPivotFilePresent && supportSnippetsPresent;
  const mode: TokenDisciplineMode = strongContext
    ? "strong_context_patch_first"
    : "weak_context_explore";
  const missing: string[] = [];
  if (!contextInjected) missing.push("context not injected");
  if (!leadPivotPresent) missing.push("no lead pivot");
  else if (!leadPivotFilePresent) missing.push("lead pivot has no file");
  if (!supportSnippetsPresent) missing.push("no support snippets");
  const reason = strongContext
    ? "strong context: lead pivot + file + support + injected"
    : `weak context: ${missing.join(", ")}`;
  return {
    mode,
    strongContext,
    leadPivotPresent,
    leadPivotFilePresent,
    supportSnippetsPresent,
    contextInjected,
    reason,
  };
}

// Build the token-discipline block for a given mode. Returns null for "disabled".
// The strong-context block is patch-first with concrete pre-edit budgets; the
// weak-context block deliberately permits more exploration (the capsule is not a
// reliable lead, so forcing patch-first would be wrong).
export function buildTokenDisciplineBlock(
  mode: TokenDisciplineMode,
  budgets: TokenDisciplineBudgets = DEFAULT_TOKEN_DISCIPLINE_BUDGETS,
): string | null {
  if (mode === "disabled") return null;
  if (mode === "weak_context_explore") {
    return [
      TOKEN_DISCIPLINE_MARKER,
      "",
      "The context capsule for this task is weak or incomplete: there is no strong, "
        + "file-anchored lead pivot. More exploration is warranted here.",
      "- Search to localize the failing behavior, but keep each search focused and state "
        + "the next concrete file/function after each one.",
      "- Avoid broad recursive grep loops and long Bash inspection loops; widen only when a "
        + "focused search fails.",
      "- Once the edit location is clear, stop searching and make the smallest patch.",
    ].join("\n");
  }
  // strong_context_patch_first
  return [
    TOKEN_DISCIPLINE_MARKER,
    "",
    "The context capsule is precomputed and provides a strong lead pivot. Use it as the "
      + "primary source of truth.",
    "",
    "Before calling tools:",
    "1. Read the capsule pivots and support snippets.",
    "2. Decide whether the edit target is already identified.",
    "3. If the target file/function is present, patch first; do not rediscover it with grep.",
    "",
    "Tool budget:",
    `- At most ${budgets.preEditSearchBudget} search/grep/read calls before the first edit when the capsule has a lead pivot.`,
    `- At most ${budgets.preEditBashBudget} Bash inspection command before the first edit unless tests are being run.`,
    "- Do not run broad recursive grep after the capsule already names a pivot file.",
    `- Do not repeatedly read or grep the same file/symbol (at most ${budgets.repeatedFileReadLimit} re-read).`,
    "- Do not use Bash loops to inspect many files unless the capsule lacks a plausible target.",
    "- If you need more context, prefer one focused read around the lead pivot.",
    "- If the capsule provides deferred refs, expand only the exact ref needed.",
    "",
    "Patch trigger:",
    "- If the capsule lead pivot and support evidence identify a plausible edit location, make "
      + "the minimal patch before doing more search.",
    "",
    "Stop condition:",
    "- After two unsuccessful searches, stop searching and state the uncertainty rather than looping.",
  ].join("\n");
}

// Does an assembled prompt/snapshot carry the token-discipline block? Independent
// re-scan of the final text. Observability only.
export function detectTokenDisciplineText(text: string): boolean {
  return text.includes(TOKEN_DISCIPLINE_MARKER);
}

export function buildVtraceContextMarkdown(
  sections: readonly VtraceContextSection[],
  // `pivotCheckPolicy` (helper fallback "risk_gated"; the Stage 5 run path passes
  // strict_risk_gated by default) decides WHEN the compact PIVOT_CHECK block is
  // injected per Capsule v2 section; see decidePivotCheckInjection. The
  // legacy `disablePivotCheck` flag (default false) forces policy "off" for a
  // controlled "before" run and is retained for compatibility. Neither affects the
  // rest of the injected context. `pivotCheckInjected` in the return reports whether
  // the block was actually appended (true only when the policy + a section qualified).
  limits: {
    maxChars: number;
    maxItems: number;
    pivotCheckPolicy?: PivotCheckPolicy;
    disablePivotCheck?: boolean;
    disableEditGuard?: boolean;
    disablePatchVerify?: boolean;
    // Opt-in: inject the STAGE5_TOKEN_DISCIPLINE block (vtrace-only turn-count
    // reduction policy). Default false so existing callers/snapshots are unchanged;
    // the live Stage 5 run path opts in. Budgets default to DEFAULT_TOKEN_DISCIPLINE_BUDGETS.
    injectTokenDiscipline?: boolean;
    tokenDisciplineBudgets?: TokenDisciplineBudgets;
  },
): {
  markdown: string;
  chars: number;
  items: number;
  truncated: boolean;
  pivotCheckInjected: boolean;
  editGuardInjected: boolean;
  patchVerifyInjected: boolean;
  // Token-discipline policy outcome (representative across sections): whether the
  // block was injected, the mode chosen, and the budgets rendered.
  tokenDisciplineInjected: boolean;
  tokenDisciplineMode: TokenDisciplineMode;
  tokenDisciplineVersion: string;
  preEditSearchBudget: number;
  preEditBashBudget: number;
  repeatedFileReadLimit: number;
  // The effective policy and the representative section's decision (the injecting
  // section when one qualified, else the first Capsule v2 section), so run metadata
  // can record the policy, its rationale, and the deterministic risk signals.
  pivotCheckPolicy: PivotCheckPolicy;
  pivotCheckReason: string;
  pivotCheckRiskSignals: readonly string[];
  pivotCheckWouldInjectUnderMultiPivot: boolean;
} {
  // --disable-pivot-check is a hard override to "off"; otherwise honour the policy.
  // This helper's own fallback when a caller omits the policy is "risk_gated" (the
  // historical helper default); the Stage 5 run path always passes an explicit policy
  // — strict_risk_gated by default (see DEFAULT_CONFIG) — so production never relies on
  // this fallback. Kept at risk_gated so direct unit callers see unchanged behaviour.
  const effectivePolicy: PivotCheckPolicy = limits.disablePivotCheck ? "off" : (limits.pivotCheckPolicy ?? "risk_gated");
  // Representative decisions: the first section that actually injected wins; failing
  // that, the first section that carried a Capsule v2 classification (so the reason
  // explains WHY nothing injected — e.g. risk_gated did not trigger).
  let injectedDecision: PivotCheckDecision | null = null;
  let firstDecision: PivotCheckDecision | null = null;
  const lines: string[] = [
    "# vtrace indexed context",
    "",
    "This benchmark condition uses vtrace-indexed context. vexp is disabled.",
    "",
  ];
  let totalChars = 0;
  let totalItems = 0;
  let anyTruncated = false;
  let pivotCheckInjected = false;
  let editGuardInjected = false;
  let patchVerifyInjected = false;
  // Token-discipline policy state. The representative mode is the FIRST section's
  // (a single-instance eval has exactly one); strong wins over weak when any
  // section is strong, so a multi-instance context reports the strictest mode it
  // applied. `disabled` when the caller did not opt in.
  const tokenDisciplineBudgets = limits.tokenDisciplineBudgets ?? DEFAULT_TOKEN_DISCIPLINE_BUDGETS;
  const tokenDisciplineOptIn = limits.injectTokenDiscipline === true;
  let tokenDisciplineInjected = false;
  let tokenDisciplineMode: TokenDisciplineMode = "disabled";
  for (const section of sections) {
    const { instance } = section;
    // NOTE: the full problem statement is intentionally NOT repeated here. The
    // agent already receives the issue text from the SWE-bench harness; dumping
    // it again is pure overhead (it inflated small/local tasks in Stage 5C).
    // vtrace injects retrieved context only.
    lines.push(
      "## Instance",
      "",
      `- instance_id: ${instance.instanceId}`,
      `- repo: ${instance.repo}`,
      `- base_commit: ${instance.baseCommit}`,
      "",
      "## vtrace context",
      "",
    );
    if (section.error !== null || section.rawContext.trim().length === 0) {
      lines.push(`(vtrace context unavailable: ${section.error ?? "empty output"})`, "");
    } else {
      // Capsule v2 context is already budget-shaped: skip the per-item line cap
      // (which would chop a multi-line focused source body off the snapshot) and
      // apply only the char-budget safety net.
      const maxItems = section.preformatted ? Number.POSITIVE_INFINITY : limits.maxItems;
      const truncatedContext = truncateContext(section.rawContext, limits.maxChars, maxItems);
      lines.push(truncatedContext.text, "");
      totalChars += truncatedContext.chars;
      totalItems += truncatedContext.items;
      anyTruncated = anyTruncated || truncatedContext.truncated;
      // Capsule v2: decide PIVOT_CHECK injection under the effective policy, seeded
      // from this section's actual pivots so hidden pivots are never silently omitted.
      // risk_gated (default) injects only on a deterministic high-risk signal; the
      // legacy multi_pivot policy preserves the >= 2-pivot behaviour. The decision
      // suppresses ONLY this block (and the EDIT_GUARD / PATCH_VERIFY blocks that ride
      // with it); everything else in the section is injected unchanged.
      const decision = decidePivotCheckInjection(effectivePolicy, section.classification);
      if (firstDecision === null && section.classification !== null) firstDecision = decision;
      // `always` lowers the render floor to a single pivot (experiments); every other
      // policy keeps the >= 2 multi-row checklist floor.
      const sectionNeighborhood = section.classification?.capsuleV2Result
        ? readPivotNeighborhood(section.classification.capsuleV2Result)
        : [];
      const pivotCheck = decision.inject
        ? buildPivotCheckBlock(
          section.classification?.capsulePivots ?? null,
          effectivePolicy === "always" ? 1 : 2,
          sectionNeighborhood,
        )
        : null;
      if (pivotCheck !== null) {
        if (injectedDecision === null) injectedDecision = decision;
        lines.push(pivotCheck, "");
        pivotCheckInjected = true;
        // EDIT_GUARD rides with PIVOT_CHECK: same multi-pivot Capsule v2 gate,
        // appended right after the checklist. --disable-edit-guard suppresses ONLY
        // this guard block; the PIVOT_CHECK checklist above is untouched.
        if (limits.disableEditGuard !== true) {
          lines.push(buildEditGuardBlock(), "");
          editGuardInjected = true;
        }
        // PATCH_VERIFY rides on the SAME multi-pivot Capsule v2 gate and is appended
        // AFTER EDIT_GUARD when both are present. It is INDEPENDENT of EDIT_GUARD:
        // --disable-edit-guard removes only the guard above and leaves this checkpoint;
        // --disable-patch-verify removes only this checkpoint. Because it rides on the
        // PIVOT_CHECK checklist, --disable-pivot-check removes it too (no checklist =>
        // no checkpoint). It is a patch-quality checkpoint, not a retrieval mechanism.
        if (limits.disablePatchVerify !== true) {
          lines.push(buildPatchVerifyBlock(), "");
          patchVerifyInjected = true;
        }
      }
    }
    // STAGE5_TOKEN_DISCIPLINE: active turn-count reduction policy, conditional on
    // this section's capsule confidence. Strong context => patch-first/low-search;
    // weak context => exploratory. Injected only when the caller opts in.
    if (tokenDisciplineOptIn) {
      const strength = classifyContextStrength(section);
      const block = buildTokenDisciplineBlock(strength.mode, tokenDisciplineBudgets);
      if (block !== null) {
        lines.push(block, "");
        tokenDisciplineInjected = true;
        // Strong wins over weak when reporting a single representative mode.
        if (strength.mode === "strong_context_patch_first" || tokenDisciplineMode === "disabled") {
          tokenDisciplineMode = strength.mode;
        }
      }
    }
    lines.push(
      "## Instruction",
      "",
      "Use the vtrace context above to orient before broad search. It may be incomplete; verify with local files/tests before editing.",
      "",
    );
  }
  // The representative decision for run metadata: the injecting section's decision
  // when one qualified, else the first Capsule v2 section's (its reason explains the
  // non-injection), else a synthesised "no Capsule v2 context" decision under the
  // effective policy (legacy / hard-error / baseline runs).
  const repDecision: PivotCheckDecision = injectedDecision ?? firstDecision ?? {
    inject: false,
    policy: effectivePolicy,
    reason:
      effectivePolicy === "off"
        ? "policy=off: PIVOT_CHECK never injected"
        : "no Capsule v2 context for PIVOT_CHECK",
    riskSignals: [],
    wouldInjectUnderMultiPivot: false,
  };
  return {
    markdown: `${lines.join("\n")}\n`,
    chars: totalChars,
    items: totalItems,
    truncated: anyTruncated,
    pivotCheckInjected,
    editGuardInjected,
    patchVerifyInjected,
    pivotCheckPolicy: effectivePolicy,
    pivotCheckReason: repDecision.reason,
    pivotCheckRiskSignals: repDecision.riskSignals,
    pivotCheckWouldInjectUnderMultiPivot: repDecision.wouldInjectUnderMultiPivot,
    tokenDisciplineInjected,
    tokenDisciplineMode: tokenDisciplineInjected ? tokenDisciplineMode : "disabled",
    tokenDisciplineVersion: STAGE5_TOKEN_DISCIPLINE_VERSION,
    preEditSearchBudget: tokenDisciplineBudgets.preEditSearchBudget,
    preEditBashBudget: tokenDisciplineBudgets.preEditBashBudget,
    repeatedFileReadLimit: tokenDisciplineBudgets.repeatedFileReadLimit,
  };
}

// Workspace/index-run metadata for the vtrace _run.meta.json (alongside the flat
// IndexedContextFields). `vtraceIndexCommand` is already carried by
// indexedContextMetaFields; these record the freshness/quiet policy and the
// observed index timing (started/finished/duration are null when the index was
// reused rather than re-run).
function indexRunMetaFields(result: IndexedContextResult): Record<string, unknown> {
  return {
    freshWorkspace: result.freshWorkspace,
    // Reusable-clean-workspace observability (no-op flags off the indexed path).
    workspaceReused: result.workspaceReused,
    workspaceResetToBaseCommit: result.workspaceResetToBaseCommit,
    workspaceBaseCommit: result.workspaceBaseCommit,
    workspaceCleaned: result.workspaceCleaned,
    workspaceGitRetryCount: result.workspaceGitRetryCount,
    workspaceGitFallbackUsed: result.workspaceGitFallbackUsed,
    workspaceRecreatedAfterFailure: result.workspaceRecreatedAfterFailure,
    workspacePreparationError: result.workspacePreparationError,
    vtraceIndexQuiet: result.vtraceIndexQuiet,
    vtraceIndexStartedAt: result.vtraceIndexStartedAt,
    vtraceIndexFinishedAt: result.vtraceIndexFinishedAt,
    vtraceIndexDurationMs: result.vtraceIndexDurationMs,
    vtraceIndexPolicy: result.vtraceIndexPolicy,
    vtraceIndexReused: result.vtraceIndexReused,
    vtraceIndexFresh: result.vtraceIndexFresh,
    vtraceIndexFreshnessReason: result.vtraceIndexFreshnessReason,
    vtraceIndexMismatches: result.vtraceIndexMismatches,
    vtraceIndexMetaFile: result.vtraceIndexMetaFile,
  };
}

// Map the orchestration result onto the flat IndexedContextFields meta keys.
export function indexedContextMetaFields(result: IndexedContextResult): IndexedContextFields {
  return {
    vtraceIndexedContext: result.indexedContext,
    vtraceIndexCommand: result.indexCommand,
    vtraceQueryCommand: result.queryCommand,
    vtraceWorkspacePath: result.workspacePath,
    vtraceContextFile: result.contextFile,
    vtraceContextChars: result.contextChars,
    vtraceContextItems: result.contextItems,
    vtraceContextTruncated: result.contextTruncated,
    vtraceContextError: result.contextError,
    vtracePolicyAction: result.policyAction,
    vtraceContextInjected: result.contextInjected,
    vtraceSkipReason: result.skipReason,
    vtracePivotCount: result.pivotCount,
    vtraceSupportCount: result.supportCount,
    vtraceContextPolicyAction: result.contextPolicyAction,
    vtraceContextPolicyOverride: result.contextPolicyOverride,
    vtracePolicyReason: result.policyReason,
    vtraceContextPolicyDecisionSignals: result.contextPolicyDecisionSignals,
    expectedContextValue: result.expectedContextValue,
    expectedOverheadRisk: result.expectedOverheadRisk,
    vtraceCapsuleEngine: result.capsuleEngine,
    vtraceCapsuleIntent: result.capsuleIntent,
    vtraceCapsuleBudget: result.capsuleBudget,
    vtraceRequestedCapsuleEngine: result.requestedCapsuleEngine,
    vtraceEffectiveCapsuleEngine: result.effectiveCapsuleEngine,
    vtraceCapsuleEngineFallbackReason: result.capsuleEngineFallbackReason,
    vtraceCompactInspectFirst: result.compactInspectFirst,
    vtraceCapsulePivots: result.capsulePivots,
    vtraceCapsuleSupport: result.capsuleSupport,
    vtraceCapsuleTopPivotFile: result.capsuleTopPivotFile,
    vtraceCapsuleTopPivotSymbol: result.capsuleTopPivotSymbol,
    vtraceCapsuleActualMode: result.capsuleActualMode,
    vtraceCapsuleEstimatedTokens: result.capsuleEstimatedTokens,
    vtraceCapsuleTopPivotHasSource: result.capsuleTopPivotHasSource,
    vtraceCapsulePivotSourceChars: result.capsuleTopPivotSourceChars,
    vtraceCapsulePivotSourceMode: result.capsuleTopPivotSourceMode,
    vtraceCapsuleEditRiskDirectivesCount: result.capsuleEditRiskDirectivesCount,
    vtraceCapsuleLineAnchorResolutionUsed: result.capsuleLineAnchorResolutionUsed,
    vtraceCapsuleSqlRenderingBackfillUsed: result.capsuleSqlRenderingBackfillUsed,
    vtracePivotCheckEnabled: result.pivotCheckEnabled,
    vtracePivotCheckInjected: result.pivotCheckInjected,
    vtracePivotCheckDisabledByFlag: result.pivotCheckDisabledByFlag,
    vtracePivotCheckPolicy: result.pivotCheckPolicy,
    vtracePivotCheckPolicyReason: result.pivotCheckPolicyReason,
    vtracePivotCheckRiskSignals: result.pivotCheckRiskSignals,
    vtracePivotCheckWouldInjectUnderMultiPivot: result.pivotCheckWouldInjectUnderMultiPivot,
    vtraceEditGuardEnabled: result.editGuardEnabled,
    vtraceEditGuardInjected: result.editGuardInjected,
    vtraceEditGuardDisabledByFlag: result.editGuardDisabledByFlag,
    vtraceEditGuardTextPresent: result.editGuardTextPresent,
    vtracePatchVerifyEnabled: result.patchVerifyEnabled,
    vtracePatchVerifyInjected: result.patchVerifyInjected,
    vtracePatchVerifyDisabledByFlag: result.patchVerifyDisabledByFlag,
    vtracePatchVerifyTextPresent: result.patchVerifyTextPresent,
  };
}

// Stage 5B orchestration: for each selected instance, reproduce the checkout
// (Approach B), index it with vtrace, query vtrace with the problem statement,
// and assemble a compact context block written to the instructions/context file.
// Returns aggregate metadata. Missing instance data is a hard error (thrown);
// clone/index/query failures are recorded per-instance and degrade the result
// (never silently fall back to generic instructions).
export async function prepareIndexedContext(config: CliConfig, deps: RunDeps = {}): Promise<IndexedContextResult> {
  const runProc = deps.runProcess ?? runProcess;
  const sleep = deps.sleep ?? defaultSleep;
  const contextFile = vtraceInstructionsFilePath(config.out);
  const records = await loadSweBenchData(sweBenchDataPath(config));
  const instanceIds = await resolveInstances(config);
  if (instanceIds.length === 0) {
    throw new Error("indexed-context requires instances (via --instances or smoke_instances.json).");
  }

  const sections: VtraceContextSection[] = [];
  const errors: string[] = [];
  let indexCommand: string | null = null;
  let queryCommand: string | null = null;
  let workspacePath: string | null = null;
  // Index-run metadata (last instance wins; smoke runs are single-instance). Null
  // started/finished/duration means the index was reused, not re-run.
  let indexQuiet = false;
  let indexStartedAt: string | null = null;
  let indexFinishedAt: string | null = null;
  let indexDurationMs: number | null = null;
  // Index-reuse policy outcome (last instance wins; smoke runs are single-instance).
  let indexReused = false;
  let indexFresh = false;
  let indexFreshnessReason = "";
  let indexMismatches: readonly string[] = [];
  let indexMetaFile: string | null = null;
  // Workspace-prep outcome (last instance wins; smoke runs are single-instance).
  let workspacePrep: WorkspacePrep | null = null;
  let workspacePrepError: string | null = null;

  for (const instanceId of instanceIds) {
    const record = findSweBenchRecord(records, instanceId);
    if (record === null) {
      throw new Error(`Instance ${instanceId} not found in SWE-bench data ${sweBenchDataPath(config)}.`);
    }
    const instance = toSweBenchInstance(record); // throws on missing fields
    const workspace = workspacePathFor(config.out, instance.instanceId, config.runLabel);
    if (workspacePath === null) workspacePath = workspace;

    let rawContext = "";
    let sectionError: string | null = null;
    let classification: CapsuleClassification | null = null;
    // Engine migration bookkeeping: the engine that was REQUESTED (config default
    // is now v2) vs the engine that EFFECTIVELY produced the injected context after
    // any v2 → legacy fallback, plus the fallback reason. Reset per instance.
    const requestedEngine: CapsuleEngine = config.capsuleEngine;
    let effectiveEngine: CapsuleEngine = requestedEngine;
    let engineFallbackReason: string | null = null;
    try {
      workspacePrep = await prepareWorkspaceForInstance({ instance, workspace, runProc, sleep });
      const indexSpec = buildVtraceIndexCommand(config, workspace);
      indexCommand = renderCommand(indexSpec);
      indexQuiet = indexSpec.args.includes("--quiet");
      indexMetaFile = resolveIndexMetaPath(workspace);
      // Resolve the index-reuse policy. The fresh-workspace checkout above
      // preserves `.vtrace`, so a fingerprint-fresh index survives the source
      // reset and `auto` can reuse it instead of paying for a rebuild.
      let decision = await decideIndexPolicy(config.indexPolicy, workspace);
      const indexPresent = await pathExists(path.join(workspace, ".vtrace", "index.sqlite"));
      // Legacy --reuse-workspace / --skip-vtrace-index-if-present force reuse of a
      // present index regardless of freshness — but never override an explicit
      // --index-policy always, where a forced rebuild must win.
      if (
        config.indexPolicy !== "always"
        && !decision.reuse
        && indexPresent
        && (config.reuseWorkspace || config.skipVtraceIndexIfPresent)
      ) {
        decision = {
          reuse: true,
          fresh: decision.fresh,
          reason: config.reuseWorkspace
            ? "reuse-workspace: reusing present index"
            : "skip-vtrace-index-if-present: reusing present index",
          mismatches: decision.mismatches,
        };
      }
      // --index-policy reuse keeps a stale index but warns loudly so a run made
      // against a mismatched index is never silently trusted.
      if (config.indexPolicy === "reuse" && decision.reuse && !decision.fresh) {
        process.stderr.write(
          `\n[stage5] WARNING: --index-policy reuse kept a STALE index at ${resolveVtraceDir(workspace)} ` +
            `(${decision.reason}; mismatches: ${decision.mismatches.join(", ") || "none"}).\n`,
        );
      }
      indexReused = decision.reuse;
      indexFresh = decision.fresh;
      indexFreshnessReason = decision.reason;
      indexMismatches = decision.mismatches;
      if (!decision.reuse) {
        // --index-policy always: remove `.vtrace` entirely so the rebuild starts
        // from a clean slate with no stale rows or metadata surviving.
        if (config.indexPolicy === "always") {
          await rm(resolveVtraceDir(workspace), { recursive: true, force: true });
        }
        process.stderr.write(`\n[stage5] indexing ${workspace} …\n`);
        operatorTtyHintOnce();
        const startMs = Date.now();
        indexStartedAt = new Date(startMs).toISOString();
        // No longer gated behind --show-vtrace-index-log. On a real terminal the
        // indexer inherits our TTY and draws its FANCY single-line progress bar
        // exactly as a direct `vtrace index` run does; when piped (`| tee`), where a
        // \r-bar cannot render, it stays quiet instead of dumping per-file noise.
        const indexResult = await runProc(indexSpec.command, indexSpec.args, liveIndexRunOptions());
        const endMs = Date.now();
        indexFinishedAt = new Date(endMs).toISOString();
        indexDurationMs = endMs - startMs;
        if (indexResult.exitCode !== 0) {
          throw new Error(`vtrace index failed (exit ${indexResult.exitCode}): ${indexResult.stderr.trim() || "(no stderr)"}`);
        }
      }
      // Product-path Capsule v2 accounting probe (instrumentation only). Runs as
      // soon as the workspace index is ready and BEFORE the in-pipeline capsule
      // query, so a capsule skip/error below can never suppress it — the whole
      // point is to measure the PRODUCT surface (`run-pipeline --capsule-engine
      // v2`) on its own. Retrieval is identical to the in-pipeline capsule (both
      // call buildCapsuleV2); this only captures the product envelope
      // (contextEngine / capsuleV2 / accounting) so the turn-reduction gate can
      // confirm the first VTRACE call's accounting is observable. Persisted to the
      // run LABEL dir (NOT raw/vtrace, which the external vexp `run` cleans at
      // startup). Strictly best-effort — a probe failure never alters the run.
      if (config.captureProductV2Accounting && config.capsuleEngine === "v2") {
        try {
          const [productCommand, ...productBase] = splitArgs(config.vtraceCommand);
          if (productCommand !== undefined) {
            const productArgs = buildProductV2RunPipelineArgs({
              baseArgs: productBase,
              workspace,
              query: capsuleQueryTextFor(config, instance),
              intent: config.capsuleIntent,
              budgetTokens: config.capsuleBudget,
            });
            const productResult = await runProc(productCommand, [...productArgs]);
            const signals = parseProductV2Response(productResult.stdout);
            const probeDir = productV2ProbeDir(config.out, config.runLabel);
            await mkdir(probeDir, { recursive: true });
            const probeFile = productV2ProbeFilePath(probeDir, instance.instanceId);
            await writeFile(probeFile, `${JSON.stringify(signals, null, 2)}\n`);
            process.stderr.write(
              `[stage5] product-v2 probe wrote ${probeFile} ` +
                `(exit=${productResult.exitCode} engineV2=${signals.contextEngineIsV2} ` +
                `capsuleV2=${signals.capsuleV2Present} accounting=${signals.accounting !== null})\n`,
            );
          } else {
            process.stderr.write("[stage5] product-v2 probe skipped: empty --vtrace-command\n");
          }
        } catch (error) {
          // The probe is observability, not a treatment — never fail the run. But
          // surface the reason so a missing probe is debuggable, not silent.
          process.stderr.write(
            `[stage5] product-v2 probe FAILED (non-fatal): ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }

      // v2 ignores `mode` (it sizes from --budget); legacy uses it. The task/query
      // text also differs per engine (clean task for v2, packed query for legacy).
      const mode = capsuleModeForInstance(instance);

      // Run the capsule query for a given engine, classifying the policy. A SKIP
      // (no high-confidence target) is a VALID policy decision, not an error; only
      // a non-zero exit or a genuinely unusable output (empty WITHOUT skip
      // diagnostics) raises an EngineQueryError. The engine is threaded through a
      // shallow config clone so the legacy fallback uses legacy query text + args
      // (the workspace/index were already prepared above and are engine-agnostic).
      const runEngineQuery = async (engine: CapsuleEngine): Promise<{
        classification: CapsuleClassification;
        rawContext: string;
        command: string;
      }> => {
        const engineConfig = engine === config.capsuleEngine ? config : { ...config, capsuleEngine: engine };
        const spec = buildVtraceQueryCommand(engineConfig, workspace, capsuleQueryTextFor(engineConfig, instance), mode);
        const command = renderCommand(spec);
        const result = await runProc(spec.command, spec.args);
        if (result.exitCode !== 0) {
          throw new EngineQueryError(`vtrace query failed (exit ${result.exitCode}): ${result.stderr.trim() || "(no stderr)"}`);
        }
        const classified = classifyCapsuleOutput(result.stdout);
        if (classified.policyAction === "error") {
          throw new EngineQueryError(classified.error ?? "vtrace query returned empty context.");
        }
        return { classification: classified, rawContext: classified.context, command };
      };

      try {
        const attempt = await runEngineQuery(config.capsuleEngine);
        queryCommand = attempt.command;
        classification = attempt.classification;
        rawContext = attempt.rawContext;
      } catch (engineError) {
        // Legacy fallback: ONLY when the requested engine was v2 and the failure was
        // the v2 query itself (an EngineQueryError) — a v2 build failure or a missing
        // v2 prerequisite. Workspace/index prep failures throw before this block and
        // are never masked. If the legacy retry also fails, it propagates to the
        // section-level catch as a genuine error (no silent empty-context run).
        if (effectiveEngine === "v2" && engineError instanceof EngineQueryError) {
          engineFallbackReason = engineError instanceof Error ? engineError.message : String(engineError);
          effectiveEngine = "legacy";
          process.stderr.write(
            `[stage5] Capsule v2 query failed for ${instance.instanceId}; falling back to legacy v1: ${engineFallbackReason}\n`,
          );
          const fallback = await runEngineQuery("legacy");
          queryCommand = fallback.command;
          classification = fallback.classification;
          rawContext = fallback.rawContext;
        } else {
          throw engineError;
        }
      }
    } catch (error) {
      sectionError = error instanceof Error ? error.message : String(error);
      errors.push(`${instance.instanceId}: ${sectionError}`);
      // A workspace-prep failure is recorded distinctly for observability; the run
      // still aborts before spawn via the empty-context check in runVtrace.
      if (error instanceof WorkspacePreparationError) workspacePrepError = sectionError;
      // Surface the section failure on stderr. A swallowed context-prep error (e.g.
      // a failed clone/index) otherwise reads as a silent no-capsule run.
      process.stderr.write(`[stage5] context-prep section FAILED for ${instance.instanceId}: ${sectionError}\n`);
      classification = null;
    }
    sections.push({
      instance,
      rawContext,
      error: sectionError,
      classification,
      // Capsule v2 renders are budget-shaped already; keep their focused source
      // bodies intact through assembly (no per-item line truncation). Keyed off the
      // EFFECTIVE engine so a v2→legacy fallback section is line-truncated like v1.
      preformatted: effectiveEngine === "v2",
      requestedEngine,
      effectiveEngine,
      engineFallbackReason,
    });
  }

  // Apply the cost-aware injection gate per section. Even REAL retrieved context
  // is dropped when the gate decides `no_context` (cheap/local task), so the
  // benchmark spends nothing on context that would be net overhead. A section
  // with a hard error has no classification and is left untouched (its error
  // still drives the abort/skip aggregation below).
  const decisions = new Map<string, ContextPolicyDecision>();
  const gatedSections: VtraceContextSection[] = sections.map((section) => {
    if (section.classification === null) return section;
    const hasContext = section.rawContext.trim().length > 0;
    const policySignals = deriveContextPolicySignals(section.instance);
    // Capsule v2 carries richer edit-risk / anchor / SQL-backfill evidence, so it
    // uses the v2-specific cost-aware gate; the legacy engine keeps the original.
    const autoDecision =
      config.capsuleEngine === "v2"
        ? decideCapsuleV2ContextPolicy(policySignals, {
            capsuleAction: section.classification.policyAction,
            hasContext,
            actualMode: section.classification.actualCapsuleMode,
            pivotCount: section.classification.pivotCount,
            supportCount: section.classification.supportCount,
            topPivotHasSource: section.classification.capsuleTopPivotHasSource,
            topPivotSourceChars: section.classification.capsuleTopPivotSourceChars,
            editRiskDirectiveCount: section.classification.capsuleEditRiskDirectivesCount,
            lineAnchorResolutionUsed: section.classification.capsuleLineAnchorResolutionUsed,
            sqlRenderingBackfillUsed: section.classification.capsuleSqlRenderingBackfillUsed,
            // M7 conservative-localization inputs, read from the engine's own v2
            // result (null on a legacy fallback → the gate keeps prior behaviour).
            actionabilityHintCount: section.classification.capsuleV2Result?.actionability_hints?.length ?? 0,
            topPivotPath: section.classification.capsuleV2Result?.pivots[0]?.path ?? null,
            localization: section.classification.capsuleV2Result?.diagnostics.localization_signals,
          })
        : decideContextPolicy(policySignals, {
            capsuleAction: section.classification.policyAction,
            hasContext,
            pivotCount: section.classification.pivotCount,
            supportCount: section.classification.supportCount,
            actualMode: section.classification.actualCapsuleMode,
          });
    // The operator override (--context-policy) can force the action either way
    // for Capsule v2 validation; `auto` leaves the cost-aware decision intact.
    const decision = applyContextPolicyOverride(autoDecision, config.contextPolicyOverride, hasContext);
    decisions.set(section.instance.instanceId, decision);
    // Drop the context body when the gate declines to inject it.
    return decision.action === "inject" ? section : { ...section, rawContext: "" };
  });

  // --disable-pivot-check forces "off"; otherwise the configured policy applies.
  const effectivePivotCheckPolicy: PivotCheckPolicy = config.disablePivotCheck ? "off" : config.pivotCheckPolicy;
  const assembled = buildVtraceContextMarkdown(gatedSections, {
    maxChars: config.vtraceContextMaxChars,
    maxItems: config.vtraceContextMaxItems,
    pivotCheckPolicy: effectivePivotCheckPolicy,
    disableEditGuard: config.disableEditGuard,
    disablePatchVerify: config.disablePatchVerify,
    // Active turn-count reduction policy: inject STAGE5_TOKEN_DISCIPLINE on the
    // live vtrace path (vtrace-only; conditional on per-section capsule confidence).
    injectTokenDiscipline: !config.disableTokenDiscipline,
  });
  await writeFile(contextFile, assembled.markdown);

  const indexedContext = gatedSections.some((section) => section.error === null && section.rawContext.trim().length > 0);
  const hardErrors = sections.filter((section) => section.error !== null);
  const noContextSections = sections.filter(
    (section) => section.error === null && decisions.get(section.instance.instanceId)?.action === "no_context",
  );
  // The run is a valid no-context policy only when nothing was injected, at
  // least one instance was gated to no_context, and there was no hard error to
  // fail on. A no-context decision is recorded via the existing `skip` action so
  // the run-status / treatment-validity machinery treats it as a valid policy.
  // --context-policy force-inject NEVER degrades to a valid skip: if no context
  // was generated it must surface as a failure (indexedContext === false drives
  // the abort in runVtrace), not as an intentional no-context policy.
  const forceInject = config.contextPolicyOverride === "force-inject";
  const noContext =
    !forceInject && !indexedContext && noContextSections.length > 0 && hardErrors.length === 0;
  const policyAction: VtracePolicyAction = noContext ? "skip" : "inject";
  const contextPolicyAction: ContextPolicyAction = noContext ? "no_context" : "inject";
  const pivotCount = sumClassification(sections, (c) => c.pivotCount);
  const supportCount = sumClassification(sections, (c) => c.supportCount);
  // The section/decision that explains the run-level policy: the first
  // no_context section when we declined, else the first inject decision.
  const repSection = noContext ? (noContextSections[0] ?? null) : null;
  const repDecision = noContext
    ? (repSection ? decisions.get(repSection.instance.instanceId) ?? null : null)
    : [...decisions.values()].find((d) => d.action === "inject") ?? null;
  // Recorded as the legacy `skip` mode for a no-context policy (the gate's
  // `no_context` decision is carried separately by contextPolicyAction).
  const actualCapsuleMode = noContext
    ? "skip"
    : (gatedSections.find((s) => s.rawContext.trim().length > 0)
        ? (sections.find((s) => s.classification?.actualCapsuleMode != null)?.classification?.actualCapsuleMode ?? null)
        : null);

  // Capsule v2 selected-item audit, aggregated across the INJECTED sections (the
  // items that actually made it into the assembled context). Legacy classifications
  // carry no items (null), so this is naturally empty off the v2 engine.
  const injectedClassifications = gatedSections
    .filter((section) => section.rawContext.trim().length > 0 && section.classification !== null)
    .map((section) => section.classification!);
  const capsulePivots = injectedClassifications.flatMap((c) => c.capsulePivots ?? []);
  const capsuleSupport = injectedClassifications.flatMap((c) => c.capsuleSupport ?? []);
  const capsuleEstimatedTokens = injectedClassifications.reduce<number | null>(
    (sum, c) => (c.capsuleEstimatedTokens == null ? sum : (sum ?? 0) + c.capsuleEstimatedTokens),
    null,
  );
  const topPivot = capsulePivots[0] ?? null;
  // The classification whose lead pivot IS the run's top pivot (the first injected
  // section with pivots). Its source audit describes the body actually injected
  // for `topPivot`, so the metadata never disagrees with the selected pivot.
  const topClassification = injectedClassifications.find((c) => (c.capsulePivots?.length ?? 0) > 0) ?? null;
  const capsuleTopPivotHasSource = topClassification?.capsuleTopPivotHasSource ?? false;
  const capsuleTopPivotSourceChars = topClassification?.capsuleTopPivotSourceChars ?? null;
  const capsuleTopPivotSourceMode: CapsulePivotSourceMode = topClassification?.capsuleTopPivotSourceMode ?? "missing";
  // Policy-relevant v2 diagnostics for the run, taken from the section whose lead
  // pivot is the run's top pivot (its evidence describes what actually drove the
  // decision). 0/false off the v2 engine and when nothing was injected.
  const capsuleEditRiskDirectivesCount = topClassification?.capsuleEditRiskDirectivesCount ?? 0;
  const capsuleLineAnchorResolutionUsed = topClassification?.capsuleLineAnchorResolutionUsed ?? false;
  const capsuleSqlRenderingBackfillUsed = topClassification?.capsuleSqlRenderingBackfillUsed ?? false;
  // The capsule's genuine realised mode (v2: micro/standard/full/no_context),
  // distinct from the legacy-coerced `actualCapsuleMode`. v2-only.
  const capsuleActualMode =
    config.capsuleEngine === "v2"
      ? (sections.find((s) => s.classification?.actualCapsuleMode != null)?.classification?.actualCapsuleMode ?? null)
      : null;

  // Capsule v2 evidence bundles: one per section whose classification carried a
  // full v2 result (the engine actually built a capsule). The contextMarkdown is
  // the rendered Capsule v2 human view (`classification.context`) — the EXACT text
  // injected, before the Stage 5 wrapper. These drive the raw manifest/ranking/
  // context artifacts; legacy and hard-error sections carry no result and are
  // naturally excluded.
  const capsuleV2Bundles: CapsuleV2ArtifactBundle[] = sections
    .filter((section) => section.classification?.capsuleV2Result != null)
    .map((section) => ({
      instanceId: section.instance.instanceId,
      result: section.classification!.capsuleV2Result!,
      contextMarkdown: section.classification!.context,
    }));

  // Aggregate the per-section engine migration audit. A section that fell back to
  // legacy carries effectiveEngine === "legacy"; the run's effective engine is v2
  // when any section produced v2 context, else legacy. (Stage 5 runs are typically
  // single-instance, so this is usually exact.) The fallback reason is the first
  // recorded v2 failure across sections.
  const effectiveCapsuleEngine: CapsuleEngine =
    sections.some((s) => (s.effectiveEngine ?? config.capsuleEngine) === "v2") ? "v2" : "legacy";
  const capsuleEngineFallbackReason: string | null =
    sections.find((s) => s.engineFallbackReason != null)?.engineFallbackReason ?? null;

  return {
    indexedContext,
    indexCommand,
    queryCommand,
    workspacePath,
    workspaceReused: workspacePrep?.reused ?? false,
    workspaceResetToBaseCommit: workspacePrep?.resetToBaseCommit ?? false,
    workspaceBaseCommit: workspacePrep?.baseCommit ?? null,
    workspaceCleaned: workspacePrep?.cleaned ?? false,
    workspaceGitRetryCount: workspacePrep?.gitRetryCount ?? 0,
    workspaceGitFallbackUsed: workspacePrep?.fallbackUsed ?? false,
    workspaceRecreatedAfterFailure: workspacePrep?.recreatedAfterFailure ?? false,
    workspacePreparationError: workspacePrepError,
    freshWorkspace: !config.reuseWorkspace,
    vtraceIndexQuiet: indexQuiet,
    vtraceIndexStartedAt: indexStartedAt,
    vtraceIndexFinishedAt: indexFinishedAt,
    vtraceIndexDurationMs: indexDurationMs,
    vtraceIndexPolicy: config.indexPolicy,
    vtraceIndexReused: indexReused,
    vtraceIndexFresh: indexFresh,
    vtraceIndexFreshnessReason: indexFreshnessReason,
    vtraceIndexMismatches: indexMismatches,
    vtraceIndexMetaFile: indexMetaFile,
    contextFile,
    contextChars: assembled.chars,
    contextItems: assembled.items,
    contextTruncated: assembled.truncated,
    contextError: errors.length > 0 ? errors.join("; ") : null,
    policyAction,
    contextInjected: indexedContext,
    // Capsule-level reason when a capsule skip drove the no-context decision;
    // otherwise the gate's own rationale (cheap/local / weak-pivot).
    skipReason: noContext
      ? (repSection?.classification?.skipReason ?? repDecision?.reason ?? "no high-confidence actionable target recovered")
      : null,
    pivotCount,
    supportCount,
    actualCapsuleMode,
    contextPolicyAction,
    contextPolicyOverride: config.contextPolicyOverride,
    policyReason: repDecision?.reason ?? null,
    contextPolicyDecisionSignals: repDecision?.decisionSignals ?? null,
    expectedContextValue: repDecision?.expectedContextValue ?? null,
    expectedOverheadRisk: repDecision?.expectedOverheadRisk ?? null,
    capsuleEngine: effectiveCapsuleEngine,
    capsuleIntent: effectiveCapsuleEngine === "v2" ? config.capsuleIntent : null,
    capsuleBudget: effectiveCapsuleEngine === "v2" ? config.capsuleBudget : null,
    requestedCapsuleEngine: config.capsuleEngine,
    effectiveCapsuleEngine,
    capsuleEngineFallbackReason,
    compactInspectFirst: effectiveCapsuleEngine === "v2",
    capsulePivots,
    capsuleSupport,
    capsuleTopPivotFile: topPivot?.path ?? null,
    capsuleTopPivotSymbol: topPivot?.symbol ?? null,
    capsuleActualMode,
    capsuleEstimatedTokens,
    capsuleTopPivotHasSource,
    capsuleTopPivotSourceChars,
    capsuleTopPivotSourceMode,
    capsuleEditRiskDirectivesCount,
    capsuleLineAnchorResolutionUsed,
    capsuleSqlRenderingBackfillUsed,
    capsuleV2Bundles,
    // PIVOT_CHECK is enabled unless the operator suppressed it via the flag; the
    // assembled markdown reports whether the block was actually appended (a before
    // run, or a single-pivot capsule, both yield injected=false but for different
    // reasons — disabledByFlag disambiguates). Coerced to a strict boolean so a
    // config without the field set (e.g. a partial test config) never leaks
    // `undefined` into the metadata.
    pivotCheckEnabled: effectivePivotCheckPolicy !== "off",
    pivotCheckInjected: assembled.pivotCheckInjected,
    pivotCheckDisabledByFlag: config.disablePivotCheck === true,
    // Deterministic policy state: the effective policy, the representative decision's
    // rationale, the risk signals that were (or were not) present, and whether the
    // old multi_pivot behaviour would have injected — so a token-cost comparison and
    // the "absent because risk_gated did not trigger" distinction stay auditable.
    pivotCheckPolicy: assembled.pivotCheckPolicy,
    pivotCheckPolicyReason: assembled.pivotCheckReason,
    pivotCheckRiskSignals: assembled.pivotCheckRiskSignals,
    pivotCheckWouldInjectUnderMultiPivot: assembled.pivotCheckWouldInjectUnderMultiPivot,
    // EDIT_GUARD mirrors the PIVOT_CHECK state shape. `enabled` is the feature switch
    // (--disable-edit-guard off); `injected` is whether the guard block actually
    // entered the assembled context (false when PIVOT_CHECK was not injected, since
    // the guard rides with it); `textPresent` independently confirms the marker in the
    // final snapshot. Coerced to strict booleans so a partial config never leaks
    // `undefined` into metadata.
    editGuardEnabled: config.disableEditGuard !== true,
    editGuardInjected: assembled.editGuardInjected,
    editGuardDisabledByFlag: config.disableEditGuard === true,
    editGuardTextPresent: detectEditGuardText(assembled.markdown),
    // PATCH_VERIFY mirrors the EDIT_GUARD state shape but is INDEPENDENT of it.
    // `enabled` is the feature switch (--disable-patch-verify off); `injected` is
    // whether the checkpoint block entered the assembled context (false when
    // PIVOT_CHECK was not injected, since it rides with the checklist); `textPresent`
    // independently confirms the marker in the final snapshot. Coerced to strict
    // booleans so a partial config never leaks `undefined` into metadata.
    patchVerifyEnabled: config.disablePatchVerify !== true,
    patchVerifyInjected: assembled.patchVerifyInjected,
    patchVerifyDisabledByFlag: config.disablePatchVerify === true,
    patchVerifyTextPresent: detectPatchVerifyText(assembled.markdown),
  };
}

// Sum a per-section classification number (pivot/support counts), returning null
// only when no section reported the value at all.
function sumClassification(
  sections: readonly VtraceContextSection[],
  pick: (c: CapsuleClassification) => number | null,
): number | null {
  let total = 0;
  let seen = false;
  for (const section of sections) {
    const value = section.classification === null ? null : pick(section.classification);
    if (value !== null) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

// ---------------------------------------------------------------------------
// Reusable clean workspaces + git network-retry (Stage 5 SWE-bench setup)
// ---------------------------------------------------------------------------

// Transient git network failures worth retrying. SWE-bench clones hit GitHub over
// HTTP/2, which intermittently resets mid-transfer; these are not deterministic
// errors (a bad ref, auth) and almost always succeed on a retry or HTTP/1.1.
export const TRANSIENT_GIT_PATTERNS: readonly RegExp[] = [
  /RPC failed/i,
  /HTTP\/2 stream \d+/i,
  /stream \d+ (was )?(reset|not closed cleanly|cancelled|canceled)/i,
  /\berror 0x8\b/i, // HTTP/2 CANCEL
  /early EOF/i,
  /fetch-pack: unexpected disconnect/i,
  /invalid index-pack output/i,
  /unexpected disconnect while reading sideband packet/i,
  /remote end hung up unexpectedly/i,
  /connection reset/i,
  /TLS connection was non-properly terminated/i,
  /Could not resolve host|Failed to connect|Operation timed out|Connection timed out/i,
];

// Exponential backoff between git attempts: 1st retry after 2s, 2nd after 5s, 3rd 10s.
export const GIT_RETRY_BACKOFF_MS: readonly number[] = [2000, 5000, 10000];
const GIT_MAX_ATTEMPTS = 3; // initial attempt + up to 2 retries

export function isTransientGitError(text: string): boolean {
  return TRANSIENT_GIT_PATTERNS.some((re) => re.test(text));
}

// Whether a failure looks like a GitHub HTTP/2 problem an HTTP/1.1 retry can dodge.
export function isHttp2GitError(text: string): boolean {
  return /HTTP\/2|stream \d+|error 0x8/i.test(text);
}

// Thrown when workspace preparation cannot complete. Caught by the section loop so the
// run aborts BEFORE the agent spawns — no model tokens are spent on a non-treatment run.
export class WorkspacePreparationError extends Error {
  constructor(message: string) {
    super(`Workspace preparation failed before agent spawn; no model tokens were spent. ${message}`);
    this.name = "WorkspacePreparationError";
  }
}

export interface GitRetryOutcome {
  readonly result: ProcessResult;
  readonly retries: number; // re-attempts beyond the first (0 on first-try success)
  readonly fallbackUsed: boolean; // an HTTP/1.1 fallback attempt was made
}

// Run a git command with bounded retry on TRANSIENT network failures. On an
// HTTP/2-style failure it transparently retries with `-c http.version=HTTP/1.1`
// (process-local; never mutates the user's global git config). `onBeforeRetry` lets
// the caller scrub a corrupt partial workspace before the next attempt. Non-transient
// failures return immediately (the caller decides what to do).
export async function gitWithRetry(
  runProc: ProcessRunner,
  args: readonly string[],
  opts: {
    readonly sleep: (ms: number) => Promise<void>;
    readonly liveOptions?: { inheritStdio?: boolean; streamToTerminal?: boolean };
    readonly onBeforeRetry?: () => Promise<void>;
  },
): Promise<GitRetryOutcome> {
  let retries = 0;
  let fallbackUsed = false;
  let last: ProcessResult = { exitCode: 1, stdout: "", stderr: "(git never ran)" };
  for (let attempt = 0; attempt < GIT_MAX_ATTEMPTS; attempt += 1) {
    const effectiveArgs = fallbackUsed ? ["-c", "http.version=HTTP/1.1", ...args] : [...args];
    last = await runProc("git", effectiveArgs, opts.liveOptions);
    if (last.exitCode === 0) return { result: last, retries, fallbackUsed };
    const text = `${last.stderr}\n${last.stdout}`;
    if (!isTransientGitError(text)) return { result: last, retries, fallbackUsed }; // deterministic failure
    if (attempt === GIT_MAX_ATTEMPTS - 1) break; // out of attempts
    // Switch to the HTTP/1.1 transport for the next try if this looked like HTTP/2.
    if (!fallbackUsed && isHttp2GitError(text)) fallbackUsed = true;
    if (opts.onBeforeRetry) await opts.onBeforeRetry();
    await opts.sleep(GIT_RETRY_BACKOFF_MS[Math.min(attempt, GIT_RETRY_BACKOFF_MS.length - 1)]!);
    retries += 1;
  }
  return { result: last, retries, fallbackUsed };
}

export interface WorkspacePrep {
  readonly workspaceDir: string;
  readonly baseCommit: string;
  readonly reused: boolean; // an existing valid workspace was reused (not re-cloned)
  readonly resetToBaseCommit: boolean; // `git reset --hard <baseCommit>` succeeded
  readonly cleaned: boolean; // `git clean -fdx` succeeded
  readonly gitRetryCount: number; // transient-failure retries across clone+fetch
  readonly fallbackUsed: boolean; // an HTTP/1.1 transport fallback was used
  readonly recreatedAfterFailure: boolean; // an existing workspace was wrong/corrupt and rebuilt
}

// Does this look like a usable git workspace for `repo`? Returns false for a missing
// `.git`, a non-git directory, OR a definitive wrong-repo (origin URL present but not
// for this repo). A best-effort/empty origin is trusted (path is keyed by instanceId).
async function probeUsableWorkspace(workspace: string, repo: string, runProc: ProcessRunner): Promise<boolean> {
  if (!(await pathExists(path.join(workspace, ".git")))) return false;
  const inside = await runProc("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return false;
  const origin = await runProc("git", ["-C", workspace, "remote", "get-url", "origin"]);
  const url = origin.stdout.trim();
  if (origin.exitCode === 0 && url.length > 0 && !url.includes(repo)) return false; // wrong repo
  return true;
}

// Reset an existing workspace EXACTLY to the base commit with no leftovers:
//   fetch (only if the commit is missing locally) → reset --hard <base> → clean -fdx.
// Never `git pull`/checkout of main — SWE-bench runs from the historical base commit.
// `.vtrace` is preserved so the index-reuse policy (not a blanket clean) decides reuse.
// Returns null on any failure (the caller recreates the workspace).
async function resetCleanToBase(
  workspace: string,
  baseCommit: string,
  runProc: ProcessRunner,
  sleep: (ms: number) => Promise<void>,
): Promise<{ gitRetryCount: number; fallbackUsed: boolean } | null> {
  let gitRetryCount = 0;
  let fallbackUsed = false;
  const present = await runProc("git", ["-C", workspace, "cat-file", "-e", `${baseCommit}^{commit}`]);
  if (present.exitCode !== 0) {
    const fetched = await gitWithRetry(
      runProc,
      ["-C", workspace, "fetch", "origin", baseCommit, "--tags", "--prune"],
      { sleep },
    );
    gitRetryCount += fetched.retries;
    fallbackUsed = fallbackUsed || fetched.fallbackUsed;
    if (fetched.result.exitCode !== 0) return null;
  }
  const reset = await runProc("git", ["-C", workspace, "reset", "--hard", baseCommit]);
  if (reset.exitCode !== 0) return null;
  const clean = await runProc("git", ["-C", workspace, "clean", "-fdx", "-e", ".vtrace"]);
  if (clean.exitCode !== 0) return null;
  return { gitRetryCount, fallbackUsed };
}

// Fresh clone (with retry) then reset --hard <base> + clean. A failed clone may leave a
// corrupt partial dir, so it is removed before each retry. Throws on irrecoverable
// failure (aborts before spawn).
async function cloneAndResetToBase(
  instance: SweBenchInstance,
  workspace: string,
  runProc: ProcessRunner,
  sleep: (ms: number) => Promise<void>,
): Promise<{ gitRetryCount: number; fallbackUsed: boolean }> {
  await mkdir(path.dirname(workspace), { recursive: true });
  process.stderr.write(`[stage5] cloning ${instance.repo} → ${workspace} …\n`);
  operatorTtyHintOnce();
  const clone = buildCloneCommand(instance.repo, workspace);
  let gitRetryCount = 0;
  let fallbackUsed = false;
  const cloned = await gitWithRetry(runProc, clone.args, {
    sleep,
    liveOptions: liveGitRunOptions(),
    // A failed clone can leave a corrupt partial workspace; remove it before retry.
    onBeforeRetry: async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  });
  gitRetryCount += cloned.retries;
  fallbackUsed = fallbackUsed || cloned.fallbackUsed;
  if (cloned.result.exitCode !== 0) {
    throw new WorkspacePreparationError(
      `git clone of ${instance.repo} failed after ${cloned.retries} retr${cloned.retries === 1 ? "y" : "ies"} ` +
        `(exit ${cloned.result.exitCode}): ${cloned.result.stderr.trim() || "(no stderr)"}`,
    );
  }
  const reset = await resetCleanToBase(workspace, instance.baseCommit, runProc, sleep);
  if (reset === null) {
    throw new WorkspacePreparationError(
      `could not reset freshly-cloned ${instance.repo} to base commit ${instance.baseCommit}.`,
    );
  }
  return { gitRetryCount: gitRetryCount + reset.gitRetryCount, fallbackUsed: fallbackUsed || reset.fallbackUsed };
}

// Prepare the labeled workspace so it is EXACTLY at the SWE-bench base commit with no
// tracked/untracked leftovers before the agent spawns. Reuses an existing valid
// workspace (reset --hard + clean, no redownload); recreates a wrong/corrupt one;
// clones a missing one. All clone/fetch hops retry transient network failures.
export async function prepareWorkspaceForInstance(args: {
  readonly instance: SweBenchInstance;
  readonly workspace: string;
  readonly runProc: ProcessRunner;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<WorkspacePrep> {
  const { instance, workspace, runProc, sleep } = args;
  const baseCommit = instance.baseCommit;
  let gitRetryCount = 0;
  let fallbackUsed = false;
  let recreatedAfterFailure = false;

  const usable = await probeUsableWorkspace(workspace, instance.repo, runProc);
  if (usable) {
    // Reuse the existing clone: reset hard to base + clean. No huge redownload.
    const reset = await resetCleanToBase(workspace, baseCommit, runProc, sleep);
    if (reset !== null) {
      return {
        workspaceDir: workspace,
        baseCommit,
        reused: true,
        resetToBaseCommit: true,
        cleaned: true,
        gitRetryCount: reset.gitRetryCount,
        fallbackUsed: reset.fallbackUsed,
        recreatedAfterFailure: false,
      };
    }
    // Reset failed (corrupt history, a missing ref on a wrong remote) → fall through
    // and recreate the workspace from scratch.
  }

  // Recreate: a wrong/corrupt/leftover dir is removed first (a clean MISSING workspace
  // is not — that is a normal fresh clone, not a failure recovery).
  if (await pathExists(workspace)) {
    await rm(workspace, { recursive: true, force: true });
    recreatedAfterFailure = true;
  }
  const cloned = await cloneAndResetToBase(instance, workspace, runProc, sleep);
  return {
    workspaceDir: workspace,
    baseCommit,
    reused: false,
    resetToBaseCommit: true,
    cleaned: true,
    gitRetryCount: gitRetryCount + cloned.gitRetryCount,
    fallbackUsed: fallbackUsed || cloned.fallbackUsed,
    recreatedAfterFailure,
  };
}

interface RunStatusBlockInput {
  readonly runStatus: RunStatus;
  readonly label: string | null;
  readonly instance: string | null;
  readonly condition: Stage5Condition;
  readonly patch: Unknownable<boolean> | null;
  readonly tokens: Unknownable<number> | null;
  readonly cost: Unknownable<number> | null;
  readonly treatmentValid: unknown;
  readonly shouldRerun: boolean;
  readonly reason: string;
}

// Render the per-instance run-status block printed after each run-protocol /
// condition run (Requirement 4). Infra failures additionally print an explicit
// rerun action line so the operator knows the label needs re-running.
export function formatRunStatusBlock(input: RunStatusBlockInput): string {
  const yesNo = (value: Unknownable<boolean> | null): string =>
    value === true ? "yes" : value === false ? "no" : "unknown";
  const numText = (value: Unknownable<number> | null): string =>
    typeof value === "number" ? String(value) : "unknown";
  const costText = typeof input.cost === "number" ? `$${input.cost}` : "unknown";
  const treatmentText =
    input.treatmentValid === null || input.treatmentValid === undefined ? "n/a" : String(input.treatmentValid);
  const lines = [
    `Stage5 run status: ${input.runStatus}`,
    `Label: ${input.label ?? "(none)"}`,
    `Instance: ${input.instance ?? "(none)"}`,
    `Condition: ${input.condition}`,
    `Patch: ${yesNo(input.patch)}`,
    `Tokens: ${numText(input.tokens)}`,
    `Cost: ${costText}`,
    `Treatment valid: ${treatmentText}`,
    `Rerun recommended: ${input.shouldRerun ? "yes" : "no"}`,
    `Reason: ${input.reason}`,
  ];
  if (input.runStatus === "infra_failed") lines.push("Action: rerun this label.");
  return lines.join("\n");
}

// A human-readable reason for a given run status, used in the terminal summary.
function runStatusReason(
  status: RunStatus,
  row: Stage5Row,
  infra: InfraFailure | null,
  skipReason: string | null,
): string {
  switch (status) {
    case "infra_failed": {
      const detail =
        infra !== null && infra.infraErrorStatus !== null
          ? `Claude API ${infra.infraErrorStatus} ${infra.infraErrorKind === "api_overloaded" ? "overloaded" : infra.infraErrorKind}`
          : "Claude/API infrastructure error";
      return `${detail}; no tokens spent and no patch generated.`;
    }
    case "policy_skip":
      return skipReason ?? "vtrace selected no-context policy (valid skip).";
    case "agent_failed":
      return row.error ?? "agent run failed without producing a patch.";
    case "completed_patch":
      return "Run completed and produced a model patch.";
    case "completed_no_patch":
      return "Run completed but produced no patch.";
    case "missing_condition_result":
      return "No result row was written.";
  }
}

// Build the one-block-per-instance run-status summary for a just-completed
// condition run. When no result row was produced it reports
// missing_condition_result with the artifact-aware reason (Requirement 4).
async function formatRunStatusSummary(
  config: CliConfig,
  condition: Stage5Condition,
  dir: string,
  vtraceMeta: Record<string, unknown>,
): Promise<string> {
  const policyAction = isVtracePolicyAction(vtraceMeta.vtracePolicyAction) ? vtraceMeta.vtracePolicyAction : null;
  const treatmentValid = "vtraceTreatmentValid" in vtraceMeta ? vtraceMeta.vtraceTreatmentValid : null;
  const skipReason = isString(vtraceMeta.vtraceSkipReason) ? vtraceMeta.vtraceSkipReason : null;
  const resultsFile = await findCanonicalResultsFile(dir);
  const records = resultsFile === null ? [] : parseJsonlRecords(await readFile(resultsFile, "utf8").catch(() => ""));

  if (records.length === 0) {
    const diagnosis = await diagnoseConditionEvaluability(dir);
    return formatRunStatusBlock({
      runStatus: "missing_condition_result",
      label: config.runLabel,
      instance: null,
      condition,
      patch: null,
      tokens: null,
      cost: null,
      treatmentValid,
      shouldRerun: true,
      reason: diagnosis.message,
    });
  }

  const blocks: string[] = [];
  for (const record of records) {
    const row = extractRow(record, condition, resultsFile ?? "(none)");
    if (row === null) continue;
    const infra = classifyInfraFailure(record);
    const { runStatus, shouldRerun } = deriveRunStatus({
      infra,
      error: row.error,
      patchAvailable: row.patchAvailable,
      policyAction,
    });
    blocks.push(
      formatRunStatusBlock({
        runStatus,
        label: config.runLabel,
        instance: row.instanceId,
        condition,
        patch: row.patchAvailable,
        tokens: row.totalTokens,
        cost: row.costUsd,
        treatmentValid,
        shouldRerun,
        reason: runStatusReason(runStatus, row, infra, skipReason),
      }),
    );
  }
  return blocks.join("\n\n");
}

// Parse the raw agent stream the patched adapter dumped (at the results-root
// VTRACE_AGENT_STREAM_FILE) into an ordered `_tool_calls.json` written into this
// run's raw dir. Returns meta fields recording whether an ordered log was
// captured; never throws (telemetry must not fail a run). The three observable
// states (Requirement 5) map to distinct meta:
//   - stream file absent  → ordered:false, error:null  (block never ran / not patched)
//   - sentinel in stream   → ordered:false, error:"…sentinel…" (ran, rawOutput not string)
//   - real stream-json     → ordered:true, count:N      (ran and captured a stream)
// The run-identity + diagnostic summary written to `_tool_calls.summary.json`.
// `orderedTelemetryAvailable:false` + `missingReason` records the legacy/sentinel
// cases honestly (we never fabricate ordered calls when the stream is absent).
export interface OrderedToolCallSummaryArtifact extends OrderedToolCallSummary {
  runLabel: string | null;
  condition: Stage5Condition;
  instances: readonly string[];
  instanceId: string | null;
  toolCallLogFile: string | null;
  pivotChecklistEmitted: boolean | null;
  missingReason: string | null;
}

// Reason codes for `orderedTelemetryAvailable:false` (telemetry audit consumes these).
export const TELEMETRY_MISSING_LEGACY = "legacy-run-no-stream-json";
export const TELEMETRY_MISSING_SENTINEL = "adapter-stream-sentinel-rawoutput-not-string";
export const TELEMETRY_MISSING_PARSE_ERROR = "stream-json-parse-error";

function buildSummaryArtifact(
  summary: OrderedToolCallSummary,
  condition: Stage5Condition,
  instances: readonly string[],
  runLabel: string | null,
  extra: { toolCallLogFile: string | null; pivotChecklistEmitted: boolean | null; missingReason: string | null },
): OrderedToolCallSummaryArtifact {
  return {
    runLabel,
    condition,
    instances: [...instances],
    instanceId: instances.length === 1 ? instances[0] : null,
    ...summary,
    toolCallLogFile: extra.toolCallLogFile,
    pivotChecklistEmitted: extra.pivotChecklistEmitted,
    missingReason: extra.missingReason,
  };
}

export async function persistOrderedToolCalls(
  config: CliConfig,
  rawDir: string,
  condition: Stage5Condition = "vtrace",
  instances: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const summaryPath = toolCallSummaryFilePath(rawDir);
  // Write the summary alongside the ordered log for every observable state so the
  // telemetry audit can join it by run directory without re-reading the stream.
  const writeSummary = async (artifact: OrderedToolCallSummaryArtifact): Promise<void> => {
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, `${JSON.stringify(artifact, null, 2)}\n`);
  };
  const streamPath = vtraceAgentStreamFilePath(config.out);
  const stream = await readFile(streamPath, "utf8").catch(() => null);
  if (stream === null) {
    // No stream-json captured (block never ran / legacy run). Report honestly.
    await writeSummary(
      buildSummaryArtifact(summarizeOrderedToolCalls([], false), condition, instances, config.runLabel, {
        toolCallLogFile: null,
        pivotChecklistEmitted: null,
        missingReason: TELEMETRY_MISSING_LEGACY,
      }),
    );
    return {
      vtraceToolLogOrdered: false,
      vtraceToolCallLogFile: null,
      vtraceToolCallCount: null,
      vtraceToolCallError: null,
      // No stream → cannot observe whether the agent emitted a PIVOT_CHECK section.
      vtracePivotChecklistEmitted: null,
      vtracePivotCheckRows: [],
      vtraceNeighborhoodMentioned: null,
      vtraceToolCallSummaryFile: summaryPath,
      orderedTelemetryAvailable: false,
      orderedTelemetryMissingReason: TELEMETRY_MISSING_LEGACY,
    };
  }
  if (stream.includes(STAGE5_VTRACE_STREAM_SENTINEL)) {
    await writeSummary(
      buildSummaryArtifact(summarizeOrderedToolCalls([], false), condition, instances, config.runLabel, {
        toolCallLogFile: null,
        pivotChecklistEmitted: null,
        missingReason: TELEMETRY_MISSING_SENTINEL,
      }),
    );
    return {
      vtraceToolLogOrdered: false,
      vtraceToolCallLogFile: null,
      vtraceToolCallCount: null,
      vtraceToolCallError:
        "adapter stream sentinel: the stream patch executed but rawOutput was not a usable string (no stream-json captured).",
      vtracePivotChecklistEmitted: null,
      vtracePivotCheckRows: [],
      vtraceNeighborhoodMentioned: null,
      vtraceToolCallSummaryFile: summaryPath,
      orderedTelemetryAvailable: false,
      orderedTelemetryMissingReason: TELEMETRY_MISSING_SENTINEL,
    };
  }
  // Whether the agent's own response echoed a PIVOT_CHECK section (assistant text
  // only; see detectPivotChecklistEmitted). Recorded even if tool-call parsing
  // below fails — checklist telemetry must never fail a run.
  const pivotChecklistEmitted = detectPivotChecklistEmitted(stream);
  // Context-to-action verification telemetry (stream-derived; never fails a run).
  // The agent's filled PIVOT_CHECK rows are persisted so the report can check the
  // claims against tool evidence; neighborhood mention records whether the agent
  // engaged with the injected pivot-neighborhood excerpts at all.
  const assistantText = assistantTextFromStream(stream);
  const pivotCheckRows = parsePivotCheckRows(assistantText);
  const neighborhoodMentioned = detectNeighborhoodMention(stream);
  try {
    const calls = parseOrderedToolCalls(stream);
    const logPath = toolCallLogFilePath(rawDir);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${JSON.stringify(calls, null, 2)}\n`);
    await writeSummary(
      buildSummaryArtifact(summarizeOrderedToolCalls(calls, true), condition, instances, config.runLabel, {
        toolCallLogFile: logPath,
        pivotChecklistEmitted,
        missingReason: null,
      }),
    );
    return {
      vtraceToolLogOrdered: true,
      vtraceToolCallLogFile: logPath,
      vtraceToolCallCount: calls.length,
      vtraceToolCallError: null,
      vtracePivotChecklistEmitted: pivotChecklistEmitted,
      vtracePivotCheckRows: pivotCheckRows,
      vtraceNeighborhoodMentioned: neighborhoodMentioned,
      vtraceToolCallSummaryFile: summaryPath,
      orderedTelemetryAvailable: true,
      orderedTelemetryMissingReason: null,
    };
  } catch (error) {
    await writeSummary(
      buildSummaryArtifact(summarizeOrderedToolCalls([], false), condition, instances, config.runLabel, {
        toolCallLogFile: null,
        pivotChecklistEmitted,
        missingReason: TELEMETRY_MISSING_PARSE_ERROR,
      }),
    );
    return {
      vtraceToolLogOrdered: false,
      vtraceToolCallLogFile: null,
      vtraceToolCallCount: null,
      vtraceToolCallError: error instanceof Error ? error.message : String(error),
      vtracePivotChecklistEmitted: pivotChecklistEmitted,
      vtracePivotCheckRows: pivotCheckRows,
      vtraceNeighborhoodMentioned: neighborhoodMentioned,
      vtraceToolCallSummaryFile: summaryPath,
      orderedTelemetryAvailable: false,
      orderedTelemetryMissingReason: TELEMETRY_MISSING_PARSE_ERROR,
    };
  }
}

async function runCondition(
  config: CliConfig,
  condition: Stage5Condition,
  deps: RunDeps,
  extraVtraceMeta: Record<string, unknown> = {},
  injectContext = true,
  capsuleV2Bundles: readonly CapsuleV2ArtifactBundle[] = [],
): Promise<void> {
  if (config.vexpSweBenchDir === null) throw new Error(`--mode run-${condition} requires --vexp-swe-bench-dir.`);
  const cliPath = path.join(config.vexpSweBenchDir, config.cliEntry);
  if (!(await pathExists(cliPath))) {
    throw new Error(`vexp-swe-bench CLI not found at ${cliPath}. Run ./setup.sh in the external checkout first.`);
  }
  const instances = await resolveInstances(config);
  if (instances.length === 0) throw new Error(`--mode run-${condition} requires instances (via --instances or smoke_instances.json).`);

  // The vexp condition is the only one that enables vexp, so re-assert the gate
  // here as a defense-in-depth check even though runVexp already asserted it.
  if (condition === "vexp") assertVexpAllowed(config);

  const dir = rawConditionDir(config.out, condition, config.runLabel);
  await mkdir(dir, { recursive: true });
  // Write the shared anti-loop tool-use-discipline file (read by the patched
  // adapter for ALL conditions) unless suppressed by the benchmark/dev flag. Lives
  // at the results root so vexp's --output clean cannot delete it before the agent
  // reads it. Idempotent: every condition rewrites identical content.
  if (config.disableToolUseDiscipline !== true) {
    await writeFile(stage5ToolUseDisciplineFilePath(config.out), `${buildToolUseDisciplineBlock()}\n`);
  }
  const spec =
    condition === "baseline"
      ? buildBaselineCommand(config, instances)
      : condition === "vexp"
        ? buildVexpCommand(config, instances)
        : buildVtraceCommand(config, instances, injectContext);
  // Every condition now carries env (telemetry stream + shared discipline; vtrace
  // additionally carries its context env), so the agent child always gets it.
  const env = (spec as unknown as { env: Record<string, string> }).env;
  const startedMs = Date.now();
  process.stderr.write(`\n[stage5] running ${condition} agent for ${config.runLabel ?? instances.join(",")} …\n`);
  operatorTtyHintOnce();
  // Tee the agent child: its stdout (the external harness's human progress — repo
  // cloning, the vexp progress bar, etc.) streams to our terminal live, while we still
  // capture stdout (archived to _run.stdout.txt) and stderr (parsed for vtrace
  // injection telemetry). Metrics/patch come from the swebench JSONL, not this stdout,
  // so teeing is purely additive.
  const result = await (deps.runProcess ?? runProcess)(spec.command, spec.args, {
    cwd: spec.cwd ?? undefined,
    env,
    streamToTerminal: true,
  });
  // For the vtrace condition, record the instruction-file state and the runtime
  // injection status parsed from this run's stderr, so the raw meta is itself
  // sufficient evidence of whether the treatment actually applied. A SKIP policy
  // run injects nothing on purpose, so its validity does not require an observed
  // injection (a no-context policy is a valid treatment).
  const indexedFlag =
    typeof extraVtraceMeta.vtraceIndexedContext === "boolean" ? extraVtraceMeta.vtraceIndexedContext : null;
  const policyAction = isVtracePolicyAction(extraVtraceMeta.vtracePolicyAction)
    ? extraVtraceMeta.vtracePolicyAction
    : null;
  // Tool-call telemetry: parse the raw stream the patched adapter dumped into an
  // ordered `_tool_calls.json` (+ `_tool_calls.summary.json`) next to this run's
  // JSONL. UNIVERSAL — captured for every condition now, not just vtrace. Best-effort
  // and additive: absence just leaves the report's honest false-by-absence behavior.
  const toolCallMeta = await persistOrderedToolCalls(config, dir, condition, instances);
  // Persist Capsule v2 manifest/ranking/context artifacts next to the other raw
  // VTRACE evidence (vtrace condition only) and record what was written into the
  // run meta. Off the v2 engine no bundle exists, so nothing is written and the
  // meta records an explicit missing reason; a v2 run that produced no capsule
  // (gate/no_context) is distinguished as "capsule-v2-no-result". Best-effort and
  // additive — it never changes the agent run, ordered telemetry, or discipline.
  let capsuleV2ArtifactMeta: CapsuleV2ArtifactMeta | null = null;
  if (condition === "vtrace") {
    capsuleV2ArtifactMeta = await writeCapsuleV2Artifacts(dir, capsuleV2Bundles, {
      runLabel: config.runLabel,
      generatedAt: new Date().toISOString(),
    });
    if (!capsuleV2ArtifactMeta.capsuleV2ArtifactsPersisted && config.capsuleEngine === "v2") {
      capsuleV2ArtifactMeta = { ...capsuleV2ArtifactMeta, capsuleV2ArtifactsMissingReason: "capsule-v2-no-result" };
    }
  }
  const vtraceMeta =
    condition === "vtrace"
      ? {
          ...(await vtraceRunMetaFields(config, result.stderr, indexedFlag, policyAction)),
          ...toolCallMeta,
          ...extraVtraceMeta,
          ...(capsuleV2ArtifactMeta ?? {}),
        }
      : toolCallMeta;
  // Shared anti-loop tool-use-discipline metadata, recorded for EVERY condition so
  // reports can tell whether the block was injected (and which version), or that the
  // benchmark/dev flag suppressed it.
  const disciplineInjected = config.disableToolUseDiscipline !== true;
  const toolUseDisciplineMeta = {
    stage5ToolUseDisciplineInjected: disciplineInjected,
    stage5ToolUseDisciplineVersion: disciplineInjected ? STAGE5_TOOL_USE_DISCIPLINE_VERSION : null,
    stage5ToolUseDisciplineDisabledByFlag: config.disableToolUseDiscipline === true,
  };
  const meta = {
    condition,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env,
    instances,
    vtraceMethod: condition === "vtrace" ? config.vtraceMethod : null,
    ...toolUseDisciplineMeta,
    ...vtraceMeta,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedMs,
  };
  await writeFile(path.join(dir, "_run.stdout.txt"), result.stdout);
  await writeFile(path.join(dir, "_run.stderr.txt"), result.stderr);
  await writeFile(path.join(dir, "_run.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  // Always print the run-status summary BEFORE the exit-code check so an infra
  // failure (which may still exit 0) or a non-zero exit both get classified and
  // explained, not just swallowed by the thrown error (Requirement 4).
  process.stdout.write(`${await formatRunStatusSummary(config, condition, dir, vtraceMeta)}\n`);
  if (result.exitCode !== 0) {
    throw new Error(`run-${condition} exited ${result.exitCode}: ${result.stderr.trim() || "(no stderr)"}`);
  }
}

export async function runIngest(config: CliConfig, deps: RunDeps = {}): Promise<NormalizedArtifact> {
  void deps;
  await ensureOutputTree(config.out);
  const rows: Stage5Row[] = [];
  for (const condition of STAGE5_CONDITIONS) {
    rows.push(...(await parseConditionDir(rawConditionDir(config.out, condition, config.runLabel), condition)));
  }
  const merged = mergeRows(rows);
  const evidence = await collectRunEvidence(config.out, config.runLabel);
  const evaluations = await collectEvaluationEvidence(config.out, config.runLabel);
  const stamped = stampEvaluationRows(stampVtraceRows(merged, evidence), evaluations);
  const withDiagnostics = await stampCapsuleDiagnostics(stamped, config);
  const missingResults = await detectMissingResults(config.out, config.runLabel, withDiagnostics);
  const artifact = buildArtifact(withDiagnostics, evidence, evaluations, missingResults);
  await writeFile(path.join(config.out, NORMALIZED_FILENAME), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeReports(config, artifact);
  return artifact;
}

// Copy the run-level vtrace evidence onto each vtrace row (baseline rows keep
// their null vtrace fields), so the normalized rows carry the treatment metadata.
function stampVtraceRows(rows: readonly Stage5Row[], evidence: Stage5RunEvidence): Stage5Row[] {
  return rows.map((row) =>
    row.condition !== "vtrace"
      ? row
      : {
          ...row,
          vtraceMethod: evidence.vtraceMethod,
          vtraceInstructionsFile: evidence.vtraceInstructionsFile,
          vtraceInstructionsFileExists: evidence.vtraceInstructionsFileExists,
          vtraceInstructionsFileSize: evidence.vtraceInstructionsFileSize,
          vtraceInstructionsSnapshotFile: evidence.vtraceInstructionsSnapshotFile,
          vtraceInstructionsSnapshotExists: evidence.vtraceInstructionsSnapshotExists,
          vtraceInstructionsSha256: evidence.vtraceInstructionsSha256,
          vtraceInjectionObserved: evidence.vtraceInjectionObserved,
          vtraceInjectionError: evidence.vtraceInjectionError,
          vtraceTreatmentValid: evidence.vtraceTreatmentValid,
          // Stage 5B indexed-context fields.
          vtraceIndexedContext: evidence.vtraceIndexedContext,
          vtraceIndexCommand: evidence.vtraceIndexCommand,
          vtraceQueryCommand: evidence.vtraceQueryCommand,
          vtraceWorkspacePath: evidence.vtraceWorkspacePath,
          vtraceContextFile: evidence.vtraceContextFile,
          vtraceContextChars: evidence.vtraceContextChars,
          vtraceContextItems: evidence.vtraceContextItems,
          vtraceContextTruncated: evidence.vtraceContextTruncated,
          vtraceContextError: evidence.vtraceContextError,
          // Stage 5 vtrace policy fields (skip support + cost-aware gate).
          vtracePolicyAction: evidence.vtracePolicyAction,
          vtraceContextInjected: evidence.vtraceContextInjected,
          vtraceSkipReason: evidence.vtraceSkipReason,
          vtracePivotCount: evidence.vtracePivotCount,
          vtraceSupportCount: evidence.vtraceSupportCount,
          vtraceContextPolicyAction: evidence.vtraceContextPolicyAction,
          vtraceContextPolicyOverride: evidence.vtraceContextPolicyOverride,
          vtracePolicyReason: evidence.vtracePolicyReason,
          vtraceContextPolicyDecisionSignals: evidence.vtraceContextPolicyDecisionSignals,
          expectedContextValue: evidence.expectedContextValue,
          expectedOverheadRisk: evidence.expectedOverheadRisk,
          vtraceCapsuleEngine: evidence.vtraceCapsuleEngine,
          vtraceCapsuleIntent: evidence.vtraceCapsuleIntent,
          vtraceCapsuleBudget: evidence.vtraceCapsuleBudget,
          vtraceCapsulePivots: evidence.vtraceCapsulePivots,
          vtraceCapsuleSupport: evidence.vtraceCapsuleSupport,
          vtraceCapsuleTopPivotFile: evidence.vtraceCapsuleTopPivotFile,
          vtraceCapsuleTopPivotSymbol: evidence.vtraceCapsuleTopPivotSymbol,
          vtraceCapsuleActualMode: evidence.vtraceCapsuleActualMode,
          vtraceCapsuleEstimatedTokens: evidence.vtraceCapsuleEstimatedTokens,
          vtraceCapsuleTopPivotHasSource: evidence.vtraceCapsuleTopPivotHasSource,
          vtraceCapsulePivotSourceChars: evidence.vtraceCapsulePivotSourceChars,
          vtraceCapsulePivotSourceMode: evidence.vtraceCapsulePivotSourceMode,
          vtraceCapsuleEditRiskDirectivesCount: evidence.vtraceCapsuleEditRiskDirectivesCount,
          vtraceCapsuleLineAnchorResolutionUsed: evidence.vtraceCapsuleLineAnchorResolutionUsed,
          vtraceCapsuleSqlRenderingBackfillUsed: evidence.vtraceCapsuleSqlRenderingBackfillUsed,
          vtracePivotCheckEnabled: evidence.vtracePivotCheckEnabled,
          vtracePivotCheckInjected: evidence.vtracePivotCheckInjected,
          vtracePivotCheckDisabledByFlag: evidence.vtracePivotCheckDisabledByFlag,
          vtracePivotCheckPolicy: evidence.vtracePivotCheckPolicy,
          vtracePivotCheckPolicyReason: evidence.vtracePivotCheckPolicyReason,
          vtracePivotCheckRiskSignals: evidence.vtracePivotCheckRiskSignals,
          vtracePivotCheckWouldInjectUnderMultiPivot: evidence.vtracePivotCheckWouldInjectUnderMultiPivot,
          vtraceEditGuardEnabled: evidence.vtraceEditGuardEnabled,
          vtraceEditGuardInjected: evidence.vtraceEditGuardInjected,
          vtraceEditGuardDisabledByFlag: evidence.vtraceEditGuardDisabledByFlag,
          vtraceEditGuardTextPresent: evidence.vtraceEditGuardTextPresent,
          vtracePatchVerifyEnabled: evidence.vtracePatchVerifyEnabled,
          vtracePatchVerifyInjected: evidence.vtracePatchVerifyInjected,
          vtracePatchVerifyDisabledByFlag: evidence.vtracePatchVerifyDisabledByFlag,
          vtracePatchVerifyTextPresent: evidence.vtracePatchVerifyTextPresent,
        },
  );
}

// Enrich vtrace rows with capsule-sizing diagnostics: the recommended/actual
// mode + reason (from the instance), and whether the injected context mentioned
// the file/symbol the model actually edited. Best-effort — a missing dataset,
// instructions file, or patch leaves the affected fields null rather than
// failing ingest or fabricating a value.
export async function stampCapsuleDiagnostics(
  rows: readonly Stage5Row[],
  config: CliConfig,
): Promise<Stage5Row[]> {
  const recordsById = await loadDatasetById(config);

  const contextCache = new Map<string, string | null>();
  const out: Stage5Row[] = [];
  for (const row of rows) {
    // A valid skip policy is recorded directly on the row, so reflect the ACTUAL
    // capsule mode (`skip`) even when the dataset is unavailable for the richer
    // recommendation/containment diagnostics.
    const skipped = row.condition === "vtrace" && row.vtracePolicyAction === "skip";
    const record = row.condition === "vtrace" ? recordsById.get(row.instanceId) : undefined;
    if (record === undefined) {
      // A skip is always a high search budget (no target to trust).
      out.push(
        skipped
          ? { ...row, actualCapsuleMode: "skip", recommendedMode: row.recommendedMode ?? "skip", searchBudget: row.searchBudget ?? "high" }
          : row,
      );
      continue;
    }
    let instance: SweBenchInstance;
    try {
      instance = toSweBenchInstance(record);
    } catch {
      out.push(row);
      continue;
    }

    const shaped = shapeSweQuery(instance);
    const recommendation = recommendCapsuleMode(deriveModeSignals(instance, shaped));
    const context = await readInstanceContext(row, contextCache);
    const haveContext = context !== null && context.trim().length > 0;

    // When vtrace exercised its valid no-context policy, the ACTUAL capsule mode
    // is skip — not the micro envelope the recommendation degrades to.
    // The likely target the capsule directive would point at; also the pivot file
    // for agent-compliance (Requirement 6). A skip points at nothing.
    const pivotFile = skipped ? null : (shaped.likelyFiles[0] ?? null);
    out.push({
      ...row,
      recommendedMode: recommendation.recommendedMode,
      actualCapsuleMode: skipped ? "skip" : capsuleModeForInstance(instance),
      targetConfidence: recommendation.targetConfidence,
      retrievalReason: recommendation.retrievalReason,
      ...(skipped ? { searchBudget: row.searchBudget ?? "high" } : {}),
      pivotFile,
      topLikelyFile: shaped.likelyFiles[0] ?? null,
      topLikelySymbol: shaped.likelySymbols[0] ?? null,
      likelyTargetsCount: shaped.likelyFiles.length,
      containsFinalEditedFile:
        row.finalEditedFile !== null && haveContext ? contextMentionsFile(context, row.finalEditedFile) : null,
      containsFinalEditedSymbol:
        row.finalEditedSymbol !== null && haveContext
          ? contextMentionsSymbol(context, row.finalEditedSymbol)
          : null,
    });
  }
  return out;
}

// Best-effort dataset load keyed by instance id. Returns an empty map (not an
// error) when the dataset path is not configured, so diagnostics simply stay
// null on report-only runs that lack --vexp-swe-bench-dir / --swe-bench-data.
async function loadDatasetById(config: CliConfig): Promise<Map<string, Record<string, unknown>>> {
  const byId = new Map<string, Record<string, unknown>>();
  try {
    for (const record of await loadSweBenchData(sweBenchDataPath(config))) {
      const id = record.instance_id ?? record.instanceId;
      if (typeof id === "string") byId.set(id, record);
    }
  } catch {
    return byId;
  }
  return byId;
}

// Read the injected context for this row's instance from its instructions file
// (cached per file), extracting the per-instance section when present.
async function readInstanceContext(
  row: Stage5Row,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const file = row.vtraceInstructionsFile;
  if (file === null) return null;
  if (!cache.has(file)) {
    cache.set(file, await readFile(file, "utf8").catch(() => null));
  }
  const markdown = cache.get(file) ?? null;
  if (markdown === null) return null;
  return extractInstanceContextSection(markdown, row.instanceId) ?? markdown;
}

// Pull one instance's "## vtrace context" block out of the assembled
// _vtrace_instructions.md (see buildVtraceContextMarkdown). Returns null when the
// instance marker or context heading is absent.
export function extractInstanceContextSection(markdown: string, instanceId: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const markerAt = lines.findIndex((line) => line.trim() === `- instance_id: ${instanceId}`);
  if (markerAt === -1) return null;
  let start = -1;
  for (let i = markerAt; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "## vtrace context") {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i]?.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

export async function runReport(config: CliConfig, deps: RunDeps = {}): Promise<NormalizedArtifact> {
  await ensureOutputTree(config.out);
  const normalized = await readJsonIfExists(path.join(config.out, NORMALIZED_FILENAME));
  if (isRecord(normalized) && Array.isArray(normalized.rows)) {
    const rows = (normalized.rows as unknown[]).filter(isRecord) as unknown as Stage5Row[];
    // Prefer evidence already stored in the normalized intermediate; otherwise
    // re-derive it from the raw artifacts (do not fall back to config).
    const evidence = isRecord(normalized.evidence)
      ? (normalized.evidence as unknown as Stage5RunEvidence)
      : await collectRunEvidence(config.out, config.runLabel);
    const evaluations = Array.isArray(normalized.evaluations)
      ? ((normalized.evaluations as unknown[]).filter(isRecord) as unknown as EvaluationEvidence[])
      : await collectEvaluationEvidence(config.out, config.runLabel);
    const artifact = buildArtifact(stampVtraceRows(rows, evidence), evidence, evaluations);
    await writeReports(config, artifact);
    return artifact;
  }
  // No normalized intermediate yet: derive it from raw outputs.
  return runIngest(config, deps);
}

// Subdir under --out where the combined aggregate report is written, so it never
// clobbers the single-run flat outputs at the --out root.
export const AGGREGATE_SUBDIR = "aggregate";

// Stage 5C aggregate-runs: combine several isolated runs (each its own --run-label)
// into one normalized artifact + report. Each label is parsed and stamped exactly
// as `ingest` does for a single run, then their rows are concatenated so the
// shared, row-pure machinery (comparePairs, buildConditionSummaries, summarize)
// produces the combined paired comparison and per-condition aggregate for free.
//
// Duplicate-instance policy: if the same instance_id appears under more than one
// label (e.g. an accidental re-run), this errors out rather than silently mixing
// or double-counting — the caller must pick one canonical label per instance.
export async function runAggregateRuns(config: CliConfig, deps: RunDeps = {}): Promise<NormalizedArtifact> {
  void deps;
  const labels = config.runLabels;
  if (labels === null || labels.length === 0) {
    throw new Error("--mode aggregate-runs requires --run-labels label1,label2,...");
  }
  await ensureOutputTree(config.out);

  const allRows: Stage5Row[] = [];
  const allEvaluations: EvaluationEvidence[] = [];
  const perRunEvidence: Stage5RunEvidence[] = [];
  // instance_id -> the run-label that first contributed it; guards against the
  // same instance being counted under two labels.
  const instanceOwner = new Map<string, string>();

  for (const label of labels) {
    const rows: Stage5Row[] = [];
    for (const condition of STAGE5_CONDITIONS) {
      rows.push(...(await parseConditionDir(rawConditionDir(config.out, condition, label), condition)));
    }
    const evidence = await collectRunEvidence(config.out, label);
    const evaluations = await collectEvaluationEvidence(config.out, label);
    const stamped = await stampCapsuleDiagnostics(
      stampEvaluationRows(stampVtraceRows(mergeRows(rows), evidence), evaluations),
      config,
    );

    for (const row of stamped) {
      const prior = instanceOwner.get(row.instanceId);
      if (prior !== undefined && prior !== label) {
        throw new Error(
          `Duplicate instance ${row.instanceId} found in run-labels "${prior}" and "${label}". ` +
            "aggregate-runs refuses to combine repeated instances; pick one canonical run-label per instance.",
        );
      }
      instanceOwner.set(row.instanceId, label);
    }

    allRows.push(...stamped);
    allEvaluations.push(...evaluations);
    perRunEvidence.push(evidence);
  }

  const artifact = buildArtifact(allRows, combineRunEvidence(perRunEvidence), allEvaluations);
  const aggregateOut = path.join(config.out, AGGREGATE_SUBDIR);
  await ensureOutputTree(aggregateOut);
  await writeFile(path.join(aggregateOut, NORMALIZED_FILENAME), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeReports({ ...config, out: aggregateOut }, artifact);
  return artifact;
}

// Reconcile per-run evidence into one summary for the aggregate report. A boolean
// or method fact is reported only when ALL runs agree (unanimous); otherwise it
// collapses to "mixed"/"unknown" rather than implying a single run's value holds
// for the whole set. Per-run-specific fields (file paths, byte/item counts) are
// not aggregatable, so they are nulled — the authoritative per-instance treatment
// validity lives in the per-condition aggregate's valid_treatments/invalid_treatments.
export function combineRunEvidence(perRun: readonly Stage5RunEvidence[]): Stage5RunEvidence {
  if (perRun.length === 0) return emptyEvidence();
  const first = perRun[0]!;
  function unanimous<T>(pick: (e: Stage5RunEvidence) => T, fallback: T): T {
    const head = pick(first);
    return perRun.every((e) => pick(e) === head) ? head : fallback;
  }
  const firstError = (pick: (e: Stage5RunEvidence) => string | null): string | null =>
    perRun.map(pick).find((value) => value !== null) ?? null;
  return {
    vtraceMethod: unanimous((e) => e.vtraceMethod, "mixed"),
    vtracePatchInstalled: unanimous((e) => e.vtracePatchInstalled, "unknown"),
    vtraceInstructionsFile: null,
    vtraceInstructionsFileExists: perRun.every((e) => e.vtraceInstructionsFileExists),
    vtraceInstructionsFileSize: null,
    // Snapshot path/hash are per-run-label, so they do not aggregate; they stay
    // on each per-run row. Existence collapses to "every run had one".
    vtraceInstructionsSnapshotFile: null,
    vtraceInstructionsSnapshotExists: perRun.every((e) => e.vtraceInstructionsSnapshotExists),
    vtraceInstructionsSha256: null,
    vtraceInjectionObserved: unanimous((e) => e.vtraceInjectionObserved, "unknown"),
    vtraceInjectionError: firstError((e) => e.vtraceInjectionError),
    vtraceTreatmentValid: unanimous((e) => e.vtraceTreatmentValid, "unknown"),
    vtraceIndexedContext: unanimous((e) => e.vtraceIndexedContext, null),
    vtraceIndexCommand: null,
    vtraceQueryCommand: null,
    vtraceWorkspacePath: null,
    vtraceContextFile: null,
    vtraceContextChars: null,
    vtraceContextItems: null,
    vtraceContextTruncated: null,
    vtraceContextError: firstError((e) => e.vtraceContextError),
    // Policy facts are per-instance, not aggregatable, so they collapse to null
    // here; the authoritative per-instance policy lives on each row.
    vtracePolicyAction: null,
    vtraceContextInjected: null,
    vtraceSkipReason: null,
    vtracePivotCount: null,
    vtraceSupportCount: null,
    vtraceContextPolicyAction: null,
    vtraceContextPolicyOverride: null,
    vtracePolicyReason: null,
    expectedContextValue: null,
    expectedOverheadRisk: null,
    // The capsule engine IS unanimous across a run's instances, so it survives
    // aggregation; intent/budget are run-level too. Counts stay per-row (null).
    vtraceCapsuleEngine: unanimous((e) => e.vtraceCapsuleEngine, null),
    vtraceCapsuleIntent: unanimous((e) => e.vtraceCapsuleIntent, null),
    vtraceCapsuleBudget: unanimous((e) => e.vtraceCapsuleBudget, null),
    vtraceRequestedCapsuleEngine: unanimous((e) => e.vtraceRequestedCapsuleEngine, null),
    vtraceEffectiveCapsuleEngine: unanimous((e) => e.vtraceEffectiveCapsuleEngine, null),
    vtraceCapsuleEngineFallbackReason: unanimous((e) => e.vtraceCapsuleEngineFallbackReason, null),
    vtraceCompactInspectFirst: unanimous((e) => e.vtraceCompactInspectFirst, null),
    // Selected-item audit is per-instance, so it collapses to null/empty here;
    // the authoritative per-instance items live on each row.
    vtraceCapsulePivots: null,
    vtraceCapsuleSupport: null,
    vtraceCapsuleTopPivotFile: null,
    vtraceCapsuleTopPivotSymbol: null,
    vtraceCapsuleActualMode: null,
    vtraceCapsuleEstimatedTokens: null,
    // Per-instance capsule-audit + policy-signal fields collapse to null at the
    // run level (same rule as the per-instance fields above); the authoritative
    // values live on each row. Matches `emptyEvidence()`.
    vtraceContextPolicyDecisionSignals: null,
    vtraceCapsuleTopPivotHasSource: null,
    vtraceCapsulePivotSourceChars: null,
    vtraceCapsulePivotSourceMode: null,
    vtraceCapsuleEditRiskDirectivesCount: null,
    vtraceCapsuleLineAnchorResolutionUsed: null,
    vtraceCapsuleSqlRenderingBackfillUsed: null,
    vtracePivotCheckEnabled: null,
    vtracePivotCheckInjected: null,
    vtracePivotCheckDisabledByFlag: null,
    vtracePivotCheckPolicy: null,
    vtracePivotCheckPolicyReason: null,
    vtracePivotCheckRiskSignals: null,
    vtracePivotCheckWouldInjectUnderMultiPivot: null,
    vtraceEditGuardEnabled: null,
    vtraceEditGuardInjected: null,
    vtraceEditGuardDisabledByFlag: null,
    vtraceEditGuardTextPresent: null,
    vtracePatchVerifyEnabled: null,
    vtracePatchVerifyInjected: null,
    vtracePatchVerifyDisabledByFlag: null,
    vtracePatchVerifyTextPresent: null,
    notes: perRun.flatMap((e) => e.notes),
  };
}

// ----- vtrace local-patch mode ------------------------------------------------

// The code inserted into the external Claude Code adapter. When
// VTRACE_AGENT_INSTRUCTIONS_FILE is set it appends that file's contents to the
// prompt under a clear marker. It logs to STDERR on purpose: the adapter's
// stdout is parsed as stream-json for token/cost metrics, so a stdout line would
// corrupt parsing. vexp stays disabled — this only enriches the prompt/context.
export function buildVtracePatchBlock(): string {
  return [
    `        // ${STAGE5_VTRACE_PATCH_MARKER} begin — local Stage 5 smoke patch (injects`,
    "        // VTRACE_AGENT_INSTRUCTIONS_FILE into the Claude Code prompt; vexp stays disabled).",
    "        if (process.env.VTRACE_AGENT_INSTRUCTIONS_FILE) {",
    "            const __stage5VtraceFile = process.env.VTRACE_AGENT_INSTRUCTIONS_FILE;",
    "            try {",
    '                const { readFile: __stage5ReadFile } = await import("node:fs/promises");',
    '                const __stage5VtraceText = await __stage5ReadFile(__stage5VtraceFile, "utf8");',
    "                opts.prompt = `${opts.prompt}\\n\\n## Additional vtrace context/instructions\\n\\n${__stage5VtraceText}`;",
    `                console.error(\`${STAGE5_VTRACE_INJECTION_LOG} \${__stage5VtraceFile}\`);`,
    "            } catch (__stage5Err) {",
    "                console.error(`Stage5 vtrace injection skipped: ${__stage5Err instanceof Error ? __stage5Err.message : String(__stage5Err)}`);",
    "            }",
    "        }",
    `        // ${STAGE5_VTRACE_PATCH_MARKER} end`,
    "",
  ].join("\n");
}

// The SECOND inserted block: after `rawOutput` (the agent's full stream-json) is
// in scope, dump it to VTRACE_AGENT_STREAM_FILE so the harness can recover an
// ordered tool-call log. Telemetry only — it neither changes `opts` nor the
// returned metrics/patch. Logs to STDERR (stdout is parsed as stream-json).
export function buildVtraceStreamPatchBlock(): string {
  return [
    `        // ${STAGE5_VTRACE_STREAM_MARKER} begin — local Stage 5 smoke patch (dumps the`,
    "        // raw agent stream-json for pivot-inspection tool-call telemetry; no behavior change).",
    "        // Writes UNCONDITIONALLY when the env var is set: a sentinel when rawOutput is not a",
    "        // usable string, so an empty/absent file means the block never ran (vs. ran-but-no-stream).",
    "        if (process.env.VTRACE_AGENT_STREAM_FILE) {",
    "            const __stage5StreamFile = process.env.VTRACE_AGENT_STREAM_FILE;",
    "            try {",
    '                const { writeFile: __stage5WriteFile, mkdir: __stage5Mkdir } = await import("node:fs/promises");',
    '                const { dirname: __stage5Dirname } = await import("node:path");',
    "                await __stage5Mkdir(__stage5Dirname(__stage5StreamFile), { recursive: true });",
    '                const __stage5HasStream = typeof rawOutput === "string" && rawOutput.length > 0;',
    "                const __stage5Payload = __stage5HasStream",
    "                    ? rawOutput",
    `                    : JSON.stringify({ sentinel: "${STAGE5_VTRACE_STREAM_SENTINEL}", rawOutputType: typeof rawOutput });`,
    '                await __stage5WriteFile(__stage5StreamFile, __stage5Payload, "utf8");',
    `                console.error(\`${STAGE5_VTRACE_STREAM_LOG} \${__stage5StreamFile} (\${__stage5HasStream ? "stream-json" : "sentinel:rawOutput-not-string"})\`);`,
    "            } catch (__stage5StreamErr) {",
    "                console.error(`Stage5 vtrace stream capture skipped: ${__stage5StreamErr instanceof Error ? __stage5StreamErr.message : String(__stage5StreamErr)}`);",
    "            }",
    "        }",
    `        // ${STAGE5_VTRACE_STREAM_MARKER} end`,
    "",
  ].join("\n");
}

// The THIRD inserted block: when VTRACE_TOOL_USE_DISCIPLINE_FILE is set, append
// that file's contents (the shared anti-loop block) to the prompt for ANY
// condition. Mirrors the instructions block but uses a SEPARATE env var that the
// harness sets for baseline AND vtrace, so the anti-loop guidance is identical and
// fair across arms. Logs to STDERR (stdout is parsed as stream-json). vexp stays
// disabled — this only enriches the prompt.
export function buildToolUseDisciplinePatchBlock(): string {
  return [
    `        // ${STAGE5_TOOL_USE_DISCIPLINE_MARKER} begin — local Stage 5 smoke patch (injects the`,
    "        // shared anti-loop tool-use-discipline block into ALL conditions' prompts; vexp stays disabled).",
    "        if (process.env.VTRACE_TOOL_USE_DISCIPLINE_FILE) {",
    "            const __stage5DisciplineFile = process.env.VTRACE_TOOL_USE_DISCIPLINE_FILE;",
    "            try {",
    '                const { readFile: __stage5ReadDiscipline } = await import("node:fs/promises");',
    '                const __stage5DisciplineText = await __stage5ReadDiscipline(__stage5DisciplineFile, "utf8");',
    "                opts.prompt = `${opts.prompt}\\n\\n${__stage5DisciplineText}`;",
    `                console.error(\`${STAGE5_TOOL_USE_DISCIPLINE_LOG} \${__stage5DisciplineFile}\`);`,
    "            } catch (__stage5DisciplineErr) {",
    "                console.error(`Stage5 tool-use-discipline injection skipped: ${__stage5DisciplineErr instanceof Error ? __stage5DisciplineErr.message : String(__stage5DisciplineErr)}`);",
    "            }",
    "        }",
    `        // ${STAGE5_TOOL_USE_DISCIPLINE_MARKER} end`,
    "",
  ].join("\n");
}

// The FOURTH inserted block: after the `args` array is built (anchored on the
// "Tool whitelist" comment) and before the agent spawns, push `--disallowedTools`
// when VTRACE_AGENT_DISALLOWED_TOOLS is set. This is what makes the Phase-1
// read-only preflight INCAPABLE of editing — Claude Code deny rules take
// precedence over the orchestrator's hardcoded --allowedTools, so even though the
// allow-list still names Edit/Write/Bash, the deny-list wins. Logs to STDERR.
export function buildVtraceDisallowedToolsPatchBlock(): string {
  return [
    `        // ${STAGE5_VTRACE_DISALLOWED_TOOLS_MARKER} begin — local Stage 5 smoke patch (Phase-1`,
    "        // read-only enforcement: deny mutation/unsafe tools so the preflight cannot edit; vexp stays disabled).",
    "        if (process.env.VTRACE_AGENT_DISALLOWED_TOOLS) {",
    "            args.push(\"--disallowedTools\", process.env.VTRACE_AGENT_DISALLOWED_TOOLS);",
    `            console.error(\`${STAGE5_VTRACE_DISALLOWED_TOOLS_LOG} \${process.env.VTRACE_AGENT_DISALLOWED_TOOLS}\`);`,
    "        }",
    `        // ${STAGE5_VTRACE_DISALLOWED_TOOLS_MARKER} end`,
    "",
  ].join("\n");
}

// Independent per-block presence checks. A given adapter may carry the
// instructions patch but not the (later-introduced) stream patch — these let the
// patcher migrate one without re-installing the other.
export function hasInstructionsPatch(content: string): boolean {
  return content.includes(STAGE5_VTRACE_PATCH_MARKER);
}

export function hasDisallowedToolsPatch(content: string): boolean {
  return content.includes(STAGE5_VTRACE_DISALLOWED_TOOLS_MARKER);
}

export function hasStreamPatch(content: string): boolean {
  return content.includes(STAGE5_VTRACE_STREAM_MARKER);
}

export function hasToolUseDisciplinePatch(content: string): boolean {
  return content.includes(STAGE5_TOOL_USE_DISCIPLINE_MARKER);
}

// Insert `block` immediately after the first line containing `anchor`. Pure.
function insertAfterAnchor(content: string, anchor: string, block: string): string {
  const anchorIndex = content.indexOf(anchor);
  if (anchorIndex === -1) return content;
  const lineEnd = content.indexOf("\n", anchorIndex);
  const insertAt = lineEnd === -1 ? content.length : lineEnd + 1;
  return `${content.slice(0, insertAt)}${block}${content.slice(insertAt)}`;
}

// Pure transform: insert the injection block(s) after their anchor lines, each
// guarded by its OWN marker so the two patches migrate independently. Idempotent
// per block:
//   - instructions present, stream missing → installs ONLY the stream block
//   - both present                          → no-op (changed:false), no duplication
// The instructions block is REQUIRED — its missing anchor throws so the caller
// can patch manually. The stream-telemetry block is OPTIONAL — if its anchor is
// absent it is silently skipped, so an adapter without the `rawOutput`/duration
// line still patches cleanly (just without tool-call telemetry).
export function applyVtracePatch(content: string): { content: string; changed: boolean } {
  let next = content;
  let changed = false;

  if (!hasInstructionsPatch(next)) {
    if (next.indexOf(VTRACE_PATCH_ANCHOR) === -1) {
      throw new Error(
        `Could not find anchor "${VTRACE_PATCH_ANCHOR}" in the Claude Code adapter. ` +
          "The external vexp-swe-bench layout may have changed; patch the prompt builder manually.",
      );
    }
    next = insertAfterAnchor(next, VTRACE_PATCH_ANCHOR, buildVtracePatchBlock());
    changed = true;
  }

  if (!hasStreamPatch(next) && next.indexOf(VTRACE_STREAM_ANCHOR) !== -1) {
    next = insertAfterAnchor(next, VTRACE_STREAM_ANCHOR, buildVtraceStreamPatchBlock());
    changed = true;
  }

  // The tool-use-discipline block shares the instructions anchor (`startMs`). It is
  // inserted independently (own marker) so an adapter already carrying the earlier
  // patches migrates it in. The anchor is REQUIRED for the instructions block above,
  // so if we got here it is present.
  if (!hasToolUseDisciplinePatch(next) && next.indexOf(VTRACE_PATCH_ANCHOR) !== -1) {
    next = insertAfterAnchor(next, VTRACE_PATCH_ANCHOR, buildToolUseDisciplinePatchBlock());
    changed = true;
  }

  // The disallowed-tools block (Phase-1 read-only enforcement) is OPTIONAL like the
  // stream block: inserted only when its own anchor is present. An adapter whose
  // layout lacks the "Tool whitelist" comment still patches cleanly (just without
  // read-only Phase-1 enforcement, which the harness then surfaces honestly).
  if (!hasDisallowedToolsPatch(next) && next.indexOf(VTRACE_DISALLOWED_TOOLS_ANCHOR) !== -1) {
    next = insertAfterAnchor(next, VTRACE_DISALLOWED_TOOLS_ANCHOR, buildVtraceDisallowedToolsPatchBlock());
    changed = true;
  }

  return { content: next, changed };
}

// Find the adapter file that builds the `claude -p <prompt>` invocation. Tries
// the known candidate paths first, then falls back to a recursive scan of dist/
// and src/ for a file that names the claude-code agent and references the anchor.
export async function locateClaudePromptFile(vexpSweBenchDir: string): Promise<string | null> {
  for (const candidate of CLAUDE_ADAPTER_CANDIDATES) {
    const absolute = path.join(vexpSweBenchDir, candidate);
    if (await pathExists(absolute)) return absolute;
  }
  for (const subdir of ["dist", "src"]) {
    const root = path.join(vexpSweBenchDir, subdir);
    const files = await listFilesRecursive(root).catch(() => [] as string[]);
    for (const file of files) {
      if (!/\.(js|mjs|ts)$/.test(file)) continue;
      const content = await readFile(file, "utf8").catch(() => "");
      if (content.includes('"claude-code"') && content.includes(VTRACE_PATCH_ANCHOR)) return file;
    }
  }
  return null;
}

export async function installVtracePatch(config: CliConfig): Promise<VtracePatchManifest> {
  await ensureOutputTree(config.out);
  if (config.vexpSweBenchDir === null) throw new Error("--mode install-vtrace-patch requires --vexp-swe-bench-dir.");
  const target = await locateClaudePromptFile(config.vexpSweBenchDir);
  if (target === null) {
    throw new Error(
      `Could not locate the Claude Code prompt builder under ${config.vexpSweBenchDir} ` +
        `(looked for ${CLAUDE_ADAPTER_CANDIDATES.join(", ")} and scanned dist/ and src/).`,
    );
  }

  const original = await readFile(target, "utf8");
  const notes: string[] = [];
  const backupPath = `${target}${VTRACE_PATCH_BACKUP_SUFFIX}`;

  const hadInstructions = hasInstructionsPatch(original);
  const hadStream = hasStreamPatch(original);
  const hadDiscipline = hasToolUseDisciplinePatch(original);
  const { content: patched, changed } = applyVtracePatch(original);
  if (!changed) {
    notes.push("All patch blocks already present; left the file untouched (idempotent).");
  } else {
    // Back up the pristine file exactly once, before the first edit. An existing
    // backup (from an earlier instructions-only install) is preserved, NOT
    // overwritten — it must not block migrating in the newer stream block.
    if (await pathExists(backupPath)) {
      notes.push("Backup already existed; preserved it and did not overwrite.");
    } else {
      await writeFile(backupPath, original);
    }
    await writeFile(target, patched);
    if (!hadInstructions) notes.push(`Installed instructions patch (${STAGE5_VTRACE_PATCH_MARKER}).`);
    if (!hadStream && hasStreamPatch(patched)) {
      notes.push(
        hadInstructions
          ? `Migrated: added stream-telemetry patch (${STAGE5_VTRACE_STREAM_MARKER}) to an already-instructions-patched adapter.`
          : `Installed stream-telemetry patch (${STAGE5_VTRACE_STREAM_MARKER}).`,
      );
    }
    if (!hadStream && !hasStreamPatch(patched)) {
      notes.push(`Stream-telemetry anchor ("${VTRACE_STREAM_ANCHOR}") not found; stream patch skipped.`);
    }
    if (!hadDiscipline && hasToolUseDisciplinePatch(patched)) {
      notes.push(
        hadInstructions
          ? `Migrated: added tool-use-discipline patch (${STAGE5_TOOL_USE_DISCIPLINE_MARKER}) to an already-instructions-patched adapter.`
          : `Installed tool-use-discipline patch (${STAGE5_TOOL_USE_DISCIPLINE_MARKER}).`,
      );
    }
  }
  if (target.includes(`${path.sep}dist${path.sep}`)) {
    notes.push("Patched the built dist/ output directly; this is a local smoke patch and is lost on rebuild.");
  }

  const manifest: VtracePatchManifest = {
    installed: true,
    vexpSweBenchDir: config.vexpSweBenchDir,
    patchedFiles: [target],
    backupFiles: [backupPath],
    patchMarker: STAGE5_VTRACE_PATCH_MARKER,
    notes,
  };
  await writeVtracePatchManifest(config.out, manifest);
  return manifest;
}

export async function verifyVtracePatch(config: CliConfig): Promise<VtracePatchVerification> {
  await ensureOutputTree(config.out);
  if (config.vexpSweBenchDir === null) throw new Error("--mode verify-vtrace-patch requires --vexp-swe-bench-dir.");
  const target = await locateClaudePromptFile(config.vexpSweBenchDir);
  const notes: string[] = [];
  if (target === null) {
    notes.push("Could not locate the Claude Code prompt builder; nothing to verify.");
    return {
      installed: false,
      vexpSweBenchDir: config.vexpSweBenchDir,
      patchedFile: null,
      backupPresent: false,
      manifestPresent: await pathExists(path.join(config.out, VTRACE_PATCH_MANIFEST_FILENAME)),
      notes,
    };
  }
  const content = await readFile(target, "utf8").catch(() => "");
  const installed = hasInstructionsPatch(content);
  const streamInstalled = hasStreamPatch(content);
  const disciplineInstalled = hasToolUseDisciplinePatch(content);
  const backupPresent = await pathExists(`${target}${VTRACE_PATCH_BACKUP_SUFFIX}`);
  notes.push(installed ? `Instructions patch present in ${target}.` : `Instructions patch NOT found in ${target}.`);
  notes.push(
    streamInstalled
      ? `Stream-telemetry patch present in ${target}.`
      : `Stream-telemetry patch NOT found in ${target} (re-run install-vtrace-patch to migrate it).`,
  );
  notes.push(
    disciplineInstalled
      ? `Tool-use-discipline patch present in ${target}.`
      : `Tool-use-discipline patch NOT found in ${target} (re-run install-vtrace-patch to migrate it).`,
  );
  return {
    installed,
    vexpSweBenchDir: config.vexpSweBenchDir,
    patchedFile: target,
    backupPresent,
    manifestPresent: await pathExists(path.join(config.out, VTRACE_PATCH_MANIFEST_FILENAME)),
    notes,
  };
}

async function writeVtracePatchManifest(outDir: string, manifest: VtracePatchManifest): Promise<void> {
  await writeFile(
    path.join(outDir, VTRACE_PATCH_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

// Guard for run-vtrace --vtrace-method local-patch / indexed-context: the
// external prompt builder MUST already carry the instructions marker, or the run
// would silently behave like baseline. We fail here, before any agent process is
// spawned, so no tokens are spent.
//
// As a side effect we MIGRATE the stream-telemetry patch when it is missing: it
// was introduced after the instructions patch, so adapters installed by an older
// harness lack it (the symptom: env var set, but no _agent_stream.jsonl / no
// _tool_calls.json). Migration is telemetry-only and best-effort — any failure is
// logged and swallowed so it never aborts the run (Requirement 6).
async function assertVtracePatchInstalled(config: CliConfig): Promise<void> {
  if (config.vexpSweBenchDir === null) throw new Error("--mode run-vtrace requires --vexp-swe-bench-dir.");
  const target = await locateClaudePromptFile(config.vexpSweBenchDir);
  const content = target === null ? "" : await readFile(target, "utf8").catch(() => "");
  if (target === null || !hasInstructionsPatch(content)) {
    throw new Error(
      "--vtrace-method local-patch requires the local vtrace patch to be installed first, but its marker " +
        `(${STAGE5_VTRACE_PATCH_MARKER}) was not found in the external checkout. Run --mode install-vtrace-patch ` +
        "before run-vtrace so the vtrace condition is real and no tokens are wasted on a no-op run.",
    );
  }
  await migrateOptionalPatchesIfMissing(target, content);
}

// Best-effort, idempotent migration of the OPTIONAL later-introduced patch blocks
// (stream telemetry + Phase-1 disallowed-tools) into an adapter that already
// carries the instructions patch. Re-applies whenever ANY optional block is
// missing — so an adapter patched before the disallowed-tools block existed gets
// it migrated in on the next run. Writes a backup only if none exists (the
// pristine original from the instructions install is preserved). Never throws —
// telemetry / read-only enforcement must not fail the Stage 5 run.
async function migrateOptionalPatchesIfMissing(target: string, content: string): Promise<void> {
  if (hasStreamPatch(content) && hasDisallowedToolsPatch(content)) return;
  try {
    const { content: patched, changed } = applyVtracePatch(content);
    if (!changed) {
      process.stderr.write(
        "Stage5 vtrace: optional patch blocks could not be migrated (anchors not found); " +
          "tool-call telemetry and/or Phase-1 read-only enforcement may be unavailable for this run.\n",
      );
      return;
    }
    const backupPath = `${target}${VTRACE_PATCH_BACKUP_SUFFIX}`;
    if (!(await pathExists(backupPath))) await writeFile(backupPath, content);
    await writeFile(target, patched);
    const migrated: string[] = [];
    if (!hasStreamPatch(content) && hasStreamPatch(patched)) migrated.push(STAGE5_VTRACE_STREAM_MARKER);
    if (!hasDisallowedToolsPatch(content) && hasDisallowedToolsPatch(patched)) {
      migrated.push(STAGE5_VTRACE_DISALLOWED_TOOLS_MARKER);
    }
    process.stderr.write(
      `Stage5 vtrace: migrated optional patch block(s) [${migrated.join(", ")}] into ${target}.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Stage5 vtrace: optional patch migration skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export async function parseConditionDir(dir: string, condition: Stage5Condition): Promise<Stage5Row[]> {
  const files = await listFilesRecursive(dir).catch(() => [] as string[]);
  const readable = files.filter((absolute) => !path.basename(absolute).startsWith(RUNNER_ARTIFACT_PREFIX));
  // Prefer canonical `swebench-*.jsonl` logs over anything else when present, so
  // run metadata/stdout (or any stray export) never shadows the real result row.
  const canonical = readable.filter((absolute) => isCanonicalResultFile(path.basename(absolute)));
  const chosen = canonical.length > 0 ? canonical : readable;

  const rows: Stage5Row[] = [];
  for (const absolute of chosen) {
    const filename = path.basename(absolute);
    const content = await readFile(absolute, "utf8").catch(() => "");
    if (content.length === 0) continue;
    const rawResultPath = path.join("raw", condition, path.relative(dir, absolute));
    rows.push(...parseResultRecords(content, filename, condition, rawResultPath));
  }
  return rows;
}

// Detect conditions that ran (have artifacts) but produced no usable result row,
// attaching the artifact-aware reason (Requirement 3/5). A condition with no
// artifacts at all is simply "not run" and is NOT reported as missing.
async function detectMissingResults(
  outDir: string,
  runLabel: string | null,
  rows: readonly Stage5Row[],
): Promise<MissingConditionResult[]> {
  const missing: MissingConditionResult[] = [];
  for (const condition of STAGE5_CONDITIONS) {
    if (rows.some((row) => row.condition === condition)) continue;
    const diagnosis = await diagnoseConditionEvaluability(rawConditionDir(outDir, condition, runLabel));
    if (!diagnosis.hasArtifacts) continue;
    missing.push({ condition, reason: diagnosis.message });
  }
  return missing;
}

// Merge duplicate (instance, condition) records, filling "unknown" fields from
// later records so partial outputs across files combine into one row.
function mergeRows(rows: readonly Stage5Row[]): Stage5Row[] {
  const byKey = new Map<string, Stage5Row>();
  for (const row of rows) {
    const key = `${row.instanceId} ${row.condition}`;
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? row : mergeRow(existing, row));
  }
  return [...byKey.values()].sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId) || left.condition.localeCompare(right.condition),
  );
}

function mergeRow(base: Stage5Row, next: Stage5Row): Stage5Row {
  const fill = <T>(a: Unknownable<T>, b: Unknownable<T>): Unknownable<T> => (a === "unknown" ? b : a);
  const merged: Stage5Row = {
    ...base,
    resolved: fill(base.resolved, next.resolved),
    costUsd: fill(base.costUsd, next.costUsd),
    durationMs: fill(base.durationMs, next.durationMs),
    inputTokens: fill(base.inputTokens, next.inputTokens),
    outputTokens: fill(base.outputTokens, next.outputTokens),
    cacheReadTokens: fill(base.cacheReadTokens, next.cacheReadTokens),
    cacheCreationTokens: fill(base.cacheCreationTokens, next.cacheCreationTokens),
    totalTokens: fill(base.totalTokens, next.totalTokens),
    tokenAccountingMethod: base.tokenAccountingMethod === "unavailable" ? next.tokenAccountingMethod : base.tokenAccountingMethod,
    numTurns: fill(base.numTurns, next.numTurns),
    toolCallsTotal: fill(base.toolCallsTotal, next.toolCallsTotal),
    toolCallsBreakdown: base.toolCallsBreakdown ?? next.toolCallsBreakdown,
    patchAvailable: fill(base.patchAvailable, next.patchAvailable),
    patchLines: fill(base.patchLines, next.patchLines),
    model: base.model ?? next.model,
    agent: base.agent ?? next.agent,
    repo: base.repo ?? next.repo,
    finalEditedFile: base.finalEditedFile ?? next.finalEditedFile,
    finalEditedSymbol: base.finalEditedSymbol ?? next.finalEditedSymbol,
    searchBudget: base.searchBudget ?? next.searchBudget,
    searchBudgetReason: base.searchBudgetReason ?? next.searchBudgetReason,
    pivotFile: base.pivotFile ?? next.pivotFile,
    firstReadFile: base.firstReadFile === "unknown" ? next.firstReadFile : base.firstReadFile,
    firstEditFile: base.firstEditFile === "unknown" ? next.firstEditFile : base.firstEditFile,
    didReadPivotBeforeSearch: fill(base.didReadPivotBeforeSearch ?? "unknown", next.didReadPivotBeforeSearch ?? "unknown"),
    didEditPivot: fill(base.didEditPivot ?? "unknown", next.didEditPivot ?? "unknown"),
    searchCallsBeforePivot: fill(base.searchCallsBeforePivot ?? "unknown", next.searchCallsBeforePivot ?? "unknown"),
    error: base.error ?? next.error,
    // Infra-failure detail is preserved from whichever fragment observed it;
    // runStatus/shouldRerun are re-derived in buildArtifact after stamping.
    infraErrorStatus: base.infraErrorStatus ?? next.infraErrorStatus,
    infraErrorKind: base.infraErrorKind ?? next.infraErrorKind,
    infraErrorMessage: base.infraErrorMessage ?? next.infraErrorMessage,
    parserKind: base.parserKind === "unknown" ? next.parserKind : base.parserKind,
    notes: [...new Set([...base.notes, ...next.notes])],
  };
  return { ...merged, parsedFieldCount: countParsedFields(merged) };
}

function buildArtifact(
  rows: readonly Stage5Row[],
  evidence: Stage5RunEvidence,
  evaluations: readonly EvaluationEvidence[] = [],
  missingResults: readonly MissingConditionResult[] = [],
): NormalizedArtifact {
  // Re-derive run status now that vtrace policy + patch fields are stamped, so a
  // valid skip reads as policy_skip rather than its provisional parse-time value.
  const statusedRows = rows.map(deriveRowRunStatus);
  const pairs = comparePairs(statusedRows);
  return {
    rows: [...statusedRows],
    pairs,
    summary: summarize(statusedRows, pairs, missingResults),
    evidence,
    conditionSummaries: buildConditionSummaries(statusedRows),
    evaluations: [...evaluations],
    missingResults: [...missingResults],
  };
}

// Recompute a row's runStatus/shouldRerun from its now-complete fields. The infra
// detail captured at parse time is authoritative; the vtrace policy action is the
// only thing that can change between parse and ingest.
function deriveRowRunStatus(row: Stage5Row): Stage5Row {
  const infra: InfraFailure | null =
    row.infraErrorKind !== null
      ? {
          infraErrorStatus: row.infraErrorStatus,
          infraErrorKind: row.infraErrorKind,
          infraErrorMessage: row.infraErrorMessage ?? "",
        }
      : null;
  const derived = deriveRunStatus({
    infra,
    error: row.error,
    patchAvailable: row.patchAvailable,
    policyAction: row.vtracePolicyAction,
  });
  return { ...row, runStatus: derived.runStatus, shouldRerun: derived.shouldRerun };
}

// Stage 5C per-condition aggregate. resolvedRate divides resolved by EVALUATED
// instances (resolved is a concrete true/false), so `unknown` patches — generated
// but never run through tests — pull neither toward pass nor fail.
export function buildConditionSummaries(rows: readonly Stage5Row[]): ConditionSummary[] {
  const summaries: ConditionSummary[] = [];
  for (const condition of STAGE5_CONDITIONS) {
    // Infra failures (e.g. API 529) are not real attempts; exclude them from
    // every aggregate so their zero cost/tokens never deflate the means and a
    // never-attempted instance never counts as resolved/unresolved (Requirement 6).
    const conditionRows = rows.filter(
      (row) => row.condition === condition && row.runStatus !== "infra_failed",
    );
    if (conditionRows.length === 0) continue;
    const evaluated = conditionRows.filter((row) => row.resolved !== "unknown");
    const resolved = conditionRows.filter((row) => row.resolved === true);
    const numbersOf = (pick: (row: Stage5Row) => Unknownable<number>): number[] =>
      conditionRows.map(pick).filter(isNumber);
    // Treatment validity is only meaningful for the injected conditions.
    const treatmentRows =
      condition === "baseline" ? [] : conditionRows.filter((row) => row.vtraceTreatmentValid !== null);
    summaries.push({
      condition,
      instances: new Set(conditionRows.map((row) => row.instanceId)).size,
      resolvedCount: resolved.length,
      evaluatedCount: evaluated.length,
      resolvedRate: evaluated.length === 0 ? null : resolved.length / evaluated.length,
      meanCost: mean(numbersOf((row) => row.costUsd)),
      meanDuration: mean(numbersOf((row) => row.durationMs)),
      meanTotalTokens: mean(numbersOf((row) => row.totalTokens)),
      meanTokensForResolved: mean(resolved.map((row) => row.totalTokens).filter(isNumber)),
      meanCostForResolved: mean(resolved.map((row) => row.costUsd).filter(isNumber)),
      validTreatments: treatmentRows.filter((row) => row.vtraceTreatmentValid === true).length,
      invalidTreatments: treatmentRows.filter((row) => row.vtraceTreatmentValid === false).length,
    });
  }
  return summaries;
}

// The IndexedContextFields, all null — used to default baseline/result rows and
// any run that did not produce indexed context.
function nullIndexedContextFields(): IndexedContextFields {
  return {
    vtraceIndexedContext: null,
    vtraceIndexCommand: null,
    vtraceQueryCommand: null,
    vtraceWorkspacePath: null,
    vtraceContextFile: null,
    vtraceContextChars: null,
    vtraceContextItems: null,
    vtraceContextTruncated: null,
    vtraceContextError: null,
    vtracePolicyAction: null,
    vtraceContextInjected: null,
    vtraceSkipReason: null,
    vtracePivotCount: null,
    vtraceSupportCount: null,
    vtraceContextPolicyAction: null,
    vtraceContextPolicyOverride: null,
    vtracePolicyReason: null,
    vtraceContextPolicyDecisionSignals: null,
    expectedContextValue: null,
    expectedOverheadRisk: null,
    vtraceCapsuleEngine: null,
    vtraceCapsuleIntent: null,
    vtraceCapsuleBudget: null,
    vtraceRequestedCapsuleEngine: null,
    vtraceEffectiveCapsuleEngine: null,
    vtraceCapsuleEngineFallbackReason: null,
    vtraceCompactInspectFirst: null,
    vtraceCapsulePivots: null,
    vtraceCapsuleSupport: null,
    vtraceCapsuleTopPivotFile: null,
    vtraceCapsuleTopPivotSymbol: null,
    vtraceCapsuleActualMode: null,
    vtraceCapsuleEstimatedTokens: null,
    vtraceCapsuleTopPivotHasSource: null,
    vtraceCapsulePivotSourceChars: null,
    vtraceCapsulePivotSourceMode: null,
    vtraceCapsuleEditRiskDirectivesCount: null,
    vtraceCapsuleLineAnchorResolutionUsed: null,
    vtraceCapsuleSqlRenderingBackfillUsed: null,
    vtracePivotCheckEnabled: null,
    vtracePivotCheckInjected: null,
    vtracePivotCheckDisabledByFlag: null,
    vtracePivotCheckPolicy: null,
    vtracePivotCheckPolicyReason: null,
    vtracePivotCheckRiskSignals: null,
    vtracePivotCheckWouldInjectUnderMultiPivot: null,
    vtraceEditGuardEnabled: null,
    vtraceEditGuardInjected: null,
    vtraceEditGuardDisabledByFlag: null,
    vtraceEditGuardTextPresent: null,
    vtracePatchVerifyEnabled: null,
    vtracePatchVerifyInjected: null,
    vtracePatchVerifyDisabledByFlag: null,
    vtracePatchVerifyTextPresent: null,
  };
}

function nullEvaluationFields(): EvaluationFields {
  return {
    evaluationRan: null,
    evaluationMethod: null,
    failToPassPassed: null,
    passToPassPassed: null,
    testStatus: null,
    dockerUsed: null,
    evaluationError: null,
  };
}

function nullCapsuleDiagnosticFields(): CapsuleDiagnosticFields {
  return {
    recommendedMode: null,
    actualCapsuleMode: null,
    targetConfidence: null,
    retrievalReason: null,
    searchBudget: null,
    searchBudgetReason: null,
    topLikelyFile: null,
    topLikelySymbol: null,
    likelyTargetsCount: null,
    finalEditedFile: null,
    finalEditedSymbol: null,
    containsFinalEditedFile: null,
    containsFinalEditedSymbol: null,
  };
}

// Agent-compliance fields default to "unknown" (or null for the pivot/file fields)
// — the honest state when the result record carries no ORDERED tool-call list.
function nullAgentComplianceFields(): AgentComplianceFields {
  return {
    pivotFile: null,
    firstReadFile: "unknown",
    firstEditFile: "unknown",
    didReadPivotBeforeSearch: "unknown",
    didEditPivot: "unknown",
    searchCallsBeforePivot: "unknown",
  };
}

function emptyEvidence(): Stage5RunEvidence {
  return {
    vtraceMethod: "unknown",
    vtracePatchInstalled: "unknown",
    vtraceInstructionsFile: null,
    vtraceInstructionsFileExists: false,
    vtraceInstructionsFileSize: null,
    vtraceInstructionsSnapshotFile: null,
    vtraceInstructionsSnapshotExists: false,
    vtraceInstructionsSha256: null,
    vtraceInjectionObserved: "unknown",
    vtraceInjectionError: null,
    vtraceTreatmentValid: "unknown",
    ...nullIndexedContextFields(),
    notes: [],
  };
}

// Parse a captured vtrace stderr for the runtime injection outcome. A null stderr
// means none was captured (observed = "unknown").
function parseVtraceInjection(stderr: string | null): { observed: boolean | "unknown"; error: string | null } {
  if (stderr === null) return { observed: "unknown", error: null };
  if (stderr.includes(STAGE5_VTRACE_INJECTION_LOG)) return { observed: true, error: null };
  const skipped = stderr.split(/\r?\n/).find((line) => line.includes(STAGE5_VTRACE_INJECTION_SKIPPED));
  return { observed: false, error: skipped ? skipped.trim() : null };
}

// Treatment validity rules per method:
//  - local-patch: valid iff runtime injection was observed.
//  - indexed-context: valid iff injection observed AND real vtrace context was
//    generated AND the context file exists & is non-empty.
//  - any other method / unobserved injection: not assertable ("unknown").
function computeTreatmentValid(opts: {
  method: VtraceMethod | "unknown" | "mixed";
  injectionObserved: boolean | "unknown";
  instructionsFileExists?: boolean;
  instructionsFileSize?: number | null;
  indexedContext?: boolean | "unknown" | null;
  policyAction?: VtracePolicyAction | "unknown" | null;
}): boolean | "unknown" {
  // A SKIP policy is a VALID treatment by construction: vtrace deliberately
  // injected no context, so its validity does NOT require an observed injection.
  if (opts.policyAction === "skip") return true;
  if (opts.injectionObserved === "unknown") return "unknown";
  if (opts.method === "local-patch") return opts.injectionObserved === true;
  if (opts.method === "indexed-context") {
    return (
      opts.injectionObserved === true &&
      opts.indexedContext === true &&
      opts.instructionsFileExists === true &&
      (opts.instructionsFileSize ?? 0) > 0
    );
  }
  return "unknown";
}

// Run-level vtrace metadata stamped into the vtrace _run.meta.json at run time and
// recomputed at ingest. `stderr` is the captured vtrace stderr (null if absent).
async function vtraceRunMetaFields(
  config: CliConfig,
  stderr: string | null,
  indexedContext: boolean | null = null,
  policyAction: VtracePolicyAction | "unknown" | null = null,
): Promise<{
  vtraceInstructionsFile: string;
  vtraceInstructionsFileExists: boolean;
  vtraceInstructionsFileSize: number | null;
  vtraceInjectionObserved: boolean | "unknown";
  vtraceInjectionError: string | null;
  vtraceTreatmentValid: boolean | "unknown";
}> {
  const file = vtraceInstructionsFilePath(config.out);
  const stats = await stat(file).catch(() => null);
  const exists = stats !== null && stats.isFile();
  const size = exists ? stats!.size : null;
  const injection = parseVtraceInjection(stderr);
  return {
    vtraceInstructionsFile: file,
    vtraceInstructionsFileExists: exists,
    vtraceInstructionsFileSize: size,
    vtraceInjectionObserved: injection.observed,
    vtraceInjectionError: injection.error,
    vtraceTreatmentValid: computeTreatmentValid({
      method: config.vtraceMethod,
      injectionObserved: injection.observed,
      instructionsFileExists: exists,
      instructionsFileSize: size,
      indexedContext,
      policyAction,
    }),
  };
}

// Reconstruct run-level vtrace evidence from the captured raw artifacts: the per
// condition `_run.meta.json` (method + instructions-file path), the vtrace
// `_run.stderr.txt` (runtime injection log), and the patch manifest (install
// state). Everything here is observed, never inferred from the requested config.
async function collectRunEvidence(outDir: string, runLabel: string | null = null): Promise<Stage5RunEvidence> {
  const notes: string[] = [];

  // Resolve the vtrace method from RECORDED run metas only (non-null values),
  // and recover the instructions-file path the run actually used.
  const methods = new Set<VtraceMethod>();
  let instructionsFile: string | null = null;
  let snapshotFile: string | null = null;
  let snapshotSha256: string | null = null;
  let vtraceRunRecorded = false;
  let indexed: IndexedContextFields = nullIndexedContextFields();
  for (const condition of ["baseline", "vtrace"] as const) {
    const meta = await readJsonIfExists(path.join(rawConditionDir(outDir, condition, runLabel), "_run.meta.json"));
    if (!isRecord(meta)) continue;
    if (condition === "vtrace") vtraceRunRecorded = true;
    if (isString(meta.vtraceMethod) && isVtraceMethod(meta.vtraceMethod)) methods.add(meta.vtraceMethod);
    // Prefer the explicit field (new meta); fall back to the env path (old meta).
    if (condition === "vtrace") {
      if (isString(meta.vtraceInstructionsFile)) instructionsFile = meta.vtraceInstructionsFile;
      else if (isRecord(meta.env) && isString(meta.env.VTRACE_AGENT_INSTRUCTIONS_FILE)) {
        instructionsFile = meta.env.VTRACE_AGENT_INSTRUCTIONS_FILE;
      }
      if (isString(meta.vtraceInstructionsSnapshotFile)) snapshotFile = meta.vtraceInstructionsSnapshotFile;
      if (isString(meta.vtraceInstructionsSha256)) snapshotSha256 = meta.vtraceInstructionsSha256;
      indexed = readIndexedContextFromMeta(meta);
    }
  }
  const vtraceMethod: VtraceMethod | "unknown" | "mixed" =
    methods.size === 0 ? "unknown" : methods.size === 1 ? [...methods][0]! : "mixed";
  if (vtraceMethod === "mixed") notes.push("Recorded vtrace run metadata disagree on the method.");

  // Instruction-file existence/size, observed at ingest time.
  const stats = instructionsFile === null ? null : await stat(instructionsFile).catch(() => null);
  const vtraceInstructionsFileExists = stats !== null && stats.isFile();
  const vtraceInstructionsFileSize = vtraceInstructionsFileExists ? stats!.size : null;

  // Snapshot existence verified at ingest time. The snapshot is the audit-grade
  // record (the active file may have been overwritten by a later run), so we also
  // re-hash it and flag any drift from the SHA recorded at spawn time.
  const snapshotContent = snapshotFile === null ? null : await readFile(snapshotFile, "utf8").catch(() => null);
  const vtraceInstructionsSnapshotExists = snapshotContent !== null;
  if (snapshotContent !== null && snapshotSha256 !== null) {
    const ingestSha = createHash("sha256").update(snapshotContent).digest("hex");
    if (ingestSha !== snapshotSha256) {
      notes.push("Vtrace instructions snapshot SHA-256 does not match the value recorded at spawn time.");
    }
  } else if (snapshotFile !== null && snapshotContent === null) {
    notes.push("Vtrace instructions snapshot recorded in meta but missing on disk at ingest.");
  }

  // Patch install state from the manifest (on-disk install, distinct from runtime injection).
  const manifest = await readJsonIfExists(path.join(outDir, VTRACE_PATCH_MANIFEST_FILENAME));
  const vtracePatchInstalled: boolean | "unknown" = isRecord(manifest) && typeof manifest.installed === "boolean"
    ? manifest.installed
    : "unknown";

  // Runtime injection evidence: parse the captured vtrace stderr.
  const stderrPath = path.join(rawConditionDir(outDir, "vtrace", runLabel), "_run.stderr.txt");
  const stderr = await readFile(stderrPath, "utf8").catch(() => null);
  const injection = stderr === null && !vtraceRunRecorded ? { observed: "unknown" as const, error: null } : parseVtraceInjection(stderr ?? "");
  const vtraceInjectionObserved = injection.observed;
  const vtraceInjectionError = injection.error;
  if (vtraceInjectionObserved === true) {
    notes.push("Runtime vtrace injection log observed in captured vtrace stderr.");
  } else if (vtraceInjectionObserved === false) {
    notes.push("No runtime vtrace injection log found in captured vtrace stderr.");
  }
  if (vtraceInjectionError !== null) notes.push(vtraceInjectionError);

  const vtraceTreatmentValid = computeTreatmentValid({
    method: vtraceMethod,
    injectionObserved: vtraceInjectionObserved,
    instructionsFileExists: vtraceInstructionsFileExists,
    instructionsFileSize: vtraceInstructionsFileSize,
    indexedContext: typeof indexed.vtraceIndexedContext === "boolean" ? indexed.vtraceIndexedContext : null,
    policyAction: indexed.vtracePolicyAction,
  });
  if (indexed.vtracePolicyAction === "skip") {
    notes.push(
      "VTRACE selected no-context policy for this task. This is a valid policy decision, not an indexed-context "
      + "treatment. Token/cost comparison for this row measures the vtrace policy runner, not injected context.",
    );
  } else if (vtraceMethod === "local-patch" && vtraceTreatmentValid === false) {
    notes.push("Vtrace injection was skipped; this run is not a valid vtrace treatment.");
  } else if (vtraceMethod === "indexed-context" && vtraceTreatmentValid === false) {
    notes.push(
      indexed.vtraceIndexedContext === true
        ? "Vtrace injection was skipped; this run is not a valid indexed-context treatment."
        : "Vtrace indexed context was not generated; this run is not a valid indexed-context treatment.",
    );
  }

  return {
    vtraceMethod,
    vtracePatchInstalled,
    vtraceInstructionsFile: instructionsFile,
    vtraceInstructionsFileExists,
    vtraceInstructionsFileSize,
    vtraceInstructionsSnapshotFile: snapshotFile,
    vtraceInstructionsSnapshotExists,
    vtraceInstructionsSha256: snapshotSha256,
    vtraceInjectionObserved,
    vtraceInjectionError,
    vtraceTreatmentValid,
    ...indexed,
    // The context file path defaults to the instructions file when recorded.
    vtraceContextFile: indexed.vtraceContextFile ?? instructionsFile,
    notes,
  };
}

// Read the Stage 5B indexed-context fields out of a recorded vtrace _run.meta.json.
export function readIndexedContextFromMeta(meta: Record<string, unknown>): IndexedContextFields {
  const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
  const str = (value: unknown): string | null => (isString(value) ? value : null);
  const num = (value: unknown): number | null => (isNumber(value) ? value : null);
  const policy = (value: unknown): VtracePolicyAction | "unknown" | null =>
    value === "inject" || value === "skip" || value === "error" || value === "unknown"
      ? (value as VtracePolicyAction | "unknown")
      : null;
  const contextPolicy = (value: unknown): ContextPolicyAction | "unknown" | null =>
    value === "inject" || value === "no_context" || value === "unknown"
      ? (value as ContextPolicyAction | "unknown")
      : null;
  const contextPolicyOverride = (value: unknown): ContextPolicyOverride | "unknown" | null =>
    value === "auto" || value === "force-inject" || value === "force-no-context" || value === "unknown"
      ? (value as ContextPolicyOverride | "unknown")
      : null;
  const capsuleEngine = (value: unknown): CapsuleEngine | "unknown" | null =>
    // `v1` is read as its `legacy` alias; older runs may carry either spelling.
    value === "v1" ? "legacy"
      : value === "legacy" || value === "v2" || value === "unknown" ? (value as CapsuleEngine | "unknown") : null;
  const level = (value: unknown): ExpectedLevel | null =>
    value === "low" || value === "medium" || value === "high" ? (value as ExpectedLevel) : null;
  const pivotSourceMode = (value: unknown): CapsulePivotSourceMode | null =>
    value === "focused" || value === "full" || value === "missing" ? (value as CapsulePivotSourceMode) : null;
  // The recorded PIVOT_CHECK policy, tolerating older meta (an unknown/absent value
  // reads as null rather than a fabricated default).
  const pivotCheckPolicy = (value: unknown): PivotCheckPolicy | null =>
    PIVOT_CHECK_POLICIES.includes(value as PivotCheckPolicy) ? (value as PivotCheckPolicy) : null;
  // A list of decision-signal strings, tolerating partial/legacy meta (non-array
  // reads as null; non-string entries are dropped).
  const strList = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((v): v is string => isString(v)) : null;
  // Parse the recorded Capsule v2 selected items back into audit items, tolerating
  // partial/legacy meta (a non-array reads as null, a malformed item degrades).
  const auditItems = (value: unknown): CapsuleAuditItem[] | null => {
    if (!Array.isArray(value)) return null;
    return value.map((raw) => {
      const item = isRecord(raw) ? raw : {};
      return {
        path: isString(item.path) ? item.path : "",
        symbol: isString(item.symbol) ? item.symbol : "",
        roleReason: isString(item.roleReason) ? item.roleReason : null,
        estimatedTokens: isNumber(item.estimatedTokens) ? item.estimatedTokens : null,
      };
    });
  };
  return {
    vtraceIndexedContext: bool(meta.vtraceIndexedContext),
    vtraceIndexCommand: str(meta.vtraceIndexCommand),
    vtraceQueryCommand: str(meta.vtraceQueryCommand),
    vtraceWorkspacePath: str(meta.vtraceWorkspacePath),
    vtraceContextFile: str(meta.vtraceContextFile),
    vtraceContextChars: num(meta.vtraceContextChars),
    vtraceContextItems: num(meta.vtraceContextItems),
    vtraceContextTruncated: bool(meta.vtraceContextTruncated),
    vtraceContextError: str(meta.vtraceContextError),
    vtracePolicyAction: policy(meta.vtracePolicyAction),
    vtraceContextInjected: bool(meta.vtraceContextInjected),
    vtraceSkipReason: str(meta.vtraceSkipReason),
    vtracePivotCount: num(meta.vtracePivotCount),
    vtraceSupportCount: num(meta.vtraceSupportCount),
    vtraceContextPolicyAction: contextPolicy(meta.vtraceContextPolicyAction),
    vtraceContextPolicyOverride: contextPolicyOverride(meta.vtraceContextPolicyOverride),
    vtracePolicyReason: str(meta.vtracePolicyReason),
    vtraceContextPolicyDecisionSignals: strList(meta.vtraceContextPolicyDecisionSignals),
    expectedContextValue: level(meta.expectedContextValue),
    expectedOverheadRisk: level(meta.expectedOverheadRisk),
    vtraceCapsuleEngine: capsuleEngine(meta.vtraceCapsuleEngine),
    vtraceCapsuleIntent: str(meta.vtraceCapsuleIntent),
    vtraceCapsuleBudget: num(meta.vtraceCapsuleBudget),
    // Engine-migration audit fields. Old runs lack them: requested/effective fall
    // back to the recorded (effective) engine when present, fallback reason to null,
    // and compact-inspect-first to null (unknown) rather than a fabricated boolean.
    vtraceRequestedCapsuleEngine:
      meta.vtraceRequestedCapsuleEngine === undefined
        ? capsuleEngine(meta.vtraceCapsuleEngine)
        : capsuleEngine(meta.vtraceRequestedCapsuleEngine),
    vtraceEffectiveCapsuleEngine:
      meta.vtraceEffectiveCapsuleEngine === undefined
        ? capsuleEngine(meta.vtraceCapsuleEngine)
        : capsuleEngine(meta.vtraceEffectiveCapsuleEngine),
    vtraceCapsuleEngineFallbackReason: str(meta.vtraceCapsuleEngineFallbackReason),
    vtraceCompactInspectFirst:
      typeof meta.vtraceCompactInspectFirst === "boolean" ? meta.vtraceCompactInspectFirst : null,
    vtraceCapsulePivots: auditItems(meta.vtraceCapsulePivots),
    vtraceCapsuleSupport: auditItems(meta.vtraceCapsuleSupport),
    vtraceCapsuleTopPivotFile: str(meta.vtraceCapsuleTopPivotFile),
    vtraceCapsuleTopPivotSymbol: str(meta.vtraceCapsuleTopPivotSymbol),
    vtraceCapsuleActualMode: str(meta.vtraceCapsuleActualMode),
    vtraceCapsuleEstimatedTokens: num(meta.vtraceCapsuleEstimatedTokens),
    vtraceCapsuleTopPivotHasSource: bool(meta.vtraceCapsuleTopPivotHasSource),
    vtraceCapsulePivotSourceChars: num(meta.vtraceCapsulePivotSourceChars),
    vtraceCapsulePivotSourceMode: pivotSourceMode(meta.vtraceCapsulePivotSourceMode),
    vtraceCapsuleEditRiskDirectivesCount: num(meta.vtraceCapsuleEditRiskDirectivesCount),
    vtraceCapsuleLineAnchorResolutionUsed: bool(meta.vtraceCapsuleLineAnchorResolutionUsed),
    vtraceCapsuleSqlRenderingBackfillUsed: bool(meta.vtraceCapsuleSqlRenderingBackfillUsed),
    vtracePivotCheckEnabled: bool(meta.vtracePivotCheckEnabled),
    vtracePivotCheckInjected: bool(meta.vtracePivotCheckInjected),
    vtracePivotCheckDisabledByFlag: bool(meta.vtracePivotCheckDisabledByFlag),
    // Policy fields tolerate older metadata: an absent/unknown value reads as null,
    // never a fabricated default — so runs that predate --pivot-check-policy stay valid.
    vtracePivotCheckPolicy: pivotCheckPolicy(meta.vtracePivotCheckPolicy),
    vtracePivotCheckPolicyReason: str(meta.vtracePivotCheckPolicyReason),
    vtracePivotCheckRiskSignals: strList(meta.vtracePivotCheckRiskSignals),
    vtracePivotCheckWouldInjectUnderMultiPivot: bool(meta.vtracePivotCheckWouldInjectUnderMultiPivot),
    // EDIT_GUARD fields tolerate older metadata: bool() yields null when the field is
    // absent, so runs that predate EDIT_GUARD read as null (never a fabricated false).
    vtraceEditGuardEnabled: bool(meta.vtraceEditGuardEnabled),
    vtraceEditGuardInjected: bool(meta.vtraceEditGuardInjected),
    vtraceEditGuardDisabledByFlag: bool(meta.vtraceEditGuardDisabledByFlag),
    vtraceEditGuardTextPresent: bool(meta.vtraceEditGuardTextPresent),
    // PATCH_VERIFY fields tolerate older metadata: bool() yields null when the field is
    // absent, so runs that predate PATCH_VERIFY read as null (never a fabricated false).
    vtracePatchVerifyEnabled: bool(meta.vtracePatchVerifyEnabled),
    vtracePatchVerifyInjected: bool(meta.vtracePatchVerifyInjected),
    vtracePatchVerifyDisabledByFlag: bool(meta.vtracePatchVerifyDisabledByFlag),
    vtracePatchVerifyTextPresent: bool(meta.vtracePatchVerifyTextPresent),
  };
}

function summarize(
  rows: readonly Stage5Row[],
  pairs: readonly PairComparison[],
  missingResults: readonly MissingConditionResult[] = [],
): Stage5Summary {
  const bothResolved = pairs.filter((pair) => pair.outcome === "both_resolved");
  const vtraceRows = rows.filter((row) => row.condition === "vtrace");
  const countStatus = (status: RunStatus): number => rows.filter((row) => row.runStatus === status).length;
  const infraFailedCount = countStatus("infra_failed");
  const missingResultCount = missingResults.length;
  return {
    instanceCount: new Set(rows.map((row) => row.instanceId)).size,
    baselineRuns: rows.filter((row) => row.condition === "baseline").length,
    vtraceRuns: rows.filter((row) => row.condition === "vtrace").length,
    bothResolved: bothResolved.length,
    vtraceOnlyResolved: pairs.filter((pair) => pair.outcome === "vtrace_only_resolved").length,
    baselineOnlyResolved: pairs.filter((pair) => pair.outcome === "baseline_only_resolved").length,
    bothFailed: pairs.filter((pair) => pair.outcome === "both_failed").length,
    unpaired: pairs.filter((pair) => pair.outcome === "unpaired").length,
    unknown: pairs.filter((pair) => pair.outcome === "unknown").length,
    meanTokenReductionBothResolved: mean(bothResolved.map((pair) => pair.tokenReductionPct).filter(isNumber)),
    meanCostReductionBothResolved: mean(bothResolved.map((pair) => pair.costReductionPct).filter(isNumber)),
    meanDurationReductionBothResolved: mean(bothResolved.map((pair) => pair.durationReductionPct).filter(isNumber)),
    vtraceConditionRun: rows.some((row) => row.condition === "vtrace"),
    skipCount: vtraceRows.filter((row) => row.vtracePolicyAction === "skip").length,
    contextInjectedCount: vtraceRows.filter((row) => row.vtraceContextInjected === true).length,
    // A no-context row is a valid policy run that injected nothing — count it
    // SEPARATELY from injected-context rows so its efficiency deltas are never
    // advertised as a retrieval/injection win (Requirement 4). A row is
    // no_context when the gate said so OR the legacy skip mechanism recorded it.
    injectedContextCount: vtraceRows.filter((row) => row.vtraceContextInjected === true).length,
    noContextCount: vtraceRows.filter(
      (row) => row.vtraceContextPolicyAction === "no_context" || row.vtracePolicyAction === "skip",
    ).length,
    invalidTreatmentCount: vtraceRows.filter((row) => row.vtraceTreatmentValid === false).length,
    infraFailedCount,
    policySkipCount: countStatus("policy_skip"),
    agentFailedCount: countStatus("agent_failed"),
    completedPatchCount: countStatus("completed_patch"),
    completedNoPatchCount: countStatus("completed_no_patch"),
    missingResultCount,
    // A rerun is warranted for every infra failure and every missing result; a
    // completed/agent/skip row is a real attempt and is not re-run automatically.
    rerunRecommendedCount: infraFailedCount + missingResultCount,
  };
}

async function writeReports(config: CliConfig, artifact: NormalizedArtifact): Promise<void> {
  await writeFile(path.join(config.out, "stage5_vexp_swe_bench_smoke.csv"), renderCsv(artifact.rows));
  await writeFile(
    path.join(config.out, "stage5_vexp_swe_bench_smoke.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  await writeFile(
    path.join(config.out, "stage5_vexp_swe_bench_smoke.md"),
    renderMarkdown(artifact, config),
  );
}

export function renderCsv(rows: readonly Stage5Row[]): string {
  return `${[
    CSV_COLUMNS.join(","),
    ...rows.map((row) =>
      [
        row.instanceId,
        row.condition,
        cell(row.resolved),
        cell(row.costUsd),
        cell(row.durationMs),
        cell(row.inputTokens),
        cell(row.outputTokens),
        cell(row.cacheReadTokens),
        cell(row.cacheCreationTokens),
        cell(row.totalTokens),
        row.tokenAccountingMethod,
        cell(row.numTurns),
        cell(row.toolCallsTotal),
        cell(row.patchAvailable),
        row.vtraceMethod ?? "",
        row.vtraceInjectionObserved === null ? "" : String(row.vtraceInjectionObserved),
        row.vtraceIndexedContext === null ? "" : String(row.vtraceIndexedContext),
        row.vtraceTreatmentValid === null ? "" : String(row.vtraceTreatmentValid),
        row.vtracePolicyAction ?? "",
        row.vtraceContextPolicyAction ?? "",
        row.vtraceContextPolicyOverride ?? "",
        row.vtraceCapsuleEngine ?? "",
        row.vtraceCapsuleIntent ?? "",
        row.vtraceCapsuleBudget === null ? "" : String(row.vtraceCapsuleBudget),
        row.vtraceCapsuleActualMode ?? "",
        row.vtraceCapsuleEstimatedTokens === null ? "" : String(row.vtraceCapsuleEstimatedTokens),
        row.vtraceCapsuleTopPivotFile ?? "",
        row.vtraceCapsuleTopPivotSymbol ?? "",
        row.vtraceCapsuleTopPivotHasSource === null ? "" : String(row.vtraceCapsuleTopPivotHasSource),
        row.vtraceCapsulePivotSourceChars === null ? "" : String(row.vtraceCapsulePivotSourceChars),
        row.vtraceCapsulePivotSourceMode ?? "",
        row.vtraceCapsuleEditRiskDirectivesCount === null ? "" : String(row.vtraceCapsuleEditRiskDirectivesCount),
        row.vtraceCapsuleLineAnchorResolutionUsed === null ? "" : String(row.vtraceCapsuleLineAnchorResolutionUsed),
        row.vtraceCapsuleSqlRenderingBackfillUsed === null ? "" : String(row.vtraceCapsuleSqlRenderingBackfillUsed),
        formatCapsuleItemsCsv(row.vtraceCapsulePivots),
        formatCapsuleItemsCsv(row.vtraceCapsuleSupport),
        row.vtraceInstructionsSnapshotFile ?? "",
        row.vtraceInstructionsSha256 ?? "",
        row.vtracePolicyReason ?? "",
        (row.vtraceContextPolicyDecisionSignals ?? []).join("; "),
        row.expectedContextValue ?? "",
        row.expectedOverheadRisk ?? "",
        row.vtraceContextInjected === null ? "" : String(row.vtraceContextInjected),
        row.vtraceSkipReason ?? "",
        row.vtracePivotCount === null ? "" : String(row.vtracePivotCount),
        row.vtraceSupportCount === null ? "" : String(row.vtraceSupportCount),
        row.recommendedMode ?? "",
        row.actualCapsuleMode ?? "",
        row.targetConfidence ?? "",
        row.retrievalReason ?? "",
        row.searchBudget ?? "",
        row.searchBudgetReason ?? "",
        row.topLikelyFile ?? "",
        row.topLikelySymbol ?? "",
        row.likelyTargetsCount === null ? "" : String(row.likelyTargetsCount),
        row.finalEditedFile ?? "",
        row.finalEditedSymbol ?? "",
        row.containsFinalEditedFile === null ? "" : String(row.containsFinalEditedFile),
        row.containsFinalEditedSymbol === null ? "" : String(row.containsFinalEditedSymbol),
        row.pivotFile ?? "",
        row.firstReadFile === null ? "" : String(row.firstReadFile),
        row.firstEditFile === null ? "" : String(row.firstEditFile),
        row.didReadPivotBeforeSearch === null ? "" : String(row.didReadPivotBeforeSearch),
        row.didEditPivot === null ? "" : String(row.didEditPivot),
        row.searchCallsBeforePivot === null ? "" : String(row.searchCallsBeforePivot),
        row.vtraceContextChars === null ? "" : String(row.vtraceContextChars),
        row.vtraceContextItems === null ? "" : String(row.vtraceContextItems),
        row.runStatus ?? "",
        row.shouldRerun === null ? "" : String(row.shouldRerun),
        row.infraErrorStatus === null ? "" : String(row.infraErrorStatus),
        row.infraErrorKind ?? "",
        row.infraErrorMessage ?? "",
        row.error ?? "",
        row.rawResultPath,
        row.parserKind,
        row.notes.join("; "),
      ]
        .map(csvEscape)
        .join(","),
    ),
  ].join("\n")}\n`;
}

export function renderMarkdown(artifact: NormalizedArtifact, config: CliConfig): string {
  const { rows, pairs, summary } = artifact;
  const evidence = artifact.evidence ?? emptyEvidence();
  const lines: string[] = [
    "# Stage 5 vexp-swe-bench Smoke Benchmark",
    "",
    "## Scope",
    "",
    `> ${PUBLIC_CLAIM_DISCLAIMER}`,
    "",
    "Stage 5 is an external smoke benchmark. It does not claim that vtrace beats vexp, that vtrace has better SWE-bench pass@1, public leaderboard performance, full 100-task results, or statistical significance. It only checks whether the benchmark workflow runs on a tiny subset.",
    "",
    "## Setup",
    "",
    `- External benchmark dir: ${config.vexpSweBenchDir ?? "(not provided)"}`,
    `- CLI entry: ${config.cliEntry}`,
    `- vtrace method (recorded): ${evidence.vtraceMethod}`,
    `- vtrace method (requested): ${config.vtraceMethod}`,
    "",
    "See README.md for the full clone/setup workflow. vexp-swe-bench is not vendored.",
    "",
    "## Instance set",
    "",
    summary.instanceCount === 0
      ? "No instances have been ingested yet."
      : [...new Set(rows.map((row) => row.instanceId))].sort().map((id) => `- ${id}`).join("\n"),
    "",
    "## Baseline vs vtrace summary",
    "",
  ];

  if (!summary.vtraceConditionRun) {
    lines.push(
      "> Note: No vtrace condition results were found. Only the baseline condition has been ingested so far, so no baseline-vs-vtrace comparison is possible yet. Run `--mode run-vtrace` (with a documented vtrace method) and re-ingest.",
      "",
    );
  }

  lines.push(
    "| Metric | Value |",
    "| --- | ---: |",
    `| Instances | ${summary.instanceCount} |`,
    `| Baseline runs | ${summary.baselineRuns} |`,
    `| Vtrace runs | ${summary.vtraceRuns} |`,
    `| Vtrace context injected | ${summary.contextInjectedCount} |`,
    `| Vtrace skip policy | ${summary.skipCount} |`,
    `| Injected-context rows | ${summary.injectedContextCount} |`,
    `| No-context rows | ${summary.noContextCount} |`,
    `| Invalid treatments | ${summary.invalidTreatmentCount} |`,
    `| Both resolved | ${summary.bothResolved} |`,
    `| Vtrace only resolved | ${summary.vtraceOnlyResolved} |`,
    `| Baseline only resolved | ${summary.baselineOnlyResolved} |`,
    `| Both failed | ${summary.bothFailed} |`,
    `| Unpaired | ${summary.unpaired} |`,
    `| Unknown | ${summary.unknown} |`,
    `| Mean token reduction (both resolved) | ${formatPct(summary.meanTokenReductionBothResolved)} |`,
    `| Mean cost reduction (both resolved) | ${formatPct(summary.meanCostReductionBothResolved)} |`,
    `| Mean duration reduction (both resolved) | ${formatPct(summary.meanDurationReductionBothResolved)} |`,
    "",
    "## Vtrace injection evidence",
    "",
    ...renderVtraceEvidence(evidence),
    "",
    ...renderIndexedContextEvidence(evidence),
    ...renderConditionSummaryTable(artifact.conditionSummaries ?? []),
    ...renderEvaluationEvidence(artifact.evaluations ?? []),
    "## Result mode",
    "",
    describeResultMode(pairs, rows),
    "",
    "## Per-instance table (baseline vs vtrace)",
    "",
    renderPairTable(pairs),
    "",
    "## Per-instance comparison (baseline vs vtrace vs vexp)",
    "",
    renderTripleTable(pairs),
    "",
    "## Missing/unknown fields",
    "",
    renderUnknownFields(rows),
    "",
    ...renderRunStatusSection(artifact),
    "## Failures/errors",
    "",
    renderFailures(rows),
    "",
    "## Interpretation",
    "",
    "Pass/resolution is primary. Token, cost, and duration reductions are only meaningful for instances where both conditions resolved. A `vtrace_only_resolved` instance is a qualitative win even if tokens are higher. When all paired `resolved` values are `unknown`, this is a patch-generation smoke — patches were produced but not evaluated pass/fail — and must not be read as a win/loss. Any `unknown` field means the benchmark output did not expose that value; it was not guessed.",
    "",
    "## Next step",
    "",
    "If the workflow holds on this tiny subset, expand the instance set gradually and, separately, add an explicit vexp-enabled condition before making any vexp-vs-vtrace comparison. This smoke run does not authorize public SWE-bench claims.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

// Run-level injection evidence table plus a warning when local-patch was the
// method but the runtime injection was not actually observed (a no-op treatment).
function renderVtraceEvidence(evidence: Stage5RunEvidence): string[] {
  const lines = [
    "| Field | Value |",
    "| --- | --- |",
    `| vtrace_method | ${evidence.vtraceMethod} |`,
    `| vtrace_patch_installed | ${String(evidence.vtracePatchInstalled)} |`,
    // Audit display PREFERS the immutable per-run snapshot over the shared active
    // file (which a later run can overwrite), falling back to the active file when
    // no snapshot was recorded.
    `| vtrace_instructions_file | ${evidence.vtraceInstructionsSnapshotFile ?? evidence.vtraceInstructionsFile ?? "(none)"} |`,
    `| vtrace_instructions_file_exists | ${String(evidence.vtraceInstructionsFileExists)} |`,
    `| vtrace_instructions_file_size | ${evidence.vtraceInstructionsFileSize ?? "(n/a)"} |`,
    `| vtrace_instructions_snapshot_file | ${evidence.vtraceInstructionsSnapshotFile ?? "(none)"} |`,
    `| vtrace_instructions_snapshot_exists | ${String(evidence.vtraceInstructionsSnapshotExists)} |`,
    `| vtrace_instructions_sha256 | ${evidence.vtraceInstructionsSha256 ?? "(n/a)"} |`,
    `| vtrace_injection_observed | ${String(evidence.vtraceInjectionObserved)} |`,
    `| vtrace_injection_error | ${evidence.vtraceInjectionError ?? "(none)"} |`,
    `| vtrace_treatment_valid | ${String(evidence.vtraceTreatmentValid)} |`,
  ];
  if (evidence.vtraceMethod === "local-patch" && evidence.vtraceTreatmentValid !== true) {
    lines.push(
      "",
      "> ⚠️ Warning: Vtrace injection was skipped; this run is not a valid vtrace treatment. The recorded " +
        "vtrace method is `local-patch`, but no runtime injection was observed in the captured vtrace stderr " +
        `(\`${STAGE5_VTRACE_INJECTION_LOG} ...\` was not found). The vtrace condition ran WITHOUT the injected ` +
        "vtrace context, making it indistinguishable from baseline, so its token/cost/duration deltas must NOT " +
        "be advertised as vtrace performance. Confirm the patch is installed and that the instructions file " +
        "survives into the run, then re-run the vtrace condition until the injection log appears.",
    );
    if (evidence.vtraceInjectionError !== null) {
      lines.push("", `> Injection error: \`${evidence.vtraceInjectionError}\``);
    }
  }
  return lines;
}

// The lead Capsule v2 pivot as `path::symbol`, preferring the explicit top-pivot
// fields and falling back to the first recorded pivot item.
function formatTopPivot(evidence: Stage5RunEvidence): string {
  const file = evidence.vtraceCapsuleTopPivotFile ?? evidence.vtraceCapsulePivots?.[0]?.path ?? null;
  const symbol = evidence.vtraceCapsuleTopPivotSymbol ?? evidence.vtraceCapsulePivots?.[0]?.symbol ?? null;
  if (file === null && symbol === null) return "(none)";
  return `${file ?? "(unknown file)"}::${symbol ?? "(unknown symbol)"}`;
}

// Compact CSV serialisation of a Capsule v2 selected-item list: each item as
// `path::symbol`, joined by "; " (csvEscape quotes the cell). Empty off the v2
// engine / on baseline rows, so a single-cell column stays diff-friendly.
function formatCapsuleItemsCsv(items: readonly CapsuleAuditItem[] | null): string {
  if (items === null || items.length === 0) return "";
  return items.map((item) => `${item.path}::${item.symbol}`).join("; ");
}

// The distinct support file paths (deduped, order-preserving) for the audit table.
function formatSupportFiles(support: readonly CapsuleAuditItem[] | null): string {
  if (support === null || support.length === 0) return "(none)";
  const files = [...new Set(support.map((item) => item.path).filter((p) => p.length > 0))];
  return files.length > 0 ? files.join(", ") : "(none)";
}

// Render the Capsule v2 selected items (pivots first, then support) as a compact
// auditable list. Returns [] off the v2 engine / when nothing was selected.
function renderCapsuleItemList(evidence: Stage5RunEvidence): string[] {
  const pivots = evidence.vtraceCapsulePivots ?? [];
  const support = evidence.vtraceCapsuleSupport ?? [];
  if (pivots.length === 0 && support.length === 0) return [];
  const line = (role: string, item: CapsuleAuditItem): string => {
    const tokens = item.estimatedTokens === null ? "" : ` (~${item.estimatedTokens} tok)`;
    const reason = item.roleReason === null ? "" : ` — ${item.roleReason}`;
    return `- ${role}: \`${item.path}::${item.symbol}\`${tokens}${reason}`;
  };
  return [
    "### Capsule v2 selected items",
    "",
    ...pivots.map((item) => line("pivot", item)),
    ...support.map((item) => line("support", item)),
    "",
  ];
}

// Stage 5B evidence table. Only rendered when the run used (or recorded any)
// indexed-context, so plain local-patch / instructions-file runs are unaffected.
function renderIndexedContextEvidence(evidence: Stage5RunEvidence): string[] {
  if (evidence.vtraceMethod !== "indexed-context" && evidence.vtraceIndexedContext === null) return [];
  const lines = [
    "## Vtrace indexed context evidence",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| vtrace_method | ${evidence.vtraceMethod} |`,
    `| vtrace_policy_action | ${evidence.vtracePolicyAction ?? "(n/a)"} |`,
    // The cost-aware gate's decision in its own vocabulary (`inject`|`no_context`);
    // a recorded `skip` policy is reported here as `no_context`.
    `| vtrace_context_policy_action | ${evidence.vtraceContextPolicyAction ?? (evidence.vtracePolicyAction === "skip" ? "no_context" : evidence.vtracePolicyAction) ?? "(n/a)"} |`,
    `| vtrace_context_policy_override | ${evidence.vtraceContextPolicyOverride ?? "(n/a)"} |`,
    `| vtrace_capsule_engine | ${evidence.vtraceCapsuleEngine ?? "(n/a)"} |`,
    `| vtrace_capsule_intent | ${evidence.vtraceCapsuleIntent ?? "(n/a)"} |`,
    `| vtrace_capsule_budget | ${evidence.vtraceCapsuleBudget ?? "(n/a)"} |`,
    `| vtrace_capsule_actual_mode | ${evidence.vtraceCapsuleActualMode ?? "(n/a)"} |`,
    `| vtrace_capsule_estimated_tokens | ${evidence.vtraceCapsuleEstimatedTokens ?? "(n/a)"} |`,
    `| vtrace_capsule_top_pivot | ${formatTopPivot(evidence)} |`,
    `| vtrace_capsule_top_pivot_file | ${evidence.vtraceCapsuleTopPivotFile ?? evidence.vtraceCapsulePivots?.[0]?.path ?? "(none)"} |`,
    `| vtrace_capsule_top_pivot_symbol | ${evidence.vtraceCapsuleTopPivotSymbol ?? evidence.vtraceCapsulePivots?.[0]?.symbol ?? "(none)"} |`,
    `| vtrace_capsule_top_pivot_has_source | ${evidence.vtraceCapsuleTopPivotHasSource === null ? "(n/a)" : String(evidence.vtraceCapsuleTopPivotHasSource)} |`,
    `| vtrace_capsule_pivot_source_chars | ${evidence.vtraceCapsulePivotSourceChars ?? "(n/a)"} |`,
    `| vtrace_capsule_pivot_source_mode | ${evidence.vtraceCapsulePivotSourceMode ?? "(n/a)"} |`,
    `| vtrace_capsule_edit_risk_directives_count | ${evidence.vtraceCapsuleEditRiskDirectivesCount ?? "(n/a)"} |`,
    `| vtrace_capsule_line_anchor_resolution_used | ${evidence.vtraceCapsuleLineAnchorResolutionUsed === null ? "(n/a)" : String(evidence.vtraceCapsuleLineAnchorResolutionUsed)} |`,
    `| vtrace_capsule_sql_rendering_backfill_used | ${evidence.vtraceCapsuleSqlRenderingBackfillUsed === null ? "(n/a)" : String(evidence.vtraceCapsuleSqlRenderingBackfillUsed)} |`,
    `| vtrace_capsule_top_support_files | ${formatSupportFiles(evidence.vtraceCapsuleSupport)} |`,
    // Snapshot path + content hash, so the audit table names the exact immutable
    // record of what was injected (the active file may be overwritten by a later run).
    `| vtrace_instructions_snapshot_file | ${evidence.vtraceInstructionsSnapshotFile ?? "(none)"} |`,
    `| vtrace_instructions_sha256 | ${evidence.vtraceInstructionsSha256 ?? "(n/a)"} |`,
    `| vtrace_policy_reason | ${evidence.vtracePolicyReason ?? evidence.vtraceSkipReason ?? "(none)"} |`,
    `| vtrace_context_policy_decision_signals | ${(evidence.vtraceContextPolicyDecisionSignals ?? []).join(", ") || "(none)"} |`,
    `| expected_context_value | ${evidence.expectedContextValue ?? "(n/a)"} |`,
    `| expected_overhead_risk | ${evidence.expectedOverheadRisk ?? "(n/a)"} |`,
    `| vtrace_context_injected | ${evidence.vtraceContextInjected === null ? "(n/a)" : String(evidence.vtraceContextInjected)} |`,
    `| vtrace_indexed_context | ${String(evidence.vtraceIndexedContext)} |`,
    `| vtrace_skip_reason | ${evidence.vtraceSkipReason ?? "(none)"} |`,
    `| pivot_count | ${evidence.vtracePivotCount ?? "(n/a)"} |`,
    `| support_count | ${evidence.vtraceSupportCount ?? "(n/a)"} |`,
    `| vtrace_index_command | ${evidence.vtraceIndexCommand ?? "(none)"} |`,
    `| vtrace_query_command | ${evidence.vtraceQueryCommand ?? "(none)"} |`,
    `| vtrace_workspace_path | ${evidence.vtraceWorkspacePath ?? "(none)"} |`,
    `| vtrace_context_file | ${evidence.vtraceContextFile ?? "(none)"} |`,
    `| vtrace_context_chars | ${evidence.vtraceContextChars ?? "(n/a)"} |`,
    `| vtrace_context_items | ${evidence.vtraceContextItems ?? "(n/a)"} |`,
    `| vtrace_context_truncated | ${String(evidence.vtraceContextTruncated)} |`,
    `| vtrace_context_error | ${evidence.vtraceContextError ?? "(none)"} |`,
    `| vtrace_treatment_valid | ${String(evidence.vtraceTreatmentValid)} |`,
    "",
  ];
  // The exact Capsule v2 pivots/support that were injected (v2 runs only).
  lines.push(...renderCapsuleItemList(evidence));
  // A SKIP policy is a valid, intentional no-context decision — explain it
  // honestly rather than warning, so the row is not mistaken for a failed
  // treatment or read as injected-context performance.
  if (evidence.vtracePolicyAction === "skip") {
    lines.push(
      "> VTRACE selected no-context policy for this task. This is a valid policy decision, not an indexed-context "
        + "treatment. Token/cost comparison for this row measures the vtrace policy runner, not injected context.",
      "",
    );
    if (evidence.vtraceSkipReason !== null) {
      lines.push(`> Skip reason: \`${evidence.vtraceSkipReason}\``, "");
    }
  } else if (evidence.vtraceMethod === "indexed-context" && evidence.vtraceTreatmentValid !== true) {
    lines.push(
      evidence.vtraceIndexedContext === true
        ? "> ⚠️ Warning: Vtrace injection was skipped; this run is not a valid indexed-context treatment. The " +
            "indexed context was generated but was not observed being injected at runtime, so its deltas must NOT " +
            "be advertised as vtrace performance."
        : "> ⚠️ Warning: Vtrace indexed context was not generated; this run is not a valid indexed-context " +
            "treatment. The vtrace condition ran without real retrieval context, so its token/cost/duration " +
            "deltas must NOT be advertised as vtrace performance.",
      "",
    );
    if (evidence.vtraceContextError !== null) {
      lines.push(`> Context error: \`${evidence.vtraceContextError}\``, "");
    }
  }
  return lines;
}

// Resolution was never evaluated when all paired outcomes are "unknown"; say so
// plainly instead of letting an "unknown" outcome read like a pass/fail verdict.
function describeResultMode(pairs: readonly PairComparison[], rows: readonly Stage5Row[]): string {
  const pairedKnown = pairs.filter((pair) => pair.baselineResolved !== null && pair.vtraceResolved !== null);
  const allUnknownResolution = pairedKnown.length > 0 && pairedKnown.every((pair) => pair.outcome === "unknown");
  if (!allUnknownResolution) {
    return "Resolution pass/fail was evaluated for at least one paired instance; see the per-instance table.";
  }
  const patchesGenerated = rows.some((row) => row.patchAvailable === true);
  const patchClause = patchesGenerated
    ? "Patches were generated for both conditions but resolution was not evaluated."
    : "Resolution was not evaluated for any paired instance.";
  return (
    `This run is a **paired patch-generation smoke, not evaluated pass/fail**. ${patchClause} ` +
    "All paired `resolved` values are `unknown`, so this must NOT be read as a pass/fail or win/loss result. " +
    "Token/cost/duration deltas here describe effort, not correctness."
  );
}

function renderPairTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) return "No paired instances have been ingested yet.";
  // When the vtrace treatment is invalid (injection skipped) the efficiency
  // deltas are NOT vtrace performance, so we show "invalid" instead of a number.
  const reductionCell = (pair: PairComparison, value: number | null): string =>
    pair.vtraceTreatmentValid === false ? "invalid" : formatPct(value);
  return [
    "| instance | baseline resolved | vtrace resolved | outcome | treatment valid | baseline tokens | vtrace tokens | token reduction | cost reduction | duration reduction |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...pairs.map((pair) =>
      `| ${pair.instanceId} | ${cellOrDash(pair.baselineResolved)} | ${cellOrDash(pair.vtraceResolved)} | ${pair.outcome} | ${cellOrDash(pair.vtraceTreatmentValid)} | ${cellOrDash(pair.baselineTotalTokens)} | ${cellOrDash(pair.vtraceTotalTokens)} | ${reductionCell(pair, pair.tokenReductionPct)} | ${reductionCell(pair, pair.costReductionPct)} | ${reductionCell(pair, pair.durationReductionPct)} |`,
    ),
  ].join("\n");
}

// Stage 5C aggregate: one row per condition. resolved_rate is over EVALUATED
// instances only (the denominator is shown so `unknown` is never read as a fail).
function renderConditionSummaryTable(summaries: readonly ConditionSummary[]): string[] {
  if (summaries.length === 0) return [];
  const rate = (summary: ConditionSummary): string =>
    summary.resolvedRate === null ? "n/a" : `${(summary.resolvedRate * 100).toFixed(1)}% (${summary.resolvedCount}/${summary.evaluatedCount})`;
  const num = (value: number | null): string => (value === null ? "n/a" : value.toFixed(2));
  return [
    "## Per-condition aggregate",
    "",
    "| condition | instances | resolved | resolved_rate (of evaluated) | mean_cost | mean_duration_ms | mean_total_tokens | mean_tokens_resolved | mean_cost_resolved | valid_treatments | invalid_treatments |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaries.map((summary) =>
      `| ${summary.condition} | ${summary.instances} | ${summary.resolvedCount} | ${rate(summary)} | ${num(summary.meanCost)} | ${num(summary.meanDuration)} | ${num(summary.meanTotalTokens)} | ${num(summary.meanTokensForResolved)} | ${num(summary.meanCostForResolved)} | ${summary.validTreatments} | ${summary.invalidTreatments} |`,
    ),
    "",
  ];
}

// Stage 5C evaluation evidence: proves HOW resolved was reached (or why it is
// still unknown) per condition. Only rendered once an evaluate run has recorded it.
function renderEvaluationEvidence(evaluations: readonly EvaluationEvidence[]): string[] {
  if (evaluations.length === 0) {
    return [
      "## Evaluation evidence",
      "",
      "No evaluation has been run yet. `resolved` is `unknown` (patch-generation only) until " +
        "`--mode evaluate` runs the external `node dist/cli.js evaluate` step. `--eval-mode docker` is the only " +
        "real pass/fail signal; `lightweight` does not run tests.",
      "",
    ];
  }
  return [
    "## Evaluation evidence",
    "",
    "| condition | evaluation_ran | method | docker_used | instances_evaluated | resolved | error |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
    ...evaluations.map((evidence) =>
      `| ${evidence.condition} | ${String(evidence.evaluationRan)} | ${evidence.evaluationMethod} | ${String(evidence.dockerUsed)} | ${evidence.instancesEvaluated} | ${evidence.resolvedCount} | ${evidence.evaluationError ?? "(none)"} |`,
    ),
    "",
    ...(evaluations.some((evidence) => evidence.evaluationMethod === "lightweight")
      ? ["> ⚠️ Lightweight evaluation does not run tests; it is NOT a pass/fail signal. Use `--eval-mode docker`.", ""]
      : []),
  ];
}

// Stage 5C three-condition comparison (requirement #7 paired table). vexp columns
// are dashes until the vexp protocol is run with --allow-vexp.
function renderTripleTable(pairs: readonly PairComparison[]): string {
  if (pairs.length === 0) return "No paired instances have been ingested yet.";
  return [
    "| instance | baseline_resolved | vtrace_resolved | vexp_resolved | baseline_tokens | vtrace_tokens | vexp_tokens | vtrace_token_reduction | vexp_token_reduction | patch_diff_available |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...pairs.map((pair) =>
      `| ${pair.instanceId} | ${cellOrDash(pair.baselineResolved)} | ${cellOrDash(pair.vtraceResolved)} | ${cellOrDash(pair.vexpResolved)} | ${cellOrDash(pair.baselineTotalTokens)} | ${cellOrDash(pair.vtraceTotalTokens)} | ${cellOrDash(pair.vexpTotalTokens)} | ${pair.vtraceTreatmentValid === false ? "invalid" : formatPct(pair.tokenReductionPct)} | ${formatPct(pair.vexpTokenReductionPct)} | ${String(pair.patchDiffAvailable)} |`,
    ),
  ].join("\n");
}

function renderUnknownFields(rows: readonly Stage5Row[]): string {
  const withUnknown = rows
    .map((row) => ({ row, fields: unknownFieldsOf(row) }))
    .filter((entry) => entry.fields.length > 0);
  if (withUnknown.length === 0) return "No unknown fields; all expected fields were present in benchmark output.";
  return withUnknown.map((entry) => `- ${entry.row.instanceId}.${entry.row.condition}: ${entry.fields.join(", ")}`).join("\n");
}

function unknownFieldsOf(row: Stage5Row): string[] {
  const fields: Array<[string, Unknownable<unknown>]> = [
    ["resolved", row.resolved],
    ["cost_usd", row.costUsd],
    ["duration_ms", row.durationMs],
    ["input_tokens", row.inputTokens],
    ["output_tokens", row.outputTokens],
    ["cache_read_tokens", row.cacheReadTokens],
    ["cache_creation_tokens", row.cacheCreationTokens],
    ["total_tokens", row.totalTokens],
    ["num_turns", row.numTurns],
    ["tool_calls_total", row.toolCallsTotal],
    ["patch_available", row.patchAvailable],
  ];
  return fields.filter(([, value]) => value === "unknown").map(([name]) => name);
}

// Run-status / failures-and-errors section (Requirement 5): aggregate counts plus
// a per-row table for everything that needs attention (infra/agent failures and
// policy skips) and the artifact-aware list of missing condition results.
function renderRunStatusSection(artifact: NormalizedArtifact): string[] {
  const { summary, rows } = artifact;
  const missingResults = artifact.missingResults ?? [];
  const lines: string[] = [
    "## Run status",
    "",
    "| Status | Count |",
    "| --- | ---: |",
    `| infra_failed | ${summary.infraFailedCount} |`,
    `| agent_failed | ${summary.agentFailedCount} |`,
    `| policy_skip | ${summary.policySkipCount} |`,
    `| completed_patch | ${summary.completedPatchCount} |`,
    `| completed_no_patch | ${summary.completedNoPatchCount} |`,
    `| missing_condition_result | ${summary.missingResultCount} |`,
    `| rerun_recommended | ${summary.rerunRecommendedCount} |`,
    "",
  ];
  if (summary.infraFailedCount > 0) {
    lines.push(
      "> ⚠️ Infrastructure failures detected (e.g. Claude API 529 overloaded). These rows are EXCLUDED from " +
        "resolved-rate, token/cost/duration reductions, and per-condition means — an API failure is not a vtrace " +
        "treatment or model-solving result. Rerun the affected labels.",
      "",
    );
  }
  const attention = rows.filter(
    (row) => row.runStatus === "infra_failed" || row.runStatus === "agent_failed" || row.runStatus === "policy_skip",
  );
  if (attention.length > 0) {
    lines.push(
      "| instance | condition | run_status | should_rerun | infra_error_status | infra_error_kind | vtrace_policy_action | vtrace_skip_reason |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...attention.map(
        (row) =>
          `| ${row.instanceId} | ${row.condition} | ${row.runStatus} | ${row.shouldRerun === null ? "unknown" : String(row.shouldRerun)} | ${row.infraErrorStatus ?? "(n/a)"} | ${row.infraErrorKind ?? "(n/a)"} | ${row.vtracePolicyAction ?? "(n/a)"} | ${row.vtraceSkipReason ?? "(none)"} |`,
      ),
      "",
    );
  }
  if (missingResults.length > 0) {
    lines.push(
      "Missing condition results (artifacts present but no usable result row):",
      "",
      ...missingResults.map((entry) => `- ${entry.condition}: ${entry.reason}`),
      "",
    );
  }
  if (attention.length === 0 && missingResults.length === 0 && summary.infraFailedCount === 0) {
    lines.push("All ingested rows completed without infra/agent failures or policy skips.", "");
  }
  return lines;
}

function renderFailures(rows: readonly Stage5Row[]): string {
  const failures = rows.filter((row) => row.error !== null || row.resolved === false);
  if (failures.length === 0) return "No errors or unresolved instances recorded.";
  return failures
    .map((row) => `- ${row.instanceId}.${row.condition}: ${row.error ?? (row.resolved === false ? "unresolved" : "")}`)
    .join("\n");
}

// ----- low-level helpers ------------------------------------------------------

function renderCommand(spec: { command: string; args: readonly string[] }): string {
  return [spec.command, ...spec.args].join(" ");
}

function cell(value: Unknownable<unknown>): string {
  if (value === "unknown") return "unknown";
  if (value === null || value === undefined) return "";
  return String(value);
}

function cellOrDash(value: Unknownable<unknown> | null): string {
  if (value === null || value === undefined) return "—";
  return cell(value);
}

async function ensureOutputTree(outDir: string): Promise<void> {
  for (const subdir of ["raw/baseline", "raw/vtrace"]) {
    await mkdir(path.join(outDir, subdir), { recursive: true });
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    return null;
  }
}

// Live-output stdio for the vtrace INDEX child. The index's fancy single-line progress
// bar is TTY-only (src/cli/progress.ts: selectProgressReporter requires stderr.isTTY).
//   - TTY  → inherit: the child sees our real terminal and draws its FANCY bar.
//   - pipe → capture quietly: a \r-bar cannot render through a pipe (`… | tee`), and
//            the verbose per-file fallback ([read] N/M …) is just noise — so we do NOT
//            force VTRACE_PROGRESS_STREAM and the index stays silent (nullReporter).
// `--quiet` is dropped from the index args either way so the TTY bar is never gated off.
function liveIndexRunOptions(): { inheritStdio?: boolean } {
  return process.stderr.isTTY === true ? { inheritStdio: true } : {};
}

// Live-output stdio for git clone. Clone progress (`git --progress`: "Receiving
// objects: X%") is a single compact \r line, not per-file spam, so it is worth showing
// even when piped: TTY → inherit (native), pipe → tee (echo + capture for errors).
function liveGitRunOptions(): { inheritStdio?: boolean; streamToTerminal?: boolean } {
  return process.stderr.isTTY === true ? { inheritStdio: true } : { streamToTerminal: true };
}

// Print, at most once per process, why the fancy TTY progress bar is unavailable when
// our output is piped (e.g. `… | tee log`): the bar needs a real terminal, so indexing
// runs quietly instead of dumping the verbose per-file fallback.
let operatorTtyHintPrinted = false;
function operatorTtyHintOnce(): void {
  if (operatorTtyHintPrinted || process.stderr.isTTY === true) return;
  operatorTtyHintPrinted = true;
  process.stderr.write(
    "[stage5] output is piped (no TTY) — indexing runs quietly (the fancy progress bar needs a real " +
      "terminal). For the live bar, run without `| tee`, or keep a log via a pseudo-TTY: " +
      "`script -qefc '<command>' run.log`.\n",
  );
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly inheritStdio?: boolean;
    // Tee mode: capture stdout/stderr into buffers (for archival + telemetry) AND
    // echo each chunk to our own terminal live as it arrives. Unlike inheritStdio
    // (which hands over the real TTY but leaves the captured buffers empty), this
    // keeps the result populated — used when we need BOTH live visibility and a
    // captured copy (e.g. the agent child, whose stderr telemetry we still parse).
    readonly streamToTerminal?: boolean;
  } = {},
): Promise<ProcessResult> {
  return await new Promise((resolve) => {
    // Inherit mode hands the child our real terminal, so it renders interactive
    // output (a TTY progress bar) directly; there are then no pipes to capture,
    // and stdout/stderr come back empty. Otherwise capture both into buffers.
    const inherit = options.inheritStdio === true;
    const tee = !inherit && options.streamToTerminal === true;
    const proc = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (tee) process.stdout.write(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (tee) process.stderr.write(chunk);
    });
    proc.on("error", (error) =>
      resolve({ exitCode: 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: `${Buffer.concat(stderrChunks).toString("utf8")}${error.message}` }),
    );
    proc.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8") }),
    );
  });
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatPct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(2)}%`;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isVtraceMethod(value: string): value is VtraceMethod {
  return value === "instructions-file" || value === "mcp" || value === "local-patch" || value === "indexed-context";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  const config = { ...DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--mode": {
        const value = requireValue(argv, ++index, arg);
        if (
          ![
            "prepare",
            "run-baseline",
            "run-vtrace",
            "run-vexp",
            "run-protocol",
            "evaluate",
            "ingest",
            "report",
            "aggregate-runs",
            "install-vtrace-patch",
            "verify-vtrace-patch",
          ].includes(value)
        )
          throw new Error("Invalid --mode.");
        config.mode = value as Stage5Mode;
        break;
      }
      case "--protocol": {
        const value = requireValue(argv, ++index, arg);
        if (!["baseline", "vtrace-indexed", "vexp", "all"].includes(value)) throw new Error("Invalid --protocol.");
        config.protocol = value as Stage5Protocol;
        break;
      }
      case "--allow-vexp": config.allowVexp = true; break;
      case "--eval-mode": {
        const value = requireValue(argv, ++index, arg);
        if (!["docker", "lightweight"].includes(value)) throw new Error("Invalid --eval-mode.");
        config.evalMode = value as EvalMode;
        break;
      }
      case "--eval-dataset": config.evalDataset = requireValue(argv, ++index, arg); break;
      case "--eval-timeout": config.evalTimeout = requirePositiveInt(argv, ++index, arg); break;
      case "--vexp-swe-bench-dir": config.vexpSweBenchDir = requireValue(argv, ++index, arg); break;
      case "--instances": config.instances = requireValue(argv, ++index, arg).split(",").map((value) => value.trim()).filter(Boolean); break;
      case "--instances-file": config.instancesFile = requireValue(argv, ++index, arg); break;
      case "--out": config.out = requireValue(argv, ++index, arg); break;
      case "--node-command": config.nodeCommand = requireValue(argv, ++index, arg); break;
      case "--cli-entry": config.cliEntry = requireValue(argv, ++index, arg); break;
      case "--vtrace-method": {
        const value = requireValue(argv, ++index, arg);
        if (!["instructions-file", "mcp", "local-patch", "indexed-context"].includes(value)) throw new Error("Invalid --vtrace-method.");
        config.vtraceMethod = value as VtraceMethod;
        break;
      }
      case "--vtrace-command": config.vtraceCommand = requireValue(argv, ++index, arg); break;
      case "--vtrace-index-args": config.vtraceIndexArgs = requireValue(argv, ++index, arg); break;
      case "--vtrace-query-args": config.vtraceQueryArgs = requireValue(argv, ++index, arg); break;
      case "--skip-vtrace-index-if-present": config.skipVtraceIndexIfPresent = true; break;
      case "--reuse-workspace": config.reuseWorkspace = true; break;
      case "--index-policy": {
        const value = requireValue(argv, ++index, arg);
        if (!["auto", "always", "reuse"].includes(value)) throw new Error("Invalid --index-policy (expected auto|always|reuse).");
        config.indexPolicy = value as Stage5IndexPolicy;
        break;
      }
      case "--show-vtrace-index-log": config.showVtraceIndexLog = true; break;
      case "--vtrace-context-max-chars": config.vtraceContextMaxChars = requirePositiveInt(argv, ++index, arg); break;
      case "--vtrace-context-max-items": config.vtraceContextMaxItems = requirePositiveInt(argv, ++index, arg); break;
      case "--context-policy": {
        const value = requireValue(argv, ++index, arg);
        if (!["auto", "force-inject", "force-no-context"].includes(value)) throw new Error("Invalid --context-policy.");
        config.contextPolicyOverride = value as ContextPolicyOverride;
        break;
      }
      case "--capsule-engine": {
        const value = requireValue(argv, ++index, arg);
        // `v1` is an explicit alias for the `legacy` engine so callers can force
        // the legacy fallback with the same v1/v2 vocabulary. `v2` is the default.
        const normalized = value === "v1" ? "legacy" : value;
        if (!["legacy", "v2"].includes(normalized)) throw new Error("Invalid --capsule-engine (expected v2, v1, or legacy).");
        config.capsuleEngine = normalized as CapsuleEngine;
        break;
      }
      case "--capture-product-v2-accounting":
        config.captureProductV2Accounting = true;
        break;
      case "--capsule-intent": {
        const value = requireValue(argv, ++index, arg);
        // Route through the canonical parser so the harness flag maps through the
        // exact same normalized vocabulary every other surface uses.
        const parsed = parseCapsuleIntent(value);
        if (parsed === undefined) {
          throw new Error("Invalid --capsule-intent.");
        }
        config.capsuleIntent = parsed as CapsuleV2Intent;
        break;
      }
      case "--capsule-budget": config.capsuleBudget = requirePositiveInt(argv, ++index, arg); break;
      case "--pivot-check-policy": {
        const value = requireValue(argv, ++index, arg);
        if (!PIVOT_CHECK_POLICIES.includes(value as PivotCheckPolicy)) {
          throw new Error("Invalid --pivot-check-policy (expected off|multi_pivot|risk_gated|strict_risk_gated|always).");
        }
        config.pivotCheckPolicy = value as PivotCheckPolicy;
        break;
      }
      case "--pivot-check-gate": {
        const value = requireValue(argv, ++index, arg);
        if (!PIVOT_CHECK_GATE_MODES.includes(value as PivotCheckGateMode)) {
          throw new Error("Invalid --pivot-check-gate (expected off|hard).");
        }
        config.pivotCheckGate = value as PivotCheckGateMode;
        break;
      }
      case "--pivot-check-gate-phase1-only": config.pivotCheckGatePhase1Only = true; break;
      case "--disable-pivot-check": config.disablePivotCheck = true; break;
      case "--disable-edit-guard": config.disableEditGuard = true; break;
      case "--disable-patch-verify": config.disablePatchVerify = true; break;
      case "--disable-tool-use-discipline": config.disableToolUseDiscipline = true; break;
      case "--disable-token-discipline": config.disableTokenDiscipline = true; break;
      case "--swe-bench-data": config.sweBenchDataFile = requireValue(argv, ++index, arg); break;
      case "--run-label": config.runLabel = requireValue(argv, ++index, arg); break;
      case "--run-labels":
        config.runLabels = requireValue(argv, ++index, arg).split(",").map((value) => value.trim()).filter(Boolean);
        break;
      case "--yes": config.yes = true; break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    ...config,
    vexpSweBenchDir: config.vexpSweBenchDir === null ? null : path.resolve(config.vexpSweBenchDir),
    instancesFile: path.resolve(config.instancesFile),
    out: path.resolve(config.out),
    sweBenchDataFile: config.sweBenchDataFile === null ? null : path.resolve(config.sweBenchDataFile),
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function requirePositiveInt(argv: readonly string[], index: number, flag: string): number {
  const value = Number.parseInt(requireValue(argv, index, flag), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} requires a positive integer.`);
  return value;
}

function printUsageAndExit(exitCode: number): never {
  process.stdout.write(
    [
      "Usage: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\",
      "  --mode prepare|run-baseline|run-vtrace|run-vexp|run-protocol|evaluate|ingest|report|aggregate-runs|install-vtrace-patch|verify-vtrace-patch \\",
      "  --vexp-swe-bench-dir /path/to/vexp-swe-bench --instances id1,id2,id3 --out benchmarks/stage5_vexp_swe_bench_smoke/results",
      "",
      "Stage 5C protocol/evaluation flags:",
      "  --protocol baseline|vtrace-indexed|vexp|all   (with --mode run-protocol)",
      "  --allow-vexp                                  required before any vexp-enabled run",
      "  --eval-mode docker|lightweight                (with --mode evaluate; docker is the only real signal)",
      "  --eval-dataset <jsonl-or-hf-name>             full SWE-bench dataset for docker evaluation",
      "  --eval-timeout <seconds>                      per-instance evaluation timeout",
      "  --run-label <label>                           isolate runs under results/runs/<label>/",
      "  --reuse-workspace                             reuse an existing labeled workspace by RESETTING it to the SWE-bench base commit and running git clean -fdx (never pulls main; reuses a fresh index per --index-policy) instead of redownloading the repo",
      "  --index-policy auto|always|reuse              reuse a fingerprint-fresh index (auto), force rebuild (always), or keep a stale index (reuse). default: auto",
      "  --show-vtrace-index-log                       print the vtrace index log to the terminal (drops --quiet)",
      "  --context-policy auto|force-inject|force-no-context   override the cost-aware context gate (default: auto)",
      "  --capsule-engine legacy|v2                    capsule retrieval engine for indexed-context (default: legacy)",
      "  --capsule-intent auto|debug|modify|refactor|impact|explain|test-failure   Capsule v2 intent (default: auto; v2 only)",
      "  --capsule-budget <tokens>                     Capsule v2 token budget (default: 8000; v2 only)",
      "  --pivot-check-policy off|multi_pivot|risk_gated|strict_risk_gated|always   when to inject PIVOT_CHECK (default: strict_risk_gated — inject only on a STRONG risk signal, rejecting hidden_pivot-only and two ordinary pivots; risk_gated injects on any high-risk signal)",
      "  --pivot-check-gate off|hard                   opt-in HARD two-phase context-to-action gate (default: off). 'hard' runs a READ-ONLY inspect-only Phase-1 preflight (mutation tools denied) whose checklist is verified before any Phase-2 solve; on a failed gate Phase 2 never runs (no solve, no Docker). v2 indexed-context only; orthogonal to --pivot-check-policy",
      "  --pivot-check-gate-phase1-only                 (with --pivot-check-gate hard) run only the read-only Phase-1 preflight + gate, then STOP — Phase 2 never runs even on a pass. Canary to prove the read-only preflight can pass without editing",
      "  --disable-pivot-check                         force PIVOT_CHECK policy off for a controlled before run (compatibility; equivalent to --pivot-check-policy off)",
      "  --disable-edit-guard                          suppress the EDIT_GUARD block (rides with PIVOT_CHECK) for a PIVOT_CHECK-only before run (default: EDIT_GUARD on)",
      "  --disable-patch-verify                        suppress the PATCH_VERIFY checkpoint (rides with PIVOT_CHECK, after EDIT_GUARD; independent of EDIT_GUARD) (default: PATCH_VERIFY on)",
      "  --disable-tool-use-discipline                 benchmark/dev-only: suppress the shared anti-loop tool-use-discipline block injected into BOTH baseline and vtrace prompts (default: injected). Not a user-facing product mode",
      "  --disable-token-discipline                    benchmark/dev-only: suppress the vtrace-only STAGE5_TOKEN_DISCIPLINE turn-count reduction policy (strong-context patch-first / weak-context explore) (default: injected). Not a user-facing product mode",
      "  --run-labels a,b,c                            (with --mode aggregate-runs) combine those run-labels into results/aggregate/",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function main(config: CliConfig): Promise<void> {
  switch (config.mode) {
    case "prepare": await runPrepare(config); break;
    case "run-baseline": await runBaseline(config); break;
    case "run-vtrace":
      if (config.pivotCheckGate === "hard") await runVtraceHardGate(config);
      else await runVtrace(config);
      break;
    case "run-vexp": await runVexp(config); break;
    case "run-protocol": await runProtocol(config); break;
    case "evaluate": {
      const evaluations = await runEvaluate(config);
      process.stdout.write(`${JSON.stringify(evaluations, null, 2)}\n`);
      break;
    }
    case "ingest": await runIngest(config); break;
    case "report": await runReport(config); break;
    case "aggregate-runs": {
      const artifact = await runAggregateRuns(config);
      process.stdout.write(`${JSON.stringify(artifact.summary, null, 2)}\n`);
      break;
    }
    case "install-vtrace-patch": {
      const manifest = await installVtracePatch(config);
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      break;
    }
    case "verify-vtrace-patch": {
      const verification = await verifyVtracePatch(config);
      process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
      if (!verification.installed) process.exitCode = 1;
      break;
    }
  }
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

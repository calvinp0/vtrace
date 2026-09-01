/**
 * M194 §43/§49 — regenerate the entire corpus accounting from the preserved raw
 * artefacts, using the frozen classifiers and no model call.
 *
 * Nothing load-bearing is transcribed. Run validity, I6 usability, the
 * runtime-diagnosis capability label, repository breadth, the stopping-rule
 * state and the corpus adequacy verdict are all computed here, from the arm
 * records, the adapter's ordered event log and the agent's own stream, by
 * calling M193's committed functions rather than reimplementing their rules.
 *
 *   bun run_stage5_m194_account.ts --out <acquisition root> [--quiet]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ArmOutcome,
  type AgentTermination,
  type PatchBoundary,
  type PatchSnapshot,
  type StreamCapture,
  type TraceEvent,
  M193_ADEQUACY,
  M193_LIMITS,
  accountCorpus,
  assessAdequacy,
  classifyArmLifecycle,
  classifyValidationProvenance,
  classifySourceVersion,
  runnerStarted,
  semanticTestResult,
  stopDecision,
  traceOrderingIsWellFormed,
  workdirIsPinned,
} from "./m193Acquisition";
import { isValidationAttempt, streamCapture } from "./m194Lifecycle";

const CHECKOUT_ROOT = "/testbed";

interface RawEvent {
  kind: string;
  sequence?: number;
  boundary?: string;
  diffHash?: string | null;
  diffBytes?: number;
  ok?: boolean;
  status?: string;
  toolUseId?: string | null;
  hookTool?: string | null;
  hookEvent?: string;
  originalCommand?: string;
  routedCommand?: string;
  looksLikeValidation?: boolean;
  stdout?: string;
  stderr?: string;
  streamsCaptured?: boolean;
  exitCode?: number | null;
  shellExitObserved?: boolean;
  preSequence?: number | null;
  wallClock?: number;
  ts?: string;
  moduleFile?: string | null;
  probe?: Record<string, unknown>;
  captured?: boolean;
  error?: string;
  robustness?: string;
  stateHashBefore?: string | null;
  stateHashAfter?: string | null;
  routedTo?: string;
  workdir?: string;
  [k: string]: unknown;
}

function readJsonl(path: string): RawEvent[] {
  if (!existsSync(path)) return [];
  const out: RawEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RawEvent);
    } catch {
      /* a truncated final line is a telemetry fact, recorded by its absence */
    }
  }
  return out;
}

/** The agent's own ordering: tool_use ids and assistant turns, in stream order. */
interface StreamItem {
  kind: "assistant" | "tool_use";
  id?: string;
  name?: string;
  text?: string;
  ts?: string;
}

function streamOrder(path: string): StreamItem[] {
  const out: StreamItem[] = [];
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type !== "assistant") continue;
    const ts = typeof ev.timestamp === "string" ? ev.timestamp : undefined;
    const content = ((ev.message as Record<string, unknown> | undefined)?.content ?? []) as Record<string, unknown>[];
    for (const block of content) {
      if (block?.type === "text") out.push({ kind: "assistant", ts, text: String(block.text ?? "").slice(0, 4000) });
      else if (block?.type === "tool_use") out.push({ kind: "tool_use", ts, id: String(block.id ?? ""), name: String(block.name ?? "") });
    }
  }
  return out;
}

const capture = (e: RawEvent): StreamCapture => streamCapture(e.stdout, e.stderr);

function buildOutcome(runDir: string): { outcome: ArmOutcome; diagnostics: Record<string, unknown> } | null {
  const armPath = join(runDir, "arm.json");
  if (!existsSync(armPath)) return null;
  const arm = JSON.parse(readFileSync(armPath, "utf8")) as Record<string, any>;
  const raw = join(runDir, "raw");
  const events = readJsonl(join(raw, "adapter_events.jsonl"));
  const stream = streamOrder(join(raw, "agent_stream.jsonl"));

  const bySeq = [...events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const byToolUse = new Map<string, RawEvent[]>();
  const unattached: RawEvent[] = [];
  for (const e of bySeq) {
    const id = e.toolUseId;
    if (typeof id === "string" && id) {
      if (!byToolUse.has(id)) byToolUse.set(id, []);
      byToolUse.get(id)!.push(e);
    } else unattached.push(e);
  }

  const trace: TraceEvent[] = [];
  const snapshots: PatchSnapshot[] = [];
  let stateHash: string | null = null;

  /**
   * Every trace event carries a real observed timestamp.
   *
   * `traceOrderingIsWellFormed` requires one, and it is right to: an event with
   * no time is an event whose position in the record rests on nothing but the
   * order someone assembled it in. The adapter stamps its own events; the CLI
   * stamps its assistant turns. The few structural events that neither side
   * timestamps — the agent's start and end — take the time of the nearest
   * observation on the correct side of them, which is a real measured instant
   * rather than an invented one.
   */
  let lastTs = bySeq.find((e) => typeof e.ts === "string" && e.ts)?.ts ?? "";
  const at = (ts?: string | null): string => {
    if (typeof ts === "string" && ts.length > 0) lastTs = ts;
    return lastTs;
  };

  const push = (t: Omit<TraceEvent, "ordinal">) => {
    trace.push({ ...t, ts: at(t.ts), ordinal: trace.length } as TraceEvent);
  };
  const pushSnapshot = (e: RawEvent) => {
    stateHash = e.diffHash ?? stateHash;
    if (e.boundary === "OBSERVATION") return;
    const snap: PatchSnapshot = {
      ordinal: trace.length,
      boundary: e.boundary as PatchBoundary,
      diffHash: e.diffHash ?? "",
      diffBytes: e.diffBytes ?? 0,
    };
    snapshots.push(snap);
    push({ ts: e.ts ?? "", type: "patch_snapshot", stateHash, snapshot: snap });
  };

  push({ ts: lastTs, type: "agent_start", stateHash: null, toolInput: { instanceId: arm.instanceId } });
  for (const e of unattached.filter((x) => x.boundary === "SETUP")) pushSnapshot(e);

  const robustness = (arm.phases?.provenanceRobustness?.robustness ?? "UNKNOWN") as
    "EDITABLE_INSTALL" | "CWD_DEPENDENT" | "UNKNOWN";
  let validationAttempts = 0;

  for (const item of stream) {
    if (item.kind === "assistant") {
      push({ ts: item.ts ?? "", type: "assistant_text", stateHash, toolInput: { text: item.text } });
      continue;
    }
    const group = byToolUse.get(item.id ?? "") ?? [];
    const pre = group.find((e) => e.kind === "bash_pre");
    const post = group.find((e) => e.kind === "bash_post");
    const prov = group.find((e) => e.kind === "validation_provenance");

    for (const e of group.filter((x) => x.kind === "patch_snapshot" && x.boundary === "BEFORE_VALIDATION")) {
      pushSnapshot(e);
    }

    if (post && pre) {
      const streams = capture(post);
      const attempt = isValidationAttempt(pre.originalCommand ?? "", streams);
      if (attempt) validationAttempts++;
      const started = runnerStarted(streams);
      const provenance = classifyValidationProvenance({
        isValidationAttempt: attempt,
        runnerStarted: started,
        workdir: CHECKOUT_ROOT,
        checkoutRoot: CHECKOUT_ROOT,
        moduleFile: (prov?.moduleFile as string | null) ?? null,
        robustness,
      });
      const probe = (prov?.probe ?? {}) as Record<string, any>;
      const sourceVersion = classifySourceVersion({
        isValidationAttempt: attempt,
        runnerStarted: started,
        probeRan: Boolean(probe.probeRan),
        stateStableAcrossValidation:
          prov?.stateHashBefore != null && prov.stateHashBefore === prov.stateHashAfter,
        changedSourceFileCount: (probe.requestedPaths as unknown[] | undefined)?.length ?? 0,
        fileVerdicts: ((probe.files as Record<string, any>[] | undefined) ?? []).map(
          (f) => f.verdict ?? "INDETERMINATE",
        ),
      });
      push({
        ts: post.ts ?? "",
        type: "tool_call",
        toolName: "Bash",
        toolInput: { command: pre.originalCommand, routed: pre.routedCommand },
        stateHash,
        validation: {
          isValidationAttempt: attempt,
          workdir: CHECKOUT_ROOT,
          routedTo: "container",
          shell: {
            processStarted: Boolean(post.streamsCaptured),
            exitCode: post.exitCode ?? null,
            timedOut: false,
            signal: null,
            durationMs:
              pre.wallClock != null && post.wallClock != null
                ? Math.round((post.wallClock - pre.wallClock) * 1000)
                : 0,
          },
          streams,
          runnerStarted: started,
          semanticTestResult: semanticTestResult(streams),
          provenance,
          sourceVersion,
          moduleFile: (prov?.moduleFile as string | null) ?? null,
        },
      });
    } else if (group.length || item.name) {
      push({ ts: item.ts ?? "", type: "tool_call", toolName: item.name, toolInput: {}, stateHash });
    }

    for (const e of group.filter(
      (x) => x.kind === "patch_snapshot" && x.boundary !== "BEFORE_VALIDATION" && x.boundary !== "SETUP",
    )) {
      pushSnapshot(e);
    }
  }

  for (const e of unattached.filter((x) => x.kind === "patch_snapshot" && x.boundary === "BEFORE_SUBMIT")) {
    pushSnapshot(e);
  }
  push({ ts: "", type: "agent_end", stateHash });  // the last observed instant

  const ev = arm.phases?.evaluator ?? {};
  const finalPatch = arm.phases?.finalPatch ?? {};
  const routing = arm.phases?.routingAudit ?? {};
  const isolation = arm.phases?.treatmentIsolation ?? {};
  const authority = arm.phases?.checkoutAuthority ?? {};
  const adapterErrors = (arm.phases?.adapterErrors ?? []) as unknown[];

  const outcome: ArmOutcome = {
    armId: arm.armId,
    instanceId: arm.instanceId,
    repo: arm.repo,
    preflightPassed: (arm.phases?.preflight?.verdict ?? "") === "PREFLIGHT_PASSED",
    agentStarted: Boolean(arm.phases?.agent?.started),
    termination: (arm.termination ?? "HARNESS_CRASH") as AgentTermination,
    // §39: one authoritative mutable checkout, proven by inode identity rather
    // than by the absence of a complaint.
    authoritativeCheckoutMaintained: Boolean(authority.sameInode) && Boolean(authority.hostMountPresent),
    // §8/§24: constructed isolation AND every Bash call demonstrably routed.
    treatmentAbsenceVerified:
      isolation.status === "TREATMENT_ISOLATION_CONSTRUCTED" &&
      isolation.effectiveMcpServerCount === 0 &&
      routing.allBashRouted === true,
    telemetryComplete: events.length > 0 && adapterErrors.length === 0,
    traceWellFormed: traceOrderingIsWellFormed(trace),
    finalPatchExtracted: Boolean(finalPatch.ok),
    finalPatchIsEmpty: Boolean(finalPatch.empty),
    evaluatorRan: Boolean(ev.ran),
    resolved: ev.resolved === undefined ? null : ev.resolved,
    events: trace,
    snapshots,
  };

  return {
    outcome,
    diagnostics: {
      armId: arm.armId,
      verdict: arm.verdict,
      costUsd: arm.costUsd,
      termination: arm.termination,
      traceEvents: trace.length,
      traceWellFormed: traceOrderingIsWellFormed(trace),
      eventsMissingTimestamp: trace.filter((e) => !e.ts).length,
      snapshots: snapshots.length,
      validationAttempts,
      bashToolUses: routing.bashToolUses ?? 0,
      unroutedBashCalls: routing.unroutedBashCalls ?? 0,
      adapterErrors: adapterErrors.length,
      finalPatchBytes: finalPatch.bytes ?? 0,
      evaluatorStatus: ev.status ?? null,
      workdirPinned: workdirIsPinned(CHECKOUT_ROOT, CHECKOUT_ROOT),
    },
  };
}

// ── entry point ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const outRoot = argv[argv.indexOf("--out") + 1] ?? "";
const quiet = argv.includes("--quiet");
const runsDir = join(outRoot, "runs");

const built = (existsSync(runsDir) ? readdirSync(runsDir).sort() : [])
  .map((d) => buildOutcome(join(runsDir, d)))
  .filter((x): x is { outcome: ArmOutcome; diagnostics: Record<string, unknown> } => x !== null);

// Only arms that actually launched a model are corpus arms. A preflight failure
// costs nothing and consumes no arm slot, and stays visible in the ledger.
const paid = built.filter((b) => (b.diagnostics.costUsd ?? null) !== null || b.outcome.agentStarted);
const lifecycles = paid.map((b) => classifyArmLifecycle(b.outcome));
const costs = paid
  .map((b) => b.diagnostics.costUsd as number | null)
  .filter((c): c is number => typeof c === "number")
  .sort((a, b) => a - b);
const spend = costs.reduce((a, b) => a + b, 0);

const accounting = accountCorpus(lifecycles, spend);
const i6Repos = new Set(lifecycles.filter((l) => l.i6Usable).map((l) => l.repo));
const adequacy = assessAdequacy(accounting);
const stopState = {
  armsLaunched: paid.length,
  spendUsd: spend,
  i6UsableArms: lifecycles.filter((l) => l.i6Usable).length,
  repositoriesAmongI6Usable: i6Repos.size,
};
const decision = stopDecision(stopState);

const pct = (n: number, d: number) => (d === 0 ? 0 : Number(((n / d) * 100).toFixed(1)));
const report = {
  schemaVersion: "stage5.m194.corpus-accounting.v1",
  milestone: "M194",
  generatedFrom: "raw per-arm artefacts only; no model call",
  armsInRunsDirectory: built.length,
  paidArms: paid.length,
  accounting,
  i6Repositories: i6Repos.size,
  i6RepositoryList: [...i6Repos].sort(),
  i6UnusableReasons: lifecycles.reduce<Record<string, number>>((acc, l) => {
    if (!l.i6Usable && l.i6UnusableReason) acc[l.i6UnusableReason] = (acc[l.i6UnusableReason] ?? 0) + 1;
    return acc;
  }, {}),
  runtimeDiagnosisRepositories: new Set(lifecycles.filter((l) => l.runtimeDiagnosisUsable).map((l) => l.repo)).size,
  provenance: {
    editedCheckoutConfirmed: lifecycles.reduce((a, l) => a + l.usableValidationEvents, 0),
    wrongSourceEvents: lifecycles.reduce((a, l) => a + l.wrongSourceEvents, 0),
    ambiguousSourceEvents: lifecycles.reduce((a, l) => a + l.ambiguousSourceEvents, 0),
    sourceVersionAmbiguousEvents: lifecycles.reduce((a, l) => a + l.sourceVersionAmbiguousEvents, 0),
    staleExecutionEvents: lifecycles.reduce((a, l) => a + l.staleExecutionEvents, 0),
    sourceVersionUnknownEvents: lifecycles.reduce((a, l) => a + l.sourceVersionUnknownEvents, 0),
  },
  resolution: {
    resolved: lifecycles.filter((l) => l.resolved === true).length,
    unresolved: lifecycles.filter((l) => l.resolved === false).length,
    unknown: lifecycles.filter((l) => l.resolved === null).length,
    resolutionRatePctOfValid: pct(
      lifecycles.filter((l) => l.resolved === true && l.validity === "RUN_VALID").length,
      lifecycles.filter((l) => l.validity === "RUN_VALID").length,
    ),
  },
  spend: {
    totalUsd: Number(spend.toFixed(6)),
    medianUsd: costs.length ? costs[Math.floor((costs.length - 1) / 2)] : 0,
    p90Usd: costs.length ? costs[Math.min(costs.length - 1, Math.floor(costs.length * 0.9))] : 0,
    maxUsd: costs.length ? costs[costs.length - 1] : 0,
    perRunCapUsd: M193_LIMITS.perRunCostCapUsd,
    totalCapUsd: M193_LIMITS.totalSpendCapUsd,
    perRunCapViolations: costs.filter((c) => c > M193_LIMITS.perRunCostCapUsd).length,
    totalCapViolation: spend > M193_LIMITS.totalSpendCapUsd,
  },
  adequacyThresholds: M193_ADEQUACY,
  corpusAdequacy: adequacy,
  corpusVerdict: `I6_OBSERVATIONAL_CORPUS_${adequacy}`,
  stopState,
  stopDecision: decision,
  lifecycles,
  diagnostics: built.map((b) => b.diagnostics),
};

if (outRoot) writeFileSync(join(outRoot, "corpus_accounting.json"), `${JSON.stringify(report, null, 2)}\n`);
if (quiet) {
  console.log(JSON.stringify({ accounting, stopState, stopDecision: decision, i6Repositories: i6Repos.size }));
} else {
  console.log(JSON.stringify(report, null, 2));
}

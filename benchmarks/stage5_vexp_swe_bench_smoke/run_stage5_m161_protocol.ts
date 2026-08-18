/**
 * M161-A §17, §23-§31, §43-§46, §87 — freeze the experimental protocol.
 *
 * OFFLINE. Reads the frozen manifests, binds them by hash, and writes the single
 * document every later workstream is judged against. Everything here must be
 * fixed BEFORE the first agent spawns; §50 forbids touching it afterwards.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m161_protocol.ts
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable } from "./benchmarkProvenance";

const RESULTS = path.join(import.meta.dir, "results");
const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const RUNNER = path.join(import.meta.dir, "run_stage5_vexp_swe_bench_smoke.ts");
const DRIVER = path.join(import.meta.dir, "run_stage5_m161_paired_driver.sh");

async function sha256File(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).arrayBuffer().catch(() => null);
  if (bytes === null) return "ABSENT";
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function git(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  return (await new Response(proc.stdout).text()).trim();
}

async function main(): Promise<void> {
  const paired30 = await Bun.file(path.join(RESULTS, "stage5_m161_paired30_manifest.json")).json();
  const extension = await Bun.file(path.join(RESULTS, "stage5_m161_extension_manifest.json")).json();
  const schedule = await Bun.file(path.join(RESULTS, "stage5_m161_arm_schedule.json")).json();
  const integrity = await Bun.file(path.join(RESULTS, "stage5_m161_integrity_audit.json")).json();

  const protocol = {
    schemaVersion: "stage5.m161.protocol.v1",
    milestone: "M161",
    title: "Fresh paired coding-agent utility qualification",
    frozenAt: "2026-08-18",
    question:
      "Does the current VTRACE product improve a coding agent's end-to-end performance, efficiency or " +
      "behaviour relative to the same agent without VTRACE-selected context? (§26 — causal utility of " +
      "VTRACE-selected INJECTED context. Callable-tool utility is a different experiment.)",

    // ---------------------------------------------------------------------
    productFreeze: {
      rule: "No product feature changes during M161 (§3). `git status --porcelain src/` must stay empty.",
      candidateHead: await git(["rev-parse", "HEAD"]),
      candidateTree: await git(["rev-parse", "HEAD^{tree}"]),
      branch: await git(["rev-parse", "--abbrev-ref", "HEAD"]),
      predecessors: {
        m158FinalProduct: "b7ba0381",
        m159Evidence: "f15b274d",
        m160CorpusFreeze: "227b6fbee90b1f71098cfbf466a52b13c41e13de",
        m160Evidence: "3c3c14d362e66dd8bdb1516f8e9ab44e27c5cd78",
        m160ShaStamp: "3ae72d007b6e606ed40fb9ba8f085cb8a76a6761",
        m160CorpusDeletion: "454d869b2479d0960115796cb4b6a24434676f5b",
      },
      frozenSubsystems: [
        "retrieval scoring", "candidate generation", "query shaping", "candidate bounds",
        "support packing", "pivot selection", "Capsule delivery", "index representation",
        "behavioral routing", "workspace routing", "MCP behavior",
      ],
      behavioralRouting: "OFF — default, test-asserted, enabled in NEITHER arm (§4)",
      preservedInvariants: {
        M140: "<module> nodes stay structural and delivery-invisible",
        M152: "repository evidence (index.sqlite) and mutable session state (session.sqlite) stay physically separated",
        M154: "unsupported anti-search guidance removed from the product contract",
        M156: "per-file Python/Cython parse failures do not abort the whole repository",
        M157: "pivot-ineligible candidates do not permanently consume pivot slots",
        M158: "byte-identical support evidence consumes at most one support slot",
      },
    },

    // ---------------------------------------------------------------------
    corpus: {
      family: "princeton-nlp/SWE-bench_Verified",
      populationRows: 500,
      consumed: { broad100A: 100, broad100B: 100, union: 200, source: "results/stage5_m161_consumed_manifests.json" },
      eligibleAfterExclusions: 300,
      metadataExclusions: 0,
      paired30: {
        manifest: "results/stage5_m161_paired30_manifest.json",
        manifestHash: paired30.manifestHash,
        caseCount: paired30.caseCount,
        maxRepositoryShare: paired30.maxRepositoryShare,
        overlapWithConsumed: 0,
      },
      extension: {
        manifest: "results/stage5_m161_extension_manifest.json",
        extensionHash: extension.extension.manifestHash,
        extensionCaseCount: extension.extension.caseCount,
        reserveHash: extension.reserve.manifestHash,
        reserveCaseCount: extension.reserve.caseCount,
        rule: "paired30 ⊂ paired100; extending runs the NEXT cases in this frozen order under the SAME frozen product (§13, §106)",
      },
      integrityGate: {
        audit: "results/stage5_m161_integrity_audit.json",
        scope: integrity.scope,
        checked: integrity.counts.checked,
        valid: integrity.counts.valid,
        corpusInvalid: integrity.counts.corpusInvalid,
        neededRetry: integrity.counts.neededRetry,
        knownPositiveControls: "run_stage5_m161_integrity.test.ts — VALID, GOLD_FIXTURE_ABSENT_FROM_CHECKOUT and SOURCE_REVISION_UNAVAILABLE all demonstrated (§122/§123)",
      },
      selectionIndependence:
        "Selection consumed only instance id, repository and difficulty. No VTRACE Top-1, gold state, " +
        "candidate count, latency, lead correctness or lane behaviour entered it (§14), and a test asserts " +
        "that adding those fields to every candidate changes nothing.",
    },

    // ---------------------------------------------------------------------
    treatment: {
      conditionA: "baseline — same agent, same tools, same task, same source revision, NO VTRACE context",
      conditionB: "vtrace — same agent, same tools, same task, same source revision, PLUS VTRACE-selected injected context",
      delivery: "VTRACE-selected context injected as text via _vtrace_instructions.md (§23)",
      callableVtraceTools: {
        state: "UNAVAILABLE UNDER THIS PROTOCOL (§25, §61)",
        mechanism: "the agent is launched with --strict-mcp-config against {\"mcpServers\":{}}; no VTRACE tool is registered or callable",
        unmeasurable: [
          "VTRACE MCP calls", "get_code_context calls", "get_impact_graph calls",
          "voluntary invocation", "VTRACE-vs-grep tool sequencing",
        ],
      },

      // The decision this protocol turns on. See stage5_m161_plan.md §Treatment.
      historicalTreatmentDivergence: {
        m161IsHistoricalTreatmentIdentical: false,
        historicalStage5Treatment: "capsule evidence + STAGE5_TOKEN_DISCIPLINE search/edit policy",
        m161Treatment: "capsule evidence only",
        reason: "isolate evidence utility from search/edit policy",
        disabledBlock: {
          name: "STAGE5_TOKEN_DISCIPLINE",
          flag: "--disable-token-discipline",
          appliedTo: "BOTH arms (the block is vtrace-only by construction; the flag is passed on both invocations so the parity control can assert its absence symmetrically)",
          whatItSaid: [
            "patch first; do not rediscover it with grep",
            "at most N search/grep/read calls before the first edit",
            "do not run broad recursive grep after the capsule already names a pivot file",
          ],
          whyDisabled:
            "§30 forbids instructing the VTRACE arm to avoid broad search, and §26 defines M161's subject as the " +
            "utility of the CONTEXT. The block is benchmark-runner text the runner itself documents as \"NOT a " +
            "user-facing product mode\", so it is not part of the product being qualified. Left ON, every §64/§66/§70 " +
            "anchoring finding and every §113 efficiency delta would be attributable to an explicit instruction " +
            "rather than to the evidence.",
          implementationUnchanged: "the historical block is NOT deleted or modified; M161 only declines to inject it",
          cost: "M161's absolute numbers are NOT directly comparable to M155's paired-30, which carried the block",
          followUp: "a token-discipline policy ablation is a SEPARATE experiment, considered only after the capsule-only utility result (§ user directive)",
        },
        retainedProductText: {
          name: "Capsule v2 digest decision contract (M112)",
          location: "src/capsuleV2/digestDecisionContract.ts",
          retained: true,
          why:
            "it is PRODUCT delivery — the per-file EDIT/RULE_OUT contract over the evidence VTRACE delivered, " +
            "shipped default-ON in M112 — not benchmark scaffolding. It also does not suppress search: it says " +
            "\"a Search/Grep hit is not enough; inspect/read the file\" and \"inspect optional context and search as needed\".",
        },
      },

      sharedAcrossArms: {
        toolUseDisciplineBlock: "the generic anti-loop block is injected into BOTH arms (symmetric, unchanged)",
        note: "the ONLY intended prompt difference is the injected VTRACE evidence block (§28, §84)",
      },
    },

    // ---------------------------------------------------------------------
    agent: {
      provider: "Anthropic via the `claude` CLI credentials (~/.claude/.credentials.json); ANTHROPIC_API_KEY is unset",
      model: "claude-opus-4-5-20251101",
      modelSource: "vexp-swe-bench `run` default; the historical Stage 5 model, identical in both arms (§27)",
      agentAdapter: "claude-code (vexp-swe-bench/src/agents/claude-code.ts)",
      maxTurns: 250,
      costLimitUsdPerTask: 3,
      timeoutSeconds: 0,
      allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite"],
      allowedToolsSource: "vexp-swe-bench orchestrator DEFAULT_ALLOWED_TOOLS — IDENTICAL in both arms (§29 baseline not crippled, §30 VTRACE arm free to grep/read/git)",
      parityRequired: ["system prompt", "task prompt", "agent version", "turn budget", "cost budget", "timeout", "tool permissions", "repo tools", "grader", "environment"],
    },

    // ---------------------------------------------------------------------
    execution: {
      driver: "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m161_paired_driver.sh",
      driverSha256: await sha256File(DRIVER),
      runner: "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts",
      runnerSha256: await sha256File(RUNNER),
      datasetPassthrough: {
        flag: "--vexp-run-data",
        why: "M161's corpus is drawn from the 400 SWE-bench Verified instances the vexp harness's bundled swe-bench-100.jsonl does not contain; the flag forwards the external CLI's own --data",
        appliedTo: "BOTH arms identically — the dataset decides which instances exist, never which arm sees what",
        default: "null, so every historical command stays byte-identical",
      },
      sequential: "live runs share results/_agent_stream.jsonl and must never overlap (§47 also forbids saturating the machine to save wall time)",
      armSchedule: {
        artifact: "results/stage5_m161_arm_schedule.json",
        scheduleHash: schedule.paired30.scheduleHash,
        rule: "odd rank runs baseline first, even rank runs VTRACE first (§45); a function of rank alone, so it cannot be nudged after an outcome (§46)",
        baselineLeads: schedule.paired30.baselineLeads,
        vtraceLeads: schedule.paired30.vtraceLeads,
      },
      mandatoryGuards: [
        "--stage5-env-guard", "--stage5-env-drift-check", "--expected-testbed-prefix",
        "--stage5-agent-shell-guard", "--stage5-host-pip-firewall",
      ],
      guardRationale: "M89 makes the env guard mandatory: a live run fails closed BEFORE agent spawn without it",
    },

    // ---------------------------------------------------------------------
    treatmentStates: {
      rule: "these four must never be collapsed (§32)",
      VALID_NONEMPTY: "retrieval succeeded and delivered ≥1 item; the capsule is injected",
      VALID_DELIVERY_EMPTY: "retrieval succeeded and delivered 0 items — a legitimate product outcome (§33). Inject zero VTRACE tokens, spawn the agent normally, grade normally. NEVER abort.",
      DEGRADED_VALID: "index readiness reports usable with contained per-file parse failures (M156). Treatment is valid; cross-tabbed separately (§117).",
      TREATMENT_UNAVAILABLE: "a real deterministic product failure (index generation, context generation). The agent does NOT spawn; recorded in treatment availability, excluded from the conditional paired matrix (§34, §89).",
      CORPUS_INVALID: "benchmark source integrity could not be established after the bounded retry policy. No agent money is spent (§21).",
      denominatorRule: "availability is always reported over the ORIGINAL frozen 30; the paired agent matrix is conditional on both arms having run and being gradable. The denominator is never silently shrunk (§35, §36, §37).",
    },

    grading: {
      path: "authoritative SWE-bench grading via `--mode evaluate --eval-mode docker`",
      rule: "patch produced, agent claimed solved, and grader PASS are kept SEPARATE; the grader is the authority (§51, §87)",
      identicalAcrossArms: true,
    },

    rerunPolicy: { document: "results/stage5_m161_rerun_policy.md", frozenBeforeAnyLiveRun: true },

    smokeValidation: {
      purpose: "harness validity only (§81) — prove the complete live chain, especially the --data passthrough",
      caseSelection: "outside paired30 AND outside the pre-frozen extension set; integrity-valid",
      excludedFrom: ["M161 utility denominators", "unique win/loss counts", "the frozen 30"],
      agentOutcomeIsIrrelevant: "PASS/FAIL on the smoke case is not a gate and must not modify the protocol",
    },

    outOfScope: {
      note: "M161 measures utility, not another deterministic metric win (§7)",
      forbidden: [
        "candidate pool increases", "generation-pool widening", "support cap increases",
        "ranking-weight changes", "synonym expansion", "placeholder-lane reordering",
        "result/effect semantics", "subject→owner bridge", "search_symbols", "new retrieval lanes",
      ],
      m160Conclusion: "subject→owner / result-effect: NOT REPLICATED — DO NOT BUILD (§6, §36 of M160)",
    },
  };

  const withHash = { ...protocol, protocolHash: hashStable(protocol) };
  await writeFile(path.join(RESULTS, "stage5_m161_protocol.json"), `${JSON.stringify(withHash, null, 2)}\n`);
  console.log(`protocol hash   ${withHash.protocolHash}`);
  console.log(`paired30 hash   ${paired30.manifestHash}`);
  console.log(`schedule hash   ${schedule.paired30.scheduleHash}`);
  console.log(`runner sha256   ${withHash.execution.runnerSha256}`);
  console.log(`driver sha256   ${withHash.execution.driverSha256}`);
}

if (import.meta.main) {
  await main();
}

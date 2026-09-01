/**
 * M197A — Track-A verdict assembly. Fails closed on any missing measurement.
 *
 * Every load-bearing number in the final report is computed here from the
 * measurement JSONs (§40). Nothing is transcribed: if a claim's input is absent
 * the claim is recorded as unmeasured, which the aggregate evaluator counts as a
 * non-pass rather than skipping.
 *
 * The scoring rule for each claim is written next to its threshold so a reader
 * can check the rule, not just the result. Where a threshold could reasonably be
 * applied to more than one surface, BOTH are reported and the aggregate's
 * sensitivity to that choice is published rather than resolved silently.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m197a_report.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ClaimVerdict, ReproductionStatus, comparisonIsPartiallyNonReproducible,
  evaluateTrackAParity, type ClaimRow, type CorpusCoverage,
} from "./m197aParity";
import {
  callSiteIsRendered, countsTowardReduction, determinismVerdict, semanticProjection,
  signatureFaults, skeletonValidity, supportedLanguageCount,
} from "./m197aScoring";

const RESULTS = path.join(import.meta.dir, "results");
const read = (name: string) => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) throw new Error(`M197A_MEASUREMENT_MISSING: ${name}`);
  return JSON.parse(readFileSync(p, "utf8"));
};

const authority = read("stage5_m197a_authority.json");
const indexing = read("stage5_m197a_indexing.json");
const engine = read("stage5_m197a_engine.json");

if (authority.verdict !== "M197A_AUTHORITY_VERIFIED") {
  throw new Error(`M197A_AUTHORITY_NOT_VERIFIED: ${authority.verdict}`);
}

const corpusOf = (list: any[], id: string) => list.find((c) => c.id === id);
const ing = (id: string) => corpusOf(indexing.ingestion, id);
const idx = (id: string) => corpusOf(indexing.indexing, id);
const eng = (id: string) => corpusOf(engine.corpora, id);

/** MATCH when every measured value clears `match`; EXCEED when every one clears `exceed`. */
function band(values: readonly (number | null)[], match: number, exceed: number,
              direction: "atLeast" | "atMost"): ClaimVerdict | null {
  if (values.length === 0 || values.some((v) => v === null || Number.isNaN(v))) return null;
  const nums = values as number[];
  const clears = (bar: number) => direction === "atLeast"
    ? nums.every((v) => v >= bar) : nums.every((v) => v <= bar);
  if (clears(exceed)) return ClaimVerdict.Exceeds;
  if (clears(match)) return ClaimVerdict.Matches;
  return ClaimVerdict.Below;
}

const CONTENDED = `machine shared with an unrelated compute job during measurement `
  + `(load average ${engine.hardware.loadAverageAtStart?.[0]} of ${engine.hardware.cpus} cpus); `
  + `VEXP states no hardware, corpus, cache state or tokenizer, so the threshold is preserved `
  + `but the comparison is a local analogue`;

// ------------------------------------------------------------------ the 15 rows
const a1 = engine.a1;
const a1Supported = supportedLanguageCount({
  declaredEnum: a1.declaredEnum, extensionDetected: Object.keys(a1.extensionDetection),
  parserBacked: a1.parserBacked,
});

const a2Values = [idx("C-MED")?.cold?.filesPerSecondMedian ?? null,
                  idx("C-LARGE")?.cold?.filesPerSecondMedian ?? null];
const a3Values = [idx("C-LARGE")?.incremental?.k1?.ratioToColdMedian ?? null,
                  idx("C-LARGE")?.incremental?.k3?.ratioToColdMedian ?? null];
const a3Crashed = ["k1", "k3"].some((k) => (idx("C-LARGE")?.incremental?.[k]?.failureMode ?? null) !== null)
  || (idx("C-LARGE")?.singleRefreshSequence?.status === "CRASH");
const a3CrashDetail = ["C-SMALL", "C-MED", "C-LARGE"].map((c) => ({ corpus: c,
  k1: idx(c)?.incremental?.k1?.failureMode ?? null, k3: idx(c)?.incremental?.k3?.failureMode ?? null,
  singleRefresh: idx(c)?.singleRefreshSequence ?? null }));

const a4Values = ["C-SMALL", "C-MED", "C-LARGE"].map((c) => {
  const ms = idx(c)?.noop?.median; return ms === undefined ? null : ms / 1000;
});
const a5Values = ["C-SMALL", "C-MED", "C-LARGE"].map((c) => eng(c)?.a5?.latency?.p90 ?? null);
const a6Values = [eng("C-LARGE")?.a6?.latency?.p90 ?? null];
const a7Values = [eng("C-LARGE")?.a7?.latency?.p90 ?? null];
const a8Coverage: CorpusCoverage[] = ["C-SMALL", "C-MED", "C-LARGE"]
  .map((c) => ({ corpus: c, coveragePercent: ing(c)?.coveragePercent ?? null }));
const a9Values = [eng("C-MED")?.a9?.renderedReduction?.median ?? null,
                  eng("C-LARGE")?.a9?.renderedReduction?.median ?? null];
// A10 uses the §21 source-truth basis. The presence-only figure M196 reported is
// published beside it; the gap between them IS the malformation rate.
const a10Signature = ["C-MED", "C-LARGE"].map((c) => eng(c)?.a10?.signatureRetentionPercent ?? null);
const a10Members = ["C-MED", "C-LARGE"].map((c) => eng(c)?.a10?.memberRetentionPercent ?? null);
const a11Utilisation = Object.values(eng("C-MED")?.a11a13?.utilisationByBudget ?? {})
  .map((v: any) => v.median as number);
const a12Classes = (eng("C-MED")?.a12?.distinctClassesObserved ?? []).length;
const a13Violations = (eng("C-MED")?.a11a13?.tasksWithSizeViolation ?? 0)
  + (eng("C-MED")?.a11a13?.tasksWithFocusSwap ?? 0);
const a14PerItem = eng("C-MED")?.a14?.itemsWithPerItemAccounting ?? null;
const a15Impact = eng("C-LARGE")?.a15?.impactRenderPercent ?? null;
const a15Flow = eng("C-LARGE")?.a15?.flowCorrectRenderPercent ?? null;

const claims: (ClaimRow & { measurement: string; matchThreshold: string; exceedThreshold: string;
  vexpSource: string; m196Prior: string })[] = [
  {
    id: "A1", vexpClaim: "30 programming languages supported out of the box",
    vexpSource: "V-A1, vexp-cli/README.md", m196Prior: "4 families — FAILS",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `${a1Supported} parser-backed families (${a1.parserBacked.join(", ")}); `
      + `${a1.extensionDetectedFamilies} extension-detected; ${a1.declaredEnumMembers} enum members`,
    matchThreshold: ">= 30 parser-backed families", exceedThreshold: "> 30",
    verdict: band([a1Supported], 30, 31, "atLeast"),
    comparabilityCaveat: "VEXP counts rows in a README table; VTRACE counts registered parsers (F7)",
  },
  {
    id: "A2", vexpClaim: "practical cold-index throughput on a real repository",
    vexpSource: "frozen M196 protocol (VEXP publishes no throughput figure)",
    m196Prior: "15.3 files/s C-LARGE, 56.3 C-MED",
    reproduction: ReproductionStatus.ReproducedWithInterpretation,
    measurement: `C-MED ${a2Values[0]} files/s, C-LARGE ${a2Values[1]} files/s (median of `
      + `${indexing.repeats} cold builds)`,
    matchThreshold: ">= 15 files/s", exceedThreshold: ">= 30 files/s",
    verdict: band(a2Values, 15, 30, "atLeast"),
    comparabilityCaveat: CONTENDED,
  },
  {
    id: "A3", vexpClaim: "incremental refresh is materially cheaper than a cold build",
    vexpSource: "frozen M196 protocol", m196Prior: "0.31 C-MED / 1.45 C-LARGE — FAILS",
    reproduction: ReproductionStatus.ReproducedWithInterpretation,
    measurement: (a3Crashed ? `incremental refresh ABORTED on C-LARGE `
        + `(${idx("C-LARGE")?.incremental?.k1?.failureMode ?? idx("C-LARGE")?.singleRefreshSequence?.error}); ` : "")
      + `C-LARGE k=1 ratio ${a3Values[0]}, k=3 ratio ${a3Values[1]}; `
      + `reparsed ${idx("C-LARGE")?.incremental?.k1?.filesAttemptedForParse} of the `
      + `${idx("C-LARGE")?.filesIndexed} files the indexer holds for a ONE-file change `
      + `(the eligible .py denominator is ${idx("C-LARGE")?.eligibleFiles}; the indexer also `
      + `enumerates .pyx/.pxd/.yml/.toml)`,
    matchThreshold: "ratio <= 0.25", exceedThreshold: "ratio <= 0.05",
    // §14: "If the path crashes, that is BELOW unless the protocol says
    // otherwise." A crash is a measured failure of the capability, not a
    // missing measurement, so it must not fall through to "unmeasured".
    verdict: a3Crashed ? ClaimVerdict.Below : band(a3Values, 0.25, 0.05, "atMost"),
    comparabilityCaveat: "pre-existing: incremental refresh has no incremental path (M196A §14)",
  },
  {
    id: "A4", vexpClaim: "a no-change freshness check is fast",
    vexpSource: "frozen M196 protocol", m196Prior: "0.16 s — passes",
    reproduction: ReproductionStatus.ReproducedWithInterpretation,
    measurement: `no-op median ${a4Values.map((v) => v === null ? "?" : v.toFixed(3)).join(" / ")} s `
      + `(C-SMALL / C-MED / C-LARGE), 0 files reparsed`,
    matchThreshold: "<= 3 s", exceedThreshold: "<= 1 s",
    verdict: band(a4Values, 3, 1, "atMost"),
    comparabilityCaveat: CONTENDED,
  },
  {
    id: "A5", vexpClaim: "query time is reported per capsule call in milliseconds",
    vexpSource: "V-A5, vexp-cli/mcp/mcp-server.cjs", m196Prior: "113-221 ms — passes",
    reproduction: ReproductionStatus.ReproducedWithInterpretation,
    measurement: `get_code_context warm p90 ${a5Values.join(" / ")} ms (C-SMALL / C-MED / C-LARGE), `
      + `${engine.repeats} repetitions; best observed `
      + `${["C-SMALL", "C-MED", "C-LARGE"].map((c) => eng(c)?.a5?.latency?.min).join(" / ")} ms`,
    matchThreshold: "p90 <= 500 ms", exceedThreshold: "p90 <= 200 ms",
    verdict: band(a5Values, 500, 200, "atMost"),
    comparabilityCaveat: `${CONTENDED}; VEXP reports a warm-daemon number on an unspecified corpus`,
  },
  {
    id: "A6", vexpClaim: "impact graph returns callers, importers and transitive dependents to depth",
    vexpSource: "V-B1, vexp-cli/mcp/mcp-server.cjs", m196Prior: "159 ms — passes",
    reproduction: ReproductionStatus.ReproducedWithInterpretation,
    measurement: `get_impact_graph depth 3 warm p90 ${a6Values[0]} ms on C-LARGE `
      + `(${eng("C-LARGE")?.a6?.targets} exact-FQN targets x ${engine.repeats})`,
    matchThreshold: "p90 <= 500 ms", exceedThreshold: "p90 <= 200 ms",
    verdict: band(a6Values, 500, 200, "atMost"),
    comparabilityCaveat: `${CONTENDED}; VEXP publishes no impact-latency protocol (V-B1 is INSUFFICIENT_METHOD for correctness)`,
  },
  {
    id: "A7", vexpClaim: "logic flow finds execution paths between two symbols",
    vexpSource: "V-B2, vexp-cli/mcp/mcp-server.cjs", m196Prior: "5.3 ms — passes",
    reproduction: ReproductionStatus.ReproducedWithInterpretation,
    measurement: `search_logic_flow warm p90 ${a7Values[0]} ms on C-LARGE; path edge counts `
      + `${JSON.stringify(eng("C-LARGE")?.a7?.pathEdgeCounts?.distribution ?? {})}`,
    matchThreshold: "p90 <= 500 ms", exceedThreshold: "p90 <= 200 ms",
    verdict: band(a7Values, 500, 200, "atMost"),
    comparabilityCaveat: `${CONTENDED}; every returned path is one edge long, so this measures `
      + `single-hop resolution rather than multi-hop traversal`,
  },
  {
    id: "A8", vexpClaim: "the engine represents the repository it indexes",
    vexpSource: "VTRACE veto derived from the frozen M197 gate G8",
    m196Prior: "100% / 100% / 100% after the M196A repair — PASSES",
    reproduction: ReproductionStatus.Reproduced,
    measurement: a8Coverage.map((c) => `${c.corpus} ${c.coveragePercent}%`).join(", ")
      + `; unexplained missing ${["C-SMALL", "C-MED", "C-LARGE"].map((c) => ing(c)?.unexplainedMissing).join("/")}`,
    matchThreshold: ">= 99% on every corpus", exceedThreshold: "100%",
    verdict: band(a8Coverage.map((c) => c.coveragePercent), 99, 100, "atLeast"),
    comparabilityCaveat: null,
  },
  {
    id: "A9", vexpClaim: "get_skeleton saves 70-90% tokens versus Read",
    vexpSource: "V-C1, vexp-cli/mcp/mcp-server.cjs", m196Prior: "88.9% / 90.0% — passes",
    reproduction: ReproductionStatus.ReproducedWithInterpretation,
    measurement: `median rendered reduction C-MED ${a9Values[0]}%, C-LARGE ${a9Values[1]}% over `
      + `${eng("C-MED")?.a9?.filesMeasured} + ${eng("C-LARGE")?.a9?.filesMeasured} structurally valid files; `
      + `${eng("C-MED")?.a9?.filesMalformed} C-MED files excluded as malformed (F4)`,
    matchThreshold: "median reduction >= 70%", exceedThreshold: ">= 90%",
    verdict: band(a9Values, 70, 90, "atLeast"),
    comparabilityCaveat: "tokenizer is ceil(chars/4) on both sides; VEXP states no tokenizer",
  },
  {
    id: "A10", vexpClaim: "the skeleton preserves signatures and members",
    vexpSource: "V-C1 structural half", m196Prior: "100% / 91.6% signatures (presence only)",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `signature retention C-MED ${a10Signature[0]}%, C-LARGE ${a10Signature[1]}% `
      + `(verbatim, token-aligned, bracket-closed slices of source); member retention `
      + `C-MED ${a10Members[0]}%, C-LARGE ${a10Members[1]}%. Signature-PRESENCE alone would read `
      + `${["C-MED", "C-LARGE"].map((c) => eng(c)?.a10?.signaturePresencePercent).join("% / ")}%`,
    matchThreshold: ">= 95% signatures and >= 90% members", exceedThreshold: "100%",
    verdict: (() => {
      const sig = band(a10Signature, 95, 100, "atLeast");
      const mem = band(a10Members, 90, 100, "atLeast");
      if (sig === null || mem === null) return null;
      if (sig === ClaimVerdict.Below || mem === ClaimVerdict.Below) return ClaimVerdict.Below;
      return sig === ClaimVerdict.Exceeds && mem === ClaimVerdict.Exceeds
        ? ClaimVerdict.Exceeds : ClaimVerdict.Matches;
    })(),
    comparabilityCaveat: "§21 requires source truth; a signature sliced mid-identifier fails "
      + "preservation even though the field is populated",
  },
  {
    id: "A11", vexpClaim: "run_pipeline takes a whole-output token budget, default 10000",
    vexpSource: "V-C5, vexp-cli/mcp/mcp-server.cjs", m196Prior: "4.5% at 8k — FAILS",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `C-MED whole-response utilisation by budget: `
      + Object.entries(eng("C-MED")?.a11a13?.utilisationByBudget ?? {})
        .map(([b, v]: [string, any]) => `${b}=${v.median}%`).join(", ")
      + ` over ${eng("C-MED")?.a11a13?.tasks} tasks`,
    matchThreshold: ">= 60% utilisation at every budget", exceedThreshold: ">= 80%",
    verdict: band(a11Utilisation, 60, 80, "atLeast"),
    comparabilityCaveat: "fixed per-tier caps bind before the whole-output budget does (M196)",
  },
  {
    id: "A12", vexpClaim: "pivots are delivered as full content, supporting files as skeletons",
    vexpSource: "V-C6, vexp-core binary", m196Prior: "2 (FULL x1, RELATIONSHIP_ONLY) — FAILS",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `C-MED default response carries ${a12Classes} distinct representation classes `
      + `(${(eng("C-MED")?.a12?.distinctClassesObserved ?? []).join(", ")}); C-LARGE carries `
      + `${(eng("C-LARGE")?.a12?.distinctClassesObserved ?? []).length}`,
    matchThreshold: ">= 3 distinct classes", exceedThreshold: "5",
    verdict: band([a12Classes], 3, 5, "atLeast"),
    comparabilityCaveat: "measured on the DEFAULT model-facing response, not debug internals (F6)",
  },
  {
    id: "A13", vexpClaim: "pivots degrade to skeletons and support is dropped when the budget binds",
    vexpSource: "V-C7, vexp-core binary", m196Prior: "1/3 tasks violated — FAILS",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `${eng("C-MED")?.a11a13?.tasksWithSizeViolation} of `
      + `${eng("C-MED")?.a11a13?.tasks} tasks lose focus content as the budget grows, and `
      + `${eng("C-MED")?.a11a13?.tasksWithFocusSwap} swap the delivered focus symbol, over `
      + `${(eng("C-MED")?.a11a13?.budgets ?? []).length} budgets`,
    matchThreshold: "0 monotonicity violations", exceedThreshold: "0 plus a declared drop order",
    verdict: band([a13Violations], 0, 0, "atMost"),
    comparabilityCaveat: "a focus swap is counted as a violation: swapping the delivered symbol is "
      + "a loss the token count alone cannot show",
  },
  {
    id: "A14", vexpClaim: "per-symbol token_reduction_pct is reported for each skeleton",
    vexpSource: "V-C3, vexp-cli/mcp/mcp-server.cjs", m196Prior: "absent, 2 disagreeing authorities — FAILS",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `${a14PerItem} of ${eng("C-MED")?.a14?.itemsDelivered} delivered items carry token `
      + `accounting; no accounting block appears in the default response at all `
      + `(present at detail=debug only). get_skeleton publishes a per-CALL block whose savings figure `
      + `differs from an independent measurement of the same output by `
      + `${["C-SMALL", "C-MED", "C-LARGE"].map((c) => eng(c)?.a14?.skeletonAccounting?.authoritiesDisagreeByPoints).join(" / ")} points`,
    matchThreshold: "present per item and internally consistent", exceedThreshold: "plus an accumulated ledger",
    verdict: a14PerItem === null ? null : (a14PerItem > 0 ? ClaimVerdict.Matches : ClaimVerdict.Below),
    comparabilityCaveat: "debug-only presence does not satisfy a default-output claim (F6)",
  },
  {
    id: "A15", vexpClaim: "call-site evidence renders the call expression, not just a location",
    vexpSource: "V-B1/V-B2 evidence half", m196Prior: "0% rendered (100% stored) — FAILS",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `C-LARGE, ${eng("C-LARGE")?.a15?.eligibleCallSites} eligible call edges: the impact `
      + `surface renders ${a15Impact}% as source expressions, the logic-flow surface ${a15Flow}%. `
      + `On C-MED the flow surface renders ${eng("C-MED")?.a15?.flowCorrectRenderPercent}%`,
    matchThreshold: ">= 90% of eligible call sites render the expression", exceedThreshold: "100%",
    // Scored on the IMPACT surface: that is the caller-enumeration surface V-B1
    // describes and the surface M196's prior was set against. The flow-surface
    // result is a correction to that prior and is published beside it, with the
    // aggregate's sensitivity to the choice stated below.
    verdict: band([a15Impact], 90, 100, "atLeast"),
    comparabilityCaveat: "scored on get_impact_graph; get_code_context's logic-flow surface DOES "
      + "render expressions and would score EXCEED — see the sensitivity note",
  },
];

// ------------------------------------------------------------------- aggregate
const parity = evaluateTrackAParity(claims, a8Coverage);

/**
 * Contention sensitivity, published rather than resolved.
 *
 * The machine was shared with an unrelated compute job throughout. Contention
 * can only ADD time, never remove it, so the least-contended observation is a
 * lower bound on the engine's true speed and the frozen statistic is an upper
 * bound on its true latency. The verdicts above use the FROZEN statistic — the
 * median for throughput, p90 for latency — because switching statistic after
 * seeing which one passes is the precise failure §32 exists to prevent.
 *
 * What the timing rows would score on the least-contended observation is
 * reported here so the reader can see exactly how much of the result is the
 * engine and how much is the machine.
 */
const contentionSensitivity = {
  loadAverageDuringMeasurement: engine.hardware.loadAverageAtStart,
  cpus: engine.hardware.cpus,
  rule: "verdicts use the frozen statistic; this block shows the least-contended alternative",
  rows: [
    { id: "A2", frozen: `median ${a2Values.join(" / ")} files/s`,
      frozenVerdict: band(a2Values, 15, 30, "atLeast"),
      leastContended: ["C-MED", "C-LARGE"].map((c) => {
        const best = idx(c)?.cold?.min; const n = idx(c)?.filesIndexed;
        return best && n ? +(1000 * n / best).toFixed(2) : null;
      }),
      leastContendedVerdict: band(["C-MED", "C-LARGE"].map((c) => {
        const best = idx(c)?.cold?.min; const n = idx(c)?.filesIndexed;
        return best && n ? 1000 * n / best : null;
      }), 15, 30, "atLeast") },
    { id: "A5", frozen: `p90 ${a5Values.join(" / ")} ms`,
      frozenVerdict: band(a5Values, 500, 200, "atMost"),
      leastContended: ["C-SMALL", "C-MED", "C-LARGE"].map((c) => eng(c)?.a5?.latency?.min ?? null),
      leastContendedVerdict: band(
        ["C-SMALL", "C-MED", "C-LARGE"].map((c) => eng(c)?.a5?.latency?.min ?? null), 500, 200, "atMost") },
    { id: "A6", frozen: `p90 ${a6Values[0]} ms`, frozenVerdict: band(a6Values, 500, 200, "atMost"),
      leastContended: [eng("C-LARGE")?.a6?.latency?.min ?? null],
      leastContendedVerdict: band([eng("C-LARGE")?.a6?.latency?.min ?? null], 500, 200, "atMost") },
    { id: "A7", frozen: `p90 ${a7Values[0]} ms`, frozenVerdict: band(a7Values, 500, 200, "atMost"),
      leastContended: [eng("C-LARGE")?.a7?.latency?.min ?? null],
      leastContendedVerdict: band([eng("C-LARGE")?.a7?.latency?.min ?? null], 500, 200, "atMost") },
  ],
};

/** What the aggregate would be if A15 were scored on the logic-flow surface. */
const a15FlowAlternative = evaluateTrackAParity(
  claims.map((c) => c.id === "A15"
    ? { ...c, verdict: band([a15Flow], 90, 100, "atLeast") } : c),
  a8Coverage,
);

// -------------------------------------------------------- determinism (§29)
const determinism = ["C-SMALL", "C-MED", "C-LARGE"].map((c) => {
  const e = eng(c);
  return { corpus: c,
    getCodeContext: e?.a5?.deterministic ?? null, getImpactGraph: e?.a6?.deterministic ?? null,
    searchLogicFlow: e?.a7?.deterministic ?? null,
    unstable: [...(e?.a5?.nonDeterministicQueries ?? []), ...(e?.a6?.nonDeterministicQueries ?? []),
      ...(e?.a7?.nonDeterministicQueries ?? [])],
    indexNonIdenticalRuns: ing(c)?.determinism?.nonIdenticalRuns ?? null };
});
const allDeterministic = determinism.every((d) =>
  d.getCodeContext === true && d.getImpactGraph === true && d.searchLogicFlow === true
  && d.indexNonIdenticalRuns === 0);

// ------------------------------------------------------ truthfulness (§30)
const truth = ["C-SMALL", "C-MED", "C-LARGE"].map((c) => ({ corpus: c, ...eng(c)?.truthfulness }));
const strengthened = truth.reduce((n, t: any) => n + (t.strengthenedCallSiteRenderings ?? 0), 0);
const invented = truth.reduce((n, t: any) => n + (t.inventedStructuralClaims ?? 0), 0);

// ------------------------------------------------- falsification controls F1-F8
const SOURCE = "export function f(a: string): string[] {\n  return [];\n}\n";
const synth = (matching: number, over: Partial<ClaimRow> = {}): ClaimRow[] =>
  Array.from({ length: 15 }, (_u, i) => ({ id: `S${i + 1}`, vexpClaim: "synthetic",
    reproduction: ReproductionStatus.Reproduced,
    verdict: i < matching ? ClaimVerdict.Matches : ClaimVerdict.Below, ...over }));
const clean: CorpusCoverage[] = [{ corpus: "X", coveragePercent: 100 }];

const controls = [
  { id: "F1", statement: "fewer than 10 of 15 matches must not meet the threshold",
    pass: evaluateTrackAParity(synth(9), clean).verdict === "VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_NOT_MET" },
  { id: "F2", statement: "14 of 15 matches with A8 at 98.9% must still fail",
    pass: evaluateTrackAParity(synth(14), [{ corpus: "X", coveragePercent: 98.9 }]).thresholdMet === false },
  { id: "F3", statement: "a NOT_COMPARABLE claim must not increase the match count",
    pass: evaluateTrackAParity(
      synth(9).map((r, i) => i === 9
        ? { ...r, reproduction: ReproductionStatus.NotComparable, verdict: ClaimVerdict.Matches } : r),
      clean).matchOrExceed === 9 },
  { id: "F4", statement: "a structurally invalid skeleton must fail A9 and A10",
    pass: !countsTowardReduction(skeletonValidity(
      { declarations: [{ kind: "function", name: "f", signature: "t function f(a: string): string[", members: [] }] },
      SOURCE))
      && signatureFaults("export function f(a: string): string[] {", SOURCE).length === 0 },
  { id: "F5", statement: "file:line must not satisfy call-expression rendering",
    pass: !callSiteIsRendered({ referenceName: "f", callSites: [{ startLine: 1, endLine: 1 }] })
      && !callSiteIsRendered({ sourceText: "): string {", referenceName: "f" })
      && callSiteIsRendered({ sourceText: "const x = f(1);", referenceName: "f" }) },
  { id: "F6", statement: "a debug-only field must not satisfy a default-output claim",
    pass: ["C-SMALL", "C-MED", "C-LARGE"].every((c) =>
      eng(c)?.a14?.defaultVsDebug?.accountingInDefaultResponse === false
      && eng(c)?.a14?.defaultVsDebug?.accountingInDebugResponse === true)
      && a14PerItem === 0 },
  { id: "F7", statement: "a declared language enum without a parser must not satisfy A1",
    pass: supportedLanguageCount({ declaredEnum: Array.from({ length: 30 }, (_u, i) => `l${i}`),
      extensionDetected: [], parserBacked: [] }) === 0
      && a1Supported === a1.parserBackedFamilies },
  { id: "F8", statement: "a semantically unstable repeated output must fail the measurement",
    pass: determinismVerdict(new Map([["q", new Set(["a", "b"])]])).deterministic === false
      && determinismVerdict(new Map([["q", new Set(["a"])]])).deterministic === true
      // The projection must hide latency and still expose a content change.
      && JSON.stringify(semanticProjection({ n: 1, timing: { totalMs: 1 } }))
        === JSON.stringify(semanticProjection({ n: 1, timing: { totalMs: 2 } }))
      && JSON.stringify(semanticProjection({ n: 1 })) !== JSON.stringify(semanticProjection({ n: 2 })) },
];
const controlsPass = controls.every((c) => c.pass);

// ---------------------------------------------------------------------- output
const report = {
  milestone: "M197A",
  instrument: "run_stage5_m197a_report.ts",
  authorityVerdict: authority.verdict,
  preregistrationSha256: authority.preregistration.sha256,
  vexpCliVersion: authority.claimLedger.vexpCliVersion,
  comparisonMode: {
    directVexpExecution: false,
    networkUsed: false,
    modelOrProviderUsed: false,
    mode: "CLAIM_TARGET_COMPARISON with VTRACE_LOCAL_ANALOGUE on every latency row",
    reason: "no VEXP binary was executed; the local artefacts were read at M196 and are the claim source",
  },
  hardware: engine.hardware,
  claims,
  parity,
  contentionSensitivity,
  a15SensitivityIfScoredOnFlowSurface: {
    matchOrExceed: a15FlowAlternative.matchOrExceed, verdict: a15FlowAlternative.verdict,
    note: "published so the choice of surface for A15 is visible rather than silently decisive",
  },
  aggregateUnderLeastContendedTimings: (() => {
    const byId = new Map(contentionSensitivity.rows.map((r) => [r.id, r.leastContendedVerdict]));
    const alt = evaluateTrackAParity(
      claims.map((c) => byId.has(c.id) ? { ...c, verdict: byId.get(c.id)! } : c), a8Coverage);
    return { matchOrExceed: alt.matchOrExceed, verdict: alt.verdict };
  })(),
  partiallyNonReproducible: comparisonIsPartiallyNonReproducible(parity),
  determinism: { allDeterministic, perCorpus: determinism },
  truthfulness: { strengthenedStructuralClaims: strengthened, inventedStructuralClaims: invented,
    target: 0, perCorpus: truth },
  supportingEngineeringMetrics: {
    toolSchemaTokens: engine.toolSchemaTokens,
    indexBytes: ["C-SMALL", "C-MED", "C-LARGE"].map((c) => ({ corpus: c,
      bytes: idx(c)?.indexBytes ?? null, symbols: idx(c)?.symbols ?? null, edges: idx(c)?.edges ?? null })),
    knownDefectsPreserved: {
      incrementalReparsesWholeCorpus: ["C-SMALL", "C-MED", "C-LARGE"].map((c) => ({ corpus: c,
        eligibleFiles: idx(c)?.eligibleFiles ?? null,
        filesReparsedForOneChangedFile: idx(c)?.incremental?.k1?.filesAttemptedForParse ?? null })),
      singleRefreshSequence: ["C-SMALL", "C-MED", "C-LARGE"]
        .map((c) => ({ corpus: c, ...idx(c)?.singleRefreshSequence })),
      incrementalCrashDetail: a3CrashDetail,
      budgetTierBindsBeforeWholeOutputBudget: eng("C-MED")?.a11a13?.utilisationByBudget ?? null,
      twoTokenAccountingAuthoritiesDisagree: ["C-SMALL", "C-MED", "C-LARGE"].map((c) => ({ corpus: c,
        points: eng(c)?.a14?.skeletonAccounting?.authoritiesDisagreeByPoints ?? null })),
      noCallSiteExpressionRenderingOnImpactSurface: a15Impact,
      noMarkdownIndexing: !Object.keys(engine.a1.extensionDetection).includes("markdown"),
      noCrossRepoEdges: "get_impact_graph types crossRepo as the literal false (M196 V-B3)",
    },
  },
  falsificationControls: { allPass: controlsPass, controls },
  productUtilityBoundary: [
    "CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED",
    "NO_OBSERVED_FERRARI_SIZED_REPOSITORY_CONSUMPTION",
  ],
  verdict: parity.verdict,
};

writeFileSync(path.join(RESULTS, "stage5_m197a_claim_ledger.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n${"ID".padEnd(4)}${"REPRODUCTION".padEnd(46)}${"VERDICT".padEnd(30)}MEASUREMENT`);
for (const c of claims) {
  console.log(`${c.id.padEnd(4)}${c.reproduction.padEnd(46)}${String(c.verdict).padEnd(30)}`
    + `${c.measurement.slice(0, 90)}`);
}
console.log(`\nMATCH ${parity.match}  EXCEED ${parity.exceed}  BELOW ${parity.below}  `
  + `NOT_COMPARABLE ${parity.notComparable}  INSUFFICIENT ${parity.insufficientMethod}`);
console.log(`match-or-exceed ${parity.matchOrExceed}/15 (need 10); A8 minimum coverage `
  + `${parity.a8MinimumCoveragePercent}% (need 99)`);
console.log(`structural violations: ${parity.structuralViolations.length}`);
console.log(`determinism: ${allDeterministic ? "stable" : "UNSTABLE"}   `
  + `strengthened structural claims: ${strengthened}   invented: ${invented}`);
console.log(`falsification controls F1-F8: ${controlsPass ? "all pass" : "FAILED"}`);
console.log(`\n${report.verdict}`);
if (!controlsPass) process.exit(1);

/**
 * M160 §42-§44, §116 — known-positive controls for every detector M160's
 * conclusions depend on.
 *
 * The reason this exists is M159's `sympy-13480`: the reach detector reported a
 * clean `UNREACHABLE_BY_GENERATION` while the product was, at that moment,
 * delivering the symbol through `computeClassMethodExpansion` — a post-hybrid
 * lane the detector could not see. The zero was real and the conclusion it
 * invited was false. §42 generalises that into a rule: a detector reporting zero
 * has told you nothing until you have watched it report one.
 *
 * The strongest control available here is not synthetic. The retrieval scorer and
 * the trace reconstruction measure gold delivery through two INDEPENDENT code
 * paths — the scorer over the capsule's ranked files, the reconstruction over the
 * capsule's role assignments. Where they disagree on a case, one of them is
 * wrong, and no downstream taxonomy built on either can be trusted. So that
 * agreement is checked case by case rather than assumed.
 *
 * Reads committed artifacts and pinned workspaces. NO agent, NO Docker, NO
 * network, NO indexing, NO product code.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fileMatches, type RetrievalEvalRow } from "./run_stage5_retrieval_eval";
import { goldFilePresent } from "./run_stage5_m160_corpus_integrity";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(import.meta.dir, "results");

interface Control {
  readonly detector: string;
  readonly kind: "known_positive" | "known_negative" | "cross_check";
  readonly name: string;
  readonly want: unknown;
  readonly got: unknown;
  readonly pass: boolean;
  readonly detail: string;
}

/** §24/§116 — the path comparator, including the cases naive equality gets wrong. */
function pathControls(): Control[] {
  const cases: Array<{ name: string; expected: string; candidate: string; want: boolean }> = [
    { name: "package_root_stripped", expected: "django/db/models/base.py", candidate: "db/models/base.py", want: true },
    { name: "package_root_stripped_nested", expected: "sympy/core/numbers.py", candidate: "core/numbers.py", want: true },
    { name: "identical_path", expected: "lib/matplotlib/axes/_axes.py", candidate: "lib/matplotlib/axes/_axes.py", want: true },
    { name: "non_boundary_suffix", expected: "django/db/models/base.py", candidate: "db/models/notbase.py", want: false },
    { name: "same_leaf_other_tree", expected: "django/db/models/base.py", candidate: "contrib/gis/base.py", want: false },
    { name: "unrelated_file", expected: "sphinx/ext/autodoc/__init__.py", candidate: "sphinx/util/inspect.py", want: false },
    { name: "empty_candidate", expected: "a/b.py", candidate: "", want: false },
  ];
  return cases.map((kase) => {
    const got = fileMatches(kase.expected, kase.candidate);
    return {
      detector: "gold_path_matching",
      kind: kase.want ? "known_positive" : "known_negative",
      name: kase.name,
      want: kase.want,
      got,
      pass: got === kase.want,
      detail: `${kase.expected} vs ${kase.candidate}`,
    } as const;
  });
}

/** §116 — the integrity detector must catch the shape that contaminated Broad100-A. */
function integrityControls(): Control[] {
  const healthy = new Set(["django/apps/registry.py", "django/db/models/sql/query.py"]);
  const truncated = new Set(["django/apps/registry.py", "django/contrib/admin/utils.py"]);
  return [
    {
      detector: "gold_file_integrity",
      kind: "known_positive",
      name: "finds gold in a complete tree",
      want: true,
      got: goldFilePresent("django/db/models/sql/query.py", healthy),
      pass: goldFilePresent("django/db/models/sql/query.py", healthy),
      detail: "a healthy tree must not be reported as broken",
    },
    {
      detector: "gold_file_integrity",
      kind: "known_positive",
      name: "catches the django-13590 truncation shape",
      want: false,
      got: goldFilePresent("django/db/models/sql/query.py", truncated),
      pass: goldFilePresent("django/db/models/sql/query.py", truncated) === false,
      detail: "the tree that lost db/ while keeping apps/ and contrib/",
    },
  ];
}

interface CaseTrace {
  readonly instanceId: string;
  readonly representation: { goldSymbolsIndexed: number; goldFilesIndexed: number };
  readonly preCap: { goldSymbolScored: unknown[]; goldFileScored: unknown[]; replicationValid: boolean };
  readonly postCap: { goldFileOrdinaryRank: number | null; goldSymbolOrdinaryRank: number | null };
  readonly delivery: { goldFileDelivered: boolean; goldSymbolDelivered: boolean };
  readonly firstDivergence: string;
  readonly confidence: string;
}

/**
 * The independent cross-check. The scorer and the reconstruction disagree only if
 * one of them is broken, so this is the control that protects every rate M160
 * reports — not just the residual taxonomy.
 */
function deliveryCrossCheck(rows: readonly RetrievalEvalRow[], traces: readonly CaseTrace[]): Control[] {
  const byId = new Map(traces.map((trace) => [trace.instanceId, trace]));
  const disagreements: string[] = [];
  let compared = 0;
  for (const row of rows) {
    const trace = byId.get(row.instance_id);
    if (trace === undefined) continue;
    compared += 1;
    const scorerDelivered = row.expected_file_role === "pivot" || row.expected_file_role === "support";
    if (scorerDelivered !== trace.delivery.goldFileDelivered) {
      disagreements.push(`${row.instance_id}: scorer=${scorerDelivered} reconstruction=${trace.delivery.goldFileDelivered}`);
    }
  }
  return [
    {
      detector: "delivery",
      kind: "cross_check",
      name: "scorer and trace reconstruction agree on gold delivery",
      want: 0,
      got: disagreements.length,
      pass: disagreements.length === 0,
      detail:
        compared === 0
          ? "no overlapping cases to compare"
          : `${compared} cases compared; disagreements: ${disagreements.slice(0, 5).join("; ") || "none"}`,
    },
  ];
}

/** Internal consistency each first-divergence class must satisfy by its own definition. */
function taxonomyConsistency(traces: readonly CaseTrace[]): Control[] {
  const controls: Control[] = [];

  const laneGeneration = traces.filter((t) => t.firstDivergence === "LANE_GENERATION_FAILURE");
  const laneViolations = laneGeneration.filter(
    (t) => t.representation.goldSymbolsIndexed === 0 || t.preCap.goldSymbolScored.length > 0,
  );
  controls.push({
    detector: "lane_generation",
    kind: "known_positive",
    name: "every LANE_GENERATION_FAILURE has gold indexed and unscored",
    want: 0,
    got: laneViolations.length,
    pass: laneViolations.length === 0,
    detail: `${laneGeneration.length} cases checked; violations: ${laneViolations.map((t) => t.instanceId).join(", ") || "none"}`,
  });

  const eviction = traces.filter((t) => t.firstDivergence === "CANDIDATE_BOUND_EVICTION");
  const evictionViolations = eviction.filter(
    (t) => t.preCap.goldSymbolScored.length + t.preCap.goldFileScored.length === 0,
  );
  controls.push({
    detector: "candidate_bound",
    kind: "known_positive",
    name: "every CANDIDATE_BOUND_EVICTION had gold scored before the cap",
    want: 0,
    got: evictionViolations.length,
    pass: evictionViolations.length === 0,
    detail: `${eviction.length} cases checked; violations: ${evictionViolations.map((t) => t.instanceId).join(", ") || "none"}`,
  });

  const indexMissing = traces.filter((t) => t.firstDivergence === "INDEX_SYMBOL_MISSING");
  const indexViolations = indexMissing.filter((t) => t.representation.goldSymbolsIndexed > 0);
  controls.push({
    detector: "index_symbol_presence",
    kind: "known_positive",
    name: "every INDEX_SYMBOL_MISSING really has no indexed gold symbol",
    want: 0,
    got: indexViolations.length,
    pass: indexViolations.length === 0,
    detail: `${indexMissing.length} cases checked; violations: ${indexViolations.map((t) => t.instanceId).join(", ") || "none"}`,
  });

  // The M159 framework replicates the pre-cap pool and refuses to trust a case
  // whose replication does not match the capsule's own scores. Demanding zero
  // here would be demanding the framework never exercise its own safety valve —
  // A ran 2 of 20, B runs 4 of 27, comparable rates. The invariant that actually
  // matters is that every such case is DOWNGRADED rather than silently labelled.
  const unreplicated = traces.filter((t) => !t.preCap.replicationValid);
  const undowngraded = unreplicated.filter((t) => t.confidence !== "low");
  controls.push({
    detector: "pre_cap_replication",
    kind: "cross_check",
    name: "every case whose pre-cap replication failed is marked low confidence rather than labelled silently",
    want: 0,
    got: undowngraded.length,
    pass: undowngraded.length === 0,
    detail:
      `${unreplicated.length}/${traces.length} unvalidated replications ` +
      `(${unreplicated.map((t) => t.instanceId).join(", ") || "none"}); ` +
      `not downgraded: ${undowngraded.map((t) => t.instanceId).join(", ") || "none"}`,
  });

  return controls;
}

interface ReachControls {
  readonly controlCases: number;
  readonly passed: number;
  readonly failed: number;
  readonly misses: Array<{ instanceId: string; explanation?: string }>;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index < 0 ? fallback : (argv[index + 1] ?? fallback);
  };
  const evalPath = get("--eval", path.join(RESULTS, "stage5_m160_broad100b_retrieval.json"));
  const tracesPath = get("--traces", path.join(RESULTS, "stage5_m160_broad100b_case_traces.json"));
  const reachPath = get("--reach-controls", path.join(RESULTS, "stage5_m160_broad100b_reach_controls.json"));
  const outPath = get("--out", path.join(RESULTS, "stage5_m160_detector_controls.json"));

  const evalDoc = JSON.parse(await readFile(evalPath, "utf8")) as { rows: RetrievalEvalRow[] };
  const traceDoc = JSON.parse(await readFile(tracesPath, "utf8")) as { traces: CaseTrace[] };
  const reach = await readFile(reachPath, "utf8")
    .then((text) => JSON.parse(text) as ReachControls)
    .catch(() => null);

  const controls = [
    ...pathControls(),
    ...integrityControls(),
    ...deliveryCrossCheck(evalDoc.rows, traceDoc.traces),
    ...taxonomyConsistency(traceDoc.traces),
  ];

  const doc = {
    schemaVersion: "stage5.m160.detector-controls.v1",
    milestone: "M160",
    kind: "known-positive controls for every detector M160's conclusions rest on (§42, §116)",
    why:
      "M159's reach detector returned a clean zero on sympy-13480 while the product was delivering the " +
      "symbol through a post-hybrid lane. A zero without a control is not evidence.",
    controls,
    passed: controls.filter((control) => control.pass).length,
    failed: controls.filter((control) => !control.pass).length,
    reachDetector: reach === null
      ? { available: false, note: "reach controls artifact not found" }
      : {
          available: true,
          controlCases: reach.controlCases,
          passed: reach.passed,
          failed: reach.failed,
          misses: reach.misses,
          interpretation:
            "a miss means the product delivered a gold symbol that hybrid generation never scored — i.e. a " +
            "post-hybrid lane. UNREACHABLE_BY_GENERATION must be read as unreachable by HYBRID generation, " +
            "never by the product (M159 standing finding).",
        },
  };

  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`detector controls: ${doc.passed} passed, ${doc.failed} failed`);
  for (const control of controls.filter((c) => !c.pass)) {
    console.log(`  FAIL ${control.detector}/${control.name}: want ${control.want}, got ${control.got} — ${control.detail}`);
  }
  console.log(`  ${path.relative(REPO_ROOT, outPath)}`);
}

if (import.meta.main) {
  await main();
}

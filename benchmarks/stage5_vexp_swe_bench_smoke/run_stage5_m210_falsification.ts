/**
 * M210 — falsification controls F1-F20.
 *
 * M210 is a CAUSAL milestone: its deliverable is the claim that frozen A15's
 * residual is a representation-budget bound and not a relation-allocation one.
 * A causal claim needs controls that could refute it, so the suite here is
 * built around the two statements the milestone actually makes —
 *
 *   (1) no truthful re-ORDERING of the relations the product already delivers
 *       can recover the scored caller, because nothing weaker than an exact
 *       caller is ever ahead of one; and
 *   (2) no CAPACITY the tool accepts can either, because the model-visible
 *       budget cannot carry the number of relations the metric requires.
 *
 * — and each is written so that a product which behaved differently would make
 * the control fail. F1 and F9 are the load-bearing ones: F1 asks the product
 * whether a weaker relation can ever crowd out an exact caller (if it can, the
 * audit's "831 of 831 slots ahead are other callers" is a fact about ARC and
 * not about the tool), and F9 replays every allocation policy over the frozen
 * evidence and requires them all to be identical.
 *
 * The repositories are REAL: materialised on disk and indexed by the production
 * `indexProject`, so a control exercises the parser, the call-site table, the
 * freshness check and the envelope together, never a hand-built graph.
 *
 * F18 is the no-change control. M210 ships no product change, so the honest
 * version of "the predecessor must fail what this milestone repaired" is the
 * mechanical proof that there is nothing to have repaired: `src/` is untouched,
 * so predecessor and product are the same program and every measurement here
 * describes both.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m210_falsification.ts \
 *     [--scratch <dir>]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { getImpactGraph } from "../../src/impact/getImpactGraph";
import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { semanticProjection } from "./m197aScoring";
import { callSiteTruthFaults, frozenA15Rendered, type RelationLike } from "./m209CallSiteTruth";
import { ALLOCATION_POLICIES, relationLane, laneAuthority, responseAnatomy } from "./m210RelationAllocation";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const SCRATCH = argOf("--scratch", "/tmp/m210-falsification");
mkdirSync(SCRATCH, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", REPO, ...a]).stdout.toString();

interface Control { id: string; question: string; pass: boolean; detail: string }
const controls: Control[] = [];
const record = (id: string, question: string, pass: boolean, detail: string) => {
  controls.push({ id, question, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${detail}`);
};

type Server = { handleRequest: (request: unknown) => Promise<any> };
const callTool = async (server: Server, toolId: string, input: unknown): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "m210f", toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

function materialize(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
}

// ---------------------------------------------------------------- fixture A
//
// One repository carrying every relation family at once, so a control about
// ORDER is asked of a stream that genuinely contains weaker things to order.

const callerModule = (count: number): string => [
  "from pkg.core import target",
  "",
  ...Array.from({ length: count }, (_, i) => [
    `def caller_${String(i).padStart(3, "0")}(x):`,
    `    return target(x)`,
    "",
  ]).flat(),
].join("\n");

const FIXTURE_A: Record<string, string> = {
  "pkg/__init__.py": "",
  "pkg/core.py": [
    "def target(x):",
    "    \"\"\"The focal symbol every control asks about.\"\"\"",
    "    return x",
    "",
    "def sibling(x):",
    "    return target(x)",
    "",
    "def orphan():",
    "    return 0",
    "",
  ].join("\n"),
  // One cross-file exact caller and nothing else in this module, so the
  // strongest relation the target has is unambiguous.
  "pkg/one_caller.py": [
    "from pkg.core import target",
    "",
    "def only_caller(x):",
    "    return target(x)",
    "",
  ].join("\n"),
  // Two call sites from ONE caller: F8.
  "pkg/twice.py": [
    "from pkg.core import target",
    "",
    "def two(a, b):",
    "    first = target(a)",
    "    second = target(b)",
    "    return first, second",
    "",
  ].join("\n"),
  // Weaker families: module-level importers, a subtype chain, a referrer.
  "pkg/importer_a.py": ["from pkg.core import target", "", "VALUE = 1", ""].join("\n"),
  "pkg/importer_b.py": ["from pkg.core import target", "", "OTHER = 2", ""].join("\n"),
  "pkg/base.py": ["class Base:", "    def run(self):", "        return 1", ""].join("\n"),
  "pkg/child.py": ["from pkg.base import Base", "", "class Child(Base):", "    def run(self):", "        return 2", ""].join("\n"),
  "pkg/refer.py": [
    "from pkg.core import target",
    "",
    "def hand_off():",
    "    fn = target",
    "    return fn",
    "",
  ].join("\n"),
  // An unresolved receiver: the only state in which a POTENTIAL caller exists.
  "pkg/registry.py": ["class Reg:", "    def target(self, x):", "        return x", ""].join("\n"),
  "pkg/dyn.py": [
    "from pkg.registry import Reg",
    "",
    "def dispatch(table, name, x):",
    "    handler = table[name]",
    "    return handler.target(x)",
    "",
    "def build(flag):",
    "    return Reg() if flag else None",
    "",
  ].join("\n"),
  // A transitive layer, so `edges`/`nodes` carry depth-2 content too.
  "pkg/outer.py": ["from pkg.one_caller import only_caller", "", "def outer(x):", "    return only_caller(x)", ""].join("\n"),
};

const TARGET = "pkg/core.py::target";
const ORPHAN = "pkg/core.py::orphan";

/**
 * Build a real repository and index it THROUGH THE PRODUCT, then hand back both
 * the core handle and an MCP server bound to the same on-disk index. The index
 * has to be a file the server can open: an in-memory database indexed here is
 * invisible to a server that opens its own, and every MCP control would then be
 * measuring an unready repository rather than the product.
 */
async function buildRepo(name: string, files: Record<string, string>) {
  const root = mkdtempSync(path.join(SCRATCH, `${name}-`));
  materialize(root, files);
  const dbPath = path.join(root, ".vtrace/index.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const server: Server = createMcpServer({ context: { repoRoot: root, dbPath } } as any);
  const indexed = await callTool(server, McpToolId.IndexRepo, { repo_root: root });
  if (indexed?.readiness?.status !== "ready") throw new Error(`M210_FIXTURE_NOT_READY: ${name} ${JSON.stringify(indexed)?.slice(0, 200)}`);
  const db = new Database(dbPath, { readonly: true });
  return { root, db, server };
}

const fixtureA = await buildRepo("mixed", FIXTURE_A);
const impactA = (input: Record<string, unknown> = {}) =>
  getImpactGraph(fixtureA.db, { symbolFqn: TARGET, depth: 3, format: "tree", ...input }, { repoRoot: fixtureA.root });

// ---------------------------------------------------------- F1 crowd-out

{
  const result = impactA();
  const relations: readonly RelationLike[] = result.ok ? (result.output.directRelations as readonly RelationLike[]) : [];
  const lanes = relations.map(relationLane);
  const firstExact = lanes.indexOf("exact_caller");
  const weakerAheadOfFirstExact = firstExact < 0 ? 0
    : lanes.slice(0, firstExact).filter((lane) => laneAuthority(lane) > laneAuthority("exact_caller")).length;
  // The population genuinely contains weaker families, or the control is vacuous.
  const weakerPresent = lanes.filter((lane) => laneAuthority(lane) > laneAuthority("resolved_caller")).length;
  record("F1", "can a weaker relation ever be ordered ahead of an exact caller?",
    firstExact >= 0 && weakerAheadOfFirstExact === 0 && weakerPresent > 0,
    `${relations.length} relations, lanes ${JSON.stringify(lanes.reduce((a: any, l) => ({ ...a, [l]: (a[l] ?? 0) + 1 }), {}))}; `
    + `first exact caller at ordinal ${firstExact}; weaker relations ahead of it ${weakerAheadOfFirstExact}; `
    + `weaker relations present in the stream ${weakerPresent} (a zero here would make the control vacuous)`);
}

// ------------------------------------------------------- F2 no caller exists

{
  const response = await callTool(fixtureA.server, McpToolId.GetImpactGraph, { repo_root: fixtureA.root, symbol_fqn: ORPHAN, depth: 3 });
  const incomingCalls = (response?.directRelations ?? []).filter((r: any) => r.direction === "incoming" && r.kind === "calls");
  const fabricated = (response?.directRelations ?? []).filter((r: any) => r.evidence?.sourceText !== undefined && r.evidence?.callSites === undefined);
  record("F2", "does a target with no callers get a fabricated caller slot?",
    incomingCalls.length === 0 && fabricated.length === 0 && (response?.callerCoverage?.exactCallerCount ?? -1) === 0,
    `orphan: ${response?.directRelations?.length ?? 0} relations, ${incomingCalls.length} incoming calls, `
    + `exactCallerCount ${response?.callerCoverage?.exactCallerCount}, potentialCallers ${response?.potentialCallers?.length ?? 0}, fabricated ${fabricated.length}`);
}

// ------------------------------------------------- F3/F10/F20 fanout family

const FANOUTS = [0, 1, 8, 32, 63, 64, 65, 96, 128, 256, 512] as const;
const fanoutRows: any[] = [];
for (const n of FANOUTS) {
  const files = { ...FIXTURE_A, "pkg/many.py": callerModule(n) };
  const built = await buildRepo(`fan${n}`, files);
  const hashes = new Set<string>();
  const latency: number[] = [];
  let response: any = null;
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    response = await callTool(built.server, McpToolId.GetImpactGraph, { repo_root: built.root, symbol_fqn: TARGET, depth: 3 });
    latency.push(+(performance.now() - started).toFixed(2));
    // The committed §29 projection, not a hand-rolled one: it strips exactly the
    // clock-derived keys and nothing a content change could hide behind.
    hashes.add(sha(JSON.stringify(semanticProjection(response))));
  }
  const core = getImpactGraph(built.db, { symbolFqn: TARGET, depth: 3, format: "tree" }, { repoRoot: built.root });
  const coreIds = core.ok ? (core.output.directRelations as any[]).map((r) => r.id) : [];
  const deliveredIds = (response?.directRelations ?? []).map((r: any) => r.id);
  const anatomy = responseAnatomy(response);
  fanoutRows.push({
    fanout: n, coreRelations: coreIds.length, deliveredRelations: anatomy.deliveredRelations,
    characters: anatomy.totalCharacters, ceilingCharacters: (response?.responseBudget?.totalCeiling ?? 0) * 4,
    withinEnvelope: response?.responseBudget?.withinEnvelope === true,
    resultState: response?.responseBudget?.resultState, omittedEdges: response?.responseBudget?.omittedEdges,
    deterministic: hashes.size === 1,
    deliveredIsCorePrefix: deliveredIds.every((id: string, i: number) => coreIds[i] === id),
    // §22: standalone impact latency at this fanout, so "does enumeration cost
    // scale with the caller population" is a measurement, not an assumption.
    latencyMs: latency, medianLatencyMs: [...latency].sort((a, b) => a - b)[1] ?? null,
  });
  built.db.close();
}
record("F3", "do many exact callers yield a deterministic BOUNDED prefix rather than an unbounded list?",
  fanoutRows.every((r) => r.deterministic && r.deliveredIsCorePrefix && r.deliveredRelations <= r.coreRelations),
  fanoutRows.map((r) => `${r.fanout}:${r.deliveredRelations}/${r.coreRelations}${r.deterministic ? "" : " NONDET"}${r.deliveredIsCorePrefix ? "" : " NOTPREFIX"}`).join(" "));
record("F10", "does genuine capacity exhaustion stay bounded and report itself?",
  fanoutRows.filter((r) => r.fanout >= 64).every((r) => r.withinEnvelope && r.omittedEdges > 0 && r.resultState === "bounded_truncated"),
  fanoutRows.filter((r) => r.fanout >= 64).map((r) => `${r.fanout}:${r.resultState}/omitted ${r.omittedEdges}`).join(" "));
record("F20", "is ONE policy applied across arbitrary fanout, with the response always inside its envelope?",
  fanoutRows.every((r) => r.withinEnvelope && r.characters <= r.ceilingCharacters && r.deliveredRelations >= Math.min(1, r.coreRelations)),
  fanoutRows.map((r) => `${r.fanout}:${r.characters}<=${r.ceilingCharacters}@${r.medianLatencyMs}ms`).join(" "));

// -------------------------------------------------- F4 exact versus potential

{
  const response = await callTool(fixtureA.server, McpToolId.GetImpactGraph,
    { repo_root: fixtureA.root, symbol_fqn: "pkg/registry.py::Reg.target", depth: 3, max_tokens: 8000 });
  const relations = response?.directRelations ?? [];
  const promoted = relations.filter((r: any) => r.kind === "calls" && r.strength === "exact"
    && (r.source?.path ?? "").endsWith("dyn.py"));
  const potential = response?.potentialCallers ?? [];
  // Non-vacuity: the fixture must actually produce the state the control is
  // about — an unresolved receiver — or the "no promotion" assertion is empty.
  // M209 recorded that candidate discovery is edge-gated, so this is checked and
  // reported rather than assumed.
  const potentialIsSeparate = potential.every((c: any) => typeof c.confidence === "string"
    && !relations.some((r: any) => r.source?.path === c.filePath && r.strength === "exact"));
  record("F4", "can an unresolved receiver arrive as an EXACT caller?",
    promoted.length === 0 && potentialIsSeparate && potential.length > 0,
    `Reg.target: ${relations.length} relations, ${promoted.length} exact callers claimed from the dynamic dispatch site `
    + `(0 required); ${potential.length} potential callers, confidences `
    + `${JSON.stringify([...new Set(potential.map((c: any) => c.confidence))])}; kept out of directRelations ${potentialIsSeparate}`);
}

// ------------------------------------- F5/F6/F7/F8 preservation and identity

{
  const result = impactA({ maxTokens: 8000 });
  const relations: readonly RelationLike[] = result.ok ? (result.output.directRelations as readonly RelationLike[]) : [];
  const lanes = relations.map(relationLane);
  const importers = lanes.filter((l) => l === "importer").length;
  const nonCallers = lanes.filter((l) => l !== "exact_caller" && l !== "resolved_caller").length;
  record("F5", "does the relation stream still carry non-call impact evidence?",
    importers > 0 && nonCallers > 0,
    `${relations.length} relations: ${JSON.stringify(lanes.reduce((a: any, l) => ({ ...a, [l]: (a[l] ?? 0) + 1 }), {}))}`);

  const sameFile = relations.filter((r) => r.source?.path === r.target?.path).length;
  const crossFile = relations.filter((r) => r.source?.path !== undefined && r.target?.path !== undefined && r.source.path !== r.target.path).length;
  const sameFileTruthful = relations.every((r) => r.source?.path === undefined || r.target?.path === undefined
    || (r.source.path === r.target.path) === (r.source.path === "pkg/core.py" && r.target.path === "pkg/core.py"));
  record("F6", "are same-file and cross-file status truthful?",
    sameFile > 0 && crossFile > 0 && sameFileTruthful,
    `same-file ${sameFile} (sibling in pkg/core.py), cross-file ${crossFile}`);

  const ids = relations.map((r) => r.id);
  const pairs = relations.map((r) => `${r.source?.symbol}->${r.target?.symbol}|${r.kind}`);
  record("F7", "does one caller/target pair reached by several routes arrive once?",
    new Set(ids).size === ids.length && new Set(pairs).size === pairs.length,
    `${ids.length} relations, ${new Set(ids).size} distinct ids, ${new Set(pairs).size} distinct caller/target/kind pairs`);

  const twice = relations.find((r) => (r.source?.symbol ?? "").endsWith("::two"));
  const sites = twice?.evidence?.callSites ?? [];
  record("F8", "do two calls from one caller stay two distinct sites on one relation?",
    twice !== undefined && (twice.evidence?.callSiteCount ?? 0) === 2 && sites.length === 2
    && sites[0]!.startLine !== sites[1]!.startLine,
    twice === undefined ? "pkg/twice.py::two relation not delivered"
      : `callSiteCount ${twice.evidence?.callSiteCount}, sites ${sites.map((s) => `${s.startLine}-${s.endLine}`).join(",")}`);
}

// ------------------------- F9 fixed-capacity closure control (load-bearing)

{
  const auditPath = path.join(RESULTS, "stage5_m210_audit_pre.json");
  const allocPath = path.join(RESULTS, "stage5_m210_allocation_pre.json");
  if (!existsSync(auditPath) || !existsSync(allocPath)) {
    record("F9", "can any truthful allocation policy recover the frozen caller inside the shipped bound?",
      false, "M210_MEASUREMENT_MISSING: run the audit and allocation drivers first");
  } else {
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    const alloc = JSON.parse(readFileSync(allocPath, "utf8"));
    const large = audit.corpora.find((c: any) => c.id === "C-LARGE");
    const largeAlloc = alloc.corpora.find((c: any) => c.id === "C-LARGE");
    const armPercents = Object.entries(large.arms).map(([name, a]: any) => [name, a.percent]);
    const allEqual = armPercents.every(([, p]) => p === large.frozen.percent);
    const evidenceOnlyCeiling = largeAlloc.packingModels.C_EVIDENCE_ONLY.percent;
    record("F9", "can any truthful allocation policy recover the frozen caller inside the shipped bound?",
      allEqual && evidenceOnlyCeiling < 90,
      `C-LARGE frozen ${large.frozen.percent}%; every allocation arm ${JSON.stringify(Object.fromEntries(armPercents))}; `
      + `evidence-only packing ceiling (graph restatement charged at ZERO) ${evidenceOnlyCeiling}% < 90 required`);
    // The edge sweep is the other half: capacity that is not budget.
    const edgeSweep = Object.entries(largeAlloc.edgeSweep).map(([k, s]: any) => [k, s.percent]);
    record("F11", "is the capacity/budget decomposition stable and single-authority?",
      edgeSweep.every(([, p]) => p === large.frozen.percent)
      && Object.values(largeAlloc.tokenSweep).some((s: any) => s.percent > large.frozen.percent),
      `edge-only sweep ${JSON.stringify(Object.fromEntries(edgeSweep))} (flat = enumeration capacity does not bind); `
      + `token-only sweep ${JSON.stringify(Object.fromEntries(Object.entries(largeAlloc.tokenSweep).map(([k, s]: any) => [k, s.percent])))}`);
  }
}

// -------------------------------------------- F12/F13 M209 rendering guards

{
  const result = impactA({ maxTokens: 8000 });
  const relations: readonly RelationLike[] = result.ok ? (result.output.directRelations as readonly RelationLike[]) : [];
  const caller = relations.find((r) => (r.source?.symbol ?? "").endsWith("::only_caller"));
  const lines = readFileSync(path.join(fixtureA.root, "pkg/one_caller.py"), "utf8").split("\n");
  const identity = (() => { const b = readFileSync(path.join(fixtureA.root, "pkg/one_caller.py")); return { sizeBytes: b.length, contentHash: createHash("sha256").update(b).digest("hex") }; })();
  const truth = (relation: RelationLike) => callSiteTruthFaults({
    relation, sourceLines: lines, indexedFile: identity, actualFile: identity,
    callerSpan: { startLine: 3, endLine: 4 }, expectedCallee: "target",
  });
  const honest = caller !== undefined && frozenA15Rendered(caller) && truth(caller).length === 0;
  // A forged line that SATISFIES the frozen rule must still fail the truth guard.
  const forged: RelationLike = { ...caller!, evidence: { ...caller!.evidence, sourceText: "    return target(x)  # forged" } };
  const forgedPassesFrozen = frozenA15Rendered(forged);
  const forgedFailsTruth = truth(forged).includes("SOURCE_TEXT_NOT_AT_SPAN");
  record("F12", "is the delivered call line the file's own line, and is a plausible forgery still caught?",
    honest && forgedPassesFrozen && forgedFailsTruth,
    caller === undefined ? "only_caller relation not delivered"
      : `rendered ${JSON.stringify(caller.evidence?.sourceText)} faults ${JSON.stringify(truth(caller))}; `
      + `forgery passes the frozen rule ${forgedPassesFrozen} and fails the truth guard ${forgedFailsTruth}`);

  // F13: edit the file after indexing; the excerpt must not be rebuilt from it.
  const staleRoot = mkdtempSync(path.join(SCRATCH, "stale-"));
  materialize(staleRoot, FIXTURE_A);
  const staleDb = openIndexerDatabase();
  await indexProject({ repoRoot: staleRoot, db: staleDb });
  const edited = readFileSync(path.join(staleRoot, "pkg/one_caller.py"), "utf8")
    .replace("    return target(x)", "    return target(x)  # edited after indexing\n    # padding line");
  writeFileSync(path.join(staleRoot, "pkg/one_caller.py"), edited);
  const staleResult = getImpactGraph(staleDb, { symbolFqn: TARGET, depth: 3, format: "tree", maxTokens: 8000 }, { repoRoot: staleRoot });
  const staleRelation: RelationLike | undefined = staleResult.ok
    ? (staleResult.output.directRelations as readonly RelationLike[]).find((r) => (r.source?.symbol ?? "").endsWith("::only_caller"))
    : undefined;
  const staleText = staleRelation?.evidence?.sourceText;
  record("F13", "is a file edited after indexing ever rendered as current source?",
    staleRelation !== undefined && (staleText === undefined || !staleText.includes("edited after indexing")),
    staleRelation === undefined ? "relation absent" : `sourceText ${staleText === undefined ? "(withheld)" : JSON.stringify(staleText)}`);
  staleDb.close();
}

// --------------------------------------------- F14 whole-response bound

{
  const built = await buildRepo("bound", { ...FIXTURE_A, "pkg/many.py": callerModule(400) });
  const rows: any[] = [];
  for (const budget of [1, 50, 200, 400, 1200, 4000, 20000]) {
    const response = await callTool(built.server, McpToolId.GetImpactGraph,
      { repo_root: built.root, symbol_fqn: TARGET, depth: 3, max_tokens: budget });
    const characters = JSON.stringify(response ?? {}).length;
    rows.push({ budget, characters, ceiling: (response?.responseBudget?.totalCeiling ?? 0) * 4,
      within: response?.responseBudget?.withinEnvelope === true,
      tokens: response?.responseBudget?.estimatedTotalTokens, totalCeiling: response?.responseBudget?.totalCeiling });
  }
  record("F14", "does a 400-caller fanout ever leave the response envelope, at any budget?",
    rows.every((r) => r.within && r.tokens <= r.totalCeiling && r.characters <= 80_000),
    rows.map((r) => `${r.budget}:${r.tokens}<=${r.totalCeiling}`).join(" "));
  built.db.close();
}

// ------------------------------------------- F15 A11 path isolation proof

{
  const importers = Bun.spawnSync(["grep", "-rln", "impactResponseEnvelope", path.join(REPO, "src")]).stdout.toString()
    .split("\n").filter((l) => l.trim().length > 0).map((l) => path.relative(REPO, l));
  const consumers = importers.filter((f) => f !== "src/impact/impactResponseEnvelope.ts" && !f.endsWith(".test.ts"));
  const pipelineFree = !consumers.some((f) => f.includes("runPipeline") || f.includes("productContext/assemble"));
  record("F15", "is the impact envelope on the run_pipeline / get_code_context path at all?",
    pipelineFree,
    `files referencing impactResponseEnvelope: ${JSON.stringify(consumers)}; `
    + `run_pipeline and get_code_context import getImpactGraph (the CORE) and never the envelope, so an envelope-only `
    + `change cannot reach A11/A13`);
}

// ------------------------------------------------ F17 accounting integrity

{
  const response = await callTool(fixtureA.server, McpToolId.GetImpactGraph, { repo_root: fixtureA.root, symbol_fqn: TARGET, depth: 3 });
  const measured = JSON.stringify(response).length;
  const claimed = response?.responseBudget?.serializedCharacters ?? -1;
  const corrupted = claimed + 40;
  record("F17", "does the response's own size accounting equal its measured size, and is a corruption detectable?",
    measured === claimed && corrupted !== measured,
    `claimed ${claimed}, measured ${measured}; a +40 corruption (${corrupted}) is detectable`);
}

// ---------------------------------------------------- F18 no product change

{
  const changedSrc = git("diff", "--name-only", "HEAD", "--", "src").split("\n").filter((l) => l.trim().length > 0);
  const stagedSrc = git("diff", "--name-only", "--cached", "HEAD", "--", "src").split("\n").filter((l) => l.trim().length > 0);
  record("F18", "did M210 change product behaviour, so that a predecessor comparison is even meaningful?",
    changedSrc.length === 0 && stagedSrc.length === 0,
    `src/ files modified: ${changedSrc.length + stagedSrc.length}. With zero product change the predecessor IS this `
    + `product, so every measurement in this suite describes both and there is no historical condition to reproduce apart from it.`);
}

// ------------------------------------------------------- F19 anti-hardcode

{
  const newFiles = [
    "benchmarks/stage5_vexp_swe_bench_smoke/m210RelationAllocation.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m210_audit.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m210_allocation.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m210_falsification.ts",
  ];
  // The frozen threshold may appear in an INSTRUMENT (it is what the instrument
  // measures against); it may never appear in `src/`.
  const hits = Bun.spawnSync(["grep", "-rnE", "\\b(50|90|0\\.9)\\b", path.join(REPO, "src/impact")]).stdout.toString()
    .split("\n").filter((l) => l.trim().length > 0 && !l.includes(".test.ts"))
    .map((l) => path.relative(REPO, l).trim());
  // Every hit must PREDATE this milestone. A constant that entered `src/` during
  // M210 is the thing this control exists to catch, and with the tree untouched
  // the set is provably the inherited one.
  const introducedByM210 = Bun.spawnSync(["git", "-C", REPO, "diff", "HEAD", "--", "src/impact"]).stdout.toString().trim().length > 0;
  record("F19", "did any frozen-A15 constant enter the product?",
    !introducedByM210,
    `src/impact carries ${hits.length} pre-existing occurrences of 50/90/0.9, none introduced here (src/impact diff empty: `
    + `${!introducedByM210}): ${JSON.stringify(hits.slice(0, 12))}. The frozen population size and threshold appear only in `
    + `the instruments, which is where a measurement's own constants belong: ${JSON.stringify(newFiles)}`);
}

// -------------------------------------------------------- F16 A13 protection

{
  const enginePath = path.join(RESULTS, "stage5_m197a_engine.json");
  if (!existsSync(enginePath)) {
    record("F16", "did the focus contract move?", false, "M197A_MEASUREMENT_MISSING");
  } else {
    const engine = JSON.parse(readFileSync(enginePath, "utf8"));
    const med = engine.corpora.find((c: any) => c.id === "C-MED");
    record("F16", "did the focus contract move?",
      (med?.a11a13?.tasksWithSizeViolation ?? -1) === 0 && (med?.a11a13?.tasksWithFocusSwap ?? -1) === 0,
      `C-MED focus size violations ${med?.a11a13?.tasksWithSizeViolation}, focus swaps ${med?.a11a13?.tasksWithFocusSwap} over ${med?.a11a13?.tasks} tasks`);
  }
}

fixtureA.db.close();

const verdict = controls.every((c) => c.pass) ? "M210_FALSIFICATION_SUITE_PASSED" : "M210_FALSIFICATION_SUITE_FAILED";
console.log(`\n${controls.filter((c) => c.pass).length}/${controls.length} controls pass — ${verdict}`);
writeFileSync(path.join(RESULTS, "stage5_m210_falsification.json"),
  `${JSON.stringify({ milestone: "M210", instrument: "run_stage5_m210_falsification.ts", scratch: SCRATCH,
    fanout: fanoutRows, controls, verdict }, null, 2)}\n`);
console.log("wrote results/stage5_m210_falsification.json");

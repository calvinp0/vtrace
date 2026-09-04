/**
 * M209 — falsification controls F1-F20.
 *
 * A gate that has never been seen to fail is not known to be a gate. Each
 * control constructs the specific dishonesty the milestone guards against — a
 * span that points at the wrong line, a plausible invented call expression, an
 * unresolved receiver dressed as a proven caller, two call sites collapsed into
 * one, a transitive dependent presented as a direct caller, a stale file
 * rendered as current, a generated file smuggled in through an edge, a caller
 * read out of a nested worktree, an unaccounted item, an unbounded packet — and
 * shows the production evidence builder, the production impact envelope, the
 * production indexer or the M209 truth guard refusing it, beside the honest
 * case each accepts.
 *
 * The repositories are REAL: materialised on disk and indexed by the production
 * `indexProject`, never hand-built graph fixtures, so a control exercises the
 * parser, the call-site table, the freshness check and the envelope together.
 * F19 runs the PREDECESSOR product (a worktree at the M208 final commit) on the
 * same repository and requires it to FAIL the rendering condition this
 * milestone repaired: a suite that cannot make the historical product fail is
 * not a suite.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m209_falsification.ts \
 *     [--predecessor-root /home/calvin/bench/vtrace-m209/pre] [--scratch <dir>]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { getImpactGraph } from "../../src/impact/getImpactGraph";
import { compactImpactProductResponse } from "../../src/impact/impactResponseEnvelope";
import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { listSymbolsByFqName } from "../../src/db/repositories/symbolsRepository";
import { getFileByPath } from "../../src/db/repositories/filesRepository";
import {
  callSiteIdentity, callSiteTruthFaults, frozenA15Rendered, impactRole, type RelationLike,
} from "./m209CallSiteTruth";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PREDECESSOR_ROOT = path.resolve(argOf("--predecessor-root", "/home/calvin/bench/vtrace-m209/pre"));
const SCRATCH = argOf("--scratch", "/home/calvin/bench/vtrace-m209/scratch/falsification");
mkdirSync(SCRATCH, { recursive: true });

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const predecessorEnvelope = await import(path.join(PREDECESSOR_ROOT, "src/impact/impactResponseEnvelope.ts"));
const predecessorHead = Bun.spawnSync(["git", "-C", PREDECESSOR_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

interface Control { id: string; question: string; pass: boolean; detail: string }
const controls: Control[] = [];
const record = (id: string, question: string, pass: boolean, detail: string) => {
  controls.push({ id, question, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${detail}`);
};

// ------------------------------------------------------------------ fixture

/**
 * One repository, written once, carrying every shape the controls need: a
 * cross-file exact call, a same-file call, one caller that calls the target
 * twice, a transitive A -> B -> C chain, a dynamic receiver the parser cannot
 * resolve, and a generated file the scanner excludes.
 */
const FILES: Record<string, string> = {
  // Real packages: the Python import resolver maps `svc.user` to `svc/user.py`
  // only for a package on disk, and a fixture that skipped them would be
  // measuring an unresolvable import rather than a cross-file call.
  "svc/__init__.py": "",
  "routes/__init__.py": "",
  "svc/user.py": [
    "def get_user_by_id(user_id):",
    "    \"\"\"Return the user record.\"\"\"",
    "    return {\"id\": user_id}",
    "",
    "def load_profile(user_id):",
    "    record = get_user_by_id(user_id)",
    "    return record",
    "",
  ].join("\n"),
  "routes/user.py": [
    "from svc.user import get_user_by_id",
    "",
    "def handle(request):",
    "    owner = get_user_by_id(request.owner_id)",
    "    return owner",
    "",
    "def handle_twice(request):",
    "    first = get_user_by_id(request.a)",
    "    second = get_user_by_id(request.b)",
    "    return first, second",
    "",
  ].join("\n"),
  "routes/admin.py": [
    "from routes.user import handle",
    "",
    "def panel(request):",
    "    return handle(request)",
    "",
  ].join("\n"),
  "svc/registry.py": [
    "class UserService:",
    "    def lookup_user(self, user_id):",
    "        return {\"id\": user_id}",
    "",
  ].join("\n"),
  // `handler` is a dict element: the parser cannot prove its type, so no edge
  // exists and `lookup_user` has zero exact callers. That is the only state in
  // which the caller-coverage scan runs, and it is the state F4 is about.
  "svc/dynamic.py": [
    "from svc.registry import UserService",
    "",
    "def dispatch(registry, name):",
    "    handler = registry[name]",
    "    return handler.lookup_user(1)",
    "",
    "def build(kind):",
    "    return UserService() if kind else None",
    "",
  ].join("\n"),
  "build/generated.py": [
    "from svc.user import get_user_by_id",
    "",
    "def generated_caller():",
    "    return get_user_by_id(0)",
    "",
  ].join("\n"),
};

function materialize(root: string, files: Record<string, string> = FILES): void {
  for (const [rel, text] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
}

const repoRoot = mkdtempSync(path.join(SCRATCH, "repo-"));
materialize(repoRoot);
const db = openIndexerDatabase();
await indexProject({ repoRoot, db });

const TARGET = "svc/user.py::get_user_by_id";
const linesOf = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8").split("\n");
const truthInput = (relation: RelationLike, callee = "get_user_by_id") => {
  const callerPath = relation.source?.path ?? "";
  const bytes = readFileSync(path.join(repoRoot, callerPath));
  const indexed = getFileByPath(db, callerPath);
  const callerSymbol = relation.source?.symbol === undefined ? undefined : listSymbolsByFqName(db, relation.source.symbol)[0];
  return {
    relation, sourceLines: bytes.toString("utf8").split("\n"),
    indexedFile: indexed === undefined ? null : { sizeBytes: indexed.sizeBytes, contentHash: indexed.contentHash },
    actualFile: { sizeBytes: bytes.length, contentHash: sha(bytes) },
    callerSpan: callerSymbol === undefined ? null : { startLine: callerSymbol.startLine, endLine: callerSymbol.endLine },
    expectedCallee: callee,
  };
};

const core = getImpactGraph(db, { symbolFqn: TARGET, depth: 3, format: "tree" }, { repoRoot });
if (!core.ok) throw new Error("M209_FALSIFICATION_FIXTURE_UNUSABLE: the target did not resolve");
const coreRelations = core.output.directRelations as unknown as RelationLike[];
const incoming = coreRelations.filter((r) => r.direction === "incoming" && r.kind === "calls");
/**
 * The delivered response at a budget that can afford the evidence. The DEFAULT
 * budget is deliberately not used for the rendering controls: at 1 200 tokens
 * this fixture's response reaches the ladder's per-relation rung and sheds the
 * line, which is correct behaviour and is what F16/F17 pin. A rendering control
 * measured there would be measuring the budget instead of the rendering.
 */
const AFFORDABLE_TOKENS = 3_000;
const affordable = (output: any, envelope = compactImpactProductResponse) =>
  envelope({ ...output, limits: { ...output.limits, maxTokens: AFFORDABLE_TOKENS } });
const delivered = affordable(core.output);
const deliveredRelations = delivered.directRelations as unknown as RelationLike[];
const relationFrom = (list: readonly RelationLike[], caller: string) => list.find((r) => r.source?.symbol === caller) ?? null;

// ------------------------------------------------------- F1 exact caller

const f1 = relationFrom(deliveredRelations, "routes/user.py::handle");
const f1Site = f1?.evidence?.callSites?.[0];
const f1Line = f1Site === undefined ? "" : linesOf("routes/user.py")[f1Site.startLine - 1] ?? "";
record("F1", "does an exact cross-file caller render its own call line, at its own span?",
  f1 !== null && frozenA15Rendered(f1) && callSiteTruthFaults(truthInput(f1)).length === 0
  && f1.evidence?.sourceText === f1Line.trim(),
  f1 === null ? "the caller was not delivered at all"
    : `routes/user.py::handle rendered ${JSON.stringify(f1.evidence?.sourceText)} at L${f1Site?.startLine}, faults ${JSON.stringify(callSiteTruthFaults(truthInput(f1)))}, role "${impactRole(f1)}"`);

// -------------------------------------------------------- F2 wrong span

const f2Relation: RelationLike = f1 === null ? {} : {
  ...f1, evidence: { ...f1.evidence, callSites: [{ startLine: 3, endLine: 3, precision: "span" }] },
};
const f2Faults = callSiteTruthFaults(truthInput(f2Relation));
record("F2", "is a span moved to another valid-looking line of the same file rejected?",
  f2Faults.includes("SPAN_TEXT_LACKS_CALLEE") || f2Faults.includes("SOURCE_TEXT_NOT_AT_SPAN"),
  `moved to L3 (\`${(linesOf("routes/user.py")[2] ?? "").trim()}\`): faults ${JSON.stringify(f2Faults)}`);

// --------------------------------------------------- F3 fabricated snippet

const forged = "user = await UserService.getUserById(session.userId)";
const f3Relation: RelationLike = f1 === null ? {} : { ...f1, evidence: { ...f1.evidence, sourceText: forged, referenceName: "getUserById" } };
const f3Faults = callSiteTruthFaults(truthInput(f3Relation, "getUserById"));
record("F3", "is a plausible invented call expression rejected even though it names a callee?",
  f3Faults.includes("SOURCE_TEXT_NOT_AT_SPAN") && frozenA15Rendered(f3Relation),
  `the forged line satisfies the FROZEN rule (${frozenA15Rendered(f3Relation)}) and fails the source guard: ${JSON.stringify(f3Faults)}`);

// -------------------------------------------------- F4 potential caller

const dynamic = await (async () => {
  const server = createMcpServer({ context: { repoRoot, dbPath: path.join(repoRoot, ".vtrace/index.sqlite") } } as any);
  const call = async (t: string, i: unknown) => (await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "f4", toolId: t, input: i } as any) as any)?.result?.output;
  await call(McpToolId.IndexRepo, { repo_root: repoRoot });
  return call(McpToolId.GetImpactGraph, { repo_root: repoRoot, symbol_fqn: "svc/registry.py::UserService.lookup_user", depth: 3 });
})();
const dynamicCallerIsRelation = (dynamic?.directRelations ?? []).some((r: any) => r.source?.path === "svc/dynamic.py");
const potentialCallers = dynamic?.potentialCallers ?? [];
const dynamicSite = potentialCallers.find((c: any) => c.filePath === "svc/dynamic.py");
record("F4", "does an unresolved receiver stay out of the proven relations, and arrive labelled?",
  !dynamicCallerIsRelation && (dynamic?.callerCoverage?.status ?? "") !== "complete"
  && dynamicSite !== undefined && dynamicSite.confidence !== undefined
  && !JSON.stringify(dynamic?.directRelations ?? []).includes("svc/dynamic.py"),
  `svc/dynamic.py as a proven relation: ${dynamicCallerIsRelation}; coverage status "${dynamic?.callerCoverage?.status}" `
  + `(exact callers ${dynamic?.callerCoverage?.exactCallerCount}, potential ${dynamic?.callerCoverage?.potentialCallerCount}); `
  + `the dynamic site arrives as a potential caller with confidence "${dynamicSite?.confidence}" / evidenceKind `
  + `"${dynamicSite?.evidenceKind}", receiver ${JSON.stringify(dynamicSite?.receiverExpression)} — never as a caller`);

// ------------------------------------------- F5 exact / weaker collision

const byIdentity = new Map<string, RelationLike[]>();
for (const relation of incoming) {
  const key = `${relation.source?.symbol} ${relation.target?.symbol}`;
  byIdentity.set(key, [...(byIdentity.get(key) ?? []), relation]);
}
const collisions = [...byIdentity.values()].filter((v) => v.length > 1);
record("F5", "can one caller reach the target through two relations at once?",
  collisions.length === 0,
  collisions.length === 0
    ? `${byIdentity.size} caller/target pairs, each represented once; strengths ${JSON.stringify([...new Set(incoming.map((r) => r.strength))])}`
    : `${collisions.length} pair(s) delivered more than once`);

// ------------------------------------- F6 two call sites in one caller

const twice = relationFrom(coreRelations, "routes/user.py::handle_twice");
const twiceSites = twice?.evidence?.callSites ?? [];
record("F6", "are two calls from one caller kept as two sites, not collapsed to a file?",
  twiceSites.length === 2 && twiceSites[0]!.startLine !== twiceSites[1]!.startLine
  && (twice?.evidence?.callSiteCount ?? 0) === 2,
  `handle_twice: ${twiceSites.length} sites at L${twiceSites.map((s) => s.startLine).join(", L")}, callSiteCount ${twice?.evidence?.callSiteCount}`);

// ------------------------------------------- F7 duplicate traversal routes

const identities = deliveredRelations.map((r) => callSiteIdentity(r));
record("F7", "does one underlying call site arrive once, however many routes reach it?",
  new Set(identities).size === identities.length,
  `${identities.length} delivered relation(s), ${new Set(identities).size} distinct call-site identities`);

// ------------------------------------------------------- F8/F9 same/cross file

const sameFile = relationFrom(coreRelations, "svc/user.py::load_profile");
const crossFileOk = f1 !== null && f1.source?.path === "routes/user.py" && f1.target?.path === "svc/user.py";
record("F8", "is a same-file caller rendered, and truthfully marked same-file?",
  sameFile !== null && sameFile.source?.path === "svc/user.py" && sameFile.target?.path === "svc/user.py"
  && callSiteTruthFaults(truthInput(sameFile)).length === 0,
  sameFile === null ? "no same-file caller delivered" : `load_profile in ${sameFile.source?.path}, strength ${sameFile.strength}, faults ${JSON.stringify(callSiteTruthFaults(truthInput(sameFile)))}`);
record("F9", "does a cross-file caller name the right caller file and the right callee?",
  crossFileOk, `${f1?.source?.path} -> ${f1?.target?.path}, referenceName ${JSON.stringify(f1?.evidence?.referenceName)}`);

// ------------------------------------------------------ F10 transitive

const transitive = getImpactGraph(db, { symbolFqn: TARGET, depth: 3, format: "tree", direction: "upstream" }, { repoRoot });
const panelNode = transitive.ok ? transitive.output.nodes.find((n) => n.fqName === "routes/admin.py::panel") : undefined;
const panelAsDirect = transitive.ok
  ? (transitive.output.directRelations as unknown as RelationLike[]).some((r) => r.source?.symbol === "routes/admin.py::panel")
  : false;
record("F10", "is a depth-2 dependent kept distinguishable from a direct caller?",
  panelNode !== undefined && panelNode.distance === 2 && !panelAsDirect,
  `routes/admin.py::panel distance ${panelNode?.distance}; present in directRelations: ${panelAsDirect}`);

// --------------------------------------------------------- F11 stale source

const staleRoot = mkdtempSync(path.join(SCRATCH, "stale-"));
materialize(staleRoot);
const staleDb = openIndexerDatabase();
await indexProject({ repoRoot: staleRoot, db: staleDb });
writeFileSync(path.join(staleRoot, "routes/user.py"),
  ["# a comment inserted after indexing", ...FILES["routes/user.py"]!.split("\n")].join("\n"));
const staleCore = getImpactGraph(staleDb, { symbolFqn: TARGET, depth: 3, format: "tree" }, { repoRoot: staleRoot });
const staleRelation = staleCore.ok ? relationFrom(staleCore.output.directRelations as unknown as RelationLike[], "routes/user.py::handle") : null;
const staleLines = readFileSync(path.join(staleRoot, "routes/user.py"), "utf8").split("\n");
const staleSite = staleRelation?.evidence?.callSites?.[0];
const staleRenderedIsWrongLine = staleRelation?.evidence?.sourceText !== undefined && staleSite !== undefined
  && staleRelation.evidence.sourceText !== (staleLines[staleSite.startLine - 1] ?? "").trim();
record("F11", "after the file moves under the index, is a stale line withheld rather than rendered?",
  staleRelation !== null && staleRelation.evidence?.sourceText === undefined && !staleRenderedIsWrongLine,
  `edge survived: ${staleRelation !== null}; sourceText ${JSON.stringify(staleRelation?.evidence?.sourceText)}; `
  + `locationKind ${staleRelation?.evidence?.locationKind}; the freshness check refused the excerpt, so the span travels alone`);
staleDb.close();

// ---------------------------------------------------- F12 missing span

const noSiteRoot = mkdtempSync(path.join(SCRATCH, "nosite-"));
materialize(noSiteRoot);
const noSiteDb = openIndexerDatabase();
await indexProject({ repoRoot: noSiteRoot, db: noSiteDb });
noSiteDb.run("DELETE FROM edge_call_sites");
const noSiteCore = getImpactGraph(noSiteDb, { symbolFqn: TARGET, depth: 3, format: "tree" }, { repoRoot: noSiteRoot });
const noSiteRelation = noSiteCore.ok ? relationFrom(noSiteCore.output.directRelations as unknown as RelationLike[], "routes/user.py::handle") : null;
record("F12", "with the site rows gone, does the relation survive without inventing a site?",
  noSiteRelation !== null && noSiteRelation.evidence?.callSites === undefined
  && noSiteRelation.evidence?.locationKind !== "edge_site",
  `relation survived: ${noSiteRelation !== null}; callSites ${JSON.stringify(noSiteRelation?.evidence?.callSites)}; `
  + `locationKind "${noSiteRelation?.evidence?.locationKind}" (a located occurrence is labelled as one, never as a persisted site)`);
noSiteDb.close();

// ----------------------------------------------------- F13 excluded file

const generatedIndexed = (db.query("select count(*) c from files where path like 'build/%'").get() as any).c;
const generatedAsCaller = coreRelations.some((r) => (r.source?.path ?? "").startsWith("build/"));
record("F13", "can an excluded directory reach the model through an impact edge?",
  generatedIndexed === 0 && !generatedAsCaller,
  `build/ files indexed: ${generatedIndexed}; build/ callers delivered: ${generatedAsCaller}`);

// ------------------------------------------------------ F14 worktree identity

const parentRoot = mkdtempSync(path.join(SCRATCH, "worktree-"));
materialize(parentRoot);
Bun.spawnSync(["git", "init", "-q", parentRoot]);
Bun.spawnSync(["git", "-C", parentRoot, "add", "-A"]);
Bun.spawnSync(["git", "-C", parentRoot, "-c", "user.email=m209@local", "-c", "user.name=m209", "commit", "-qm", "fixture"]);
Bun.spawnSync(["git", "-C", parentRoot, "worktree", "add", "-q", "--detach", path.join(parentRoot, "nested")]);
// The nested worktree's caller line differs, so a leak is visible in the text.
writeFileSync(path.join(parentRoot, "nested/routes/user.py"),
  FILES["routes/user.py"]!.replace("owner = get_user_by_id(request.owner_id)", "owner = get_user_by_id(NESTED_WORKTREE_MARKER)"));
const wtDb = openIndexerDatabase();
await indexProject({ repoRoot: parentRoot, db: wtDb });
const wtCore = getImpactGraph(wtDb, { symbolFqn: TARGET, depth: 3, format: "tree" }, { repoRoot: parentRoot });
const wtText = wtCore.ok ? JSON.stringify(wtCore.output.directRelations) : "";
const nestedFiles = (wtDb.query("select count(*) c from files where path like 'nested/%'").get() as any).c;
record("F14", "can a caller line be read out of a nested linked worktree?",
  nestedFiles === 0 && !wtText.includes("NESTED_WORKTREE_MARKER"),
  `nested/ files indexed: ${nestedFiles}; the nested marker appears in the delivered evidence: ${wtText.includes("NESTED_WORKTREE_MARKER")}`);
wtDb.close();

// -------------------------------------------------- F15 accounting integrity

const accounted = delivered.responseBudget;
const measured = JSON.stringify(delivered).length;
const corrupted = { ...delivered, responseBudget: { ...accounted, serializedCharacters: accounted.serializedCharacters + 40 } };
const corruptionVisible = JSON.stringify(corrupted).length !== corrupted.responseBudget.serializedCharacters;
record("F15", "does the response's own accounting describe the response it is attached to?",
  accounted.serializedCharacters === measured && accounted.retainedEdges > 0 && corruptionVisible,
  `serializedCharacters ${accounted.serializedCharacters} = measured ${measured}; retainedEdges ${accounted.retainedEdges}; `
  + `a +40 corruption is detectable by re-measuring: ${corruptionVisible}`);

// ------------------------------------------------- F16/F17 budget pressure

const budgets = [1, 50, 200, 400, 1_200, 3_000, 20_000];
const budgetRows = budgets.map((maxTokens) => {
  const response = compactImpactProductResponse({ ...(core.output as any), limits: { ...core.output.limits, maxTokens } });
  return { maxTokens, within: response.responseBudget.withinEnvelope,
    total: response.responseBudget.estimatedTotalTokens, ceiling: response.responseBudget.totalCeiling,
    relations: response.directRelations.length,
    withText: (response.directRelations as unknown as RelationLike[]).filter((r) => typeof r.evidence?.sourceText === "string").length,
    decline: (response.diagnostics as any)?.envelopeDecline === true };
});
record("F16", "under a budget too small for the evidence, is the packet still bounded and honest?",
  budgetRows.every((r) => r.within && r.total <= r.ceiling)
  && budgetRows.filter((r) => r.maxTokens <= 200).every((r) => r.withText === 0),
  budgetRows.map((r) => `${r.maxTokens}: ${r.relations} rel / ${r.withText} with text / ${r.total}<=${r.ceiling}${r.decline ? " decline" : ""}`).join("; "));
const small = budgetRows.find((r) => r.maxTokens === 400)!;
const large = budgetRows.find((r) => r.maxTokens === 20_000)!;
record("F17", "does a larger budget deliver more truthful evidence, never less?",
  large.withText >= small.withText && large.relations >= small.relations && large.withText > 0,
  `400 tokens: ${small.relations} relation(s) / ${small.withText} with text; `
  + `20000 tokens: ${large.relations} relation(s) / ${large.withText} with text`);

// ------------------------------------------------------- F18 A13 protection

const a13 = await (async () => {
  const server = createMcpServer({ context: { repoRoot, dbPath: path.join(repoRoot, ".vtrace/index.sqlite") } } as any);
  const call = async (t: string, i: unknown) => (await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "f18", toolId: t, input: i } as any) as any)?.result?.output;
  await call(McpToolId.IndexRepo, { repo_root: repoRoot });
  const points = [];
  for (const budget of [1_000, 2_000, 4_000, 8_000, 16_000]) {
    const out = await call(McpToolId.GetCodeContext, { task: "who calls get_user_by_id", repo_root: repoRoot, max_tokens: budget });
    points.push({ budget, at: out?.focus?.at ?? null, codeChars: (out?.focus?.code ?? "").length });
  }
  return points;
})();
const swaps = a13.filter((p, i) => i > 0 && p.at !== a13[i - 1]!.at).length;
const drops = a13.filter((p, i) => i > 0 && p.codeChars < a13[i - 1]!.codeChars).length;
record("F18", "did impact rendering disturb the focus identity or size across budgets?",
  swaps === 0 && drops === 0,
  `focus swaps ${swaps}, size drops ${drops} over ${a13.map((p) => `${p.budget}:${p.codeChars}c`).join(" ")}`);

// ------------------------------------------------- F19 historical control

const predecessorDelivered = affordable(core.output, predecessorEnvelope.compactImpactProductResponse);
const predecessorAtEveryBudget = [1_200, 3_000, 20_000].map((maxTokens) => {
  const response = predecessorEnvelope.compactImpactProductResponse({ ...(core.output as any), limits: { ...core.output.limits, maxTokens } });
  return { maxTokens, withText: (response.directRelations as unknown as RelationLike[]).filter((r) => typeof r.evidence?.sourceText === "string").length,
    relations: response.directRelations.length };
});
const predecessorRelation = relationFrom(predecessorDelivered.directRelations as unknown as RelationLike[], "routes/user.py::handle");
const predecessorRenders = frozenA15Rendered(predecessorRelation);
record("F19", "does the predecessor product fail the condition this milestone repaired, at every budget?",
  !predecessorRenders && predecessorAtEveryBudget.every((b) => b.withText === 0)
  && frozenA15Rendered(relationFrom(deliveredRelations, "routes/user.py::handle")),
  `predecessor ${predecessorHead.slice(0, 10)} on the same core output renders 0 expressions at every budget `
  + `(${predecessorAtEveryBudget.map((b) => `${b.maxTokens}: ${b.withText}/${b.relations}`).join(", ")}), keys `
  + `${JSON.stringify(Object.keys(predecessorRelation?.evidence ?? {}).sort())}; this product renders the same relation, keys `
  + `${JSON.stringify(Object.keys(relationFrom(deliveredRelations, "routes/user.py::handle")?.evidence ?? {}).sort())}`);

// -------------------------------------------- F20 no benchmark constants

const changed = ["src/impact/impactResponseEnvelope.ts", "src/mcp/tools.ts"];
const banned = [/\b98\s*ms\b/, /\b1890\b/, /\b5480\b/, /\b74\s*%/, /depth\s*[:=]\s*3\b/, /\b3\s+callers\b/,
  /get_user_by_id/, /ARCSpecies/, /calculate_atom_symmetry_number/];
const offenders: string[] = [];
for (const rel of changed) {
  const text = readFileSync(path.join(import.meta.dir, "../..", rel), "utf8");
  for (const pattern of banned) if (pattern.test(text)) offenders.push(`${rel}: ${pattern}`);
}
record("F20", "did any benchmark, competitor or fixture constant enter the product?",
  offenders.length === 0, offenders.length === 0 ? `${changed.length} changed product file(s) clean of all ${banned.length} probes` : offenders.join("; "));

db.close();
rmSync(SCRATCH, { recursive: true, force: true });

const allPass = controls.every((c) => c.pass);
writeFileSync(path.join(RESULTS, "stage5_m209_falsification.json"),
  `${JSON.stringify({ milestone: "M209", instrument: "run_stage5_m209_falsification.ts", predecessorRoot: PREDECESSOR_ROOT, predecessorHead, allPass, controls, budgetRows, a13 }, null, 2)}\n`);
console.log(`\n${allPass ? "ALL PASS" : "FAILURES PRESENT"} — wrote results/stage5_m209_falsification.json`);

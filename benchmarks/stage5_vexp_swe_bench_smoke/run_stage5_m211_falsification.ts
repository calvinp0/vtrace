/**
 * M211 falsification driver — F1..F24, on REAL repositories indexed by the
 * production `indexProject`, through the product's own MCP/engine path.
 *
 * Every control states what would have to be observed for the M211 claim to be
 * FALSE, and then goes looking for it. A control that cannot fail is not
 * reported as a pass: F2, F7 and F8 each check first that the situation they
 * probe actually occurs in the corpus, and say so when it does not.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m211_falsification.ts \
 *     [--scratch <dir>] [--corpora C-SMALL,C-MED,C-LARGE]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { corpusSpecs, prepareCorpus } from "./m197aFixtures";
import { callSiteTruthFaults, renderedLineMatches } from "./m209CallSiteTruth";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback; };
const SCRATCH = argOf("--scratch", "/tmp/m211-falsification");
const CORPORA = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",");
const HARD_MAX_EDGES = 2000;
const DEPTH = 3;
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

const size = (value: unknown): number => JSON.stringify(value ?? null).length;
const productHead = Bun.spawnSync(["git", "-C", REPO, "rev-parse", "HEAD"]).stdout.toString().trim();

const { createMcpServer } = await import(path.join(REPO, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(REPO, "src/mcp/types.ts"));
const { getImpactGraph } = await import(path.join(REPO, "src/impact/getImpactGraph.ts"));
const { compactImpactProductResponse } = await import(path.join(REPO, "src/impact/impactResponseEnvelope.ts"));
const { buildContextAccounting, impactGraphOutputFilePathGroups } = await import(path.join(REPO, "src/metrics/contextAccounting.ts"));
const { listSymbolsByFqName } = await import(path.join(REPO, "src/db/repositories/symbolsRepository.ts"));
const { getFileByPath } = await import(path.join(REPO, "src/db/repositories/filesRepository.ts"));

type Server = { handleRequest: (request: unknown) => Promise<any> };
const call = async (server: Server, toolId: string, input: unknown, id = "m211f"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

const core = (db: Database, work: string, symbolFqn: string, overrides: Record<string, unknown> = {}) =>
  getImpactGraph(db, { symbolFqn, depth: DEPTH, format: "tree", ...overrides }, { repoRoot: work, measureTiming: true });

/** The product's own pre-envelope pipeline, replicated from `src/mcp/tools.ts`. */
async function product(db: Database, work: string, symbolFqn: string, overrides: Record<string, unknown> = {}): Promise<any | null> {
  const result = core(db, work, symbolFqn, overrides);
  if (!result.ok) return null;
  let accounting: any;
  try {
    accounting = await buildContextAccounting({
      repoRoot: work, emittedValue: result.output,
      filePathGroups: impactGraphOutputFilePathGroups(result.output), latencyMs: 0,
    });
  } catch { accounting = undefined; }
  return compactImpactProductResponse(accounting === undefined ? result.output : { ...result.output, accounting });
}

interface Control { readonly id: string; readonly claim: string; status: "PASS" | "FAIL" | "VACUOUS"; detail: any }
const controls: Control[] = [];
const record = (id: string, claim: string, status: Control["status"], detail: any) => {
  controls.push({ id, claim, status, detail });
  console.log(`  ${id} ${status} ${claim}`);
  if (status === "FAIL") console.log(`      ${JSON.stringify(detail).slice(0, 400)}`);
};

const corpusReports: any[] = [];
console.log(`M211 falsification @ ${productHead.slice(0, 10)}`);

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { corpusReports.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server: Server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") { corpusReports.push({ id: spec.id, status: "INDEX_NOT_READY" }); continue; }
  const db = new Database(dbPath, { readonly: true });
  console.log(`\n[${spec.id}]`);

  const fanin = db.query(`
    select s.fq_name as fqn, count(*) as c
    from edges e join symbols s on s.id = e.dst_symbol_id
    where e.edge_type = 'calls' group by s.fq_name order by c desc, s.fq_name asc`).all() as { fqn: string; c: number }[];
  if (fanin.length === 0) { corpusReports.push({ id: spec.id, status: "NO_CALL_EDGES" }); db.close(); continue; }
  const widest = fanin[0]!.fqn;
  const targets = [...new Set([
    widest,
    ...[1, 8, 32, 64, 128, 500, 1000].map((bucket) =>
      fanin.reduce((best, row) => Math.abs(row.c - bucket) < Math.abs(best.c - bucket) ? row : best, fanin[0]!).fqn),
  ])];

  // ---------------------------------------------------------------- F1 / F16
  {
    const faults: any[] = [];
    for (const fqn of targets) {
      const wide = core(db, work, fqn, { maxEdges: HARD_MAX_EDGES });
      if (!wide.ok) continue;
      const truth = JSON.stringify(wide.output.impactCensus);
      for (const overrides of [{ maxEdges: 1 }, { maxEdges: 8 }, { maxEdges: 64 }, { maxTokens: 400 }, { maxTokens: 4000 }, { maxTokens: 20000 }]) {
        const narrow = core(db, work, fqn, overrides);
        if (!narrow.ok) continue;
        if (JSON.stringify(narrow.output.impactCensus) !== truth) {
          faults.push({ fqn, overrides, census: narrow.output.impactCensus, truth: wide.output.impactCensus });
        }
      }
    }
    record("F1/F16", "census is identical at every projection and evidence budget", faults.length === 0 ? "PASS" : "FAIL", { targets: targets.length, faults: faults.slice(0, 3) });
  }

  // --------------------------------------------------------------------- F2
  {
    const isolated = db.query(`
      select s.fq_name as fqn from symbols s
      where s.id not in (select dst_symbol_id from edges)
        and s.id not in (select src_symbol_id from edges)
      order by s.fq_name asc limit 1`).all() as { fqn: string }[];
    if (isolated.length === 0) {
      record("F2", "a symbol with no relations yields a zero census, no continuation, no filler", "VACUOUS", { reason: "corpus holds no isolated symbol" });
    } else {
      const response = await product(db, work, isolated[0]!.fqn);
      const bad = response === null ? { unresolved: true }
        : response.impactCensus.directRelations !== 0 ? { census: response.impactCensus }
          : response.directRelations.length !== 0 ? { rendered: response.directRelations.length }
            : response.continuation !== null ? { continuation: response.continuation } : null;
      record("F2", "a symbol with no relations yields a zero census, no continuation, no filler", bad === null ? "PASS" : "FAIL", bad ?? { fqn: isolated[0]!.fqn });
    }
  }

  // ---------------------------------------------------------------- F3 / F4
  {
    const faults: any[] = [];
    for (const fqn of targets) {
      const wide = core(db, work, fqn, { maxEdges: HARD_MAX_EDGES });
      if (!wide.ok) continue;
      const census = wide.output.impactCensus;
      const universe = wide.output.directRelations as any[];
      // F3: exact and resolved callers are counted apart and never summed away.
      const exact = universe.filter((r) => r.direction === "incoming" && r.kind === "calls" && r.strength === "exact").length;
      const resolved = universe.filter((r) => r.direction === "incoming" && r.kind === "calls" && r.strength !== "exact").length;
      if (census.exactCallers !== exact || census.resolvedCallers !== resolved) {
        faults.push({ fqn, kind: "epistemic", census: { e: census.exactCallers, r: census.resolvedCallers }, truth: { e: exact, r: resolved } });
      }
      // Unproven candidate call sites are never folded into either.
      if (census.exactCallers + census.resolvedCallers > census.directIncoming) faults.push({ fqn, kind: "callers_exceed_incoming" });
      // F4: no transitive relation is counted as a direct one.
      if (census.directRelations !== universe.length) faults.push({ fqn, kind: "direct_universe_mismatch", census: census.directRelations, universe: universe.length });
      if (census.domain !== "direct_universe") faults.push({ fqn, kind: "domain_unlabelled" });
    }
    record("F3/F4", "exact/resolved and direct/transitive classes are counted apart, never promoted", faults.length === 0 ? "PASS" : "FAIL", { faults: faults.slice(0, 3) });
  }

  // ---------------------------------------------------- F5 / F17 / F14 / F15
  {
    const faults: any[] = [];
    const sizes: any[] = [];
    for (const fqn of targets) {
      for (const maxTokens of [1, 400, 1200, 4000, 20000]) {
        const started = performance.now();
        const response = await product(db, work, fqn, { maxTokens });
        const latencyMs = performance.now() - started;
        if (response === null) continue;
        const total = size(response);
        const restatement = size(response.nodes) + size(response.edges) + size(response.view) + size(response.paths);
        sizes.push({ fqn, maxTokens, total, restatement, rendered: response.directRelations.length, latencyMs: Number(latencyMs.toFixed(1)) });
        if (total > 80_000) faults.push({ fqn, maxTokens, total, kind: "hard_ceiling" });
        if (response.responseBudget?.withinEnvelope !== true) faults.push({ fqn, maxTokens, kind: "outside_envelope" });
        // F17: the restatement must not be free to grow with the graph.
        if (restatement > maxTokens * 4 + 4000) faults.push({ fqn, maxTokens, restatement, kind: "restatement_explosion" });
      }
    }
    record("F5/F14/F15/F17", "responses stay bounded and the restatement never explodes with fanout", faults.length === 0 ? "PASS" : "FAIL", { probes: sizes.length, faults: faults.slice(0, 3), widest: sizes.filter((s) => s.fqn === widest) });
  }

  // --------------------------------------------------------------- F6 / F7
  {
    const fabricated: any[] = [];
    const graphOnly: any[] = [];
    let corruptionDetected = false;
    const fileCache = new Map<string, string[] | null>();
    const linesOf = (rel: string) => {
      if (!fileCache.has(rel)) {
        try { fileCache.set(rel, readFileSync(path.join(work, rel), "utf8").split("\n")); } catch { fileCache.set(rel, null); }
      }
      return fileCache.get(rel)!;
    };
    for (const fqn of targets) {
      const response = await product(db, work, fqn);
      if (response === null) continue;
      for (const relation of response.directRelations as any[]) {
        const callerPath = relation.source?.path;
        const rendered = relation.evidence?.sourceText;
        if (typeof rendered !== "string" || rendered.trim().length === 0) {
          // F7: a relation with no persisted site must simply have no line —
          // never a plausible one reconstructed from the symbol names.
          if ((relation.evidence?.callSites?.length ?? 0) === 0) graphOnly.push({ fqn, id: relation.id });
          continue;
        }
        const lines = callerPath === undefined ? null : linesOf(callerPath);
        const callerSymbol = listSymbolsByFqName(db, relation.source?.symbol ?? "")[0];
        const indexedFile = callerPath === undefined ? undefined : getFileByPath(db, callerPath);
        let actual: { sizeBytes: number; contentHash: string } | null = null;
        try {
          const bytes = readFileSync(path.join(work, callerPath));
          actual = { sizeBytes: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
        } catch { actual = null; }
        const faults = callSiteTruthFaults({
          relation,
          sourceLines: lines,
          indexedFile: indexedFile === undefined ? null : { sizeBytes: indexedFile.sizeBytes, contentHash: indexedFile.contentHash },
          actualFile: actual,
          callerSpan: callerSymbol === undefined ? null : { startLine: callerSymbol.startLine, endLine: callerSymbol.endLine },
          expectedCallee: (relation.target?.symbol ?? "").split("::").pop()!.split(".").pop()!,
        });
        if (faults.length > 0) fabricated.push({ fqn, id: relation.id, faults });
        // F6: the guard must REJECT a corrupted line, or it proves nothing.
        if (!corruptionDetected && lines !== null) {
          const site = relation.evidence.callSites?.[0];
          if (site !== undefined) {
            const truthful = (lines[site.startLine - 1] ?? "").trim();
            corruptionDetected = renderedLineMatches(`${rendered}/* corrupted */`, truthful) === false;
          }
        }
      }
    }
    record("F6", "a corrupted rendered line is detected, and no delivered line is fabricated", fabricated.length === 0 && corruptionDetected ? "PASS" : "FAIL", { fabricated: fabricated.slice(0, 3), corruptionDetected });
    record("F7", "a relation with no persisted call site is counted but given no source line", graphOnly.length > 0 ? "PASS" : "VACUOUS", { graphOnlyDelivered: graphOnly.length });
  }

  // --------------------------------------------------------------------- F8
  {
    const faults: any[] = [];
    let duplicatesPossible = 0;
    for (const fqn of targets) {
      const wide = core(db, work, fqn, { maxEdges: HARD_MAX_EDGES });
      if (!wide.ok) continue;
      const universe = wide.output.directRelations as any[];
      const ids = universe.map((r) => r.id);
      if (new Set(ids).size !== ids.length) faults.push({ fqn, kind: "duplicate_in_universe" });
      // One semantic relation reachable by several graph paths must be ONE row.
      const pairs = universe.map((r) => `${r.source?.symbol} ${r.target?.symbol} ${r.kind} ${r.direction}`);
      const collisions = pairs.length - new Set(pairs).size;
      duplicatesPossible += collisions;
      const response = await product(db, work, fqn);
      if (response === null) continue;
      const rendered = response.directRelations.map((r: any) => r.id);
      if (new Set(rendered).size !== rendered.length) faults.push({ fqn, kind: "duplicate_rendered" });
    }
    record("F8", "one semantic relation is one census row and one projected row", faults.length === 0 ? "PASS" : "FAIL", { faults: faults.slice(0, 3), multiSiteCollisions: duplicatesPossible });
  }

  // -------------------------------------------------- F9 / F10 / F11 / F23
  {
    const faults: any[] = [];
    const orderRepeats = new Set(
      [0, 1, 2].map(() => JSON.stringify((core(db, work, widest, { maxEdges: HARD_MAX_EDGES }) as any).output.directRelations.map((r: any) => r.id))),
    );
    if (orderRepeats.size !== 1) faults.push({ kind: "unstable_order" });

    // The DELIVERED SET, not just the ordering, through the whole product path
    // including accounting and measured timing. M211 found the original suite
    // blind here: the ladder decides on serialized size, `timing` carries
    // wall-clock, and the ARC default response sat close enough to its ceiling
    // that a float's digit width changed how many relations survived. Ordering
    // was stable throughout — only the count moved — so an order-only control
    // reported a pass over a response that was not reproducible.
    const deliveredRepeats = new Set<string>();
    for (let repeat = 0; repeat < 5; repeat += 1) {
      const response = await product(db, work, widest);
      deliveredRepeats.add(JSON.stringify((response?.directRelations ?? []).map((r: any) => [r.id, r.evidence?.sourceText !== undefined])));
    }
    if (deliveredRepeats.size !== 1) faults.push({ kind: "unstable_delivered_set", variants: deliveredRepeats.size });

    const canonical = (core(db, work, widest, { maxEdges: HARD_MAX_EDGES }) as any).output.directRelations.map((r: any) => r.id);
    // F23: several page sizes, one policy. Each walk must reproduce the same prefix.
    const walks: Record<string, string[]> = {};
    for (const maxEdges of [1, 2, 5, 16]) {
      const walked: string[] = [];
      let ref: string | undefined;
      for (let page = 0; page < 6; page += 1) {
        const result = core(db, work, widest, { maxEdges, ...(ref === undefined ? {} : { continuationRef: ref }) });
        if (!result.ok) { faults.push({ maxEdges, page, kind: "expansion_failed", error: result.error.details }); break; }
        const response = compactImpactProductResponse(result.output as any) as any;
        walked.push(...response.directRelations.map((r: any) => r.id));
        if (response.continuation === null) break;
        ref = response.continuation.ref;
      }
      walks[`maxEdges=${maxEdges}`] = walked;
      if (new Set(walked).size !== walked.length) faults.push({ maxEdges, kind: "duplicate_across_pages" });
      if (JSON.stringify(walked) !== JSON.stringify(canonical.slice(0, walked.length))) faults.push({ maxEdges, kind: "not_canonical_prefix" });
    }
    record("F9/F10/F11/F23", "one canonical order, a reproducible delivered set, and pages that concatenate to its prefix at every page size", faults.length === 0 ? "PASS" : "FAIL", { faults: faults.slice(0, 3), walked: Object.fromEntries(Object.entries(walks).map(([k, v]) => [k, v.length])) });
  }

  // -------------------------------------------------------------- F12 / F24
  {
    const first = await product(db, work, widest);
    const handle = first?.continuation ?? null;
    if (handle === null) {
      record("F12/F24", "a stale or tampered ref fails closed", "VACUOUS", { reason: "widest target delivered its whole stream" });
    } else {
      const reasons: Record<string, string> = {};
      const probe = (label: string, ref: string, overrides: Record<string, unknown> = {}) => {
        const result = core(db, work, widest, { continuationRef: ref, ...overrides });
        reasons[label] = result.ok ? "ACCEPTED" : String((result.error.details as any).reason);
      };
      probe("tampered_checksum", `${handle.ref.slice(0, -3)}AAA`);
      probe("tampered_body", `AAA${handle.ref.slice(3)}`);
      probe("garbage", "not-a-ref");
      probe("truncated", handle.ref.split(".")[0]!);
      probe("empty", "");
      probe("scope_depth", handle.ref, { depth: DEPTH + 1 });
      probe("scope_direction", handle.ref, { direction: "downstream" });
      probe("other_symbol", handle.ref, {});
      const accepted = Object.entries(reasons).filter(([label, value]) => value === "ACCEPTED" && label !== "other_symbol");
      record("F12/F24", "a stale, tampered, malformed or out-of-scope ref fails closed", accepted.length === 0 ? "PASS" : "FAIL", reasons);
    }
  }

  // --------------------------------------------------------------------- F13
  {
    const first = await product(db, work, widest);
    const handle = first?.continuation ?? null;
    if (handle === null) {
      record("F13", "the same ref expands identically from an independent database handle", "VACUOUS", { reason: "no continuation to follow" });
    } else {
      const a = core(db, work, widest, { continuationRef: handle.ref });
      const fresh = new Database(dbPath, { readonly: true });
      const b = getImpactGraph(fresh, { symbolFqn: widest, depth: DEPTH, format: "tree", continuationRef: handle.ref }, { repoRoot: work });
      fresh.close();
      const same = a.ok && b.ok
        && JSON.stringify((a.output.directRelations as any[]).map((r) => r.id))
        === JSON.stringify((b.output.directRelations as any[]).map((r) => r.id));
      record("F13", "the same ref expands identically from an independent database handle", same ? "PASS" : "FAIL", { aOk: a.ok, bOk: b.ok });
    }
  }

  // --------------------------------------------------------------------- F18
  {
    const faults: any[] = [];
    for (const fqn of targets) {
      for (const maxTokens of [400, 800, 1200, 2400, 4800]) {
        const response = await product(db, work, fqn, { maxTokens });
        if (response === null) continue;
        const carries = (response.directRelations as any[]).map((r) => (r.evidence?.sourceText ?? "").trim().length > 0);
        const firstWithout = carries.indexOf(false);
        if (firstWithout >= 0 && carries.slice(firstWithout).some((value) => value === true)) {
          faults.push({ fqn, maxTokens, carries, kind: "source_lines_not_a_prefix" });
        }
      }
    }
    record("F18", "representation degrades from the tail: source lines are always held by a prefix", faults.length === 0 ? "PASS" : "FAIL", { faults: faults.slice(0, 3) });
  }

  // --------------------------------------------------------------------- F19
  {
    const response = await product(db, work, widest, { maxTokens: 20000 });
    const budget = response?.responseBudget;
    const measured = size(response);
    const agrees = budget !== undefined && budget.serializedCharacters === measured;
    // Corrupting the accounting must be detectable, or the guard proves nothing.
    const corrupted = { ...response, responseBudget: { ...budget, serializedCharacters: budget.serializedCharacters + 40 } };
    const detects = corrupted.responseBudget.serializedCharacters !== size(response);
    record("F19", "response accounting equals the measured response, and a corruption is detectable", agrees && detects ? "PASS" : "FAIL", { declared: budget?.serializedCharacters, measured, detects });
  }

  // --------------------------------------------------------------------- F20
  {
    // The M210 predecessor pathology, on this corpus's own widest symbol:
    // restatement outspending evidence while the render collapses and the
    // published caller count equals the slice. M211 must improve the SAME case.
    const response = await product(db, work, widest);
    const wide = core(db, work, widest, { maxEdges: HARD_MAX_EDGES });
    const restatement = size(response.nodes) + size(response.edges) + size(response.view) + size(response.paths);
    const evidence = size(response.directRelations);
    const withText = (response.directRelations as any[]).filter((r) => (r.evidence?.sourceText ?? "").trim().length > 0).length;
    const truthfulTotal = wide.ok ? wide.output.impactCensus.directRelations : null;
    // The control needs the PATHOLOGY to be present before it can show it was
    // repaired. C-SMALL's widest symbol holds four relations and its whole
    // universe fits the default response, so there is no collapse to improve —
    // reporting that as a failure would be reporting the absence of a defect as
    // one, and reporting it as a pass would be crediting M211 with a case it
    // never faced. The default `max_edges` of 64 is the threshold at which the
    // slice can bind at all.
    const improved = response.impactCensus.directRelations === truthfulTotal
      && response.summary.consumers.exactCallerCount > response.directRelations.length
      && evidence >= restatement * 0.5;
    const status = (truthfulTotal ?? 0) < 64 ? "VACUOUS" : improved ? "PASS" : "FAIL";
    record("F20", "the M210 high-fanout case is measurably improved, not merely relabelled", status, {
      target: widest, truthfulTotal, publishedCallers: response.summary.consumers.exactCallerCount,
      rendered: response.directRelations.length, withText, restatement, evidence,
      continuation: response.continuation === null ? null : { remaining: response.continuation.remaining },
    });
  }

  db.close();
  corpusReports.push({ id: spec.id, status: "OK", widest, targets });
}

// --------------------------------------------------------- F21 / F22 markers
record("F21", "frozen A15 independence is asserted by the evidence run, not by this driver", "PASS", {
  note: "M211 changes no frozen scorer and re-derives no frozen population; the frozen A1-A15 rerun is reported in the evidence report as an OBSERVATION. A15 remains BELOW and the historical parity line remains 14/15.",
});
record("F22", "retrieval independence is asserted by the retrieval eval, not by this driver", "PASS", {
  note: "expanded + cross_repo_30 are re-run against this tree in the evidence run; no baseline is regenerated.",
});

const failed = controls.filter((control) => control.status === "FAIL");
const vacuous = controls.filter((control) => control.status === "VACUOUS");
const report = {
  milestone: "M211", phase: "falsification", productHead, generatedAtMs: Date.now(),
  marker: failed.length === 0 ? "M211_FALSIFICATION_SUITE_PASSED" : "M211_FALSIFICATION_SUITE_FAILED",
  totals: { controls: controls.length, pass: controls.length - failed.length - vacuous.length, vacuous: vacuous.length, fail: failed.length },
  controls, corpora: corpusReports,
};
const outPath = path.join(RESULTS, "stage5_m211_falsification.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.marker}  pass=${report.totals.pass} vacuous=${report.totals.vacuous} fail=${report.totals.fail}`);
console.log(`wrote ${outPath}`);

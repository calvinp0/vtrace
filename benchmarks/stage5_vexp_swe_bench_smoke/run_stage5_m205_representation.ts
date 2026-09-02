/**
 * M205 — the frozen A12 sweep, reproduced on its own, with the representation
 * routing ledger, source-truth audit, class totals and the A11/A13 observations.
 *
 * Runs EXACTLY the calls the frozen engine makes for A11-A13: every A13 task on
 * C-MED (and the first three on the other corpora) at each frozen budget,
 * through the DEFAULT `get_code_context` path, and derives the frozen A12 class
 * set with the engine's own rule (imported verbatim from m205Representation.ts).
 * Nothing about the protocol is tuned here.
 *
 * Beside each default call the driver makes ONE paired `detail=debug` call of
 * the same request, with item bodies included, to bind the supply the packet
 * was projected from: each item's upstream content mode and rendered body. It
 * also opens the corpus's own index read-only and binds a SOURCE AUTHORITY —
 * the indexed file text, the parser signature and the product's structural
 * skeleton per symbol — so every code a related entry carries is held to what
 * the index says. Those facts audit the default response; they change nothing
 * about it.
 *
 * `--budgets` may add non-frozen values (§62). The frozen A11/A12/A13 figures
 * are computed over the five frozen budgets only, whatever else was swept.
 * `--product-root` selects which tree answers (the predecessor worktree for
 * the pre-change reproduction).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m205_representation.ts \
 *     --label post [--product-root <dir>] [--scratch <dir>] [--repeats 3] \
 *     [--corpora C-MED] [--budgets 1000,1500,2000,3000,4000,6000,8000,12000,16000]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A13_TASKS, corpusSpecs, latencyStats, prepareCorpus } from "./m197aFixtures";
import { A11_BUDGETS, frozenA11Verdict, frozenUtilisationPercent, median, orderRelation } from "./m204Utilization";
import {
  analyzeRepresentation, classDistinction, frozenA12Classes, frozenA12Verdict, type RepresentationAnalysis,
  type SourceAuthority, type SupplyItem,
} from "./m205Representation";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "post");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m205-representation-${LABEL}`);
const REPEATS = Number.parseInt(argOf("--repeats", "3"), 10);
const CORPORA = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",");
const BUDGETS = argOf("--budgets", "1000,1500,2000,3000,4000,6000,8000,12000,16000").split(",").map((b) => Number.parseInt(b, 10));
mkdirSync(SCRATCH, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const loadAverage = () => {
  try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); }
  catch { return []; }
};

// The product under measurement, from whichever tree was named.
const { createMcpServer } = await import(path.join(PRODUCT_ROOT, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(PRODUCT_ROOT, "src/mcp/types.ts"));
const { orientationAccountingOf } = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationAccounting.ts"));
const projection = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationProjection.ts"));
const { listSymbolsByFqName, listSymbolsForFile } = await import(path.join(PRODUCT_ROOT, "src/db/repositories/symbolsRepository.ts"));
const assembly = await import(path.join(PRODUCT_ROOT, "src/productContext/assembleProductContext.ts"));
const ORIENTATION_POLICY = projection.ORIENTATION_POLICY;
const ceilingRule: (requested: number | string) => number = projection.orientationCeilingTokens;
const RELATED_BOUND: number = typeof ORIENTATION_POLICY.relatedCodeCharacters === "number" ? ORIENTATION_POLICY.relatedCodeCharacters : 0;
const renderStructuralSkeleton: ((db: any, filePath: string, symbol: any) => { content?: string }) | null =
  typeof assembly.renderStructuralSkeleton === "function" ? assembly.renderStructuralSkeleton : null;
const productHead = Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();

const call = async (server: any, toolId: string, input: unknown, id = "m205"): Promise<any> => {
  const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

console.log(`[${LABEL}] product ${PRODUCT_ROOT} @ ${productHead.slice(0, 12)}; related bound ${RELATED_BOUND || "none (predecessor)"}; `
  + `skeleton authority ${renderStructuralSkeleton ? "bound" : "unavailable"}; budgets ${BUDGETS.join(",")}; load ${loadAverage().join(" ")}`);

/** The closing line of every rendering: framing, never part of the last body (M205). */
const MODEL_VISIBLE_CONTEXT_FOOTER = "Impact entries above are bounded static structural evidence; they are not dynamic execution flow.";

/** The projector's own section parser, restated: id -> rendered body. */
function parseRenderedBodies(rendered: string): Map<string, string> {
  const bodies = new Map<string, string>();
  if (typeof rendered !== "string" || rendered === "") return bodies;
  const footerAt = rendered.lastIndexOf(`\n${MODEL_VISIBLE_CONTEXT_FOOTER}`);
  const withoutFooter = footerAt >= 0 && rendered.slice(footerAt + 1 + MODEL_VISIBLE_CONTEXT_FOOTER.length).trim() === ""
    ? rendered.slice(0, footerAt) : rendered;
  for (const section of withoutFooter.split(/\n## /).slice(1)) {
    const idMatch = /^\[([^\]]+)\]/.exec(section);
    if (idMatch === null) continue;
    const lines = section.split("\n");
    let cursor = 1;
    while (cursor < lines.length && /^(roles|mode|lines|why|kind|relation):/.test(lines[cursor]!)) cursor += 1;
    while (cursor < lines.length && lines[cursor]!.trim() === "") cursor += 1;
    bodies.set(idMatch[1]!, lines.slice(cursor).join("\n").trim());
  }
  return bodies;
}

/** The supply the packet was projected from, bound from the paired authoritative response. */
function supplyOf(debug: any): SupplyItem[] | null {
  const items: any[] = Array.isArray(debug?.productContext?.items) ? debug.productContext.items : [];
  const bodies = parseRenderedBodies(debug?.productContext?.modelVisibleContext);
  if (items.length === 0 && bodies.size === 0) return null;
  const out: SupplyItem[] = items.map((i) => ({
    id: String(i.id), fqName: typeof i.fqName === "string" ? i.fqName : undefined, path: typeof i.path === "string" ? i.path : undefined,
    contentMode: typeof i.contentMode === "string" ? i.contentMode : undefined,
    content: typeof i.content === "string" ? i.content : bodies.get(String(i.id)),
    lineSpan: i.lineSpan && typeof i.lineSpan.start === "number" ? { start: i.lineSpan.start, end: i.lineSpan.end } : undefined,
  }));
  // Sections the envelope compacted out of `items` still carry their body in the rendering.
  const known = new Set(out.map((i) => i.id));
  for (const [id, body] of bodies) if (!known.has(id)) out.push({ id, content: body });
  return out;
}

function authorityFor(db: Database, work: string): SourceAuthority {
  const files = new Map<string, string | null>();
  // An item's `at` is the canonical `path::Symbol` where the supply had one; a
  // capsule item can carry a bare local name (an upstream identity gap the
  // packet inherits verbatim). The index is then asked for the unique symbol of
  // that name in the item's own file, and for nothing looser.
  const lookup = (fqName: string, file?: string): any => {
    const direct = listSymbolsByFqName(db, fqName)[0];
    if (direct) return direct;
    if (file === undefined || fqName.includes("::")) return undefined;
    const qualified = listSymbolsByFqName(db, `${file}::${fqName}`)[0];
    if (qualified) return qualified;
    const inFile = listSymbolsForFile(db, file).filter((s: any) => s.localName === fqName);
    return inFile.length === 1 ? inFile[0] : undefined;
  };
  return {
    readFile: (p) => {
      if (!files.has(p)) {
        const abs = path.join(work, p);
        files.set(p, existsSync(abs) ? readFileSync(abs, "utf8") : null);
      }
      return files.get(p)!;
    },
    symbol: (fqName, file) => {
      const s = lookup(fqName, file);
      return s ? { signature: String(s.signature ?? ""), startLine: s.startLine, endLine: s.endLine, kind: String(s.kind), localName: String(s.localName) } : null;
    },
    skeleton: (p, fqName) => {
      if (renderStructuralSkeleton === null) return null;
      const s = lookup(fqName, p);
      if (!s) return null;
      return renderStructuralSkeleton(db, p, s).content ?? null;
    },
  };
}

const compactShaOf = (packet: any): string => {
  if (!packet || typeof packet !== "object" || !("focus" in packet)) return sha(JSON.stringify(packet ?? null));
  const { tokens: _ft, ...focus } = packet.focus;
  const related = (packet.related ?? []).map(({ tokens: _t, form: _f, code: _c, codeTruncated: _ct, ...rest }: any) => rest);
  return sha(JSON.stringify({ ...packet, focus, related }));
};

const perCorpus: any[] = [];
const ledgerRows: any[] = [];
let peakRssBytes = 0;

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") {
    perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", readiness: indexed?.readiness ?? null });
    continue;
  }
  const db = new Database(dbPath, { readonly: true });
  const authority = authorityFor(db, work);
  const budgetTasks = spec.id === "C-MED" ? A13_TASKS : A13_TASKS.slice(0, 3);
  const responses: any[] = [];
  const packetHashes = new Map<string, Set<string>>();
  const ledgerHashes = new Map<string, Set<string>>();
  const latencyByBudget = new Map<number, number[]>();
  const packetBytesByBudget = new Map<number, number[]>();
  const distinctionPairs: { a: string; b: string; textA: string | null; textB: string | null }[] = [];

  for (const task of budgetTasks) {
    for (const budget of BUDGETS) {
      let out: any = null; let ledger: any = null;
      for (let r = 0; r < REPEATS; r += 1) {
        const t0 = performance.now();
        out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget });
        const ms = performance.now() - t0;
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        latencyByBudget.set(budget, [...(latencyByBudget.get(budget) ?? []), ms]);
        packetBytesByBudget.set(budget, [...(packetBytesByBudget.get(budget) ?? []), JSON.stringify(out ?? null).length]);
        ledger = out && typeof out === "object" ? orientationAccountingOf(out) : undefined;
        const key = `${task}@${budget}`;
        const ph = packetHashes.get(key) ?? new Set(); ph.add(sha(JSON.stringify(out ?? null))); packetHashes.set(key, ph);
        const lh = ledgerHashes.get(key) ?? new Set(); lh.add(sha(JSON.stringify(ledger ?? null))); ledgerHashes.set(key, lh);
      }
      const isPacket = out && typeof out === "object" && "focus" in out;
      const debug = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget, detail: "debug", include_item_content: true }, "dbg");
      const supply = supplyOf(debug);
      const analysis: RepresentationAnalysis | null = isPacket ? analyzeRepresentation({
        packet: out, ledger, ceilingTokens: ceilingRule(budget), relatedBound: RELATED_BOUND,
        focusBound: ORIENTATION_POLICY.focusCodeCharacters, supply, authority,
      }) : null;
      // Class distinction: for every related entry with a source-backed body, the three constructions side by side.
      if (isPacket && supply) {
        const byId = new Map(supply.map((s) => [s.id, s]));
        for (const record of ledger?.items ?? []) {
          if (record.slot !== "related" || record.origin !== "item_supply") continue;
          const s = byId.get(String(record.sourceId));
          if (!s || !s.fqName || !s.path) continue;
          const sym = authority.symbol(s.fqName, s.path);
          if (!sym) continue;
          const skeleton = authority.skeleton(s.path, s.fqName);
          const file = authority.readFile(s.path);
          const focused = file === null ? null : file.split("\n").slice(sym.startLine - 1, sym.endLine).join("\n");
          distinctionPairs.push({ a: "skeleton", b: "signature", textA: skeleton, textB: sym.signature || null });
          distinctionPairs.push({ a: "focused_source", b: "skeleton", textA: focused, textB: skeleton });
          distinctionPairs.push({ a: "focused_source", b: "signature", textA: focused, textB: sym.signature || null });
        }
      }
      const row = {
        corpus: spec.id, task, budget, frozenBudget: (A11_BUDGETS as readonly number[]).includes(budget),
        shape: isPacket ? "orientation" : String(out?.schemaVersion ?? out?.__error?.code ?? "other"),
        packetSha: sha(JSON.stringify(out ?? null)), compactSha: compactShaOf(out),
        focusAt: isPacket ? out.focus.at : null, focusForm: isPacket ? out.focus.form : null,
        focusCodeTokensFrozen: isPacket ? Math.ceil((out.focus.code ?? "").length / 4) : 0,
        relatedIds: isPacket ? (out.related ?? []).map((r: any) => String(r.at)) : [],
        frozenClasses: isPacket ? frozenA12Classes(out) : [],
        frozenUtilisationPercent: isPacket ? frozenUtilisationPercent(out, budget) : null,
        relatedWithCode: isPacket ? (out.related ?? []).filter((r: any) => typeof r.code === "string").length : 0,
        relatedCount: isPacket ? (out.related ?? []).length : 0,
        supplyBound: supply !== null, supplyItemsWithBody: supply === null ? 0 : supply.filter((s) => typeof s.content === "string" && s.content.length > 0).length,
        candidates: ledger?.candidates ? { proposed: ledger.candidates.proposed, admitted: ledger.candidates.admitted,
          rejectedForCeiling: ledger.candidates.rejectedForCeiling, notReached: ledger.candidates.notReached } : null,
        evidenceTokens: ledger?.evidence?.tokens ?? null, ceilingTokens: ledger?.ceilingTokens ?? null,
        latencyMs: +(latencyByBudget.get(budget)!.at(-1)!).toFixed(1),
        analysis,
      };
      responses.push(row);
      if (analysis !== null) {
        for (const item of analysis.items) {
          ledgerRows.push({ corpus: spec.id, task, budget, frozen_budget: row.frozenBudget, at: item.at, file: item.file, ordinal: item.ordinal, slot: item.slot,
            representation: item.representation, frozen_class: item.frozenClass, reason: item.reason,
            available_representation: item.availableRepresentation, available_code_characters: item.availableCodeCharacters,
            source_capability: item.sourceCapability, source_truth: item.sourceTruth, code_characters: item.codeCharacters,
            truncated: item.truncated, actual_tokens: item.actualTokens, pass: item.pass,
            failed_gates: item.gates.filter((g) => !g.pass).map((g) => g.id) });
        }
      }
    }
  }

  // ------------------------------------------------------------- aggregates
  const packets = responses.filter((r) => r.analysis !== null);
  const frozenPackets = packets.filter((r) => r.frozenBudget);
  const frozenClasses = [...new Set(frozenPackets.flatMap((r) => r.frozenClasses))];
  const allBudgetClasses = [...new Set(packets.flatMap((r) => r.frozenClasses))];
  const classTotals: Record<string, number> = {};
  const reasonTotals: Record<string, number> = {};
  const truthTotals: Record<string, Record<string, number>> = {};
  const capabilityTotals: Record<string, number> = {};
  for (const r of packets) for (const item of (r.analysis as RepresentationAnalysis).items) {
    classTotals[item.representation] = (classTotals[item.representation] ?? 0) + 1;
    if (item.slot === "related") {
      reasonTotals[item.reason] = (reasonTotals[item.reason] ?? 0) + 1;
      capabilityTotals[item.sourceCapability] = (capabilityTotals[item.sourceCapability] ?? 0) + 1;
    }
    if (item.codeCharacters > 0) {
      truthTotals[item.representation] ??= {};
      truthTotals[item.representation]![item.sourceTruth] = (truthTotals[item.representation]![item.sourceTruth] ?? 0) + 1;
    }
  }
  const byBudget = Object.fromEntries(BUDGETS.map((b) => {
    const rows = packets.filter((r) => r.budget === b);
    const a = rows.map((r) => r.analysis as RepresentationAnalysis);
    const med = (f: (x: any) => number | null) => {
      const v = rows.map(f).filter((n): n is number => typeof n === "number");
      return v.length === 0 ? null : +median(v).toFixed(2);
    };
    const classes: Record<string, number> = {};
    for (const x of a) for (const i of x.items) if (i.slot === "related") classes[i.representation] = (classes[i.representation] ?? 0) + 1;
    return [b, {
      responses: rows.length, ceilingTokens: ceilingRule(b),
      frozenClasses: [...new Set(rows.flatMap((r) => r.frozenClasses))],
      frozenUtilisationMedian: med((r) => r.frozenUtilisationPercent),
      medians: {
        relatedCount: med((r) => r.relatedCount), relatedWithCode: med((r) => r.relatedWithCode),
        proposed: med((r) => r.candidates?.proposed ?? null), admitted: med((r) => r.candidates?.admitted ?? null),
        evidenceTokens: med((r) => r.evidenceTokens),
        deliveredRelatedTokens: med((r) => r.analysis.supply.deliveredRelatedTokens),
        compactRelatedTokens: med((r) => r.analysis.supply.compactRelatedTokens),
        representableRelatedTokens: med((r) => r.analysis.supply.representableRelatedTokens),
        relatedWithAvailableForm: med((r) => r.analysis.supply.relatedWithAvailableForm),
      },
      relatedClasses: classes,
      totals: { relatedDelivered: rows.reduce((n, r) => n + r.relatedCount, 0), relatedWithCode: rows.reduce((n, r) => n + r.relatedWithCode, 0),
        rejectedForCeiling: rows.reduce((n, r) => n + (r.candidates?.rejectedForCeiling ?? 0), 0),
        integrityFailures: a.filter((x) => x.verdict !== "REPRESENTATION_INTEGRITY_PASS").length,
        supplyBound: rows.filter((r) => r.supplyBound).length },
      latency: latencyStats(latencyByBudget.get(b) ?? []),
      largestPacketBytes: Math.max(0, ...(packetBytesByBudget.get(b) ?? [])),
    }];
  }));

  // Frozen A11 (observed, not optimised) and A13 (observed, not optimised).
  const frozenMedians = A11_BUDGETS.map((b) => byBudget[b]?.frozenUtilisationMedian ?? null);
  const frozenA11 = { utilisationByBudget: Object.fromEntries(A11_BUDGETS.map((b, k) => [b, { median: frozenMedians[k] }])), verdict: frozenA11Verdict(frozenMedians) };
  const curves = budgetTasks.map((task) => {
    const points = A11_BUDGETS.map((b) => responses.find((r) => r.task === task && r.budget === b)).filter(Boolean);
    let sizeViolations = 0; let focusSwaps = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i]!.focusCodeTokensFrozen < points[i - 1]!.focusCodeTokensFrozen) sizeViolations += 1;
      if (points[i]!.focusAt !== points[i - 1]!.focusAt) focusSwaps += 1;
    }
    const relations = A11_BUDGETS.slice(1).map((b, k) => {
      const lo = points[k]; const hi = points[k + 1];
      return { from: A11_BUDGETS[k], to: b, relation: lo && hi ? orderRelation(lo.relatedIds, hi.relatedIds) : "unmeasured" };
    });
    // Representation monotonicity across ALL swept budgets: an entry delivered with code at a
    // smaller budget keeps code at every larger budget in which it is delivered.
    const all = BUDGETS.map((b) => responses.find((r) => r.task === task && r.budget === b)).filter(Boolean);
    let representationRegressions = 0;
    for (let i = 1; i < all.length; i += 1) {
      const lo: any = all[i - 1]; const hi: any = all[i];
      if (!lo.analysis || !hi.analysis) continue;
      const richLo = new Set(lo.analysis.items.filter((x: any) => x.slot === "related" && x.codeCharacters > 0).map((x: any) => x.at));
      const hiById = new Map(hi.analysis.items.map((x: any) => [x.at, x]));
      for (const at of richLo) { const h: any = hiById.get(at); if (h && h.codeCharacters === 0) representationRegressions += 1; }
    }
    return { task, sizeViolations, focusSwaps, orderRelations: relations, representationRegressions };
  });
  const relationHist: Record<string, number> = {};
  for (const c of curves) for (const r of c.orderRelations) relationHist[r.relation] = (relationHist[r.relation] ?? 0) + 1;

  db.close();
  const unstable = [...packetHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const unstableLedgers = [...ledgerHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const distinction = classDistinction(distinctionPairs);

  perCorpus.push({
    id: spec.id, filesIndexed: indexed?.summary?.filesIndexed ?? null, tasks: budgetTasks.length,
    budgets: BUDGETS, frozenBudgets: A11_BUDGETS, responseCount: responses.length, packets: packets.length,
    frozenA12: { distinctClassesObserved: frozenClasses, count: frozenClasses.length, verdict: frozenA12Verdict(frozenClasses.length),
      overAllSweptBudgets: allBudgetClasses },
    frozenA11,
    frozenA13: { tasksWithSizeViolation: curves.filter((c) => c.sizeViolations > 0).length, tasksWithFocusSwap: curves.filter((c) => c.focusSwaps > 0).length,
      orderRelations: relationHist, representationRegressions: curves.reduce((n, c) => n + c.representationRegressions, 0), curves },
    classTotals, reasonTotals, capabilityTotals, sourceTruth: truthTotals, byBudget,
    classDistinction: distinction,
    integrity: { packets: packets.length, failures: packets.filter((r) => r.analysis.verdict !== "REPRESENTATION_INTEGRITY_PASS").length,
      failedGates: packets.flatMap((r) => r.analysis.gates.filter((g: any) => !g.pass).map((g: any) => `${r.task}@${r.budget}:${g.id}`)),
      failedItems: packets.flatMap((r) => r.analysis.items.filter((i: any) => !i.pass).map((i: any) => `${r.task}@${r.budget}:${i.at}:${i.gates.filter((g: any) => !g.pass).map((g: any) => g.id).join("+")}`)).slice(0, 50) },
    determinism: { repeats: REPEATS, packetsStable: unstable.length === 0, unstablePackets: unstable, ledgersStable: unstableLedgers.length === 0, unstableLedgers },
    resources: { largestPacketBytes: Math.max(0, ...packets.map((r) => JSON.stringify(r.analysis ? 0 : 0) === "" ? 0 : 0), ...[...packetBytesByBudget.values()].flat()),
      largestItemCount: Math.max(0, ...packets.map((r) => 1 + r.relatedCount)) },
    responses: responses.map(({ analysis, ...rest }) => ({ ...rest, analysis: analysis === null ? null : {
      verdict: analysis.verdict, frozenClasses: analysis.frozenClasses, deliveredClasses: analysis.deliveredClasses, supply: analysis.supply,
      failedGates: analysis.gates.filter((g: any) => !g.pass).map((g: any) => g.id) } })),
  });
  const c = perCorpus.at(-1)!;
  console.log(`[${LABEL}] ${spec.id.padEnd(8)} A12 ${c.frozenA12.count} classes (${c.frozenA12.distinctClassesObserved.join(", ")}) ${c.frozenA12.verdict} `
    + `| A11 ${A11_BUDGETS.map((b) => `${b}=${byBudget[b]?.frozenUtilisationMedian}%`).join(" ")} | A13 size ${c.frozenA13.tasksWithSizeViolation} swap ${c.frozenA13.tasksWithFocusSwap} `
    + `| integrity failures ${c.integrity.failures}/${c.integrity.packets} | stable ${c.determinism.packetsStable}/${c.determinism.ledgersStable} | reasons ${JSON.stringify(reasonTotals)}`);
}

const cmed = perCorpus.find((c) => c.id === "C-MED");
const out = {
  milestone: "M205", instrument: "run_stage5_m205_representation.ts", label: LABEL,
  product: { root: PRODUCT_ROOT, head: productHead, relatedCodeCharacters: RELATED_BOUND || null, focusCodeCharacters: ORIENTATION_POLICY.focusCodeCharacters,
    skeletonAuthorityBound: renderStructuralSkeleton !== null },
  protocol: {
    calls: "get_code_context, default detail, max_tokens at each budget, one index per corpus copy; one paired detail=debug call with include_item_content per request for the supply",
    tasks: "A13_TASKS (all 20 on C-MED, first 3 elsewhere)", budgets: BUDGETS, frozenBudgets: A11_BUDGETS,
    frozenA12Rule: "FOCUS:<form> when focus.code; RELATED_WITH_CODE when related.code is a string; RELATIONSHIP_ONLY otherwise; distinct over C-MED responses at the frozen budgets; MATCHES >= 3, EXCEEDS >= 5 (engine + report, verbatim)",
  },
  hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtEnd: loadAverage(), peakRssBytes },
  frozenA12: cmed?.frozenA12 ?? null, frozenA11: cmed?.frozenA11 ?? null,
  frozenA13: cmed === undefined ? null : { tasksWithSizeViolation: cmed.frozenA13.tasksWithSizeViolation, tasksWithFocusSwap: cmed.frozenA13.tasksWithFocusSwap,
    orderRelations: cmed.frozenA13.orderRelations, representationRegressions: cmed.frozenA13.representationRegressions },
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m205_representation_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
if (ledgerRows.length > 0) {
  writeFileSync(path.join(RESULTS, `stage5_m205_routing_ledger_${LABEL}.jsonl`), `${ledgerRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}
console.log(`[${LABEL}] frozen A12 C-MED ${cmed?.frozenA12?.count ?? "?"} classes ${cmed?.frozenA12?.verdict ?? "UNMEASURED"} -> results/stage5_m205_representation_${LABEL}.json + ${ledgerRows.length} routing rows`);

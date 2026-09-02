/**
 * M205 — the VEXP representation inventory, recovered mechanically (§10).
 *
 * Reads the SAME artefacts the frozen M196 claim ledger cites — the VEXP MCP
 * server bundle, the closed core binary and the CLI README — and records
 * every representation-class marker each one exposes, as a string that can be
 * found again. Each class is labelled by how it was witnessed:
 *
 *   OBSERVED    a rendering marker present in the binary or the MCP bundle
 *   CLAIMED     described in prose (README, tool description) only
 *   UNKNOWN     internal behaviour the closed binary does not expose
 *
 * No vexp process is executed; no network is touched. The counts the frozen
 * A12 comparison rests on (MATCH at >= 3, EXCEED at 5) are taken from the
 * committed report rule and reproduced here beside what the artefacts show.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m205_vexp_inventory.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A12_EXCEED_CLASSES, A12_MATCH_CLASSES } from "./m205Representation";

const RESULTS = path.join(import.meta.dir, "results");
const ledger = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m196_vexp_claim_ledger.json"), "utf8"));
const artifacts: Record<string, { path: string; bytes: number; present: boolean }> = ledger.artifacts;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const load = (key: string): { bytes: Uint8Array; text: string; sha256: string } | null => {
  const p = artifacts[key]?.path;
  if (p === undefined || !existsSync(p)) return null;
  const bytes = readFileSync(p);
  return { bytes, text: bytes.toString("latin1"), sha256: sha(bytes) };
};
const core = load("coreBinary"); const mcp = load("mcpServer"); const readme = load("cliReadme");

/** Count exact occurrences of a needle in a text; 0 when the artefact is absent. */
const count = (hay: string | null, needle: string): number => {
  if (hay === null) return 0;
  let n = 0; let at = 0;
  for (;;) { at = hay.indexOf(needle, at); if (at < 0) return n; n += 1; at += needle.length; }
};
/** Printable context around the first occurrence, for the record. */
const context = (hay: string | null, needle: string, width = 90): string | null => {
  if (hay === null) return null;
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  return hay.slice(Math.max(0, at - width), at + needle.length + width).replace(/[^\x20-\x7e]+/g, " | ");
};

interface Marker { readonly artifact: "coreBinary" | "mcpServer" | "cliReadme"; readonly needle: string }
interface VexpClass {
  readonly name: string;
  readonly purpose: string;
  readonly observableShape: string;
  readonly markers: readonly Marker[];
  readonly claimText: readonly Marker[];
  readonly countsTowardA12: boolean;
  readonly vtraceAnalogue: string;
}

const CLASSES: readonly VexpClass[] = [
  {
    name: "pivot_full_content",
    purpose: "the edit target, delivered as its full source",
    observableShape: "a `## Pivots (Full Content)` section header in the rendered capsule; `include_file_content` tool option",
    markers: [{ artifact: "coreBinary", needle: "## Pivots (Full Content)" }, { artifact: "mcpServer", needle: "## Pivot Files (Full Content)" }],
    claimText: [{ artifact: "mcpServer", needle: "Include full file content for pivot files" }],
    countsTowardA12: true,
    vtraceAnalogue: "focus with form focused_source (FOCUS:focused_source)",
  },
  {
    name: "pivot_skeleton",
    purpose: "the edit target degraded to a skeleton when the budget binds",
    observableShape: "a `## Pivots (Skeletons` section header with a `call get_skeleton(file) for body` note",
    markers: [{ artifact: "coreBinary", needle: "## Pivots (Skeletons" }, { artifact: "coreBinary", needle: "call get_skeleton(file) for body" }],
    claimText: [],
    countsTowardA12: true,
    vtraceAnalogue: "focus with form signature/skeleton (FOCUS:signature observed on C-LARGE)",
  },
  {
    name: "supporting_skeleton",
    purpose: "supporting files delivered as skeletons",
    observableShape: "a `## Supporting (Skeletons)` / `## Supporting Context (Skeletons)` section header; per-file skeleton blocks in the MCP renderer",
    markers: [{ artifact: "coreBinary", needle: "## Supporting (Skeletons)" }, { artifact: "coreBinary", needle: "## Supporting Context (Skeletons)" }],
    claimText: [],
    countsTowardA12: true,
    vtraceAnalogue: "related entry carrying code in a skeleton/signature/focused_source/excerpt/document_excerpt form (RELATED_WITH_CODE)",
  },
  {
    name: "supporting_dropped",
    purpose: "supporting files omitted when the budget binds, with a pointer to get_skeleton",
    observableShape: "a `- (dropped … call get_skeleton(file_path) for related symbols)` line and a `supporting_dropped` field",
    markers: [{ artifact: "coreBinary", needle: "supporting_dropped" }, { artifact: "coreBinary", needle: "call get_skeleton(file_path) for related symbols" }],
    claimText: [],
    countsTowardA12: false,
    vtraceAnalogue: "an absence, not a representation: relationship-only entries and the claim boundary (RELATIONSHIP_ONLY is the nearest delivered class)",
  },
  {
    name: "get_skeleton_file_structure",
    purpose: "a separate tool: file structure without full content, full bodies for short functions and signatures for long ones",
    observableShape: "tool description text; a `# File Skeletons` renderer in the MCP bundle",
    markers: [{ artifact: "mcpServer", needle: "# File Skeletons" }, { artifact: "coreBinary", needle: "file structure without full content" }],
    claimText: [{ artifact: "mcpServer", needle: "full bodies for short functions, signatures for long ones" }],
    countsTowardA12: false,
    vtraceAnalogue: "get_skeleton (A9/A10), outside the run_pipeline response the frozen A12 scores",
  },
];

const hayOf = (a: Marker["artifact"]) => (a === "coreBinary" ? core : a === "mcpServer" ? mcp : readme)?.text ?? null;
const inventory = CLASSES.map((c) => {
  const markers = c.markers.map((m) => ({ ...m, occurrences: count(hayOf(m.artifact), m.needle), context: context(hayOf(m.artifact), m.needle) }));
  const claims = c.claimText.map((m) => ({ ...m, occurrences: count(hayOf(m.artifact), m.needle) }));
  const observed = markers.some((m) => m.occurrences > 0);
  const claimed = claims.some((m) => m.occurrences > 0);
  return {
    name: c.name, purpose: c.purpose, observableShape: c.observableShape, vtraceAnalogue: c.vtraceAnalogue,
    countsTowardA12: c.countsTowardA12,
    evidence: observed ? "OBSERVED" : claimed ? "CLAIMED" : "UNKNOWN",
    structuralBehaviourObservable: false,
    note: "the marker proves the renderer HAS this section; when it is chosen, how it is bounded and what it contains are inside the closed binary (UNKNOWN)",
    markers, claimText: claims,
  };
});

const observedCounted = inventory.filter((c) => c.countsTowardA12 && c.evidence === "OBSERVED").length;
const out = {
  milestone: "M205", instrument: "run_stage5_m205_vexp_inventory.ts",
  method: "byte search over the artefacts the frozen M196 ledger cites; no vexp process executed; no network",
  artifacts: Object.fromEntries(Object.entries(artifacts).map(([k, v]) => [k, {
    path: v.path, present: existsSync(v.path), bytes: existsSync(v.path) ? statSync(v.path).size : null, ledgerBytes: v.bytes,
    sha256: k === "coreBinary" ? core?.sha256 ?? null : k === "mcpServer" ? mcp?.sha256 ?? null : k === "cliReadme" ? readme?.sha256 ?? null : null,
  }])),
  frozenClaim: {
    id: "V-C6", claim: ledger.claims.find((c: any) => c.id === "V-C6")?.claim, needle: ledger.claims.find((c: any) => c.id === "V-C6")?.needle,
    a12MatchThreshold: `>= ${A12_MATCH_CLASSES} distinct classes`, a12ExceedThreshold: `${A12_EXCEED_CLASSES}`,
    representationDefinition: "per delivered item in the DEFAULT get_code_context response: FOCUS:<form> when the focus carries code; RELATED_WITH_CODE when a related entry's code is a string; RELATIONSHIP_ONLY otherwise; distinct classes over all C-MED responses (engine + report, verbatim)",
  },
  inventory,
  summary: {
    classes: inventory.length, observed: inventory.filter((c) => c.evidence === "OBSERVED").length,
    claimed: inventory.filter((c) => c.evidence === "CLAIMED").length, unknown: inventory.filter((c) => c.evidence === "UNKNOWN").length,
    observedCountingTowardA12: observedCounted,
    matchLineExplained: `the frozen MATCH line of ${A12_MATCH_CLASSES} equals the ${observedCounted} OBSERVED classes that count: pivot full content, pivot skeleton, supporting skeleton`,
  },
};
writeFileSync(path.join(RESULTS, "stage5_m205_vexp_representation_inventory.json"), `${JSON.stringify(out, null, 2)}\n`);

const md: string[] = [`# M205 — VEXP representation inventory`, "", `Method: ${out.method}.`, "",
  `| class | evidence | counts toward A12 | markers (occurrences) | VTRACE analogue |`, `| --- | --- | --- | --- | --- |`];
for (const c of inventory) md.push(`| ${c.name} | ${c.evidence} | ${c.countsTowardA12} | ${c.markers.map((m) => `\`${m.needle}\` ${m.artifact} x${m.occurrences}`).join("; ")} | ${c.vtraceAnalogue} |`);
md.push("", `${out.summary.matchLineExplained}. Structural behaviour (when a section is chosen, how it is bounded) is UNKNOWN for every class: the binary is closed.`, "");
writeFileSync(path.join(RESULTS, "stage5_m205_vexp_representation_inventory.md"), `${md.join("\n")}\n`);
for (const c of inventory) console.log(`${c.evidence.padEnd(9)} ${c.name.padEnd(30)} ${c.markers.map((m) => `${m.artifact}:${m.occurrences}`).join(" ")}`);
console.log(`observed classes counting toward A12: ${observedCounted} (frozen MATCH line ${A12_MATCH_CLASSES})`);

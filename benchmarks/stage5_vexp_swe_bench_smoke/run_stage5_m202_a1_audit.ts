/**
 * M202 — frozen A1 definition audit and language-family inventory (§4-§6).
 *
 * A1 is scored by `run_stage5_m197a_report.ts` as
 *
 *   supportedLanguageCount({ declaredEnum, extensionDetected, parserBacked })
 *   band([count], 30, 31, "atLeast")            MATCH >= 30, EXCEED > 30
 *
 * where `parserBacked` is `createDefaultParserRegistry([]).registeredLanguages()`
 * and `declaredEnum` is `Object.values(Language)`. The counting unit on the
 * VTRACE side is therefore a `Language` enum member with a parser registered in
 * the registry the indexer actually builds. The VEXP side is the README list.
 *
 * This instrument does not score anything. It reconstructs BOTH inventories
 * mechanically so the milestone can see what the frozen comparator counts, and
 * it fails closed if the frozen scorer's own count disagrees with the count
 * derived here. Every number in its output is generated; the VEXP list is
 * parsed from the README the M196 claim ledger cites, never typed in.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m202_a1_audit.ts --label pre|post
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Language } from "../../src/domain/types";
import { detectLanguage, isAdvertisedIndexableLanguage } from "../../src/fs/languageDetection";
import { createDefaultParserRegistry } from "../../src/indexer/indexProject";
import { supportedLanguageCount } from "./m197aScoring";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "pre");

// ------------------------------------------------------------ frozen definition
const FROZEN_A1 = {
  claimId: "A1",
  vexpClaimId: "V-A1",
  claimWording: "30 programming languages supported out of the box",
  vexpEvidenceSource: "vexp-cli/README.md, heading 'Supported Languages (30)' (M196 claim ledger, sourceKey cliReadme)",
  vexpCountingUnit: "one comma-separated name in the README list; a slash-joined pair such as HTML/CSS is ONE name",
  vtraceCountingUnit: "one Language enum member that createDefaultParserRegistry([]) registers a parser for",
  deduplicationRule: "extensions never count; detectLanguage aliases collapse onto the enum member they return",
  parserBackedCriterion: "registry.registeredLanguages() includes the enum member (control F7)",
  aliasesCountSeparately: false,
  configurationLanguagesCount: "yes on the VEXP side (YAML/JSON is a listed name); on the VTRACE side only if a parser is registered",
  markdownCounts: "no: Markdown is not a Language enum member and the M197A ledger records noMarkdownIndexing",
  generatedParserSupportCounts: "no distinction is made by the scorer; only registry membership is counted",
  matchThreshold: ">= 30 parser-backed families",
  exceedThreshold: "> 30",
  scorer: "supportedLanguageCount (m197aScoring.ts) + band([count], 30, 31, 'atLeast') (run_stage5_m197a_report.ts)",
} as const;

// ------------------------------------------------------------ VEXP inventory
const claimLedger = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m196_vexp_claim_ledger.json"), "utf8"));
const readmePath: string = claimLedger.artifacts.cliReadme.path;
const coreBinaryPath: string = claimLedger.artifacts.coreBinary.path;
const va1 = claimLedger.claims.find((c: any) => c.id === "V-A1");

function vexpReadmeLanguages(): { heading: string; names: string[] } {
  const text = readFileSync(readmePath, "utf8");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^##\s+Supported Languages/u.test(l));
  if (at < 0) throw new Error("M202_VEXP_README_HEADING_ABSENT");
  const body = lines.slice(at + 1).find((l) => l.trim().length > 0) ?? "";
  return { heading: lines[at]!.trim(), names: body.split(",").map((s) => s.trim()).filter((s) => s.length > 0) };
}

/** Printable runs of the closed core binary, the only parser evidence VEXP ships. */
function binaryStrings(file: string, minLength = 8): Set<string> {
  const bytes = readFileSync(file);
  const out = new Set<string>();
  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    const b = i < bytes.length ? bytes[i]! : 0;
    const printable = b >= 0x20 && b < 0x7f;
    if (printable && start < 0) start = i;
    if (!printable && start >= 0) {
      if (i - start >= minLength) out.add(bytes.subarray(start, i).toString("latin1"));
      start = -1;
    }
  }
  return out;
}

/**
 * Grammar identifiers a tree-sitter build leaves in a binary. Only grammars with
 * an EXTERNAL SCANNER export a symbol name that survives stripping, so absence
 * here is not evidence of absence; presence is evidence of a tree-sitter grammar.
 */
const VEXP_ROW_GRAMMAR_TOKENS: Readonly<Record<string, readonly string[]>> = {
  "TypeScript": ["typescript", "tsx"], "JavaScript": ["javascript"], "Python": ["python"], "Go": ["go"],
  "Rust": ["rust"], "Java": ["java"], "C#": ["c_sharp"], "C": ["c"], "C++": ["cpp"], "Ruby": ["ruby"],
  "Kotlin": ["kotlin"], "Scala": ["scala"], "Swift": ["swift"], "Dart": ["dart"], "Elixir": ["elixir"],
  "Haskell": ["haskell"], "OCaml": ["ocaml"], "Lua": ["lua"], "R": ["r"], "PHP": ["php"], "Zig": ["zig"],
  "HCL/Terraform": ["hcl", "terraform"], "Objective-C": ["objc"], "Bash/Shell": ["bash"],
  "Dockerfile": ["dockerfile"], "Clojure": ["clojure"], "F#": ["fsharp"], "SQL": ["sql"],
  "HTML/CSS": ["html", "css"], "YAML/JSON": ["yaml", "json"],
};

/** The VTRACE enum member(s) that would satisfy each VEXP name, for the row-convention count. */
const VEXP_ROW_TO_VTRACE: Readonly<Record<string, readonly string[]>> = {
  "TypeScript": ["typescript"], "JavaScript": ["javascript"], "Python": ["python"], "Go": ["go"],
  "Rust": ["rust"], "Java": ["java"], "C#": ["csharp"], "C": ["c"], "C++": ["cpp"], "Ruby": ["ruby"],
  "Kotlin": ["kotlin"], "Scala": ["scala"], "Swift": ["swift"], "Dart": ["dart"], "Elixir": ["elixir"],
  "Haskell": ["haskell"], "OCaml": ["ocaml"], "Lua": ["lua"], "R": ["r"], "PHP": ["php"], "Zig": ["zig"],
  "HCL/Terraform": ["hcl"], "Objective-C": ["objective_c"], "Bash/Shell": ["bash"],
  "Dockerfile": ["dockerfile"], "Clojure": ["clojure"], "F#": ["fsharp"], "SQL": ["sql"],
  "HTML/CSS": ["html", "css"], "YAML/JSON": ["yaml", "json"],
};

const readme = vexpReadmeLanguages();
const strings = existsSync(coreBinaryPath) ? binaryStrings(coreBinaryPath) : new Set<string>();
const scannerSymbols = [...strings].filter((s) => /^tree_sitter_[a-z_]+_external_scanner_/u.test(s));
const grammarWithScanner = new Set(scannerSymbols.map((s) => s.replace(/^tree_sitter_/u, "").replace(/_external_scanner_.*$/u, "")));

const vexpInventory = readme.names.map((name) => {
  const tokens = VEXP_ROW_GRAMMAR_TOKENS[name] ?? [];
  const scanner = tokens.filter((t) => grammarWithScanner.has(t));
  const nameToken = tokens.filter((t) => strings.has(t));
  return {
    name,
    parserImplementation: scanner.length > 0 ? "tree-sitter grammar with external scanner (symbol present in vexp-core)" : "not observable: closed native binary",
    parserTechnology: scanner.length > 0 ? "TREE_SITTER_STRUCTURAL" : "UNKNOWN",
    structuralCapability: "not observable from the shipped artefacts; no VEXP process was executed",
    sourceEvidence: scanner.length > 0 ? scannerSymbols.filter((s) => scanner.some((t) => s.startsWith(`tree_sitter_${t}_`))) : nameToken.map((t) => `name token '${t}' present in vexp-core`),
    countedByFrozenA1: true,
    reason: "listed under the README heading the M196 ledger cites; the frozen measurement is the count of names",
  };
});

// ------------------------------------------------------------ VTRACE inventory
const PROBE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".pyw", ".pyx", ".pxd", ".pxi",
  ".yml", ".yaml", ".toml", ".json", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php", ".c", ".h",
  ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".cs", ".swift", ".scala", ".sc", ".sh", ".bash", ".sql",
  ".md", ".html", ".htm", ".css", ".scss", ".vue", ".svelte", ".ex", ".exs", ".erl", ".hs", ".lua", ".pl",
  ".r", ".R", ".m", ".mm", ".dart", ".ml", ".mli", ".zig", ".clj", ".cljs", ".cljc", ".edn", ".fs", ".fsx",
  ".tf", ".hcl", ".dockerfile",
];

const declaredEnum = Object.values(Language) as string[];
const detected = new Map<string, string[]>();
for (const ext of PROBE_EXTENSIONS) {
  const lang = detectLanguage(`probe${ext}`);
  if (lang === undefined) continue;
  detected.set(lang, [...(detected.get(lang) ?? []), ext]);
}
const registry = createDefaultParserRegistry([]);
const registered = [...registry.registeredLanguages()] as string[];
const frozenCount = supportedLanguageCount({
  declaredEnum, extensionDetected: [...detected.keys()], parserBacked: registered,
});

// The scorer's arithmetic, re-derived independently: enum ∩ registry.
const independentCount = declaredEnum.filter((l) => registered.includes(l)).length;
if (independentCount !== frozenCount) {
  throw new Error(`M202_A1_COUNT_DISAGREEMENT frozen=${frozenCount} independent=${independentCount}`);
}

const vtraceInventory = declaredEnum.map((language) => ({
  language,
  extensions: detected.get(language) ?? [],
  registeredParser: registered.includes(language),
  advertisedIndexable: isAdvertisedIndexableLanguage(language as Language),
  countedByFrozenA1: registered.includes(language),
  reason: registered.includes(language)
    ? "enum member with a parser registered by createDefaultParserRegistry"
    : (detected.has(language)
      ? "detected by extension but no parser registered: a detection rule, not language support (F7)"
      : "enum member with neither detection nor parser: a type, not language support (F7)"),
}));

// VEXP-row convention: how many of the 30 README names VTRACE covers, where a
// slash-joined name needs every member covered to count as one row.
const rowCoverage = readme.names.map((name) => {
  const needed = VEXP_ROW_TO_VTRACE[name] ?? [];
  const covered = needed.filter((l) => registered.includes(l));
  return { name, vtraceLanguages: needed, covered, fully: needed.length > 0 && covered.length === needed.length,
    partially: covered.length > 0 && covered.length < needed.length };
});
const vexpRowsCovered = rowCoverage.filter((r) => r.fully).length;
const vexpRowsPartial = rowCoverage.filter((r) => r.partially).map((r) => r.name);
const outsideVexp = registered.filter((l) => !Object.values(VEXP_ROW_TO_VTRACE).some((set) => set.includes(l)));

const out = {
  milestone: "M202",
  instrument: "run_stage5_m202_a1_audit.ts",
  label: LABEL,
  frozenDefinition: FROZEN_A1,
  vexp: {
    readme: readmePath,
    heading: readme.heading,
    headlineCount: Number.parseInt(/\((\d+)\)/u.exec(readme.heading)?.[1] ?? "0", 10),
    namesListed: readme.names.length,
    ledgerMeasurementDefinition: va1?.measurementDefinition ?? null,
    coreBinary: coreBinaryPath,
    coreBinaryPresent: existsSync(coreBinaryPath),
    externalScannerSymbols: scannerSymbols.sort(),
    inventory: vexpInventory,
    technologyTally: Object.fromEntries(
      [...new Set(vexpInventory.map((r) => r.parserTechnology))].map((t) => [t, vexpInventory.filter((r) => r.parserTechnology === t).length])),
  },
  vtrace: {
    declaredEnumMembers: declaredEnum.length,
    extensionDetectedFamilies: detected.size,
    registeredParserFamilies: registered.length,
    registered,
    frozenA1Count: frozenCount,
    independentCount,
    classification: frozenCount > 30 ? "EXCEEDS" : frozenCount >= 30 ? "MATCHES" : "BELOW",
    inventory: vtraceInventory,
    vexpRowConvention: { rowsCovered: vexpRowsCovered, of: readme.names.length, partialRows: vexpRowsPartial,
      registeredFamiliesOutsideVexpList: outsideVexp, rows: rowCoverage },
  },
};
writeFileSync(path.join(RESULTS, `stage5_m202_a1_audit_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);

const md: string[] = [];
md.push(`# M202 — frozen A1 audit (${LABEL})\n`);
md.push(`Claim: \`${FROZEN_A1.claimWording}\` — VEXP counts ${readme.names.length} names under \`${readme.heading}\`; `
  + `VTRACE counts enum members with a registered parser. MATCH ${FROZEN_A1.matchThreshold}, EXCEED ${FROZEN_A1.exceedThreshold}.\n`);
md.push(`## VEXP inventory (${readme.names.length} names)\n`);
md.push(`| name | VTRACE analogue | parser technology (from vexp-core strings) | evidence |`);
md.push(`| --- | --- | --- | --- |`);
for (const r of vexpInventory) {
  md.push(`| ${r.name} | ${(VEXP_ROW_TO_VTRACE[r.name] ?? []).join(" + ")} | ${r.parserTechnology} | ${r.sourceEvidence.slice(0, 2).join("; ") || "none"} |`);
}
md.push(``);
md.push(`## VTRACE inventory (${LABEL}): frozen count ${frozenCount} → ${out.vtrace.classification}\n`);
md.push(`| language | extensions | parser registered | counted | reason |`);
md.push(`| --- | --- | --- | --- | --- |`);
for (const r of vtraceInventory) {
  md.push(`| ${r.language} | ${r.extensions.join(" ") || "—"} | ${r.registeredParser ? "yes" : "no"} | ${r.countedByFrozenA1 ? "yes" : "no"} | ${r.reason} |`);
}
md.push(``);
md.push(`VEXP-row convention: ${vexpRowsCovered}/${readme.names.length} names fully covered`
  + `${vexpRowsPartial.length > 0 ? `, partial: ${vexpRowsPartial.join(", ")}` : ""}; `
  + `registered families outside VEXP's list: ${outsideVexp.join(", ") || "none"}.\n`);
writeFileSync(path.join(RESULTS, `stage5_m202_a1_audit_${LABEL}.md`), `${md.join("\n")}\n`);

console.log(`VEXP: ${readme.names.length} names under '${readme.heading}'; tree-sitter scanner evidence for `
  + `${vexpInventory.filter((r) => r.parserTechnology === "TREE_SITTER_STRUCTURAL").map((r) => r.name).join(", ")}`);
console.log(`VTRACE (${LABEL}): enum ${declaredEnum.length}, detected ${detected.size}, registered ${registered.length} `
  + `[${registered.join(", ")}] → frozen A1 count ${frozenCount} (${out.vtrace.classification})`);
console.log(`VEXP-row convention: ${vexpRowsCovered}/${readme.names.length}; outside list: ${outsideVexp.join(", ") || "none"}`);
console.log(`wrote results/stage5_m202_a1_audit_${LABEL}.{json,md}`);

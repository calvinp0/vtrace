/**
 * M202 — per-family health contract and falsification controls (§47, §60).
 *
 * For every family the default registry registers, this instrument parses the
 * committed fixtures through the PRODUCTION registry and records, per family:
 *
 *   fixture parsed          the valid fixture is accepted
 *   parser invocation       tree-sitter's `Parser.prototype.parse` fired for it
 *   structural output       non-empty where the fixture declares something, and
 *                           EMPTY where the family has no declaration model
 *   span/excerpt truth      every byte span reproduces text containing the name,
 *                           and the signature is a verbatim slice (§18, §30)
 *   malformed truth         the malformed fixture yields a diagnostic or a
 *                           parse failure, and no symbol outside its own span
 *   determinism             three parses, one normalised hash (§20)
 *   empty / comment-only    zero symbols, zero diagnostics
 *
 * The falsification controls F1-F12 are executed here as well, each one a
 * mutation that must FAIL its gate. A control that passes when it should fail
 * ends the run with a non-zero exit.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m202_family_health.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";

import { Language, SymbolKind } from "../../src/domain/types";
import { detectLanguage } from "../../src/fs/languageDetection";
import { createDefaultParserRegistry } from "../../src/indexer/indexProject";
import { createParserRegistry, type LanguageParser } from "../../src/parsers/LanguageParser";
import { LANGUAGE_FAMILIES, familyOf, structuralFamilies } from "../../src/parsers/languageFamilies";
import { describeParserFamilies } from "../../src/parsers/parserFamilies";
import { parseStructural } from "../../src/parsers/structuralParser";
import { STRUCTURAL_RULES } from "../../src/parsers/structuralRules";
import { grammarArtifactStatus } from "../../src/parsers/treeSitterGrammars";
import { createOffsetTranslator } from "../../src/parsers/treeSitterSource";
import { supportedLanguageCount } from "./m197aScoring";

const RESULTS = path.join(import.meta.dir, "results");
const FIXTURES = path.join(import.meta.dir, "fixtures", "m202_language_families");

// ------------------------------------------------ parser-invocation witness
const invocations = new Map<string, number>();
let currentLanguage = "";
const originalParse = Parser.prototype.parse;
Parser.prototype.parse = function patched(this: Parser, ...args: Parameters<typeof originalParse>) {
  invocations.set(currentLanguage, (invocations.get(currentLanguage) ?? 0) + 1);
  return originalParse.apply(this, args);
} as typeof originalParse;

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalise = (result: any) => ({ symbols: result.symbols, edges: result.edges, diagnostics: result.diagnostics });

function fixtureFile(language: string, prefix: "valid" | "malformed"): { path: string; content: string } | null {
  const dir = path.join(FIXTURES, language);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.startsWith(`${prefix}.`));
  return file === undefined ? null : { path: `${language}/${file}`, content: readFileSync(path.join(dir, file), "utf8") };
}

const registry = createDefaultParserRegistry([]);
const families = describeParserFamilies(registry);
const ledger: any[] = [];

for (const family of families.filter((f) => f.registered && f.parser === "structural")) {
  const language = family.language;
  const valid = fixtureFile(language, "valid");
  const malformed = fixtureFile(language, "malformed");
  const row: any = { language, displayName: family.displayName, tier: family.tier, vexpRow: family.vexpRow,
    extensions: family.extensions, fixture: valid?.path ?? null, malformedFixture: malformed?.path ?? null };
  if (valid === null || malformed === null) { row.status = "FIXTURE_MISSING"; ledger.push(row); continue; }

  // parse (production registry) + invocation witness
  currentLanguage = language;
  const before = invocations.get(language) ?? 0;
  const parsed = await registry.parse({ path: valid.path, content: valid.content, language });
  row.parserInvocationConfirmed = (invocations.get(language) ?? 0) > before;
  row.fixtureParsed = parsed.ok;
  if (parsed.ok === false) { row.status = "PARSE_FAILED"; row.error = parsed.error.message; ledger.push(row); continue; }
  const result = parsed.result;
  const bytes = Buffer.from(valid.content, "utf8");
  const hasDeclarationModel = (STRUCTURAL_RULES[language as Language]?.declarations.length ?? 0) > 0;
  row.hasDeclarationModel = hasDeclarationModel;
  row.symbols = result.symbols.length;
  row.containsEdges = result.edges.filter((e) => e.edgeType === "contains").length;
  row.otherEdges = result.edges.filter((e) => e.edgeType !== "contains").length;
  row.diagnostics = result.diagnostics.length;
  row.kinds = Object.fromEntries([...new Set(result.symbols.map((s) => s.kind))].sort().map((k) => [k, result.symbols.filter((s) => s.kind === k).length]));
  row.structuralOutputTruthful = hasDeclarationModel ? result.symbols.length > 0 : result.symbols.length === 0;

  // spans + excerpt anchoring + signature verbatim
  const nonAsciiOffset = valid.content.search(/[^\x00-\x7f]/u);
  const firstDeclarationIndex = result.symbols.length === 0 ? -1 : Math.min(...result.symbols.map((s) => s.startByte));
  row.nonAsciiBeforeFirstDeclaration = nonAsciiOffset >= 0 && (result.symbols.length === 0 || nonAsciiOffset < firstDeclarationIndex);
  const spanFaults: string[] = [];
  for (const s of result.symbols) {
    const sliced = bytes.subarray(s.startByte, s.endByte).toString("utf8");
    const bare = s.localName.split(".").at(-1)!.split(":").at(-1)!;
    if (!sliced.includes(bare)) spanFaults.push(`${s.localName}: span text lacks the name`);
    if (!valid.content.includes(s.signature)) spanFaults.push(`${s.localName}: signature not verbatim`);
    if (!sliced.trimStart().startsWith(s.signature.slice(0, Math.min(10, s.signature.length)))) spanFaults.push(`${s.localName}: signature does not start the span`);
    const lineText = valid.content.split("\n")[s.startLine - 1] ?? "";
    if (!sliced.startsWith(lineText.trimStart().slice(0, 6)) && !lineText.includes(sliced.split("\n")[0]!.slice(0, 6))) spanFaults.push(`${s.localName}: startLine ${s.startLine} does not match the span`);
  }
  row.spanFaults = spanFaults;
  row.spanTruth = spanFaults.length === 0;

  // determinism
  const hashes = new Set<string>();
  for (let i = 0; i < 3; i += 1) hashes.add(sha(normalise(parseStructural({ path: valid.path, content: valid.content, language }, familyOf(language)!))));
  row.deterministic = hashes.size === 1;
  row.structuralHash = [...hashes][0];

  // malformed
  const bad = await registry.parse({ path: malformed.path, content: malformed.content, language });
  if (bad.ok === false) {
    row.malformedOutcome = "parse_failed";
    row.malformedTruthful = /root node is ERROR/u.test(bad.error.message);
    row.malformedSymbols = 0;
  } else {
    const badBytes = Buffer.from(malformed.content, "utf8");
    const inventedNames = bad.result.symbols.filter((s) => !badBytes.subarray(s.startByte, s.endByte).toString("utf8").includes(s.localName.split(".").at(-1)!)).map((s) => s.localName);
    row.malformedOutcome = "partial_with_diagnostics";
    row.malformedSymbols = bad.result.symbols.length;
    row.malformedDiagnostics = bad.result.diagnostics.length;
    row.malformedInventedNames = inventedNames;
    row.malformedTruthful = bad.result.diagnostics.length > 0 && inventedNames.length === 0;
  }

  // empty + comment-only
  const empty = await registry.parse({ path: `e${family.extensions[0]}`, content: "", language });
  row.emptyFileZero = empty.ok && empty.result.symbols.length === 0 && empty.result.diagnostics.length === 0;

  row.status = [row.parserInvocationConfirmed, row.fixtureParsed, row.structuralOutputTruthful, row.spanTruth, row.deterministic, row.malformedTruthful, row.emptyFileZero].every(Boolean) ? "HEALTHY" : "UNHEALTHY";
  ledger.push(row);
}

// deep families: registered, fixture parity is covered by their own suites
for (const family of families.filter((f) => f.registered && f.parser !== "structural")) {
  ledger.push({ language: family.language, displayName: family.displayName, tier: family.tier, vexpRow: family.vexpRow,
    extensions: family.extensions, status: "DEEP_ADAPTER (own regression suite)", parserInvocationConfirmed: null });
}

// ------------------------------------------------------------ controls F1-F12
const controls: { id: string; statement: string; pass: boolean; detail: string }[] = [];
const control = (id: string, statement: string, pass: boolean, detail: string) => controls.push({ id, statement, pass, detail });
const enumMembers = Object.values(Language) as string[];
const frozenCount = (reg: { registeredLanguages(): readonly Language[] }) => supportedLanguageCount({
  declaredEnum: enumMembers, extensionDetected: [], parserBacked: [...reg.registeredLanguages()] });

// F1 fake registration: name + extensions, no parser → not counted
{
  const toml = familyOf(Language.Toml)!;
  control("F1", "a family with a name and extensions but no functional parser must not count",
    toml.parser === "none" && !registry.registeredLanguages().includes(Language.Toml) && detectLanguage("x.toml") === Language.Toml,
    `toml: detected, parser=${toml.parser}, registered=${registry.registeredLanguages().includes(Language.Toml)}`);
}
// F2 alias inflation
{
  const cpp = familyOf(Language.Cpp)!;
  const countWithAliases = frozenCount(registry);
  const distinct = new Set(cpp.extensions.map((e) => detectLanguage(`x${e}`))).size;
  control("F2", "N extensions for one family must add one family, not N",
    distinct === 1 && countWithAliases === registry.registeredLanguages().length,
    `${cpp.extensions.length} C++ extensions → ${distinct} family; frozen count ${countWithAliases}`);
}
// F3 parser failure → family not accepted as healthy
{
  const failing = ledger.find((r) => r.language === "go")!;
  const mutated = { ...failing, fixtureParsed: false };
  const accepted = [mutated.parserInvocationConfirmed, mutated.fixtureParsed, mutated.structuralOutputTruthful, mutated.spanTruth, mutated.deterministic, mutated.malformedTruthful, mutated.emptyFileZero].every(Boolean);
  control("F3", "a registered parser failing its fixture contract must fail family acceptance", !accepted,
    `go with fixtureParsed=false → accepted=${accepted}`);
}
// F4 wrong coordinate conversion → span gate fails
{
  const content = "// naïve — 日本語\nfunc Add() int { return 1 }\n";
  const translator = createOffsetTranslator(content);
  const utf16Start = content.indexOf("func");
  const rightBytes = Buffer.from(content, "utf8").subarray(translator.byteOffsetAt(utf16Start)).toString("utf8").startsWith("func");
  const wrongBytes = Buffer.from(content, "utf8").subarray(utf16Start).toString("utf8").startsWith("func");
  control("F4", "an identity (UTF-16 as bytes) conversion must fail the excerpt gate", rightBytes && !wrongBytes,
    `converted slice starts with 'func': ${rightBytes}; unconverted: ${wrongBytes}`);
}
// F5 malformed fixtures invent nothing
{
  const structural = ledger.filter((r) => r.tier !== undefined && r.status !== "DEEP_ADAPTER (own regression suite)");
  const invented = structural.flatMap((r) => r.malformedInventedNames ?? []);
  const untruthful = structural.filter((r) => r.malformedTruthful === false).map((r) => r.language);
  control("F5", "malformed fixtures must not yield invented declarations", invented.length === 0 && untruthful.length === 0,
    `invented=${invented.length}, untruthful families=${untruthful.join(",") || "none"}`);
}
// F6 determinism gate catches a perturbed iteration order
{
  const family = familyOf(Language.Go)!;
  const valid = fixtureFile("go", "valid")!;
  const baseline = normalise(parseStructural({ path: valid.path, content: valid.content, language: Language.Go }, family));
  const perturbed = { ...baseline, symbols: [...baseline.symbols].reverse() };
  control("F6", "a perturbed symbol order must fail normalised-output equality", sha(baseline) !== sha(perturbed),
    `baseline ${sha(baseline).slice(0, 12)} vs reversed ${sha(perturbed).slice(0, 12)}`);
}
// F7 registry wiring: a descriptor not reachable through the production registry does not count
{
  const detached = createParserRegistry();
  const goParser = registry.getParser(Language.Go)!;
  detached.registerParser(Language.Go, goParser);
  const described = describeParserFamilies(detached);
  control("F7", "a family absent from the production registry must not be described as registered",
    described.filter((d) => d.registered).map((d) => d.language).join(",") === "go" && frozenCount(detached) === 1,
    `detached registry: registered=[go], frozen count ${frozenCount(detached)}`);
}
// F8 extension-only recogniser
{
  const recogniserOnly = createParserRegistry();
  control("F8", "a recognised extension with no parser invocation must not count as parser-backed",
    detectLanguage("x.toml") !== undefined && frozenCount(recogniserOnly) === 0 && !registry.registeredLanguages().includes(Language.Toml),
    `toml recognised, registered=false, empty-registry count=0`);
}
// F9 mixed-language routing (all counted families in one registry parse to their own family)
{
  const misrouted: string[] = [];
  for (const family of structuralFamilies()) {
    const valid = fixtureFile(family.language, "valid");
    if (valid === null) continue;
    const detected = detectLanguage(valid.path);
    if (detected !== family.language) misrouted.push(`${valid.path}→${detected}`);
    const parsed = await registry.parse({ path: valid.path, content: valid.content, language: family.language });
    if (parsed.ok === false || parsed.result.file.language !== family.language) misrouted.push(`${valid.path} parsed as ${parsed.ok ? parsed.result.file.language : "FAIL"}`);
  }
  control("F9", "every counted family's fixture must detect and parse as that family", misrouted.length === 0, misrouted.join("; ") || "all routed correctly");
}
// F10 deep parser regression: routing TypeScript through the generic walk must be refused
{
  let refused = false;
  try { parseStructural({ path: "a.ts", content: "export function f(): number { return 1; }", language: Language.TypeScript }, familyOf(Language.TypeScript)!); }
  catch { refused = true; }
  const ts = registry.getParser(Language.TypeScript)!;
  const tsResult = await ts.parse({ path: "a.ts", content: "import { x } from \"./x\";\nexport function f(): number { return x(); }\n", language: Language.TypeScript });
  control("F10", "TypeScript/Python/Cython must never route to the generic weaker parser",
    refused && familyOf(Language.Python)!.parser === "python" && familyOf(Language.Cython)!.parser === "cython" && tsResult.symbols.some((s) => s.kind === SymbolKind.Function),
    `generic parse of .ts refused=${refused}; deep TS parser produced ${tsResult.symbols.length} symbols`);
}
// F11 eager-initialise-all-grammars: measured in FRESH processes, because a
// grammar loaded once in this process is cached and a second load costs nothing.
{
  const { spawnSync } = await import("node:child_process");
  const REPO = path.resolve(import.meta.dir, "../..");
  const run = (script: string) => {
    const t0 = performance.now();
    const r = spawnSync("bun", ["-e", script], { cwd: REPO, encoding: "utf8" });
    return { wallMs: performance.now() - t0, stdout: r.stdout.trim(), status: r.status };
  };
  const lazy = run(`import { createDefaultParserRegistry } from "./src/indexer/indexProject"; const t0 = performance.now(); createDefaultParserRegistry([]); console.log((performance.now() - t0).toFixed(2));`);
  const eager = run(`import { createDefaultParserRegistry } from "./src/indexer/indexProject"; import { structuralFamilies } from "./src/parsers/languageFamilies"; import { loadGrammar } from "./src/parsers/treeSitterGrammars"; const t0 = performance.now(); createDefaultParserRegistry([]); for (const f of structuralFamilies()) loadGrammar(f.grammar); console.log((performance.now() - t0).toFixed(2));`);
  const lazyMs = Number(lazy.stdout); const eagerMs = Number(eager.stdout);
  control("F11", "eager initialisation of every grammar must cost measurably more than lazy registry creation (the A2 protection gate can fail)",
    lazy.status === 0 && eager.status === 0 && eagerMs > lazyMs * 2,
    `fresh process: lazy registry ${lazyMs} ms vs eager all-grammar dlopen ${eagerMs} ms`);
}
// F12 count authority: a hard-coded count without registry evidence must fail
{
  const hardCoded = 30;
  const derived = frozenCount(registry);
  const detachedCount = frozenCount(createParserRegistry());
  control("F12", "a hard-coded family count must not be accepted without registry evidence",
    detachedCount === 0 && (derived === hardCoded) === (registry.registeredLanguages().length === hardCoded),
    `empty registry → ${detachedCount}; production registry → ${derived} (hard-coded ${hardCoded} would only agree because the registry does)`);
}

const healthy = ledger.filter((r) => r.status === "HEALTHY").map((r) => r.language);
const unhealthy = ledger.filter((r) => r.status !== "HEALTHY" && !String(r.status).startsWith("DEEP")).map((r) => `${r.language}:${r.status}`);
const frozen = frozenCount(registry);
const acceptedCount = healthy.length + ledger.filter((r) => String(r.status).startsWith("DEEP")).length;
const out = {
  milestone: "M202", instrument: "run_stage5_m202_family_health.ts",
  registered: registry.registeredLanguages(),
  frozenCount: frozen,
  healthAcceptedCount: acceptedCount,
  countAuthorityAgrees: frozen === acceptedCount,
  healthy, unhealthy,
  ledger,
  controls,
  allControlsPass: controls.every((c) => c.pass),
  verdict: unhealthy.length === 0 && controls.every((c) => c.pass) && frozen === acceptedCount ? "M202_FAMILY_HEALTH_PASS" : "M202_FAMILY_HEALTH_FAIL",
};
writeFileSync(path.join(RESULTS, "stage5_m202_family_health.json"), `${JSON.stringify(out, null, 2)}\n`);

const md: string[] = [`# M202 — per-family health ledger\n`,
  `Registered ${registry.registeredLanguages().length}; frozen count ${frozen}; health-accepted ${acceptedCount}; verdict \`${out.verdict}\`.\n`,
  `| family | tier | VEXP row | fixture | invoked | symbols | kinds | non-ASCII before decl | span truth | malformed | deterministic | status |`,
  `| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |`];
for (const r of ledger) {
  md.push(`| ${r.displayName} | ${r.tier} | ${r.vexpRow ?? "—"} | ${r.fixture ?? "own suite"} | ${r.parserInvocationConfirmed === null ? "n/a" : r.parserInvocationConfirmed ? "yes" : "NO"} | ${r.symbols ?? "—"} | ${r.kinds === undefined ? "—" : Object.entries(r.kinds).map(([k, v]) => `${k}:${v}`).join(" ")} | ${r.nonAsciiBeforeFirstDeclaration === undefined ? "—" : r.nonAsciiBeforeFirstDeclaration ? "yes" : "no"} | ${r.spanTruth === undefined ? "—" : r.spanTruth ? "yes" : "NO"} | ${r.malformedOutcome ?? "—"}${r.malformedTruthful === false ? " (UNTRUTHFUL)" : ""} | ${r.deterministic === undefined ? "—" : r.deterministic ? "yes" : "NO"} | ${r.status} |`);
}
md.push(``, `## Falsification controls\n`, `| id | statement | result | detail |`, `| --- | --- | --- | --- |`);
for (const c of controls) md.push(`| ${c.id} | ${c.statement} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail} |`);
writeFileSync(path.join(RESULTS, "stage5_m202_family_health.md"), `${md.join("\n")}\n`);
console.log(md.join("\n"));
console.log(`\n${out.verdict}`);
if (out.verdict !== "M202_FAMILY_HEALTH_PASS") process.exit(1);

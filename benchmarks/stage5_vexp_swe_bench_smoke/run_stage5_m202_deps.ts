/**
 * M202 — parser dependency audit (§14, §43).
 *
 * Every grammar the family table declares is inspected ON DISK: pinned version,
 * tree-sitter ABI (`LANGUAGE_VERSION` in the shipped parser.c), whether a
 * binary for this platform is prebuilt or was compiled at install time,
 * licence, and unpacked size. The runtime core's supported ABI window is read
 * from its header, so an incompatible grammar is a generated finding and not a
 * remembered one.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m202_deps.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { LANGUAGE_FAMILIES } from "../../src/parsers/languageFamilies";
import { grammarArtifactStatus } from "../../src/parsers/treeSitterGrammars";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const require = createRequire(import.meta.url);

const rootPackage = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
const pinned: Record<string, string> = rootPackage.dependencies ?? {};

function dirSizeBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); }
      else total += statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

function abiOf(packageDir: string): number | null {
  const candidates: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") walk(full, depth + 1);
      else if (entry.name === "parser.c") candidates.push(full);
    }
  };
  walk(packageDir, 0);
  for (const file of candidates.sort()) {
    const head = readFileSync(file, "utf8").slice(0, 4000);
    const match = /#define LANGUAGE_VERSION (\d+)/u.exec(head);
    if (match !== null) return Number.parseInt(match[1]!, 10);
  }
  return null;
}

const coreHeader = path.join(REPO, "node_modules/tree-sitter/vendor/tree-sitter/lib/include/tree_sitter/api.h");
const coreText = existsSync(coreHeader) ? readFileSync(coreHeader, "utf8") : "";
const coreAbi = Number.parseInt(/#define TREE_SITTER_LANGUAGE_VERSION (\d+)/u.exec(coreText)?.[1] ?? "0", 10);
const coreMinAbi = Number.parseInt(/#define TREE_SITTER_MIN_COMPATIBLE_LANGUAGE_VERSION (\d+)/u.exec(coreText)?.[1] ?? "0", 10);
const corePackage = JSON.parse(readFileSync(path.join(REPO, "node_modules/tree-sitter/package.json"), "utf8"));

const rows = LANGUAGE_FAMILIES.filter((f) => f.grammar !== undefined).map((family) => {
  const grammar = family.grammar!;
  const packageDir = path.dirname(require.resolve(`${grammar.module}/package.json`));
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const abi = abiOf(packageDir);
  const status = grammarArtifactStatus(grammar);
  const prebuiltPlatforms = existsSync(path.join(packageDir, "prebuilds")) ? readdirSync(path.join(packageDir, "prebuilds")).sort() : [];
  return {
    language: family.language,
    displayName: family.displayName,
    module: grammar.module,
    pinnedVersion: pinned[grammar.module] ?? null,
    installedVersion: packageJson.version,
    pinnedExactly: pinned[grammar.module] === packageJson.version,
    license: packageJson.license ?? null,
    declaredLicense: grammar.license,
    abi,
    abiCompatibleWithCore: abi !== null && abi >= coreMinAbi && abi <= coreAbi,
    artifact: grammar.artifact,
    prebuiltPlatforms,
    nativeBuildRequired: grammar.artifact === "compiled",
    artifactAvailable: status.available,
    artifactPath: status.artifactPath === null ? null : path.relative(REPO, status.artifactPath),
    unpackedBytes: dirSizeBytes(packageDir),
  };
});

const out = {
  milestone: "M202",
  instrument: "run_stage5_m202_deps.ts",
  platform: `${process.platform}-${process.arch}`,
  runtime: { bun: Bun.version, nodeCompat: process.versions.node },
  core: { module: "tree-sitter", version: corePackage.version, languageVersion: coreAbi, minCompatibleLanguageVersion: coreMinAbi },
  grammars: rows,
  totals: {
    grammarPackages: rows.length,
    prebuilt: rows.filter((r) => r.artifact === "prebuilt").length,
    compiledAtInstall: rows.filter((r) => r.artifact === "compiled").length,
    unpackedBytes: rows.reduce((a, r) => a + r.unpackedBytes, 0),
    unpackedMiB: +(rows.reduce((a, r) => a + r.unpackedBytes, 0) / 1048576).toFixed(1),
    allPinnedExactly: rows.every((r) => r.pinnedExactly),
    allAbiCompatible: rows.every((r) => r.abiCompatibleWithCore),
    allArtifactsAvailable: rows.every((r) => r.artifactAvailable),
    licenses: Object.fromEntries([...new Set(rows.map((r) => r.license))].map((l) => [String(l), rows.filter((r) => r.license === l).length])),
  },
  blockedFamilies: [
    { vexpRow: "F#", reason: "tree-sitter-fsharp publishes ABI 15 only (0.3.5-0.3.11); core 0.21.1 loads ABI 13-14" },
    { vexpRow: "HCL/Terraform", reason: "@tree-sitter-grammars/tree-sitter-hcl 1.2.0 is ABI 15; no ABI-14 npm release" },
    { vexpRow: "Dockerfile", reason: "no Dockerfile grammar is published on npm (tree-sitter-dockerfile is a security placeholder)" },
  ],
  installTimeCompile: {
    script: "scripts/build_tree_sitter_grammars.ts (package postinstall)",
    toolchain: "node-gyp + C compiler + Node headers; Node-API binaries load under Bun",
    runtimeDownloads: "none: grammars are npm packages resolved at install, never fetched at runtime",
  },
};
const md: string[] = [`# M202 — parser dependency audit\n`,
  `Core: tree-sitter ${out.core.version} (ABI ${coreMinAbi}-${coreAbi}) on ${out.platform}; ${rows.length} grammar packages, `
  + `${out.totals.prebuilt} prebuilt, ${out.totals.compiledAtInstall} compiled at install, ${out.totals.unpackedMiB} MiB unpacked.\n`,
  `| family | package | version | ABI | artifact | licence | MiB | available |`, `| --- | --- | --- | ---: | --- | --- | ---: | --- |`];
for (const r of rows) {
  md.push(`| ${r.displayName} | ${r.module} | ${r.installedVersion}${r.pinnedExactly ? "" : " (NOT PINNED)"} | ${r.abi ?? "?"} | ${r.artifact} | ${r.license} | ${(r.unpackedBytes / 1048576).toFixed(1)} | ${r.artifactAvailable ? "yes" : "NO"} |`);
}
md.push(``, `Blocked VEXP rows: ${out.blockedFamilies.map((b) => `${b.vexpRow} (${b.reason})`).join("; ")}.`);
require("node:fs").writeFileSync(path.join(RESULTS, "stage5_m202_dependency_audit.json"), `${JSON.stringify(out, null, 2)}\n`);
require("node:fs").writeFileSync(path.join(RESULTS, "stage5_m202_dependency_audit.md"), `${md.join("\n")}\n`);
console.log(md.join("\n"));
if (!out.totals.allPinnedExactly || !out.totals.allAbiCompatible || !out.totals.allArtifactsAvailable) process.exit(1);

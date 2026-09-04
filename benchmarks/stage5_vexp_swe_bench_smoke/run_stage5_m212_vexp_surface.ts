/**
 * M212 — what the shipped VEXP MCP bundles actually publish.
 *
 * Reads one or more `vexp-cli` distributions and reports, per version, the
 * default tool catalog, the env-gated remainder, and the node fields the impact
 * renderer is capable of emitting. Nothing is executed: this parses the vendor's
 * shipped JavaScript, so it needs no license, no daemon and no network, and it
 * cannot be confounded by whatever plan this machine happens to be on.
 *
 * That last property is why the audit is built this way. The behavioural probe
 * M212 wanted is licence-blocked here (impact analysis is a paid-plan feature
 * and no `~/.vexp/license.jwt` exists), but the question frozen A15 asks —
 * whether an arbitrary caller arrives with source text naming the callee — is
 * decided by the renderer, and the renderer ships in the clear. A renderer with
 * no source-bearing field cannot emit a call expression on any plan.
 *
 * Control F2: the version is read from each bundle's own package.json and
 * reported. An old bundle is labelled old rather than labelled current.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m212_vexp_surface.ts \
 *     [--bundle <dir>]...
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { extractVexpToolSurface, rendererCanCarrySource } from "./m212VexpSurface";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);

/** Every `--bundle <dir>`, else the two this milestone was run against. */
function requestedBundles(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === "--bundle" && args[i + 1]) out.push(args[i + 1]!);
  return out.length > 0 ? out : [
    "/home/calvin/.npm-global/lib/node_modules/vexp-cli",
    path.join(process.env.M212_VEXP_311 ?? "/tmp/m212/vexp311", "package"),
  ];
}

const IMPACT_TOOL = "get_impact_graph";
const EXPANDER_TOOL = "expand_vexp_ref";

const bundles = requestedBundles().map((dir) => {
  const pkg = path.join(dir, "package.json");
  const server = path.join(dir, "mcp", "mcp-server.cjs");
  if (!existsSync(pkg) || !existsSync(server)) return { dir, status: "BUNDLE_ABSENT" as const };

  const version = JSON.parse(readFileSync(pkg, "utf8")).version ?? null;
  const surface = extractVexpToolSurface(readFileSync(server, "utf8"), version);

  return {
    dir, status: "READ" as const, surface,
    // The three questions this milestone turns on, answered per version.
    impactListedByDefault: surface.defaultListed.includes(IMPACT_TOOL),
    expanderListedByDefault: surface.defaultListed.includes(EXPANDER_TOOL),
    impactRendererCanCarrySource: rendererCanCarrySource(surface.impactNodeFields),
    // Control F1: a V-REF marker in the impact renderer would be the only
    // artifact-level evidence that impact output participates in the compact
    // reference scheme. Generic expander documentation is not that evidence.
    impactParticipatesInVref: surface.vrefMentioningTools.includes(IMPACT_TOOL),
  };
});

const read = bundles.filter((b) => b.status === "READ") as Extract<(typeof bundles)[number], { status: "READ" }>[];

const report = {
  milestone: "M212",
  generatedAt: new Date().toISOString(),
  method: "static read of shipped vexp-cli MCP bundles; no VEXP process was started, no license used, no network call made",
  bundles,
  // Did the impact surface change between the frozen-source version and the
  // newest release? If the renderer's field set is identical, then whatever the
  // engine now computes, the model is still handed the same shape.
  impactRendererFieldsIdenticalAcrossVersions:
    read.length >= 2
    && read.every((b) => b.surface.impactNodeFields !== null)
    && new Set(read.map((b) => (b.surface.impactNodeFields ?? []).join(","))).size === 1,
  versionsRead: read.map((b) => b.surface.version),
};

writeFileSync(path.join(RESULTS, "stage5_m212_vexp_surface.json"), `${JSON.stringify(report, null, 2)}\n`);

for (const b of bundles) {
  if (b.status !== "READ") { console.log(`${b.dir}: ${b.status}`); continue; }
  const s = b.surface;
  console.log(`\nvexp-cli ${s.version}  (${b.dir})`);
  console.log(`  default catalog (${s.defaultListed.length}): ${s.defaultListed.join(", ")}`);
  console.log(`  gated behind ${s.allToolsEnvVar ?? "?"} (${s.gatedOutOfDefault.length}): ${s.gatedOutOfDefault.join(", ")}`);
  console.log(`  impact node fields: ${s.impactNodeFields === null ? "REGION_NOT_LOCATED" : s.impactNodeFields.join(", ")}`);
  console.log(`  ${IMPACT_TOOL} listed by default: ${b.impactListedByDefault}`);
  console.log(`  impact renderer can carry source: ${b.impactRendererCanCarrySource}`);
  console.log(`  impact participates in V-REF: ${b.impactParticipatesInVref}`);
}
console.log(`\nimpact renderer identical across versions read: ${report.impactRendererFieldsIdenticalAcrossVersions}`);
console.log("wrote results/stage5_m212_vexp_surface.json");

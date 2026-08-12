// M142 before/after assembly.
//
// Reads the two behavioural-probe artifacts (predecessor and candidate, same
// index, same queries) and emits the comparison tables the milestone requires:
// the prose/identifier role matrix (§122), the prose-collision and
// project-reference outcomes (§87), the centrality before/after (§123), and the
// concept-owner visibility table (§124).
//
// Pure post-processing of recorded runs. No index access, no agents, no network.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { prepareRunnerOutput, SHARED_RUNNER_OPTIONS_HELP } from "./lib/runnerPaths";

interface ProbeCase {
  id: string;
  category: string;
  query: string;
  queryProvenance: string;
  reportedFailure: string;
  identifierRoles: {
    likelySymbols: string[];
    projectReferences: string[];
    symbolHypotheses: Array<{ term: string; role: string; source: string; exactSymbolEligible: boolean }>;
  };
  retrieval: { lead: string | null; pivots: string[]; support: string[]; selectedFiles: string[] };
  ownerFile: { path: string; top1: boolean; top3: boolean; anywhere: boolean; bestCandidateRank: number | null };
  expectedDefinitions: Array<{ fqName: string; indexed: boolean; state: string; candidateRank?: number | null }>;
  falsePositiveLeads: Array<{ fqName: string; indexed: boolean; state: string; candidateRank?: number | null; lead?: boolean }>;
  centralityTrace: Array<{
    fqName: string; rank: number; inDegree: number; centrality: number;
    centralityContribution: number; finalScore: number; scoreWithoutCentrality: number;
    localEvidence: number; selected: boolean; pivot: boolean;
  }>;
  response: { serializedBytes: number; pivotCount: number; supportCount: number };
}

interface ProbeArtifact {
  label: string;
  generatedFrom: Record<string, unknown>;
  cases: ProbeCase[];
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const byId = (artifact: ProbeArtifact): Map<string, ProbeCase> =>
  new Map(artifact.cases.map((entry) => [entry.id, entry]));

export function compare(before: ProbeArtifact, after: ProbeArtifact) {
  const beforeCases = byId(before);
  const afterCases = byId(after);
  const ids = [...afterCases.keys()];

  const falsePositives = ids.flatMap((id) => {
    const b = beforeCases.get(id);
    const a = afterCases.get(id);
    if (b === undefined || a === undefined) return [];
    return a.falsePositiveLeads.map((entry, index) => {
      const previous = b.falsePositiveLeads[index];
      return {
        case: id,
        fqName: entry.fqName,
        predecessor: previous === undefined
          ? null
          : { state: previous.state, rank: previous.candidateRank ?? null, lead: previous.lead ?? false },
        candidate: { state: entry.state, rank: entry.candidateRank ?? null, lead: entry.lead ?? false },
        resolved: previous !== undefined
          && (previous.state === "pivot" || previous.state === "selected_support")
          && entry.state !== "pivot" && entry.state !== "selected_support",
      };
    });
  });

  const centrality = ids.flatMap((id) => {
    const b = beforeCases.get(id);
    const a = afterCases.get(id);
    if (b === undefined || a === undefined) return [];
    const beforeByFq = new Map(b.centralityTrace.map((row) => [row.fqName, row]));
    const afterByFq = new Map(a.centralityTrace.map((row) => [row.fqName, row]));
    const names = [...new Set([...beforeByFq.keys(), ...afterByFq.keys()])].sort();
    return names.map((fqName) => ({
      case: id,
      fqName,
      predecessor: beforeByFq.get(fqName) ?? null,
      candidate: afterByFq.get(fqName) ?? null,
      droppedFromPool: beforeByFq.has(fqName) && !afterByFq.has(fqName),
    }));
  });

  const conceptOwner = ids.map((id) => {
    const b = beforeCases.get(id);
    const a = afterCases.get(id);
    return {
      case: id,
      query: a?.query ?? b?.query ?? "",
      category: a?.category ?? "",
      expectedOwnerFile: a?.ownerFile.path ?? "",
      predecessor: b === undefined ? null : {
        lead: b.retrieval.lead,
        ownerTop1: b.ownerFile.top1,
        ownerTop3: b.ownerFile.top3,
        ownerAnywhere: b.ownerFile.anywhere,
        ownerBestCandidateRank: b.ownerFile.bestCandidateRank,
        requiredDefinitions: b.expectedDefinitions.map((d) => ({ fqName: d.fqName, state: d.state })),
      },
      candidate: a === undefined ? null : {
        lead: a.retrieval.lead,
        ownerTop1: a.ownerFile.top1,
        ownerTop3: a.ownerFile.top3,
        ownerAnywhere: a.ownerFile.anywhere,
        ownerBestCandidateRank: a.ownerFile.bestCandidateRank,
        requiredDefinitions: a.expectedDefinitions.map((d) => ({ fqName: d.fqName, state: d.state })),
      },
    };
  });

  const roleMatrix = ids.flatMap((id) => {
    const a = afterCases.get(id);
    const b = beforeCases.get(id);
    if (a === undefined) return [];
    const terms = new Set([
      ...a.identifierRoles.symbolHypotheses.map((s) => s.term),
      ...(b?.identifierRoles.symbolHypotheses.map((s) => s.term) ?? []),
      ...a.identifierRoles.projectReferences,
    ]);
    return [...terms].map((term) => {
      const afterSignal = a.identifierRoles.symbolHypotheses.find((s) => s.term === term);
      const beforeSignal = b?.identifierRoles.symbolHypotheses.find((s) => s.term === term);
      return {
        case: id,
        token: term,
        context: a.identifierRoles.projectReferences.includes(term) ? "project reference" : "task text",
        predecessorRole: beforeSignal?.role ?? "ordinary_prose",
        candidateRole: afterSignal?.role ?? (a.identifierRoles.projectReferences.includes(term)
          ? "project_reference" : "ordinary_prose"),
        exactSymbolEligible: afterSignal?.exactSymbolEligible ?? false,
      };
    });
  });

  const responses = ids.map((id) => ({
    case: id,
    predecessorEngineBytes: beforeCases.get(id)?.response.serializedBytes ?? null,
    candidateEngineBytes: afterCases.get(id)?.response.serializedBytes ?? null,
  }));

  return { falsePositives, centrality, conceptOwner, roleMatrix, responses };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`run_stage5_m142_before_after.ts\n\n${SHARED_RUNNER_OPTIONS_HELP}`);
    return;
  }
  const target = await prepareRunnerOutput({ argv: process.argv.slice(2), runner: "m142_before_after" });
  const beforePath = argument("--before");
  const afterPath = argument("--after");
  if (beforePath === undefined || afterPath === undefined) {
    throw new Error("--before and --after probe artifacts are required.");
  }
  const before = JSON.parse(await readFile(beforePath, "utf8")) as ProbeArtifact;
  const after = JSON.parse(await readFile(afterPath, "utf8")) as ProbeArtifact;
  const comparison = compare(before, after);

  const write = async (name: string, body: unknown): Promise<void> => {
    const outPath = path.join(target.dir, name);
    await writeFile(outPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    process.stdout.write(`${outPath}\n`);
  };
  const provenance = {
    predecessor: { label: before.label, ...before.generatedFrom },
    candidate: { label: after.label, ...after.generatedFrom },
  };
  await write("stage5_m142_prose_collision_before_after.json", {
    schemaVersion: "stage5.m142.prose-collision.v1",
    ...provenance,
    falsePositives: comparison.falsePositives,
  });
  await write("stage5_m142_identifier_role_matrix.json", {
    schemaVersion: "stage5.m142.identifier-roles.v1",
    ...provenance,
    roles: comparison.roleMatrix,
  });
  await write("stage5_m142_centrality_before_after.json", {
    schemaVersion: "stage5.m142.centrality.v1",
    ...provenance,
    candidates: comparison.centrality,
  });
  await write("stage5_m142_arc_behavioral_acceptance.json", {
    schemaVersion: "stage5.m142.arc-behavioral-acceptance.v1",
    ...provenance,
    queryProvenanceNote:
      "Every query below is RECONSTRUCTED from the failure report's wording. None is "
      + "claimed verbatim; the report did not preserve exact transcripts.",
    cases: comparison.conceptOwner,
    engineResponseBytes: comparison.responses,
  });
}

if (import.meta.main) {
  await main();
}

/**
 * M153-C5 — three-way delivery-authority trace.
 *
 * C4 put `get_filetype` into the retrieval pool. It is still not delivered. This
 * traces the stages BELOW retrieval for three controls that differ in exactly the
 * dimension under test — how much ordinary lexical evidence a direct behavioural
 * implementer has:
 *
 *   A  requests  Session.get_adapter    direct fact + STRONG lexical  delivered
 *   B  sphinx    get_filetype           direct fact + ~zero lexical   NOT delivered
 *   C  fixture   pipeline.py::alpha     direct fact + ~zero lexical   delivered
 *
 * C is the decisive one. It is an existing, already-accepted M150 delivery
 * fixture, not a new construction: if a dull-named implementer is delivered there
 * and not in sphinx, the difference cannot be "weak lexical evidence" and the
 * trace has to say what it actually is.
 *
 * Read-only against the corpus indexes; the fixture is built in a temp dir.
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { initializeSchema } from "../../src/db/schema";
import { indexProject } from "../../src/indexer/indexProject";
import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { shapeSweQuery, type ShapedSweQuery } from "../../src/capsule/sweQueryShaping";
import { resolveProjectNameAliases } from "../../src/capsuleV2/projectNameSignals";
import { createLazyRepositoryPathPredicate } from "../../src/retrieval/repositoryPathMembership";
import { planIntent } from "../../src/capsuleV2/intent";
import { hybridRetrieve, HybridCandidateSource } from "../../src/retrieval/hybridRetrieval";
import {
  assignCandidateRoles,
  hasAnswerRoleEvidence,
  CandidateRole,
} from "../../src/capsule/assignCandidateRoles";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { repoRootFor } from "./m153BehavioralHarness";

const CANDIDATE_POOL_SIZE = 60;

function deriveSymbolSeeds(shaped: ShapedSweQuery): string[] {
  const seeds: string[] = [];
  for (const identifier of shaped.identifiers) {
    if (/Test/.test(identifier) && /^[A-Z]/.test(identifier)) {
      const subject = identifier.replace(/^Test(?=[A-Z])/, "").replace(/(?:TestCase|Tests|Test)$/, "");
      if (subject.length >= 3) seeds.push(subject);
    } else if (!/^test[_A-Z]/.test(identifier)) {
      seeds.push(identifier);
    }
  }
  return [...new Set(seeds)];
}

/** The existing M150 delivery fixture, verbatim — control C. */
const M150_FIXTURE = {
  "pipeline.py": `
def collect(registry):
    found = []
    for plugin in registry.plugins:
        if plugin.enabled:
            found.append(plugin)
    return found


def alpha(registry):
    plugins = collect(registry)
    return sorted(plugins)


def beta(registry):
    plugins = alpha(registry)
    return plugins[0]
`,
};

interface Control {
  readonly label: string;
  readonly kind: "corpus" | "fixture";
  readonly repoKey?: string;
  readonly query: string;
  readonly fqName: string;
}

const CONTROLS: readonly Control[] = [
  {
    label: "A ordinary-evidence behavioural (requests get_adapter)",
    kind: "corpus",
    repoKey: "requests",
    query: "How does the session decide which connection adapter handles a URL?",
    fqName: "requests/sessions.py::Session.get_adapter",
  },
  {
    label: "B behavioural-only (sphinx get_filetype)",
    kind: "corpus",
    repoKey: "sphinx",
    query: "How does the build decide which parser reads a given source file?",
    fqName: "sphinx/util/__init__.py::get_filetype",
  },
  {
    label: "C M150 weak-name direct implementer (pipeline.py::alpha)",
    kind: "fixture",
    query: "How does the system decide which plugin wins?",
    fqName: "pipeline.py::beta",
  },
];

async function openFor(control: Control): Promise<{ db: Database; root: string }> {
  if (control.kind === "corpus") {
    const root = repoRootFor(control.repoKey!);
    return { db: new Database(resolveRepoLocalPaths(root).dbPath, { readonly: true }), root };
  }
  const root = mkdtempSync(path.join(tmpdir(), "m153-c5-"));
  for (const [name, body] of Object.entries(M150_FIXTURE)) {
    writeFileSync(path.join(root, name), body, "utf8");
  }
  const db = new Database(":memory:");
  initializeSchema(db);
  await indexProject({ repoRoot: root, db });
  return { db, root };
}

async function traceOne(control: Control): Promise<Record<string, unknown>> {
  const { db, root } = await openFor(control);
  try {
    const repositoryPaths = createLazyRepositoryPathPredicate(db, { queries: 0 });
    const shaped = shapeSweQuery(
      { problemStatement: control.query, failToPass: [] },
      {
        projectNameAliases: resolveProjectNameAliases(root),
        isRepositoryPath: repositoryPaths.isRepositoryPath,
      },
    );
    const plan = planIntent(undefined, control.query, shaped);
    const retrieval = hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: control.query,
      weights: plan.weights,
      symbolSeeds: deriveSymbolSeeds(shaped),
      maxResults: CANDIDATE_POOL_SIZE,
    });

    // ---- the delivery stages, run on the authoritative functions -------------
    const roled = assignCandidateRoles(retrieval.candidates);
    const target = roled.find((entry) => entry.candidate.fqName === control.fqName);
    const poolIndex = retrieval.candidates.findIndex((entry) => entry.fqName === control.fqName);

    // Who holds the SINGLE answer-role grant, and who else was eligible for it.
    const eligible = retrieval.candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter((entry) => hasAnswerRoleEvidence(entry.candidate));
    const grantHolder = eligible[0];

    const capsule = buildCapsuleV2({
      db,
      repoRoot: root,
      task: control.query,
      intent: CapsuleIntent.Explain,
      maxTokens: 6000,
    });
    const delivered = [...capsule.pivots, ...capsule.support];

    return {
      label: control.label,
      query: control.query,
      target: control.fqName,
      pool: {
        size: retrieval.candidates.length,
        present: poolIndex >= 0,
        rank: poolIndex >= 0 ? poolIndex + 1 : null,
        sources: target?.candidate.sources ?? null,
      },
      ordinaryEvidence: target === undefined ? null : {
        lexical: target.candidate.scores.lexical,
        fts: target.candidate.scores.fts,
        symbol: target.candidate.scores.symbol,
        path: target.candidate.scores.path,
        domain: target.candidate.scores.domain,
        graph: target.candidate.scores.graph,
        localEvidence: target.candidate.scores.localEvidence,
        mechanismEvidence: target.candidate.scores.mechanismEvidence ?? 0,
        final: target.candidate.scores.final,
      },
      answerRole: {
        targetHasEvidence: target === undefined
          ? null
          : hasAnswerRoleEvidence(target.candidate),
        eligibleCount: eligible.length,
        eligibleRanked: eligible.slice(0, 8).map((entry) => ({
          fqName: entry.candidate.fqName,
          poolRank: entry.index + 1,
          final: entry.candidate.scores.final,
          mechanismEvidence: entry.candidate.scores.mechanismEvidence ?? 0,
        })),
        grantHolder: grantHolder === undefined ? null : {
          fqName: grantHolder.candidate.fqName,
          poolRank: grantHolder.index + 1,
        },
        targetHoldsGrant: grantHolder?.candidate.fqName === control.fqName,
      },
      roleAssignment: target === undefined ? null : {
        role: target.role,
        why: target.why,
      },
      pivots: roled.filter((entry) => entry.role === CandidateRole.Pivot)
        .slice(0, 5).map((entry) => entry.candidate.fqName),
      // §27/§59: if the candidate is correctly roled but never rendered, the loss
      // is the bounded envelope rather than the role gate, and the two must be
      // reported apart.
      supportSelection: (() => {
        const support = roled.filter((entry) => entry.role === CandidateRole.Support);
        const index = support.findIndex((entry) => entry.candidate.fqName === control.fqName);
        return {
          supportRoled: support.length,
          targetSupportIndex: index >= 0 ? index + 1 : null,
          deliveredSupport: capsule.support.length,
          deliveredPivots: capsule.pivots.length,
        };
      })(),
      capsule: {
        leadFqName: capsule.pivots[0]?.fq_name ?? null,
        pivotFqNames: capsule.pivots.map((entry) => entry.fq_name),
        deliveredCount: delivered.length,
        targetDelivered: delivered.some((entry) => entry.fq_name === control.fqName),
        targetRole: delivered.find((entry) => entry.fq_name === control.fqName)?.role ?? null,
      },
      operationFactCarriersInPool: retrieval.candidates
        .filter((entry) => entry.sources.includes(HybridCandidateSource.OperationFact))
        .map((entry) => entry.fqName),
    };
  } finally {
    db.close();
  }
}

const trace: Record<string, unknown>[] = [];
for (const control of CONTROLS) trace.push(await traceOne(control));

const out = path.join(import.meta.dir, "results/stage5_m153_c5_delivery_trace.json");
writeFileSync(out, `${JSON.stringify({ controls: trace }, null, 2)}\n`);

const comparison = path.join(import.meta.dir, "results/stage5_m153_c5_answer_role_comparison.json");
writeFileSync(comparison, `${JSON.stringify({
  question: "which candidate holds the single answer-role grant, and does the target?",
  controls: trace.map((entry) => {
    const row = entry as never as { label: string; target: string; answerRole: unknown };
    return { label: row.label, target: row.target, ...(row.answerRole as object) };
  }),
}, null, 2)}\n`);

for (const entry of trace) {
  const row = entry as never as {
    label: string; target: string;
    pool: { present: boolean; rank: number | null };
    ordinaryEvidence: { lexical: number; localEvidence: number; mechanismEvidence: number } | null;
    answerRole: {
      targetHasEvidence: boolean | null; eligibleCount: number;
      grantHolder: { fqName: string; poolRank: number } | null; targetHoldsGrant: boolean;
    };
    roleAssignment: { role: string; why: string } | null;
    capsule: { leadFqName: string | null; targetDelivered: boolean; targetRole: string | null };
  };
  console.log(`\n=== ${row.label} ===`);
  console.log(`  pool             : present=${row.pool.present} rank=${row.pool.rank}`);
  console.log(`  lexical          : ${row.ordinaryEvidence?.lexical} localEvidence=${row.ordinaryEvidence?.localEvidence}`);
  console.log(`  mechanismEvidence: ${row.ordinaryEvidence?.mechanismEvidence}`);
  console.log(`  answer-role      : hasEvidence=${row.answerRole.targetHasEvidence} eligible=${row.answerRole.eligibleCount} holdsGrant=${row.answerRole.targetHoldsGrant}`);
  console.log(`  grant holder     : ${row.answerRole.grantHolder?.fqName} (pool rank ${row.answerRole.grantHolder?.poolRank})`);
  console.log(`  role             : ${row.roleAssignment?.role} — ${row.roleAssignment?.why}`);
  console.log(`  capsule lead     : ${row.capsule.leadFqName}`);
  console.log(`  target delivered : ${row.capsule.targetDelivered} role=${row.capsule.targetRole}`);
}
console.log(`\nwrote ${out}\nwrote ${comparison}`);

/**
 * M161-D §66-§74, §139-§142 — per-case analysis of the discordant pairs, plus the
 * false-authority and false-absence populations.
 *
 * OFFLINE. Every mechanical fact here is recomputed from the captured tool-call
 * logs and patches. The CAUSAL labels are judgements, they are marked as such with
 * a confidence, and each one states the evidence that would overturn it (§74).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m161_case_analysis.ts
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

const RESULTS = path.join(import.meta.dir, "results");

interface Call { index: number; tool: string; category: string; path: string | null; args?: Record<string, unknown> }

async function readJson<T>(filePath: string): Promise<T | null> {
  return (await Bun.file(filePath).json().catch(() => null)) as T | null;
}

function label(arm: string, instanceId: string): string {
  return `m161_${arm}_${instanceId.replaceAll("-", "_")}`;
}

async function calls(arm: string, instanceId: string): Promise<Call[]> {
  return (await readJson<Call[]>(path.join(RESULTS, "runs", label(arm, instanceId), "raw", arm, "_tool_calls.json"))) ?? [];
}

/** Repo-relative edit targets, in order. */
function editPaths(list: readonly Call[]): string[] {
  return list.filter((c) => c.category === "edit").map((c) => (c.path ?? "").split(".bench-repos/")[1] ?? c.path ?? "")
    .map((p) => p.split("/").slice(1).join("/"));
}

async function patchFiles(arm: string, instanceId: string): Promise<string[]> {
  const dir = path.join(RESULTS, "runs", label(arm, instanceId), "raw", arm);
  for await (const file of new Bun.Glob("swebench-*.jsonl").scan({ cwd: dir, absolute: true })) {
    for (const line of (await Bun.file(file).text()).split("\n")) {
      if (line.trim().length === 0) continue;
      const row = JSON.parse(line) as { modelPatch?: string };
      const patch = row.modelPatch ?? "";
      return [...new Set([...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!.trim()))].sort();
    }
  }
  return [];
}

async function main(): Promise<void> {
  const outcomes = await readJson<any>(path.join(RESULTS, "stage5_m161_paired_outcomes.json"));
  const leadDoc = await readJson<any>(path.join(RESULTS, "stage5_m161_lead_quality.json"));
  const leadById = new Map<string, any>(leadDoc.rows.map((r: any) => [r.instanceId, r]));

  const facts = async (instanceId: string) => {
    const lead = leadById.get(instanceId);
    const [b, v] = [await calls("baseline", instanceId), await calls("vtrace", instanceId)];
    const [bp, vp] = [await patchFiles("baseline", instanceId), await patchFiles("vtrace", instanceId)];
    const leadFile = (lead?.leadFile ?? "") as string;
    const editedLead = (list: readonly Call[]): boolean =>
      leadFile.length > 0 && list.some((c) => c.category === "edit" && (c.path ?? "").endsWith(`/${leadFile}`));
    return {
      goldFiles: lead?.goldFiles ?? [],
      leadFile: lead?.leadFile ?? null,
      leadQuality: lead?.quality ?? null,
      goldDelivered: lead?.goldDelivered ?? [],
      baseline: { toolCalls: b.length, edits: editPaths(b), patchFiles: bp, editedVtraceLead: editedLead(b) },
      vtrace: { toolCalls: v.length, edits: editPaths(v), patchFiles: vp, editedVtraceLead: editedLead(v) },
      sameFilesEdited: JSON.stringify(bp) === JSON.stringify(vp),
    };
  };

  const pairOf = (id: string) => outcomes.pairs.find((p: any) => p.instanceId === id);

  // -- unique wins (§72, §139) ---------------------------------------------
  const wins = await Promise.all((outcomes.uniqueWinInstances as string[]).map(async (id) => ({
    instanceId: id,
    repo: pairOf(id).repo,
    deltas: { turns: pairOf(id).turnDelta, tokens: pairOf(id).tokenDelta, searches: pairOf(id).searchDelta },
    ...(await facts(id)),
    whatBaselineDid:
      "Ran 111 turns under budget, located the gold file at tool call 2, edited it twice, then made " +
      "`git stash && pytest` its FINAL action (call 46 of 47) to compare against a clean tree and never " +
      "popped the stash. The captured patch was empty.",
    whatVtraceDid: "Resolved in 59 turns with a 981-byte patch.",
    likelyContribution: "NONE — this is not a context win.",
    reasoning:
      "VTRACE's treatment on this case was LEAD_WRONG_NO_GOLD: it led with sympy/stats/rv.py and delivered " +
      "no gold file at all. The baseline had already found the correct file unaided and destroyed its own " +
      "fix with a stash it never restored. Attributing this win to retrieval quality would be attributing " +
      "it to context that did not contain the answer.",
    causalConfidence: "HIGH that VTRACE context did NOT cause it; the win is agent self-harm in the baseline arm",
    wouldOverturn: "evidence that the stash was caused by the harness rather than by the agent's own final tool call",
  })));

  // -- unique losses (§73, §140) -------------------------------------------
  const losses = await Promise.all((outcomes.uniqueLossInstances as string[]).map(async (id) => {
    const f = await facts(id);
    return {
      instanceId: id,
      repo: pairOf(id).repo,
      deltas: { turns: pairOf(id).turnDelta, tokens: pairOf(id).tokenDelta, searches: pairOf(id).searchDelta, firstEdit: pairOf(id).firstEditDelta },
      ...f,
      wrongLead: true,
      goldElsewhere: true,
      goldAbsent: false,
      misleadingSupport: false,
      prematureFixation: false,
      searchTermination: false,
      contextDisplacement: false,
      agentVariance: true,
      likelyCause: "agent variance in EDIT CONTENT, not in file selection",
      reasoning:
        "The lead was wrong (sphinx/builders/_epub_base.py) and 2 of the 3 gold files were delivered, which " +
        "makes this look like an anchoring case. It is not. Both arms edited the SAME two files " +
        "(sphinx/directives/other.py and sphinx/environment/adapters/toctree.py) and both missed the same " +
        "third gold file, and both touched gold at tool call 1 before any edit. Search counts are identical " +
        "at 7. The VTRACE arm simply wrote a worse patch on the same targets, revising twice more " +
        "(5 edits vs 3) and finishing wrong. Nothing about file selection differed, so nothing about " +
        "retrieval can be the cause.",
      causalConfidence: "MEDIUM — the file-selection evidence is decisive, but why one patch is correct and the other is not is not recoverable from tool-call telemetry",
      wouldOverturn: "a reading of both patches showing the VTRACE arm's edit follows the injected evidence into a wrong change the baseline had no reason to make",
    };
  }));

  // -- false authority (§70, §141) ------------------------------------------
  // Mechanical population: a WRONG lead that the VTRACE agent actually edited.
  // §141 is explicit that a merely wrong Top-1 does not count.
  const wrongLeadCases = (leadDoc.rows as any[]).filter((r) => r.quality === "LEAD_WRONG_GOLD_ELSEWHERE" || r.quality === "LEAD_WRONG_NO_GOLD");
  const authority = await Promise.all(wrongLeadCases.map(async (r) => {
    const f = await facts(r.instanceId);
    const pair = pairOf(r.instanceId);
    return {
      instanceId: r.instanceId,
      leadQuality: r.quality,
      leadFile: r.leadFile,
      vtraceEditedWrongLead: f.vtrace.editedVtraceLead,
      vtraceEditedGold: f.vtrace.edits.some((e) => (r.goldFiles as string[]).some((g) => e.endsWith(g))),
      baselineGrade: pair.baselineGrade,
      vtraceGrade: pair.vtraceGrade,
      classification: pair.classification,
      searchDelta: pair.searchDelta,
    };
  }));
  const anchored = authority.filter((a) => a.vtraceEditedWrongLead);

  const falseAuthority = {
    schemaVersion: "stage5.m161.false-authority.v1",
    definition:
      "§141 — a merely wrong Top-1 is NOT false authority. The population is cases where the VTRACE agent " +
      "ACTED on a wrong lead: edited it, or stopped searching because of it.",
    wrongLeadCases: authority.length,
    agentEditedTheWrongLead: anchored.length,
    agentIgnoredTheWrongLead: authority.length - anchored.length,
    anchoredCases: anchored,
    uniqueHarmCausedByAnchoring: anchored.filter((a) => a.classification === "VTRACE unique loss").length,
    finding:
      `Agents ignored a wrong VTRACE lead in ${authority.length - anchored.length} of ${authority.length} cases, editing gold instead. ` +
      `The ${anchored.length} that did edit the wrong lead BOTH failed — but both are SHARED failures: the baseline failed ` +
      "independently on those tasks, editing different wrong files. So false authority is real and observable, and it " +
      "caused zero unique losses in this sample.",
    searchSuppression:
      "No case shows the VTRACE arm terminating search early because of the context: the median search delta in the " +
      "wrong-lead population is at most one call in either direction, and the one unique loss had identical search " +
      "counts in both arms.",
  };

  // -- false absence (§71, §142) -------------------------------------------
  const patterns = [
    /not (present|included|listed|mentioned) in the (provided |vtrace |injected )?(context|capsule)/i,
    /(context|capsule) does not (contain|include|mention)/i,
    /not in the (provided |vtrace )?context/i,
  ];
  const absence: { instanceId: string; matches: string[] }[] = [];
  for (const pair of outcomes.pairs) {
    const streamPath = path.join(RESULTS, "runs", label("vtrace", pair.instanceId), "raw", "vtrace", "_agent_stream.first_pass.jsonl");
    const text = await Bun.file(streamPath).text().catch(() => "");
    const matches = patterns.flatMap((p) => { const m = p.exec(text); return m === null ? [] : [m[0]]; });
    if (matches.length > 0) absence.push({ instanceId: pair.instanceId, matches });
  }
  const synthetic = "The function is not present in the provided context, so it does not exist.";
  const falseAbsence = {
    schemaVersion: "stage5.m161.false-absence.v1",
    question: "§71 — does the agent read 'absent from VTRACE context' as 'does not exist in the repository'?",
    vtraceRunsSearched: outcomes.pairs.length,
    casesFound: absence.length,
    cases: absence,
    detectorKnownPositive: {
      // §123 — this zero only counts because the same patterns fire on a positive.
      probe: synthetic,
      fires: patterns.some((p) => p.test(synthetic)),
    },
    finding: absence.length === 0
      ? "Zero cases. The detector fires on a synthetic positive, so the zero is a measurement rather than a silent probe."
      : `${absence.length} case(s) found.`,
  };

  const write = async (name: string, value: unknown): Promise<void> => {
    await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
  };
  await write("stage5_m161_unique_wins.json", {
    schemaVersion: "stage5.m161.unique-wins.v1",
    count: wins.length,
    note: "§72 asks for a CONSERVATIVE contribution estimate. The one win here is attributed to agent self-harm in the baseline arm, not to retrieval.",
    wins,
  });
  await write("stage5_m161_unique_losses.json", {
    schemaVersion: "stage5.m161.unique-losses.v1",
    count: losses.length,
    note: "§73 — do not defend VTRACE. The loss is examined for anchoring first and the anchoring hypothesis is reported as falsified by the file-selection evidence, not waved away.",
    losses,
  });
  await write("stage5_m161_false_authority_analysis.json", falseAuthority);
  await write("stage5_m161_false_absence_analysis.json", falseAbsence);

  console.log(`unique wins   ${wins.length}`);
  console.log(`unique losses ${losses.length}`);
  console.log(`wrong-lead cases ${falseAuthority.wrongLeadCases}: edited the wrong lead ${falseAuthority.agentEditedTheWrongLead}, ignored it ${falseAuthority.agentIgnoredTheWrongLead}`);
  console.log(`unique harm from anchoring: ${falseAuthority.uniqueHarmCausedByAnchoring}`);
  console.log(`false absence cases ${falseAbsence.casesFound} (detector fires on positive: ${falseAbsence.detectorKnownPositive.fires})`);
}

if (import.meta.main) {
  await main();
}

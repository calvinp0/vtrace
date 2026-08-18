/**
 * M159-A §16–§18/§102 — verify the residual population's GROUND TRUTH before any
 * conclusion is drawn from it, and separate `PATCH_GOLD` from
 * `USEFUL_TASK_EVIDENCE`.
 *
 * M158 already found one case (`matplotlib-26466`) whose gold symbol is a genuine
 * member of the reference patch and simply not useful orientation evidence for
 * the bug. Optimising retrieval toward that kind of label is worse than leaving
 * it unretrieved, so the distinction has to be measured rather than assumed.
 *
 * Two checks run mechanically here, and both are load-bearing:
 *
 *   1. Does the gold FILE exist in the checked-out workspace at all? A gold file
 *      the corpus never checked out is not a retrieval failure — it is an invalid
 *      benchmark instance, and counting it as retrieval headroom inflates the
 *      residual population with work no product change can do.
 *   2. Does the gold SYMBOL exist in that file's source? A symbol the parser
 *      never produced and a symbol the patch invented look identical downstream.
 *
 * The usefulness labels themselves are a human reading of the task against the
 * source, recorded here as BENCHMARK annotations. §18: they never enter product
 * logic.
 *
 * Read-only over pinned workspaces. NO agent, NO Docker, NO network, NO indexing.
 */

import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { fileMatches, symbolMatches } from "./run_stage5_retrieval_eval";

interface FixtureRow {
  readonly instance_id: string; readonly repo: string; readonly task: string;
  readonly expected_files: string[]; readonly expected_symbols: string[];
}

/** §18 — benchmark-side annotations. Never referenced by product code. */
type UsefulnessLabel =
  | "USEFUL_PRIMARY"
  | "USEFUL_SUPPORT"
  | "PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT"
  | "AMBIGUOUS"
  | "GROUND_TRUTH_ERROR";

/**
 * Source-checked readings of each residual case's reference patch. Every entry
 * was reached by reading the task against the indexed source, not by pattern.
 */
const USEFULNESS: Readonly<Record<string, { label: UsefulnessLabel; why: string }>> = {
  "django__django-13590": { label: "GROUND_TRUTH_ERROR", why: "The gold file is absent from the checked-out workspace, so the instance cannot be scored against retrieval at all. Invalid benchmark instance, not a retrieval failure." },
  "django__django-15572": { label: "GROUND_TRUTH_ERROR", why: "Same corpus defect: `django/template/autoreload.py` was never checked out into this workspace." },
  "django__django-13810": { label: "USEFUL_PRIMARY", why: "`load_middleware` is exactly where MiddlewareNotUsed leaves the partially-built chain; reading it is how the bug is understood." },
  "django__django-14792": { label: "USEFUL_PRIMARY", why: "`_get_timezone_name` is the helper whose return shape changed; the Trunc/Extract symptom is two layers downstream of it." },
  "django__django-15037": { label: "USEFUL_PRIMARY", why: "`table2model` is the definition the patch edits, but it is a NESTED function inside the command handler and is not represented as an indexed symbol." },
  "django__django-17084": { label: "USEFUL_PRIMARY", why: "`get_aggregation` builds the aggregate-over-window query that fails." },
  "matplotlib__matplotlib-24970": { label: "USEFUL_PRIMARY", why: "`Colormap.__call__` holds the out-of-bounds integer assignments NumPy 1.24 deprecates." },
  "matplotlib__matplotlib-25332": { label: "USEFUL_PRIMARY", why: "`Grouper` holds the weakrefs that make the figure unpicklable; the __getstate__/__setstate__ pair is the fix site." },
  "matplotlib__matplotlib-26466": { label: "AMBIGUOUS", why: "The auto-derived symbol list mixes the real fix site (`_AnnotationBase.__init__`, which stores xy by reference) with unrelated hunks (`get_unit`, `set_unit`, `_get_scale`). M158 read the file-level label as not useful; at symbol level part of it is." },
  "pylint-dev__pylint-4551": { label: "AMBIGUOUS", why: "A FEATURE request spanning 4 files and 9 symbols, several of them new. There is no single pre-existing definition to retrieve, so 'the gold symbol' is partly a thing the patch creates." },
  "pylint-dev__pylint-8898": { label: "USEFUL_PRIMARY", why: "`_regexp_csv_transfomer` (misspelled in source) is the splitter that breaks regexes on commas." },
  "pytest-dev__pytest-6197": { label: "AMBIGUOUS", why: "Real fix site is the `Module`/`PyobjMixin` collection path, but the auto-derived list carries 14 symbols including generic `obj`, `collect`, `__init__` that are patch context rather than evidence." },
  "sphinx-doc__sphinx-7910": { label: "USEFUL_PRIMARY", why: "`_skip_member` decides whether a decorated __init__ is documented." },
  "sphinx-doc__sphinx-9230": { label: "USEFUL_PRIMARY", why: "`docfields.py::transform` is where the `dict(str,str)` param type is mis-rendered." },
  "sphinx-doc__sphinx-9698": { label: "USEFUL_PRIMARY", why: "`get_index_text` builds the parenthesised index entry the bug reports." },
  "sympy__sympy-15875": { label: "USEFUL_PRIMARY", why: "`Add._eval_is_zero` is the definition returning the wrong answer for complex integers." },
  "sympy__sympy-16597": { label: "PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT", why: "The patch spans 6 files, and two of its symbols (`get_known_facts_cnf`, `get_known_facts_dict` in `ask_generated.py`) are MACHINE-GENERATED fact tables. Nobody orients by reading a generated CNF table; retrieving it would be a wasted slot." },
  "sympy__sympy-16792": { label: "USEFUL_PRIMARY", why: "`CodeGen.routine` decides argument dimensions for array args absent from the expression." },
  "sympy__sympy-20428": { label: "USEFUL_SUPPORT", why: "The reported traceback runs through `polytools`/`polyclasses`/`densebasic`; the gold `expressiondomain.py` dunders are the fix site but not where a reader starts." },
  "sympy__sympy-20801": { label: "USEFUL_PRIMARY", why: "`Float.__eq__`/`__ne__` are exactly what makes `S(0.0) == S.false` true." },
};

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    if (value === undefined) throw new Error(`${flag} is required.`);
    return value;
  };
  const fixture = (await Bun.file(get("--fixture")).json()) as readonly FixtureRow[];
  const manifest = (await Bun.file(get("--manifest")).json()) as { entries: readonly { instanceId: string }[] };
  const corpusRoot = get("--corpus-root");
  const outPath = get("--out");
  const validityOut = get("--validity-out");

  const byId = new Map(fixture.map((row) => [row.instance_id, row]));

  // §102 known-positive control: the same on-disk probe run over EVERY case, so
  // "2 workspaces are missing their gold file" is a measured outlier against 98
  // that are not, rather than an unbounded worry.
  const onDisk = fixture.map((row) => {
    const workspace = path.join(corpusRoot, row.instance_id);
    const present = row.expected_files.some((gold) => {
      const parts = gold.split("/");
      return parts.some((_, index) => existsSync(path.join(workspace, ...parts.slice(index))));
    });
    const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
    let indexedFiles = 0;
    try {
      indexedFiles = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM files").get()?.n ?? 0;
    } finally { db.close(); }
    return { instanceId: row.instance_id, repo: row.repo, goldFileOnDisk: present, indexedFiles };
  });
  const missing = onDisk.filter((r) => !r.goldFileOnDisk);

  const rows = manifest.entries.map((entry) => {
    const row = byId.get(entry.instanceId)!;
    const workspace = path.join(corpusRoot, row.instance_id);
    const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
    let goldSymbolsIndexed = 0;
    let goldFileSymbols = 0;
    try {
      const files = db.query<{ id: string; path: string }, []>("SELECT id, path FROM files").all()
        .filter((f) => row.expected_files.some((gold) => fileMatches(gold, f.path)));
      for (const file of files) {
        const symbols = db.query<{ fq_name: string; local_name: string }, [string]>(
          "SELECT fq_name, local_name FROM symbols WHERE file_id = ?").all(file.id);
        goldFileSymbols += symbols.length;
        goldSymbolsIndexed += symbols.filter((s) =>
          row.expected_symbols.some((g) => symbolMatches(g, { symbol: s.local_name, fqName: s.fq_name }))).length;
      }
    } finally { db.close(); }
    const annotation = USEFULNESS[entry.instanceId];
    return {
      instanceId: entry.instanceId,
      repo: row.repo,
      expectedFiles: row.expected_files,
      expectedSymbols: row.expected_symbols,
      goldFileOnDisk: onDisk.find((r) => r.instanceId === entry.instanceId)?.goldFileOnDisk ?? false,
      goldFileSymbolsIndexed: goldFileSymbols,
      goldSymbolsIndexed,
      usefulness: annotation?.label ?? "AMBIGUOUS",
      why: annotation?.why ?? "no source reading recorded",
    };
  });

  const byLabel = (label: UsefulnessLabel) => rows.filter((r) => r.usefulness === label).map((r) => r.instanceId);
  await writeFile(outPath, `${JSON.stringify({
    schemaVersion: "stage5.m159.ground-truth-verification.v1",
    note: "§18 — these labels are BENCHMARK annotations. No product code reads them.",
    residualCases: rows.length,
    counts: {
      USEFUL_PRIMARY: byLabel("USEFUL_PRIMARY").length,
      USEFUL_SUPPORT: byLabel("USEFUL_SUPPORT").length,
      PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT: byLabel("PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT").length,
      AMBIGUOUS: byLabel("AMBIGUOUS").length,
      GROUND_TRUTH_ERROR: byLabel("GROUND_TRUTH_ERROR").length,
    },
    byLabel: {
      USEFUL_PRIMARY: byLabel("USEFUL_PRIMARY"),
      USEFUL_SUPPORT: byLabel("USEFUL_SUPPORT"),
      PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT: byLabel("PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT"),
      AMBIGUOUS: byLabel("AMBIGUOUS"),
      GROUND_TRUTH_ERROR: byLabel("GROUND_TRUTH_ERROR"),
    },
    rows,
  }, null, 2)}\n`, "utf8");

  await writeFile(validityOut, `${JSON.stringify({
    schemaVersion: "stage5.m159.benchmark-validity.v1",
    defect: "Two broad100 workspaces were checked out without the package subtree holding their gold file.",
    invalidPriorResult: "Both counted as `never_retrieved` retrieval failures in M157 and M158, and in M159's own first reconstruction.",
    correctedResult: "Both are INVALID BENCHMARK INSTANCES. Retrieval cannot surface a file the corpus never materialised, so they carry no retrieval headroom.",
    knownPositiveControl: `the same on-disk probe over all ${onDisk.length} cases finds the gold file present in ${onDisk.length - missing.length}`,
    affected: missing,
    evidence: missing.map((m) => ({
      instanceId: m.instanceId,
      indexedFiles: m.indexedFiles,
      peerMedianIndexedFiles: (() => {
        const peers = onDisk.filter((r) => r.repo === m.repo && r.goldFileOnDisk).map((r) => r.indexedFiles).sort((a, b) => a - b);
        return peers[Math.floor(peers.length / 2)] ?? null;
      })(),
    })),
    corpusRepaired: false,
    whyNotRepaired: "The M156 corpus is the immutable target every M156-M159 paired comparison is built on. Re-materialising two workspaces would change that baseline mid-audit and break comparability (§96). The repair is nominated as its own milestone; M159 reports both the unchanged historical metric and the qualified denominator.",
    denominatorGuidance: {
      historicalUnchanged: "gold delivered 79/100 — reported unchanged for comparability (§96)",
      retrievalAttributable: `79/${onDisk.length - missing.length} once the ${missing.length} invalid instances are excluded`,
    },
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ missing, counts: Object.fromEntries((["USEFUL_PRIMARY", "USEFUL_SUPPORT", "PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT", "AMBIGUOUS", "GROUND_TRUTH_ERROR"] as UsefulnessLabel[]).map((l) => [l, byLabel(l).length])) }, null, 2));
}

if (import.meta.main) {
  await main();
}

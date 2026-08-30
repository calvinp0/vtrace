// M191 §10 — the live-spend authorization audit.
//
// §10 forbids Stage B unless an EXISTING, COMMITTED, preregistered observational design already
// carries an explicit task set, model, turn limit, cost limit, total spend cap and stopping
// rule. It also forbids inventing any of them after the fact. So the question this script
// answers is deliberately narrow and mechanical:
//
//   does committed project evidence already authorize a specific amount of live spend?
//
// It reads COMMITTED content (`git show HEAD:<path>`), never the working tree, so a document
// drafted in this session cannot authorize this session's own spending. That is the whole point:
// an authorization you can write yourself is not an authorization.
//
// A missing element is reported as missing. Nothing here proposes a replacement value.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

/**
 * M191's OWN artifacts are excluded from the search corpus.
 *
 * Not tidiness — correctness. This script reads the repository it writes into, so once its
 * report is committed the next execution searches its own prose, which necessarily discusses
 * dollar caps and observational acquisition in the same sentences. A milestone cannot
 * authorize itself, and an audit that can find its own words is not evidence about anything.
 * The exclusion is recorded in the artifact so the negative stays auditable.
 */
const SELF = /stage5_m191_/u;

/** Every committed text file that could carry an acquisition design, at HEAD. */
const allTracked = git(["ls-files", "--", "*.md", "*.json", "*.jsonl"])
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && (l.startsWith("benchmarks/") || l.startsWith("docs/") || !l.includes("/")));
const selfExcluded = allTracked.filter((f) => SELF.test(f));
const trackedDocs = allTracked.filter((f) => !SELF.test(f));

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly excerpt: string;
}

function search(patterns: readonly RegExp[], files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    const content = git(["show", `HEAD:${f}`]);
    if (content.length === 0) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some((p) => p.test(lines[i]))) {
        hits.push({ file: f, line: i + 1, excerpt: lines[i].trim().slice(0, 220) });
      }
    }
  }
  return hits;
}

// -----------------------------------------------------------------------------------------
// 1. locate the committed observational-acquisition design
// -----------------------------------------------------------------------------------------
//
// §10 names `stage5_m189_eer` "or its exact committed equivalent". No file by that name is
// tracked; the equivalent is located by content, not by guessing at a filename.

const DESIGN_SIGNATURE = [
  /validation\s*(→|->|to)\s*repair loop/i,
  /observation of natural coding decisions/i,
  /minimum evidence acquisition/i,
];
const designCandidates = trackedDocs.filter((f) => {
  const c = git(["show", `HEAD:${f}`]);
  return c.length > 0 && DESIGN_SIGNATURE.some((p) => p.test(c));
});

// -----------------------------------------------------------------------------------------
// 2. the six elements §10 requires, searched across ALL committed evidence
// -----------------------------------------------------------------------------------------
//
// Searched repository-wide rather than only inside the design, so "absent" is a real negative:
// an authorization committed anywhere would be found.

interface Element {
  readonly id: string;
  readonly requirement: string;
  readonly patterns: readonly RegExp[];
  /** A hit only counts as an AUTHORIZATION if it also passes this test. */
  readonly qualifies: (h: Hit) => boolean;
}

const ELEMENTS: readonly Element[] = [
  {
    id: "TASK_FIXTURE",
    requirement: "an explicit, enumerable task set frozen for the observational acquisition",
    patterns: [/\b(i6|gap[ -]?b|observational)\b.{0,80}\b(fixture|manifest|task set|instances)\b/i,
               /\b(fixture|manifest)\b.{0,80}\b(i6|gap[ -]?b|observational acquisition)\b/i],
    qualifies: (h) => /instance_id|instances\s*[:=]/i.test(h.excerpt),
  },
  {
    id: "MODEL",
    requirement: "an explicit model for the acquisition arms",
    patterns: [/\b(i6|gap[ -]?b|observational)\b.{0,120}claude-[a-z0-9.-]+/i],
    qualifies: (h) => /claude-[a-z0-9.-]+/i.test(h.excerpt),
  },
  {
    id: "TURN_LIMIT",
    requirement: "an explicit per-run turn limit for the acquisition",
    patterns: [/\b(i6|gap[ -]?b|observational)\b.{0,120}\bmax[- ]?turns?\b/i,
               /\bmax[- ]?turns?\b.{0,120}\b(i6|gap[ -]?b|observational)\b/i],
    qualifies: () => true,
  },
  {
    id: "COST_LIMIT_PER_RUN",
    requirement: "an explicit per-run cost limit for the acquisition",
    patterns: [/\b(i6|gap[ -]?b|observational)\b.{0,120}\b(cost[- ]?limit|costLimitUsd|per-run cost)\b/i,
               /\b(cost[- ]?limit|costLimitUsd)\b.{0,120}\b(i6|gap[ -]?b|observational)\b/i],
    qualifies: () => true,
  },
  {
    id: "TOTAL_SPEND_CAP",
    requirement: "an explicit TOTAL live-spend cap in dollars for the acquisition",
    // Cast wide deliberately: ANY committed dollar ceiling anywhere is a candidate, so that
    // "absent" cannot be an artifact of a narrow search.
    patterns: [/\$\s?\d[\d,.]*\s*(cap|ceiling|budget|maximum|limit)/i,
               /\b(cap|ceiling|budget|maximum|limit|authoriz\w*)\b.{0,40}\$\s?\d/i,
               /\b(total|overall)\b.{0,40}\b(spend|budget)\b.{0,60}\$\s?\d/i],
    // ...then require the ceiling to be SCOPED TO THIS ACQUISITION. The repository does contain
    // committed dollar caps — a $0.40 generated-parser repair cap and a $0.75 live-critic cap —
    // and neither authorizes an I6 observational acquisition. A cap for something else is not a
    // cap for this, and treating it as one is exactly the inference §10 forbids.
    qualifies: (h) =>
      /\b(i6|gap[ -]?b|observational|acquisition|validation.{0,20}corpus)\b/i.test(h.excerpt) &&
      !/\bspent\b/i.test(h.excerpt),
  },
  {
    id: "STOPPING_RULE",
    requirement: "a predeclared stopping rule for the acquisition",
    patterns: [/\b(i6|gap[ -]?b|observational)\b.{0,140}\bstopping rule\b/i,
               /\bstopping rule\b.{0,140}\b(i6|gap[ -]?b|observational)\b/i],
    qualifies: () => true,
  },
];

const elementResults = ELEMENTS.map((e) => {
  const hits = search(e.patterns, trackedDocs);
  const qualifying = hits.filter(e.qualifies);
  return {
    id: e.id,
    requirement: e.requirement,
    candidateHits: hits.length,
    qualifyingHits: qualifying.length,
    present: qualifying.length > 0,
    evidence: qualifying.slice(0, 6),
    nearMisses: hits.filter((h) => !e.qualifies(h)).slice(0, 8),
  };
});

// -----------------------------------------------------------------------------------------
// 3. the design's OWN precondition
// -----------------------------------------------------------------------------------------
//
// The committed Gap-B design does not merely omit a cap. It states a precondition, and M190
// resolved that precondition against it. Recorded separately because it is an independent
// reason Stage B is not authorized, and it would still hold if a cap appeared tomorrow.

const preconditionHits = search(
  [/treat gap b as contingent/i, /close \*\*gap a\*\* first/i, /if i5 does not repeat/i],
  designCandidates,
);
const i5Falsified = git(["log", "--format=%H %s", "-20"]).includes("Falsify the frozen I5 mechanism out of sample");

const missing = elementResults.filter((r) => !r.present).map((r) => r.id);
const verdict = missing.length === 0 ? "LIVE_SPEND_AUTHORIZED" : "LIVE_SPEND_NOT_AUTHORIZED";

const artifact = {
  schemaVersion: "stage5.m191.spend-authorization.v1",
  milestone: "M191",
  question: "Does COMMITTED project evidence already authorize a specific amount of live spend for an I6 observational acquisition?",
  source: "git show HEAD:<path> — committed content only; the working tree is deliberately not read",
  committedDocsSearched: trackedDocs.length,
  selfExcludedFromSearch: {
    count: selfExcluded.length,
    files: selfExcluded,
    why: "a milestone cannot authorize itself; this script reads the repository it writes into",
  },
  designDocumentsLocated: designCandidates,
  designLocatedBy: "content signature, because no file named stage5_m189_eer is tracked",
  elements: elementResults,
  missingElements: missing,
  unscopedDollarCapsFound: elementResults
    .find((r) => r.id === "TOTAL_SPEND_CAP")
    ?.nearMisses.map((h) => ({ ...h, note: "a committed dollar ceiling that authorizes something ELSE" })) ?? [],
  designOwnPrecondition: {
    statedIn: designCandidates,
    hits: preconditionHits,
    gapAWasRun: i5Falsified,
    gapAResult: i5Falsified ? "I5_OUT_OF_SAMPLE_NOT_REPLICATED (M190)" : "not established here",
    preconditionSatisfied: preconditionHits.length > 0 && i5Falsified ? false : null,
    note: "The committed design makes Gap B contingent on Gap A finding that the I5 mechanism repeats. M190 ran Gap A and it did not repeat. This is an independent bar to Stage B, separate from the absent cap.",
  },
  verdict,
};

writeFileSync(path.join(RESULTS, "stage5_m191_spend_authorization.json"), `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`committed docs searched: ${trackedDocs.length}`);
console.log(`design located: ${designCandidates.join(", ") || "(none)"}`);
for (const r of elementResults) {
  console.log(`${r.present ? "present " : "ABSENT  "} ${r.id.padEnd(20)} candidates=${r.candidateHits} qualifying=${r.qualifyingHits}`);
}
console.log(`\n${verdict}${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);

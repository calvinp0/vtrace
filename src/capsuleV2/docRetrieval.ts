// Markdown / documentation section retrieval for capsule v2.
//
// The symbol index only covers code (Python/TS/Cython), so documentation never
// enters the graph. Yet a relevant doc section — a README usage block, a design
// note — is often the most useful SUPPORTING context for a task. This module is
// the doc candidate source: a bounded, deterministic, local scan of the repo's
// markdown that surfaces query-relevant sections as SUMMARIES (never edit
// targets — docs are support only, by rendering policy).
//
// It is deliberately conservative: a sorted file walk, a file-count and
// file-size cap, and a simple term-overlap score, so it is cheap on large repos
// and identical across runs. No network, no hardcoding.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { tokenize } from "../retrieval/hybridScoring";

// Bounds keep the scan cheap and deterministic on a large repo.
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".vtrace", "dist", "build", "coverage", ".mytool", ".agents",
]);
const MAX_MD_FILES = 50;
const MAX_MD_BYTES = 200_000;
const MIN_TERM_LENGTH = 3;
const SUMMARY_MAX_CHARS = 240;

export interface DocSection {
  /** Repo-relative markdown file path. */
  filePath: string;
  /** Section heading text (without the leading `#`s). */
  heading: string;
  /** A short summary of the section body — the support rendering. */
  summary: string;
  /** Query terms that matched this section, sorted. */
  matchedTerms: string[];
  /** Overlap score, normalised to [0, 1] across the matched sections. */
  score: number;
}

/**
 * Retrieve the most query-relevant markdown sections under `repoRoot`, capped at
 * `maxSections`. Returns [] when nothing matches (so the caller adds no noise).
 */
export function retrieveDocSections(
  repoRoot: string,
  query: string,
  maxSections: number,
): DocSection[] {
  if (maxSections <= 0) {
    return [];
  }
  const queryTerms = new Set(tokenize(query).filter((term) => term.length >= MIN_TERM_LENGTH));
  if (queryTerms.size === 0) {
    return [];
  }

  const files = listMarkdownFiles(repoRoot).slice(0, MAX_MD_FILES);
  const matches: Array<DocSection & { rawScore: number }> = [];

  for (const relPath of files) {
    const content = readMarkdown(repoRoot, relPath);
    if (content === undefined) {
      continue;
    }
    for (const section of splitSections(content)) {
      const sectionTokens = new Set(tokenize(`${section.heading} ${section.body}`));
      const matchedTerms = [...queryTerms].filter((term) => sectionTokens.has(term)).sort();
      if (matchedTerms.length === 0) {
        continue;
      }
      matches.push({
        filePath: relPath,
        heading: section.heading,
        summary: summarise(section.body),
        matchedTerms,
        score: 0,
        rawScore: matchedTerms.length,
      });
    }
  }

  if (matches.length === 0) {
    return [];
  }

  const maxRaw = Math.max(...matches.map((match) => match.rawScore));
  for (const match of matches) {
    match.score = maxRaw > 0 ? match.rawScore / maxRaw : 0;
  }
  matches.sort(
    (left, right) =>
      right.rawScore - left.rawScore
      || left.filePath.localeCompare(right.filePath)
      || left.heading.localeCompare(right.heading),
  );

  return matches.slice(0, maxSections).map(({ rawScore: _rawScore, ...section }) => section);
}

interface RawSection {
  heading: string;
  body: string;
}

// Split markdown into sections by ATX headings (`#`..`######`). Content before
// the first heading becomes an "(intro)" section so a heading-less README is
// still searchable.
function splitSections(content: string): RawSection[] {
  const sections: RawSection[] = [];
  let heading = "(intro)";
  let body: string[] = [];

  const flush = (): void => {
    if (body.some((line) => line.trim().length > 0)) {
      sections.push({ heading, body: body.join("\n").trim() });
    }
  };

  for (const line of content.split("\n")) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      heading = (headingMatch[2] ?? "").trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function summarise(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > SUMMARY_MAX_CHARS
    ? `${collapsed.slice(0, SUMMARY_MAX_CHARS).trimEnd()}…`
    : collapsed;
}

function readMarkdown(repoRoot: string, relPath: string): string | undefined {
  try {
    const absPath = path.join(repoRoot, relPath);
    if (statSync(absPath).size > MAX_MD_BYTES) {
      return undefined;
    }
    return readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
}

// Recursively list markdown files under `repoRoot`, repo-relative and sorted, so
// the scan order (and therefore the result) is deterministic.
function listMarkdownFiles(repoRoot: string): string[] {
  const results: string[] = [];

  const walk = (dir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        walk(path.join(dir, entry.name), relDir === "" ? entry.name : `${relDir}/${entry.name}`);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        results.push(relDir === "" ? entry.name : `${relDir}/${entry.name}`);
      }
    }
  };

  walk(repoRoot, "");
  return results.sort((a, b) => a.localeCompare(b));
}

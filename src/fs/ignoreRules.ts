import { readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeFilePath } from "../domain/types";

/**
 * Repo-local ignore-file names honored during scanning, in increasing order of
 * precedence within a single directory (later files override earlier ones).
 * `.vtraceignore` is last so vtrace-specific rules can override `.gitignore`.
 */
export const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".vtraceignore"] as const;

/**
 * A single compiled gitignore-style rule. Patterns are evaluated relative to
 * `baseDir` (the repo-relative directory of the ignore file that declared them).
 */
export interface IgnoreRule {
  baseDir: string;
  negated: boolean;
  dirOnly: boolean;
  matcher: RegExp;
}

/**
 * Reads the supported ignore files from a directory (when present) and returns
 * their compiled rules in declaration order. `entryNames` lets the caller avoid
 * a stat per candidate by passing the already-listed directory entries.
 */
export async function loadIgnoreRulesForDirectory(
  absoluteDirectory: string,
  baseDir: string,
  entryNames: ReadonlySet<string>,
): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];

  for (const fileName of IGNORE_FILE_NAMES) {
    if (!entryNames.has(fileName)) {
      continue;
    }

    let content: string;

    try {
      content = await readFile(path.join(absoluteDirectory, fileName), "utf8");
    } catch {
      continue;
    }

    rules.push(...parseIgnoreFile(content, baseDir));
  }

  return rules;
}

export function parseIgnoreFile(content: string, baseDir: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const rawLine of content.split("\n")) {
    const rule = parseIgnoreLine(rawLine, baseDir);

    if (rule !== undefined) {
      rules.push(rule);
    }
  }

  return rules;
}

function parseIgnoreLine(rawLine: string, baseDir: string): IgnoreRule | undefined {
  let line = rawLine.replace(/\r$/, "").replace(/\s+$/, "");

  if (line.length === 0 || line.startsWith("#")) {
    return undefined;
  }

  let negated = false;

  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  }

  let dirOnly = false;

  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }

  let anchored = false;

  if (line.startsWith("/")) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes("/")) {
    anchored = true;
  }

  if (line.length === 0) {
    return undefined;
  }

  return {
    baseDir,
    negated,
    dirOnly,
    matcher: globToRegExp(line, anchored),
  };
}

function globToRegExp(pattern: string, anchored: boolean): RegExp {
  let body = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const previousIsSlash = index === 0 || pattern[index - 1] === "/";
        const afterIndex = index + 2;
        const nextIsSlash = pattern[afterIndex] === "/";

        if (previousIsSlash && nextIsSlash) {
          // `**/` matches zero or more leading path segments.
          body += "(?:[^/]+/)*";
          index = afterIndex + 1;
          continue;
        }

        if (previousIsSlash && afterIndex === pattern.length) {
          // Trailing `/**` matches everything beneath the prefix.
          body += ".*";
          index = afterIndex;
          continue;
        }

        body += "[^/]*";
        index = afterIndex;
        continue;
      }

      body += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      body += "[^/]";
      index += 1;
      continue;
    }

    if (char === "[") {
      const translated = translateCharacterClass(pattern, index);

      if (translated !== undefined) {
        body += translated.regex;
        index = translated.nextIndex;
        continue;
      }

      body += "\\[";
      index += 1;
      continue;
    }

    if (char === "\\") {
      const next = pattern[index + 1];

      if (next !== undefined) {
        body += escapeRegexChar(next);
        index += 2;
        continue;
      }

      body += "\\\\";
      index += 1;
      continue;
    }

    body += escapeRegexChar(char);
    index += 1;
  }

  const source = anchored ? `^${body}$` : `(?:^|/)${body}$`;

  return new RegExp(source);
}

function translateCharacterClass(
  pattern: string,
  start: number,
): { regex: string; nextIndex: number } | undefined {
  let index = start + 1;
  let body = "[";

  if (pattern[index] === "!") {
    body += "^";
    index += 1;
  } else if (pattern[index] === "]") {
    body += "\\]";
    index += 1;
  }

  while (index < pattern.length && pattern[index] !== "]") {
    const char = pattern[index] as string;

    if (char === "\\") {
      const next = pattern[index + 1];
      body += next === undefined ? "\\\\" : `\\${next}`;
      index += next === undefined ? 1 : 2;
      continue;
    }

    body += char;
    index += 1;
  }

  if (index >= pattern.length) {
    return undefined;
  }

  return { regex: `${body}]`, nextIndex: index + 1 };
}

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Resolves whether a repo-relative path is ignored under the accumulated rule
 * set. The last matching rule wins, so negation rules (`!pattern`) can
 * re-include a path excluded by an earlier rule.
 */
export function isPathIgnored(
  rules: readonly IgnoreRule[],
  repoRelativePath: string,
  isDirectory: boolean,
): boolean {
  const normalizedPath = normalizeFilePath(repoRelativePath);
  let ignored = false;

  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) {
      continue;
    }

    const relative = relativeToBase(rule.baseDir, normalizedPath);

    if (relative === undefined) {
      continue;
    }

    if (rule.matcher.test(relative)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

function relativeToBase(baseDir: string, repoRelativePath: string): string | undefined {
  if (baseDir.length === 0) {
    return repoRelativePath;
  }

  if (repoRelativePath === baseDir) {
    return "";
  }

  return repoRelativePath.startsWith(`${baseDir}/`)
    ? repoRelativePath.slice(baseDir.length + 1)
    : undefined;
}

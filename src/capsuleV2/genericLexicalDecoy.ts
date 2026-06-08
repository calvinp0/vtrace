// Generic-infrastructure lexical-decoy suppression.
//
// WHY THIS EXISTS
// ----------------
// Some generic bug-report words over-anchor retrieval to an infrastructure/helper
// module that is NAMED after that word but is not the bug domain. A task that says
// "deprecation" pulls `matplotlib/_api/deprecation.py` to the top of the lexical
// pool; a task that says "dict" pulls a `*Dict*` helper; "utils"/"config"/"types"
// behave the same. The file's NAME, not its behaviour, won the lexical race.
//
// This is the path/name complement of the existing exception-symptom de-anchoring
// (`hybridScoring.classifyLexicalQueryTokens`): that one folds a generic SYMPTOM
// noun out of a candidate's NAME match; this one recognises when a candidate's
// whole IDENTITY is a generic infrastructure concept and the bug report merely
// shares that generic word.
//
// POLICY (applied by buildCapsuleV2)
// ----------------------------------
//   - A candidate is a generic lexical decoy only when its identity IS generic
//     infrastructure (its file basename OR its symbol name tokenises ENTIRELY into
//     conservative infra tokens), the triggering token is also in the query, and it
//     has NO stronger direct evidence: no symbol/path/test/body-literal pointer, no
//     line anchor, no title-symbol match, no strong graph neighbourhood, and the
//     task does not name its path outright.
//   - A decoy is never removed. Its lexical contribution is WEAKENED (so a generic
//     word cannot ride it to a pivot); downstream role assignment re-decides on the
//     weakened score. A decoy with real evidence is left untouched.
//
// Repo-agnostic and deterministic: no instance ids, no per-repo file lists.

import { HUB_IN_DEGREE_THRESHOLD, tokenize } from "../retrieval/hybridScoring";

// Conservative infrastructure / helper terms. A file or symbol whose name is built
// ONLY from these is a generic utility, not a bug domain. Kept deliberately small —
// a wrong suppression is worse than no suppression — and matched as whole tokens,
// never substrings (so `base` matches `base.py` but not `database.py`).
export const GENERIC_INFRA_TOKENS: ReadonlySet<string> = new Set([
  "util",
  "utils",
  "helper",
  "helpers",
  "common",
  "base",
  "core",
  "compat",
  "deprecation",
  "deprecated",
  "warning",
  "warnings",
  "exception",
  "exceptions",
  "error",
  "errors",
  "config",
  "configuration",
  "option",
  "options",
  "type",
  "types",
  "dict",
  "mapping",
  "parser",
  "parse",
  "io",
  "misc",
]);

// Multiplier applied to the blended lexical score of a confirmed decoy. Mirrors
// `GENERIC_ONLY_LEXICAL_FACTOR`: small but non-zero, so the candidate can still
// surface on other evidence (domain/graph) but cannot ride the generic word to a
// pivot — a weakened lexical falls below the role gate's `STRONG_DIRECT_LEXICAL`.
export const GENERIC_LEXICAL_DECOY_FACTOR = 0.25;

// Normalised graph score at/above which a candidate has STRONG graph-neighbourhood
// evidence and is never treated as a decoy, however generic its name. Below this a
// graph hit is incidental reach, not a reason to trust a generic filename.
export const STRONG_GRAPH_EVIDENCE = 0.5;

export interface GenericLexicalDecoyClassification {
  readonly isDecoy: boolean;
  /** The generic infra token responsible (e.g. "deprecation"); set when a decoy. */
  readonly token?: string;
  /** Why it was treated as a decoy (set when a decoy). */
  readonly reason?: string;
}

/** One suppressed generic lexical decoy, for diagnostics. */
export interface GenericLexicalDecoy {
  readonly token: string;
  readonly path: string;
  readonly reason: string;
}

// The score subset the decision reads — the DIRECT-evidence signals plus the graph
// proximity and global in-degree (the two graph-neighbourhood guards). Lexical is
// intentionally absent: a decoy is defined by its NAME identity, not by how high
// the lexical hit was.
export interface GenericLexicalDecoyScores {
  readonly symbol: number;
  readonly path: number;
  readonly testToImpl: number;
  readonly bodyLiteral: number;
  readonly graph: number;
  /** Global in-degree (dependent count): strong graph-neighbourhood evidence. */
  readonly inDegree: number;
}

export interface GenericLexicalDecoyInput {
  readonly filePath: string;
  readonly localName: string;
  /** Tokens present in the task/query (the bug report's vocabulary). */
  readonly queryTokens: ReadonlySet<string>;
  readonly scores: GenericLexicalDecoyScores;
  /** A resolved file-line anchor named this symbol. */
  readonly hasLineAnchor: boolean;
  /** The task TITLE named this symbol (title-symbol anchoring). */
  readonly hasTitleSymbol: boolean;
  /** The task names this candidate's file by an explicit path. */
  readonly taskNamesPath: boolean;
}

// Decide whether a candidate is a generic-infrastructure lexical decoy. Conservative
// by construction: any stronger evidence short-circuits to "not a decoy" before the
// identity test runs, so a candidate is suppressed ONLY when the generic infra token
// is the single thing tying it to the task.
export function classifyGenericLexicalDecoy(
  input: GenericLexicalDecoyInput,
): GenericLexicalDecoyClassification {
  // (1) Stronger direct evidence, or the task naming the path/symbol outright,
  // protects the candidate — exactly the signals the policy lists as never-suppress.
  // "Strong graph-neighbourhood evidence" is BOTH local proximity (graph) AND a
  // high global in-degree: a symbol many others depend on (a `@deprecated`
  // decorator with 100+ dependents) is real, widely-used infrastructure that is
  // genuinely relevant, not a coincidental lexical match — never a decoy.
  const stronglySupported =
    input.scores.symbol > 0
    || input.scores.path > 0
    || input.scores.testToImpl > 0
    || input.scores.bodyLiteral > 0
    || input.scores.graph >= STRONG_GRAPH_EVIDENCE
    || input.scores.inDegree >= HUB_IN_DEGREE_THRESHOLD
    || input.hasLineAnchor
    || input.hasTitleSymbol
    || input.taskNamesPath;
  if (stronglySupported) {
    return { isDecoy: false };
  }

  // (2) The candidate's identity must BE generic infrastructure and share its word
  // with the query — otherwise the generic token is not what anchored it.
  const trigger = genericInfraTrigger(input.filePath, input.localName, input.queryTokens);
  if (trigger === undefined) {
    return { isDecoy: false };
  }
  return {
    isDecoy: true,
    token: trigger.token,
    reason: `generic infrastructure token \`${trigger.token}\` in ${trigger.where} with weak direct evidence`,
  };
}

interface DecoyTrigger {
  readonly token: string;
  readonly where: string;
}

// Find the generic infra token that anchored a decoy: the candidate's file basename
// OR its symbol name must tokenise ENTIRELY into generic infra tokens (so the
// file/symbol IS generic infrastructure, not merely contains a generic word — a
// `base_user.py` keeps its `user` specificity and is never a decoy), AND at least
// one of those tokens must also appear in the query.
function genericInfraTrigger(
  filePath: string,
  localName: string,
  queryTokens: ReadonlySet<string>,
): DecoyTrigger | undefined {
  const base = baseNameWithoutExtension(filePath);
  const baseToken = identityTrigger(tokenize(base), queryTokens);
  if (baseToken !== undefined) {
    return { token: baseToken, where: `path basename ${base}` };
  }
  const nameToken = identityTrigger(tokenize(localName), queryTokens);
  if (nameToken !== undefined) {
    return { token: nameToken, where: `symbol name ${localName}` };
  }
  return undefined;
}

// The shared infra token for an identity, or undefined. Present only when EVERY
// token of the identity is a generic infra token and at least one is in the query.
function identityTrigger(
  identityTokens: readonly string[],
  queryTokens: ReadonlySet<string>,
): string | undefined {
  if (identityTokens.length === 0) {
    return undefined;
  }
  if (!identityTokens.every((token) => GENERIC_INFRA_TOKENS.has(token))) {
    return undefined;
  }
  for (const token of identityTokens) {
    if (queryTokens.has(token)) {
      return token;
    }
  }
  return undefined;
}

function baseNameWithoutExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// The task's vocabulary for the shared-word test: a plain tokenisation of the task
// prose. (The triggering infra token must appear here, i.e. the bug report uses it.)
export function collectQueryTokens(task: string): Set<string> {
  return new Set(tokenize(task));
}

// Does the task EXPLICITLY name this candidate's file by PATH? A generic word in the
// prose ("deprecation") does NOT count — only a path-shaped reference: the full
// repo-relative path, or a `/<basename>.<ext>` suffix (e.g. the task citing
// `matplotlib/_api/deprecation.py` protects `deprecation.py`). This is the condition
// "the task does not explicitly name that path" — when it does, it is not a decoy.
export function taskNamesCandidatePath(task: string, filePath: string): boolean {
  const haystack = task.replace(/\\/g, "/").toLowerCase();
  const needle = filePath.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
  if (needle.length === 0) {
    return false;
  }
  if (haystack.includes(needle)) {
    return true;
  }
  const base = needle.slice(needle.lastIndexOf("/") + 1);
  if (base.length === 0 || !base.includes(".")) {
    return false;
  }
  return haystack.includes(`/${base}`);
}

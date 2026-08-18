/**
 * M160-D §57 — classify what handle a task's LANGUAGE offers retrieval.
 *
 * EVALUATOR ANALYSIS ONLY. Nothing here is a query heuristic, nothing here runs
 * inside the product, and no classification is fed back into retrieval (§57 is
 * explicit that M160 adds no query rules). The purpose is narrower: when a
 * residual population shares a first divergence, we want to know whether it also
 * shares a QUERY SHAPE — whether the tasks that lose gold before candidate
 * generation are the ones that never named anything generation could catch.
 *
 * M159's standing finding is the reason this cannot be the whole story: the
 * missing lexical handle was true of 19 of 20 residual cases AND of 50 of the 79
 * that succeeded. A shape that is necessary is not thereby sufficient, so this
 * module reports flags and lets the analysis compare them against the delivered
 * control rather than concluding from the residual side alone.
 */

/** Non-exclusive: a task usually offers several handles at once. */
export interface TaskLanguageFlags {
  readonly identifierDriven: boolean;
  readonly pathDriven: boolean;
  readonly errorMessageDriven: boolean;
  readonly testFailureDriven: boolean;
  readonly apiDriven: boolean;
  readonly configurationDriven: boolean;
  readonly resultEffectDriven: boolean;
  readonly behaviorDriven: boolean;
}

export type TaskLanguagePrimary =
  | "IDENTIFIER_DRIVEN"
  | "PATH_DRIVEN"
  | "ERROR_MESSAGE_DRIVEN"
  | "TEST_FAILURE_DRIVEN"
  | "API_DRIVEN"
  | "CONFIGURATION_DRIVEN"
  | "RESULT_EFFECT_DRIVEN"
  | "BEHAVIOR_DRIVEN";

export interface TaskLanguage {
  readonly primary: TaskLanguagePrimary;
  readonly flags: TaskLanguageFlags;
  /** Whether the task text names a gold symbol outright — the strongest handle of all. */
  readonly namesGoldSymbol: boolean;
  /** Whether the task text names a gold file's stem. */
  readonly namesGoldFileStem: boolean;
}

const SOURCE_PATH = /\b[\w.-]+(?:\/[\w.-]+)+\.(?:py|pyx|pyi|rst|txt|cfg|toml|ini)\b/;
const EXCEPTION_NAME = /\b(?:[A-Z][A-Za-z0-9]*(?:Error|Exception|Warning))\b/;
const TRACEBACK = /Traceback \(most recent call last\)|^Errors:|^Traceback:/m;
const TEST_NAME = /\btest_[A-Za-z0-9_]+\b|\bFailing tests?:/;
const CALL_FORM = /\b[a-z_][\w.]*\.[a-z_]\w*\s*\(/;
const CONFIG_TERM = /\b(?:config|configuration|setting|settings|option|options|conf\.py|flag|--[a-z][\w-]+)\b/i;
const RESULT_TERM =
  /\b(?:returns?|returned|return value|output|outputs?|produces?|produced|result|results in|yields?|evaluates? to|renders?)\b/i;
const BEHAVIOR_TERM =
  /\b(?:should|expected|instead|incorrectly|wrongly|fails? to|does not|doesn't|no longer|regression|unexpected)\b/i;
/** A backticked or double-underscore identifier — a token retrieval could match on. */
const IDENTIFIER_TOKEN = /`[A-Za-z_][\w.]*`|\b[a-z]+_[a-z][\w_]*\b|\b[A-Z][a-z]+[A-Z]\w*\b/;

/**
 * Which gold symbols the task text actually names — not merely whether ANY of
 * them is named. The distinction matters: a task can name one ambiguous gold
 * symbol while never mentioning the other, and treating both as "named" credits
 * the query with a handle it never offered.
 */
export function namedGoldSymbols(task: string, goldSymbols: readonly string[]): string[] {
  return goldSymbols.filter((symbol) => {
    const local = (symbol.split(".").pop() ?? symbol).trim();
    if (local.length < 4) return false;
    return new RegExp(`\\b${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(task);
  });
}

export function classifyTaskLanguage(
  task: string,
  goldSymbols: readonly string[] = [],
  goldFiles: readonly string[] = [],
): TaskLanguage {
  const flags: TaskLanguageFlags = {
    identifierDriven: IDENTIFIER_TOKEN.test(task),
    pathDriven: SOURCE_PATH.test(task),
    errorMessageDriven: EXCEPTION_NAME.test(task) || TRACEBACK.test(task),
    testFailureDriven: TEST_NAME.test(task),
    apiDriven: CALL_FORM.test(task),
    configurationDriven: CONFIG_TERM.test(task),
    resultEffectDriven: RESULT_TERM.test(task),
    behaviorDriven: BEHAVIOR_TERM.test(task),
  };

  const lowered = task.toLowerCase();
  const namesGoldSymbol = namedGoldSymbols(task, goldSymbols).length > 0;
  const namesGoldFileStem = goldFiles.some((file) => {
    const stem = (file.split("/").pop() ?? file).replace(/\.[^.]+$/, "");
    if (stem.length < 4) return false;
    return lowered.includes(stem.toLowerCase());
  });

  // Priority is "strongest retrieval handle first". The question this serves is
  // what the query GAVE generation to work with, so a task that names the symbol
  // is identifier-driven even if it also complains about a wrong result.
  const primary: TaskLanguagePrimary = namesGoldSymbol || flags.identifierDriven
    ? "IDENTIFIER_DRIVEN"
    : flags.pathDriven
      ? "PATH_DRIVEN"
      : flags.errorMessageDriven
        ? "ERROR_MESSAGE_DRIVEN"
        : flags.testFailureDriven
          ? "TEST_FAILURE_DRIVEN"
          : flags.apiDriven
            ? "API_DRIVEN"
            : flags.configurationDriven
              ? "CONFIGURATION_DRIVEN"
              : flags.resultEffectDriven
                ? "RESULT_EFFECT_DRIVEN"
                : "BEHAVIOR_DRIVEN";

  return { primary, flags, namesGoldSymbol, namesGoldFileStem };
}

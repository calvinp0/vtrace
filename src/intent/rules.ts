import { QueryIntent } from "./types";

export enum IntentRuleMatcherType {
  KeywordAny = "keyword_any",
  KeywordAll = "keyword_all",
  Substring = "substring",
  RegularExpression = "regular_expression",
}

export interface IntentRule {
  id: string;
  targetIntent: QueryIntent;
  matcherType: IntentRuleMatcherType;
  patterns: readonly string[];
  explanation: string;
  priority: number;
  strength: number;
  flags?: string;
}

export interface IntentRuleMatch {
  rule: IntentRule;
  matchedTerms: string[];
}

export const DEFAULT_INTENT_RULES: readonly IntentRule[] = Object.freeze([
  {
    id: "debug-failure-signals",
    targetIntent: QueryIntent.Debug,
    matcherType: IntentRuleMatcherType.KeywordAny,
    patterns: ["bug", "fail", "failing", "error", "crash", "broken", "incorrect", "exception", "traceback"],
    explanation: "Failure-oriented terms suggest debug intent.",
    priority: 100,
    strength: 4,
  },
  {
    id: "debug-fix-signals",
    targetIntent: QueryIntent.Debug,
    matcherType: IntentRuleMatcherType.KeywordAny,
    patterns: ["fix"],
    explanation: "Explicit fix language suggests debug intent.",
    priority: 90,
    strength: 3,
  },
  {
    id: "refactor-restructure-signals",
    targetIntent: QueryIntent.Refactor,
    matcherType: IntentRuleMatcherType.KeywordAny,
    patterns: ["refactor", "split", "move", "cleanup", "reorganize", "restructure"],
    explanation: "Restructuring terms suggest refactor intent.",
    priority: 80,
    strength: 3,
  },
  {
    id: "refactor-rename-signals",
    targetIntent: QueryIntent.Refactor,
    matcherType: IntentRuleMatcherType.KeywordAny,
    patterns: ["rename"],
    explanation: "Rename requests suggest refactor intent.",
    priority: 85,
    strength: 3,
  },
  {
    id: "feature-implementation-signals",
    targetIntent: QueryIntent.Feature,
    matcherType: IntentRuleMatcherType.KeywordAny,
    patterns: ["add", "implement", "create", "build"],
    explanation: "Implementation terms suggest feature intent.",
    priority: 70,
    strength: 3,
  },
  {
    id: "feature-support-signals",
    targetIntent: QueryIntent.Feature,
    matcherType: IntentRuleMatcherType.KeywordAny,
    patterns: ["support", "enable"],
    explanation: "Enablement terms suggest feature intent.",
    priority: 75,
    strength: 3,
  },
  {
    id: "explain-question-phrases",
    targetIntent: QueryIntent.Explain,
    matcherType: IntentRuleMatcherType.Substring,
    patterns: ["how does", "where is", "what is", "why does"],
    explanation: "Understanding-oriented question phrases suggest explain intent.",
    priority: 60,
    strength: 2,
  },
  {
    id: "explain-understanding-signals",
    targetIntent: QueryIntent.Explain,
    matcherType: IntentRuleMatcherType.KeywordAny,
    patterns: ["explain", "trace", "understand"],
    explanation: "Understanding terms suggest explain intent.",
    priority: 65,
    strength: 3,
  },
]);

export function sortIntentRules(rules: readonly IntentRule[]): IntentRule[] {
  return [...rules].sort((left, right) => {
    return right.priority - left.priority
      || right.strength - left.strength
      || left.id.localeCompare(right.id);
  });
}

export function matchIntentRule(
  rule: IntentRule,
  query: string,
): IntentRuleMatch | undefined {
  const normalizedQuery = normalizeIntentQuery(query);

  if (normalizedQuery.length === 0) {
    return undefined;
  }

  const normalizedPatterns = rule.patterns.map(normalizeIntentQuery);

  switch (rule.matcherType) {
    case IntentRuleMatcherType.KeywordAny: {
      const matchedTerms = normalizedPatterns.filter((pattern) => {
        return pattern.length > 0 && containsWholeWord(normalizedQuery, pattern);
      });

      return matchedTerms.length === 0 ? undefined : { rule, matchedTerms };
    }
    case IntentRuleMatcherType.KeywordAll: {
      if (normalizedPatterns.length === 0) {
        return undefined;
      }

      const matchedTerms = normalizedPatterns.filter((pattern) => {
        return pattern.length > 0 && containsWholeWord(normalizedQuery, pattern);
      });

      return matchedTerms.length === normalizedPatterns.length
        ? { rule, matchedTerms }
        : undefined;
    }
    case IntentRuleMatcherType.Substring: {
      const matchedTerms = normalizedPatterns.filter((pattern) => {
        return pattern.length > 0 && normalizedQuery.includes(pattern);
      });

      return matchedTerms.length === 0 ? undefined : { rule, matchedTerms };
    }
    case IntentRuleMatcherType.RegularExpression: {
      const pattern = rule.patterns[0];

      if (pattern === undefined || pattern.length === 0) {
        return undefined;
      }

      const expression = new RegExp(pattern, rule.flags);
      const match = normalizedQuery.match(expression);

      return match === null
        ? undefined
        : { rule, matchedTerms: match.filter((part) => part.length > 0) };
    }
  }
}

export function normalizeIntentQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWholeWord(query: string, term: string): boolean {
  return query.split(/\s+/).includes(term);
}

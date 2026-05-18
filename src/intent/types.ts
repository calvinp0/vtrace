export enum QueryIntent {
  Debug = "debug",
  Refactor = "refactor",
  Explain = "explain",
  Feature = "feature",
}

export const QUERY_INTENTS = Object.freeze([
  QueryIntent.Debug,
  QueryIntent.Refactor,
  QueryIntent.Explain,
  QueryIntent.Feature,
]) satisfies readonly QueryIntent[];

export enum IntentClassificationReasonKind {
  RuleMatch = "rule_match",
  NoRuleMatchFallback = "no_rule_match_fallback",
  WeakMatchFallback = "weak_match_fallback",
  AmbiguousFallback = "ambiguous_fallback",
}

export interface IntentCandidate {
  intent: QueryIntent;
  strength: number;
  matchedRuleIds: string[];
}

export interface MatchedIntentRuleSummary {
  ruleId: string;
  targetIntent: QueryIntent;
  priority: number;
  strength: number;
  explanation: string;
  matchedTerms: string[];
}

export interface IntentClassificationExplanation {
  reasonKind: IntentClassificationReasonKind;
  fallbackApplied: boolean;
  summary: string;
  matchedRules: MatchedIntentRuleSummary[];
}

export interface IntentClassificationResult {
  query: string;
  intent: QueryIntent;
  strength: number;
  candidates: IntentCandidate[];
  explanation: IntentClassificationExplanation;
}

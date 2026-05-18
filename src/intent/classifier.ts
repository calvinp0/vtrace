import {
  DEFAULT_INTENT_RULES,
  matchIntentRule,
  sortIntentRules,
  type IntentRule,
  type IntentRuleMatch,
} from "./rules";
import {
  IntentClassificationReasonKind,
  QueryIntent,
  type IntentCandidate,
  type IntentClassificationExplanation,
  type IntentClassificationResult,
  type MatchedIntentRuleSummary,
} from "./types";

export interface IntentClassifier {
  classify(query: string): IntentClassificationResult;
}

export interface DefaultIntentPolicy {
  defaultIntent: QueryIntent;
  minimumStrength: number;
  ambiguityDelta: number;
  summary: string;
}

export interface RuleBasedIntentClassifierOptions {
  rules?: readonly IntentRule[];
  defaultPolicy?: DefaultIntentPolicy;
}

// Ambiguous or weak queries default to explain so later routing can stay conservative.
export const DEFAULT_INTENT_POLICY = Object.freeze({
  defaultIntent: QueryIntent.Explain,
  minimumStrength: 1,
  ambiguityDelta: 0,
  summary: "No intent rule matched strongly and uniquely enough; defaulting to explain.",
}) satisfies DefaultIntentPolicy;

export const defaultIntentClassifier = createRuleBasedIntentClassifier();

export function createRuleBasedIntentClassifier(
  options: RuleBasedIntentClassifierOptions = {},
): IntentClassifier {
  const orderedRules = sortIntentRules(options.rules ?? DEFAULT_INTENT_RULES);
  const policy = options.defaultPolicy ?? DEFAULT_INTENT_POLICY;

  return {
    classify(query) {
      const matches = orderedRules
        .map((rule) => matchIntentRule(rule, query))
        .filter((match): match is IntentRuleMatch => match !== undefined);
      const candidates = summarizeIntentCandidates(matches);
      const winningCandidate = candidates[0];
      const selectedIntent = selectIntent(candidates, policy);
      const fallbackReasonKind = classifyFallbackReason(candidates, policy);

      return {
        query,
        intent: selectedIntent,
        strength: selectedIntent === winningCandidate?.intent
          ? winningCandidate.strength
          : 0,
        candidates,
        explanation: buildExplanation(
          selectedIntent,
          candidates,
          matches,
          policy,
          fallbackReasonKind,
        ),
      };
    },
  };
}

function summarizeIntentCandidates(matches: readonly IntentRuleMatch[]): IntentCandidate[] {
  const candidatesByIntent = new Map<QueryIntent, IntentCandidate>();

  for (const match of matches) {
    const candidate = candidatesByIntent.get(match.rule.targetIntent);

    if (candidate === undefined) {
      candidatesByIntent.set(match.rule.targetIntent, {
        intent: match.rule.targetIntent,
        strength: match.rule.strength,
        matchedRuleIds: [match.rule.id],
      });
      continue;
    }

    candidate.strength += match.rule.strength;
    candidate.matchedRuleIds.push(match.rule.id);
  }

  return [...candidatesByIntent.values()]
    .map((candidate) => ({
      ...candidate,
      matchedRuleIds: [...candidate.matchedRuleIds].sort(),
    }))
    .sort((left, right) => {
      return right.strength - left.strength
        || left.intent.localeCompare(right.intent);
    });
}

function selectIntent(
  candidates: readonly IntentCandidate[],
  policy: DefaultIntentPolicy,
): QueryIntent {
  const topCandidate = candidates[0];
  const secondCandidate = candidates[1];

  if (topCandidate === undefined) {
    return policy.defaultIntent;
  }

  if (topCandidate.strength < policy.minimumStrength) {
    return policy.defaultIntent;
  }

  if (
    secondCandidate !== undefined
    && Math.abs(topCandidate.strength - secondCandidate.strength) <= policy.ambiguityDelta
  ) {
    return policy.defaultIntent;
  }

  return topCandidate.intent;
}

function classifyFallbackReason(
  candidates: readonly IntentCandidate[],
  policy: DefaultIntentPolicy,
): IntentClassificationReasonKind | undefined {
  const topCandidate = candidates[0];
  const secondCandidate = candidates[1];

  if (topCandidate === undefined) {
    return IntentClassificationReasonKind.NoRuleMatchFallback;
  }

  if (topCandidate.strength < policy.minimumStrength) {
    return IntentClassificationReasonKind.WeakMatchFallback;
  }

  if (
    secondCandidate !== undefined
    && Math.abs(topCandidate.strength - secondCandidate.strength) <= policy.ambiguityDelta
  ) {
    return IntentClassificationReasonKind.AmbiguousFallback;
  }

  return undefined;
}

function buildExplanation(
  selectedIntent: QueryIntent,
  candidates: readonly IntentCandidate[],
  matches: readonly IntentRuleMatch[],
  policy: DefaultIntentPolicy,
  fallbackReasonKind: IntentClassificationReasonKind | undefined,
): IntentClassificationExplanation {
  const matchedRules = matches.map(toMatchedIntentRuleSummary);

  if (fallbackReasonKind === undefined) {
    return {
      reasonKind: IntentClassificationReasonKind.RuleMatch,
      fallbackApplied: false,
      summary: `Selected intent ${selectedIntent} from matched rule evidence.`,
      matchedRules,
    };
  }

  return {
    reasonKind: fallbackReasonKind,
    fallbackApplied: true,
    summary: buildFallbackSummary(candidates, policy, fallbackReasonKind),
    matchedRules,
  };
}

function buildFallbackSummary(
  candidates: readonly IntentCandidate[],
  policy: DefaultIntentPolicy,
  fallbackReasonKind: IntentClassificationReasonKind,
): string {
  const topCandidate = candidates[0];
  const secondCandidate = candidates[1];

  switch (fallbackReasonKind) {
    case IntentClassificationReasonKind.NoRuleMatchFallback:
      return "No intent rule matched the normalized query; defaulting to explain.";
    case IntentClassificationReasonKind.WeakMatchFallback:
      return `Top matched intent ${topCandidate?.intent ?? policy.defaultIntent} was too weak at strength ${topCandidate?.strength ?? 0}; defaulting to explain.`;
    case IntentClassificationReasonKind.AmbiguousFallback:
      return `Top intent candidates ${topCandidate?.intent ?? policy.defaultIntent} and ${secondCandidate?.intent ?? policy.defaultIntent} tied at strength ${topCandidate?.strength ?? 0}; defaulting to explain.`;
    case IntentClassificationReasonKind.RuleMatch:
      return `Selected intent ${policy.defaultIntent} from matched rule evidence.`;
  }
}

function toMatchedIntentRuleSummary(match: IntentRuleMatch): MatchedIntentRuleSummary {
  return {
    ruleId: match.rule.id,
    targetIntent: match.rule.targetIntent,
    priority: match.rule.priority,
    strength: match.rule.strength,
    explanation: match.rule.explanation,
    matchedTerms: [...match.matchedTerms],
  };
}

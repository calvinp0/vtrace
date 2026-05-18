import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  DEFAULT_INTENT_POLICY,
  defaultIntentClassifier,
} from "./classifier";
import {
  DEFAULT_INTENT_RULES,
  IntentRuleMatcherType,
  matchIntentRule,
  normalizeIntentQuery,
  sortIntentRules,
} from "./rules";
import {
  IntentClassificationReasonKind,
  QUERY_INTENTS,
  QueryIntent,
} from "./types";

test("intent vocabulary and default policy remain explicit and stable", () => {
  assert.deepEqual(QUERY_INTENTS, [
    QueryIntent.Debug,
    QueryIntent.Refactor,
    QueryIntent.Explain,
    QueryIntent.Feature,
  ]);
  assert.equal(DEFAULT_INTENT_POLICY.defaultIntent, QueryIntent.Explain);
  assert.equal(DEFAULT_INTENT_POLICY.minimumStrength, 1);
  assert.equal(DEFAULT_INTENT_POLICY.ambiguityDelta, 0);
  assert.deepEqual(
    DEFAULT_INTENT_RULES.map((rule) => rule.id),
    [
      "debug-failure-signals",
      "debug-fix-signals",
      "refactor-restructure-signals",
      "refactor-rename-signals",
      "feature-implementation-signals",
      "feature-support-signals",
      "explain-question-phrases",
      "explain-understanding-signals",
    ],
  );
});

test("representative debug queries classify as debug", () => {
  const debugQueries = [
    "fix auth redirect bug",
    "why does this parser fail",
    "traceback in session creation",
  ];

  for (const query of debugQueries) {
    const result = defaultIntentClassifier.classify(query);

    assert.equal(result.intent, QueryIntent.Debug);
    assert.equal(result.explanation.fallbackApplied, false);
    assert.equal(result.explanation.reasonKind, IntentClassificationReasonKind.RuleMatch);
    assert.equal(result.strength > 0, true);
    assert.equal(result.explanation.matchedRules.every((rule) => rule.targetIntent === QueryIntent.Debug || rule.targetIntent === QueryIntent.Explain), true);
  }
});

test("representative refactor queries classify as refactor", () => {
  const queries = [
    "refactor session manager",
    "rename manifest model",
    "split retrieval pipeline",
  ];

  for (const query of queries) {
    const result = defaultIntentClassifier.classify(query);
    assert.equal(result.intent, QueryIntent.Refactor);
    assert.equal(result.explanation.reasonKind, IntentClassificationReasonKind.RuleMatch);
    assert.equal(result.explanation.fallbackApplied, false);
  }
});

test("representative explain queries classify as explain", () => {
  const queries = [
    "how does graph reranking work",
    "where is capsule staleness computed",
    "explain the indexing flow",
  ];

  for (const query of queries) {
    const result = defaultIntentClassifier.classify(query);
    assert.equal(result.intent, QueryIntent.Explain);
    assert.equal(result.explanation.reasonKind, IntentClassificationReasonKind.RuleMatch);
    assert.equal(result.explanation.fallbackApplied, false);
  }
});

test("representative feature queries classify as feature", () => {
  const queries = [
    "add Python parser",
    "implement edge diffs",
    "support token budgeting",
  ];

  for (const query of queries) {
    const result = defaultIntentClassifier.classify(query);
    assert.equal(result.intent, QueryIntent.Feature);
    assert.equal(result.explanation.reasonKind, IntentClassificationReasonKind.RuleMatch);
    assert.equal(result.explanation.fallbackApplied, false);
  }
});

test("ambiguous ties fall back deterministically to explain", () => {
  const result = defaultIntentClassifier.classify("fix cleanup");

  assert.deepEqual(result, {
    query: "fix cleanup",
    intent: QueryIntent.Explain,
    strength: 0,
    candidates: [
      {
        intent: QueryIntent.Debug,
        strength: 3,
        matchedRuleIds: ["debug-fix-signals"],
      },
      {
        intent: QueryIntent.Refactor,
        strength: 3,
        matchedRuleIds: ["refactor-restructure-signals"],
      },
    ],
    explanation: {
      reasonKind: IntentClassificationReasonKind.AmbiguousFallback,
      fallbackApplied: true,
      summary: "Top intent candidates debug and refactor tied at strength 3; defaulting to explain.",
      matchedRules: [
        {
          ruleId: "debug-fix-signals",
          targetIntent: QueryIntent.Debug,
          priority: 90,
          strength: 3,
          explanation: "Explicit fix language suggests debug intent.",
          matchedTerms: ["fix"],
        },
        {
          ruleId: "refactor-restructure-signals",
          targetIntent: QueryIntent.Refactor,
          priority: 80,
          strength: 3,
          explanation: "Restructuring terms suggest refactor intent.",
          matchedTerms: ["cleanup"],
        },
      ],
    },
  });
});

test("no-match queries fall back deterministically to explain", () => {
  const result = defaultIntentClassifier.classify("session manager");

  assert.deepEqual(result, {
    query: "session manager",
    intent: QueryIntent.Explain,
    strength: 0,
    candidates: [],
    explanation: {
      reasonKind: IntentClassificationReasonKind.NoRuleMatchFallback,
      fallbackApplied: true,
      summary: "No intent rule matched the normalized query; defaulting to explain.",
      matchedRules: [],
    },
  });
});

test("repeated identical input produces identical classification output", () => {
  const first = defaultIntentClassifier.classify("add support for Python parser");
  const second = defaultIntentClassifier.classify("add support for Python parser");

  assert.deepEqual(second, first);
});

test("explanations and candidate intents are deterministic and inspectable", () => {
  const result = defaultIntentClassifier.classify("fix auth redirect bug");

  assert.deepEqual(result.candidates, [
    {
      intent: QueryIntent.Debug,
      strength: 7,
      matchedRuleIds: ["debug-failure-signals", "debug-fix-signals"],
    },
  ]);
  assert.deepEqual(result.explanation, {
    reasonKind: IntentClassificationReasonKind.RuleMatch,
    fallbackApplied: false,
    summary: "Selected intent debug from matched rule evidence.",
    matchedRules: [
      {
        ruleId: "debug-failure-signals",
        targetIntent: QueryIntent.Debug,
        priority: 100,
        strength: 4,
        explanation: "Failure-oriented terms suggest debug intent.",
        matchedTerms: ["bug"],
      },
      {
        ruleId: "debug-fix-signals",
        targetIntent: QueryIntent.Debug,
        priority: 90,
        strength: 3,
        explanation: "Explicit fix language suggests debug intent.",
        matchedTerms: ["fix"],
      },
    ],
  });
});

test("rule matching and normalization remain deterministic and inspectable", () => {
  const normalized = normalizeIntentQuery("Why does parser FAIL?");
  const orderedRules = sortIntentRules(DEFAULT_INTENT_RULES);

  assert.equal(normalized, "why does parser fail");
  assert.equal(orderedRules[0]?.id, "debug-failure-signals");
  assert.equal(orderedRules.at(-1)?.id, "explain-question-phrases");
  assert.deepEqual(
    matchIntentRule(
      {
        id: "feature-support-signals",
        targetIntent: QueryIntent.Feature,
        matcherType: IntentRuleMatcherType.KeywordAny,
        patterns: ["support", "enable"],
        explanation: "Enablement terms suggest feature intent.",
        priority: 75,
        strength: 3,
      },
      "Enable token budgeting support",
    )?.matchedTerms,
    ["support", "enable"],
  );
});

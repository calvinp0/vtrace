import { normalizeIntentQuery } from "../intent/rules";
import { QueryIntent, type IntentClassificationResult } from "../intent/types";
import {
  RUN_PIPELINE_CONCRETE_PRESETS,
  RunPipelineEditGoal,
  RunPipelineIntentSource,
  RunPipelinePresetIntent,
  type RunPipelineConcretePreset,
  type RunPipelineIntentDecision,
} from "./types";

const PHRASE_TRIGGERS_REFACTOR = Object.freeze([
  "blast radius",
  "what breaks",
  "who calls",
  "rename",
  "refactor",
  "public api",
]);

const PHRASE_TRIGGERS_DEBUG = Object.freeze([
  "why does",
  "crash",
  "traceback",
  "fails",
  "failing",
  "error",
  "exception",
  "stack trace",
]);

const PHRASE_TRIGGERS_MODIFY = Object.freeze([
  "add ",
  "implement",
  "support",
  "extend",
  "enable",
  "new feature",
]);

export function selectRunPipelineIntent(input: {
  requested: RunPipelinePresetIntent;
  classification: IntentClassificationResult;
  query: string;
}): RunPipelineIntentDecision {
  const normalizedQuery = normalizeIntentQuery(input.query);
  const requested = input.requested;

  if (requested !== RunPipelinePresetIntent.Auto) {
    const selected = requested as RunPipelineConcretePreset;
    return finalize({
      requested,
      selected,
      source: RunPipelineIntentSource.Explicit,
      rationale: `Caller explicitly requested intent preset '${selected}'.`,
      fallbackApplied: false,
    });
  }

  const phraseTrigger = resolvePhraseTrigger(normalizedQuery);

  if (phraseTrigger !== null) {
    return finalize({
      requested,
      selected: phraseTrigger.preset,
      source: RunPipelineIntentSource.AutoPhraseTrigger,
      rationale: phraseTrigger.rationale,
      fallbackApplied: false,
    });
  }

  const classifierPreset = mapQueryIntentToPreset(input.classification.intent);

  if (classifierPreset !== null) {
    const fallbackApplied = input.classification.explanation.fallbackApplied;
    return finalize({
      requested,
      selected: classifierPreset,
      source: fallbackApplied
        ? RunPipelineIntentSource.AutoDefault
        : RunPipelineIntentSource.AutoClassifier,
      rationale: fallbackApplied
        ? `Classifier fell back to '${input.classification.intent}'; auto-selected preset '${classifierPreset}'.`
        : `Classifier selected intent '${input.classification.intent}'; mapped to preset '${classifierPreset}'.`,
      fallbackApplied,
    });
  }

  return finalize({
    requested,
    selected: RunPipelinePresetIntent.Explore as RunPipelineConcretePreset,
    source: RunPipelineIntentSource.AutoDefault,
    rationale: "No phrase trigger or classifier match; defaulting to explore preset.",
    fallbackApplied: true,
  });
}

function finalize(partial: {
  requested: RunPipelinePresetIntent;
  selected: RunPipelineConcretePreset;
  source: RunPipelineIntentDecision["source"];
  rationale: string;
  fallbackApplied: boolean;
}): RunPipelineIntentDecision {
  return {
    ...partial,
    mappedQueryIntent: mapPresetToQueryIntent(partial.selected),
    editGoal: mapPresetToEditGoal(partial.selected),
  };
}

function resolvePhraseTrigger(
  normalizedQuery: string,
): { preset: RunPipelineConcretePreset; rationale: string } | null {
  if (normalizedQuery.length === 0) {
    return null;
  }

  for (const phrase of PHRASE_TRIGGERS_REFACTOR) {
    if (normalizedQuery.includes(phrase)) {
      return {
        preset: RunPipelinePresetIntent.Refactor as RunPipelineConcretePreset,
        rationale: `Auto-selected refactor preset from phrase trigger '${phrase}'.`,
      };
    }
  }
  for (const phrase of PHRASE_TRIGGERS_DEBUG) {
    if (normalizedQuery.includes(phrase)) {
      return {
        preset: RunPipelinePresetIntent.Debug as RunPipelineConcretePreset,
        rationale: `Auto-selected debug preset from phrase trigger '${phrase.trim()}'.`,
      };
    }
  }
  for (const phrase of PHRASE_TRIGGERS_MODIFY) {
    if (normalizedQuery.includes(phrase)) {
      return {
        preset: RunPipelinePresetIntent.Modify as RunPipelineConcretePreset,
        rationale: `Auto-selected modify preset from phrase trigger '${phrase.trim()}'.`,
      };
    }
  }

  return null;
}

function mapQueryIntentToPreset(intent: QueryIntent): RunPipelineConcretePreset | null {
  switch (intent) {
    case QueryIntent.Refactor:
      return RunPipelinePresetIntent.Refactor as RunPipelineConcretePreset;
    case QueryIntent.Debug:
      return RunPipelinePresetIntent.Debug as RunPipelineConcretePreset;
    case QueryIntent.Feature:
      return RunPipelinePresetIntent.Modify as RunPipelineConcretePreset;
    case QueryIntent.Explain:
      return RunPipelinePresetIntent.Explore as RunPipelineConcretePreset;
  }
}

export function mapPresetToQueryIntent(preset: RunPipelineConcretePreset): QueryIntent {
  switch (preset) {
    case RunPipelinePresetIntent.Refactor:
      return QueryIntent.Refactor;
    case RunPipelinePresetIntent.Debug:
      return QueryIntent.Debug;
    case RunPipelinePresetIntent.Modify:
      return QueryIntent.Feature;
    case RunPipelinePresetIntent.Explore:
    default:
      return QueryIntent.Explain;
  }
}

export function mapPresetToEditGoal(preset: RunPipelineConcretePreset): RunPipelineEditGoal {
  switch (preset) {
    case RunPipelinePresetIntent.Refactor:
      return RunPipelineEditGoal.RefactorApi;
    case RunPipelinePresetIntent.Debug:
      return RunPipelineEditGoal.InvestigateFailure;
    case RunPipelinePresetIntent.Modify:
      return RunPipelineEditGoal.ModifyFeature;
    case RunPipelinePresetIntent.Explore:
    default:
      return RunPipelineEditGoal.ExploreCodebase;
  }
}

export function isRunPipelinePresetIntent(value: unknown): value is RunPipelinePresetIntent {
  if (typeof value !== "string") {
    return false;
  }
  if (value === RunPipelinePresetIntent.Auto) {
    return true;
  }
  return (RUN_PIPELINE_CONCRETE_PRESETS as readonly string[]).includes(value);
}

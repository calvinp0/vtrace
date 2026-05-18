import assert from "node:assert/strict";
import { test } from "bun:test";

import { defaultIntentClassifier } from "../intent/classifier";
import { QueryIntent } from "../intent/types";
import {
  isRunPipelinePresetIntent,
  selectRunPipelineIntent,
} from "./selectIntent";
import {
  RunPipelineIntentSource,
  RunPipelinePresetIntent,
} from "./types";

function autoSelect(query: string) {
  return selectRunPipelineIntent({
    requested: RunPipelinePresetIntent.Auto,
    classification: defaultIntentClassifier.classify(query),
    query,
  });
}

test("explicit preset is honored with explicit source regardless of classifier", () => {
  const decision = selectRunPipelineIntent({
    requested: RunPipelinePresetIntent.Debug as typeof RunPipelinePresetIntent.Debug,
    classification: defaultIntentClassifier.classify("rename createSession"),
    query: "rename createSession",
  });
  assert.equal(decision.requested, RunPipelinePresetIntent.Debug);
  assert.equal(decision.selected, RunPipelinePresetIntent.Debug);
  assert.equal(decision.source, RunPipelineIntentSource.Explicit);
  assert.equal(decision.fallbackApplied, false);
  assert.equal(decision.mappedQueryIntent, QueryIntent.Debug);
});

test("auto selects refactor preset for rename / blast-radius / public-api phrasing", () => {
  for (const query of [
    "rename createSession",
    "what is the blast radius of changing SessionManager",
    "who calls createSession",
    "what breaks if we refactor SessionStore",
  ]) {
    const decision = autoSelect(query);
    assert.equal(decision.selected, RunPipelinePresetIntent.Refactor, `query: ${query}`);
    assert.equal(decision.source, RunPipelineIntentSource.AutoPhraseTrigger, `query: ${query}`);
    assert.equal(decision.mappedQueryIntent, QueryIntent.Refactor);
    assert.equal(decision.editGoal, "refactor_api");
  }
});

test("auto selects debug preset for failure-oriented phrasing via phrase trigger", () => {
  for (const query of [
    "why does readSession crash",
    "exception raised when readSession is called",
  ]) {
    const decision = autoSelect(query);
    assert.equal(decision.selected, RunPipelinePresetIntent.Debug, `query: ${query}`);
    assert.equal(decision.source, RunPipelineIntentSource.AutoPhraseTrigger, `query: ${query}`);
    assert.equal(decision.mappedQueryIntent, QueryIntent.Debug);
    assert.equal(decision.editGoal, "investigate_failure");
  }
});

test("auto selects modify preset for implementation phrasing", () => {
  const decision = autoSelect("add support for multi-tenant sessions");
  assert.equal(decision.selected, RunPipelinePresetIntent.Modify);
  assert.equal(decision.mappedQueryIntent, QueryIntent.Feature);
  assert.equal(decision.editGoal, "modify_feature");
});

test("auto falls back to explore preset when no phrase trigger or rule match exists", () => {
  const decision = autoSelect("Session");
  assert.equal(decision.selected, RunPipelinePresetIntent.Explore);
  // The default classifier policy falls back to Explain for low-signal queries.
  assert.equal(decision.mappedQueryIntent, QueryIntent.Explain);
  assert.equal(
    decision.source === RunPipelineIntentSource.AutoDefault
    || decision.source === RunPipelineIntentSource.AutoClassifier,
    true,
  );
  assert.equal(decision.editGoal, "explore_codebase");
});

test("isRunPipelinePresetIntent accepts auto and all concrete presets", () => {
  for (const preset of ["auto", "explore", "debug", "modify", "refactor"]) {
    assert.equal(isRunPipelinePresetIntent(preset), true);
  }
  assert.equal(isRunPipelinePresetIntent("planetary"), false);
  assert.equal(isRunPipelinePresetIntent(42), false);
  assert.equal(isRunPipelinePresetIntent(undefined), false);
});

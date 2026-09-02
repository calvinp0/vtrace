/**
 * The representation authority: which bodies may become `code`, under what
 * bound, and how a delivered item is classed. A class here is a construction
 * rule with a source authority; a label alone is never one.
 */

import { describe, expect, test } from "bun:test";

import {
  CODE_BEARING_FORMS,
  RELATED_CODE_CHARACTERS,
  RELATIONSHIP_ONLY,
  REPRESENTATION_LADDER,
  REPRESENTATION_REASONS,
  availableRepresentation,
  headBound,
  isCodeBearingForm,
  representationClassOf,
} from "./orientationRepresentation";

describe("the code-bearing form table", () => {
  test("names the upstream forms whose bodies are source-backed, each with its authority", () => {
    for (const form of ["focused_source", "full_source", "excerpt", "skeleton", "signature", "document_excerpt"]) {
      expect(isCodeBearingForm(form)).toBe(true);
      expect(CODE_BEARING_FORMS[form]!.authority.length).toBeGreaterThan(20);
    }
  });

  test("fails closed: summaries, unknown modes and the empty label carry no code", () => {
    for (const form of ["summary", "full", "mechanism_slice", "", "unlabelled", "toString", "constructor"]) {
      expect(isCodeBearingForm(form)).toBe(false);
    }
  });

  test("the ladder is explicit and has exactly two rungs", () => {
    expect(REPRESENTATION_LADDER).toEqual(["upstream_form", RELATIONSHIP_ONLY]);
    expect(Object.isFrozen(REPRESENTATION_LADDER)).toBe(true);
  });

  test("the related bound is a third of the focus bound and every reason is named once", () => {
    expect(RELATED_CODE_CHARACTERS).toBe(600);
    expect(new Set(REPRESENTATION_REASONS).size).toBe(REPRESENTATION_REASONS.length);
    expect(REPRESENTATION_REASONS).toContain("ceiling");
    expect(REPRESENTATION_REASONS).toContain("neighbour_text_not_carried");
  });
});

describe("availability", () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i} of the body`).join("\n");

  test("a supply item with a code-bearing form and a body is available in that form, bounded", () => {
    const a = availableRepresentation({ origin: "item_supply", form: "skeleton", body, bound: 600 });
    expect(a.available).toBe(true);
    if (!a.available) return;
    expect(a.candidate.form).toBe("skeleton");
    expect(a.candidate.code.length).toBeLessThanOrEqual(600);
    expect(a.candidate.truncated).toBe(true);
    expect(body.startsWith(a.candidate.code)).toBe(true);
  });

  test("a body within the bound is delivered whole and not marked truncated", () => {
    const a = availableRepresentation({ origin: "item_supply", form: "signature", body: "def f(a, b):", bound: 600 });
    expect(a).toEqual({ available: true, candidate: { form: "signature", code: "def f(a, b):", truncated: false } });
  });

  test("a neighbourhood entry is never available: its text is stripped before projection", () => {
    expect(availableRepresentation({ origin: "pivot_neighborhood", form: "focused_source", body, bound: 600 }))
      .toEqual({ available: false, reason: "neighbour_text_not_carried" });
  });

  test("no body, no representation", () => {
    expect(availableRepresentation({ origin: "item_supply", form: "focused_source", body: "", bound: 600 }))
      .toEqual({ available: false, reason: "no_rendered_body" });
  });

  test("a body under a non-code form is not source and is refused", () => {
    expect(availableRepresentation({ origin: "item_supply", form: "summary", body: "CALLS x at y:1 [strong]", bound: 600 }))
      .toEqual({ available: false, reason: "form_not_code_bearing" });
  });

  test("it is deterministic", () => {
    const one = availableRepresentation({ origin: "item_supply", form: "focused_source", body, bound: 300 });
    const two = availableRepresentation({ origin: "item_supply", form: "focused_source", body, bound: 300 });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});

describe("head bound", () => {
  test("cuts on a line boundary and never returns a half line when one is available", () => {
    const body = Array.from({ length: 30 }, (_, i) => `l${i}`.padEnd(20, "x")).join("\n");
    const cut = headBound(body, 200);
    expect(cut.truncated).toBe(true);
    expect(cut.cut.length).toBeLessThanOrEqual(200);
    expect(body.startsWith(cut.cut)).toBe(true);
    expect(body[cut.cut.length]).toBe("\n");
  });

  test("returns the body whole when it fits", () => {
    expect(headBound("short", 600)).toEqual({ cut: "short", truncated: false });
  });
});

describe("class identity", () => {
  test("the focus is classed by its form, as it always was", () => {
    expect(representationClassOf({ form: "focused_source", code: "x" }, "focus")).toBe("focused_source");
    expect(representationClassOf({ form: "signature", code: null }, "focus")).toBe("signature");
    expect(representationClassOf({ form: null, code: null }, "focus")).toBe("unlabelled");
  });

  test("a related entry is classed by the code it carries, or relationship-only", () => {
    expect(representationClassOf({ at: "a" }, "related")).toBe(RELATIONSHIP_ONLY);
    expect(representationClassOf({ form: "skeleton" }, "related")).toBe(RELATIONSHIP_ONLY);
    expect(representationClassOf({ form: "skeleton", code: "class A:" }, "related")).toBe("skeleton");
    expect(representationClassOf({ form: "signature", code: "def f():" }, "related")).toBe("signature");
  });

  test("a label without code is not a class: relabelling a relationship-only entry changes nothing", () => {
    expect(representationClassOf({ form: "focused_source" }, "related"))
      .toBe(representationClassOf({ form: "signature" }, "related"));
  });
});

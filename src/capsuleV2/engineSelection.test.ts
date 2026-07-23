import { describe, expect, test } from "bun:test";

import {
  INVALID_CAPSULE_ENGINE_ALIAS,
  UNSUPPORTED_LEGACY_CAPSULE_ENGINE,
  resolveCapsuleCompatibility,
} from "./engineSelection";

describe("unversioned capsule compatibility", () => {
  test("omission is the current API", () => {
    expect(resolveCapsuleCompatibility(undefined)).toEqual({
      deprecatedAlias: null,
      warnings: [],
    });
  });

  test("default and v2 are deprecated no-op aliases", () => {
    for (const alias of ["default", "v2"] as const) {
      const result = resolveCapsuleCompatibility(alias);
      expect(result.deprecatedAlias).toBe(alias);
      expect(result.warnings[0]).toContain("deprecated and ignored");
    }
  });

  test("v1 and legacy fail explicitly", () => {
    for (const alias of ["v1", "legacy"]) {
      expect(() => resolveCapsuleCompatibility(alias)).toThrow(
        expect.objectContaining({ code: UNSUPPORTED_LEGACY_CAPSULE_ENGINE }),
      );
    }
  });

  test("unknown selectors do not silently normalize", () => {
    expect(() => resolveCapsuleCompatibility("v9")).toThrow(
      expect.objectContaining({ code: INVALID_CAPSULE_ENGINE_ALIAS }),
    );
  });
});

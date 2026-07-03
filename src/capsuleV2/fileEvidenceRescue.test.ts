// File-evidence deep-pool rescue (M100) — unit tests.
//
// The lane's contract: extract exact, non-generic evidence terms from the task;
// admit ONLY deep-pool source files whose raw source text contains a term at
// repo-wide ambiguity ≤3; support-only entries with synthesized sub-anchor
// scores; hard caps (2 files, ≤5 resulting distinct files); every exclusion
// (tests, __init__, docs, vendored, generic-infra, pool-present files)
// enforced. Everything here is gold-blind — the lane's API has no gold input.

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CandidateRole } from "../capsule/assignCandidateRoles";
import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { SymbolKind } from "../domain/types";
import { planIntent } from "./intent";
import { CapsuleIntent } from "./types";
import {
  seedCustomFixture,
  type CapsuleV2Fixture,
} from "./__fixtures__/capsuleV2Fixture";
import {
  extractFileEvidenceMentions,
  FILE_EVIDENCE_RESCUE_FINAL,
  rescueFileEvidenceSupport,
  type FileEvidenceRescueInput,
} from "./fileEvidenceRescue";

let fixture: CapsuleV2Fixture | undefined;

afterEach(() => {
  if (fixture !== undefined) {
    fixture.db.close();
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    fixture = undefined;
  }
});

// --- mention extraction ----------------------------------------------------------

describe("extractFileEvidenceMentions", () => {
  test("extracts quoted strings, error fragments and exception names", () => {
    const { mentions } = extractFileEvidenceMentions(
      'Saving fails with ValueError: unsupported operand for cookie storage — the message "cannot delete a shared cookie" is raised.',
    );
    const byShape = new Map(mentions.map((m) => [m.shape, m.term] as const));
    expect(byShape.get("exception_name")).toBe("ValueError");
    expect(byShape.get("error_fragment")).toContain("unsupported operand");
    expect(byShape.get("quoted_string")).toBe("cannot delete a shared cookie");
  });

  test("extracts snake/camel/dunder identifiers and dotted paths", () => {
    const { mentions } = extractFileEvidenceMentions(
      "HttpResponse.delete_cookie() ignores __getstate__ and settings.SESSION_COOKIE_PATH",
    );
    const terms = new Set(mentions.map((m) => `${m.shape}:${m.term}`));
    expect(terms.has("snake_identifier:delete_cookie")).toBe(true);
    expect(terms.has("camel_identifier:HttpResponse")).toBe(true);
    expect(terms.has("dunder_identifier:__getstate__")).toBe(true);
    expect(terms.has("dotted_path:HttpResponse.delete_cookie")).toBe(true);
  });

  test("rejects generic vocabulary and short tokens", () => {
    const { mentions, rejectedGeneric } = extractFileEvidenceMentions(
      "The `value` of a `field` in the model has a bad `abc` name",
    );
    expect(mentions.map((m) => m.term)).not.toContain("value");
    expect(mentions.map((m) => m.term)).not.toContain("field");
    // `abc` is below the minimum term length.
    expect(mentions.map((m) => m.term)).not.toContain("abc");
    expect(rejectedGeneric).toBeGreaterThan(0);
  });

  test("strips URLs so link fragments never become evidence", () => {
    const { mentions } = extractFileEvidenceMentions(
      "See https://code.example.org/tickets/session_cookie_details for details",
    );
    expect(mentions.map((m) => m.term)).not.toContain("session_cookie_details");
  });
});

// --- rescue lane -------------------------------------------------------------------

const TASK =
  "Session middleware never applies delete_stale_cookie when the response has no cookie jar";

function laneInput(overrides: Partial<FileEvidenceRescueInput> = {}): FileEvidenceRescueInput {
  const shaped = shapeSweQuery({ problemStatement: TASK });
  const plan = planIntent(CapsuleIntent.Debug, TASK, shaped);
  return {
    db: fixture!.db,
    repoRoot: fixture!.repoRoot,
    task: TASK,
    shaped,
    weights: plan.weights,
    symbolSeeds: [],
    poolFilePaths: new Set<string>(),
    baseDistinctFileCount: 2,
    taskAllowsNonSource: false,
    ...overrides,
  };
}

// A production file whose BODY (not name) carries the distinctive task term.
const MIDDLEWARE_SPEC = {
  relPath: "pkg/session/middleware.py",
  specs: [
    {
      localName: "SessionMiddleware",
      kind: SymbolKind.Class,
      docstring: "Session middleware handling cookie responses.",
      body:
        "class SessionMiddleware:\n"
        + "    def process_response(self, request, response):\n"
        + "        if response.jar is None:\n"
        + "            response.delete_stale_cookie('sessionid')\n"
        + "        return response",
    },
  ],
};

// An unrelated production file (never matches the evidence term).
const OTHER_SPEC = {
  relPath: "pkg/mailer.py",
  specs: [
    {
      localName: "send_mail",
      kind: SymbolKind.Function,
      docstring: "Send a mail message.",
      body: "def send_mail(subject):\n    return subject",
    },
  ],
};

describe("rescueFileEvidenceSupport", () => {
  test("rescues a deep-pool source file whose body carries an exact low-ambiguity term", () => {
    fixture = seedCustomFixture([MIDDLEWARE_SPEC, OTHER_SPEC]);
    const result = rescueFileEvidenceSupport(laneInput());
    expect(result.fired).toBe(true);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.candidate.filePath).toBe("pkg/session/middleware.py");
    expect(entry.role).toBe(CandidateRole.Support);
    // Support-strength construction: no direct evidence, sub-anchor final —
    // downstream ordering can never mistake a rescue for an anchor or a pivot.
    expect(entry.candidate.scores.final).toBe(FILE_EVIDENCE_RESCUE_FINAL);
    expect(entry.candidate.scores.symbol).toBe(0);
    expect(entry.candidate.scores.path).toBe(0);
    expect(entry.candidate.scores.bodyLiteral).toBe(0);
    expect(entry.candidate.evidence[0]).toContain("delete_stale_cookie");
    expect(result.matches[0]!.ambiguity).toBe(1);
  });

  test("is deterministic across repeated runs", () => {
    fixture = seedCustomFixture([MIDDLEWARE_SPEC, OTHER_SPEC]);
    const a = rescueFileEvidenceSupport(laneInput());
    const b = rescueFileEvidenceSupport(laneInput());
    expect(JSON.stringify(a.matches)).toBe(JSON.stringify(b.matches));
    expect(a.entries.map((e) => e.candidate.symbolId)).toEqual(
      b.entries.map((e) => e.candidate.symbolId),
    );
  });

  test("never rescues a file already present in any candidate lane", () => {
    fixture = seedCustomFixture([MIDDLEWARE_SPEC, OTHER_SPEC]);
    const result = rescueFileEvidenceSupport(
      laneInput({ poolFilePaths: new Set(["pkg/session/middleware.py"]) }),
    );
    expect(result.fired).toBe(false);
    expect(result.entries).toHaveLength(0);
  });

  test("rejects terms whose repo-wide ambiguity exceeds the cap", () => {
    // The term appears in four production files — one over the ≤3 cap.
    const clone = (relPath: string, name: string) => ({
      relPath,
      specs: [
        {
          localName: name,
          kind: SymbolKind.Function,
          docstring: "Cookie helper.",
          body: `def ${name}(response):\n    response.delete_stale_cookie('x')`,
        },
      ],
    });
    fixture = seedCustomFixture([
      MIDDLEWARE_SPEC,
      clone("pkg/a.py", "helper_a"),
      clone("pkg/b.py", "helper_b"),
      clone("pkg/c.py", "helper_c"),
    ]);
    const result = rescueFileEvidenceSupport(laneInput());
    expect(result.fired).toBe(false);
    expect(result.entries).toHaveLength(0);
    expect(result.ambiguousRejectedCount).toBeGreaterThan(0);
  });

  test("never rescues test files, __init__ facades, or docs/example files", () => {
    fixture = seedCustomFixture([
      {
        relPath: "tests/test_session.py",
        specs: [
          {
            localName: "test_delete",
            kind: SymbolKind.Function,
            body: "def test_delete():\n    response.delete_stale_cookie('x')",
          },
        ],
      },
      {
        relPath: "pkg/session/__init__.py",
        specs: [
          {
            localName: "boot",
            kind: SymbolKind.Function,
            body: "def boot():\n    response.delete_stale_cookie('y')",
          },
        ],
      },
      {
        relPath: "examples/cookie_demo.py",
        specs: [
          {
            localName: "demo",
            kind: SymbolKind.Function,
            body: "def demo():\n    response.delete_stale_cookie('z')",
          },
        ],
      },
      OTHER_SPEC,
    ]);
    const result = rescueFileEvidenceSupport(laneInput());
    expect(result.fired).toBe(false);
    expect(result.entries).toHaveLength(0);
  });

  test("caps rescues at two files and counts the overflow as pruned", () => {
    const carrier = (relPath: string, name: string) => ({
      relPath,
      specs: [
        {
          localName: name,
          kind: SymbolKind.Function,
          docstring: "Session cookie processing.",
          body: `def ${name}(response):\n    response.delete_stale_cookie('x')`,
        },
      ],
    });
    fixture = seedCustomFixture([
      carrier("pkg/one.py", "process_one"),
      carrier("pkg/two.py", "process_two"),
      carrier("pkg/three.py", "process_three"),
    ]);
    const result = rescueFileEvidenceSupport(laneInput());
    expect(result.entries).toHaveLength(2);
    expect(result.prunedCount).toBe(1);
  });

  test("skips entirely when the capsule is already at the distinct-file guard", () => {
    fixture = seedCustomFixture([MIDDLEWARE_SPEC, OTHER_SPEC]);
    const result = rescueFileEvidenceSupport(laneInput({ baseDistinctFileCount: 5 }));
    expect(result.fired).toBe(false);
    expect(result.entries).toHaveLength(0);
    expect(result.fileCapSkipped).toBe(true);
  });

  test("respects the distinct-file guard by shrinking the rescue cap", () => {
    const carrier = (relPath: string, name: string) => ({
      relPath,
      specs: [
        {
          localName: name,
          kind: SymbolKind.Function,
          docstring: "Session cookie processing.",
          body: `def ${name}(response):\n    response.delete_stale_cookie('x')`,
        },
      ],
    });
    fixture = seedCustomFixture([
      carrier("pkg/one.py", "process_one"),
      carrier("pkg/two.py", "process_two"),
    ]);
    // Base already holds 4 distinct files — only ONE rescue may enter.
    const result = rescueFileEvidenceSupport(laneInput({ baseDistinctFileCount: 4 }));
    expect(result.entries).toHaveLength(1);
    expect(result.prunedCount).toBe(1);
  });

  test("applies the content size guard", () => {
    fixture = seedCustomFixture([MIDDLEWARE_SPEC, OTHER_SPEC]);
    // Grow the carrier file past the 512 KiB guard AFTER indexing.
    const big = `${"# pad\n".repeat(120000)}def x():\n    response.delete_stale_cookie('x')\n`;
    writeFileSync(path.join(fixture.repoRoot, "pkg/session/middleware.py"), big, "utf8");
    const result = rescueFileEvidenceSupport(laneInput());
    expect(result.fired).toBe(false);
    expect(result.sizeRejectedCount).toBeGreaterThan(0);
  });

  test("does not fire when the task has no distinctive evidence terms", () => {
    fixture = seedCustomFixture([MIDDLEWARE_SPEC, OTHER_SPEC]);
    const task = "The model field value is wrong for the query";
    const shaped = shapeSweQuery({ problemStatement: task });
    const plan = planIntent(CapsuleIntent.Debug, task, shaped);
    const result = rescueFileEvidenceSupport(
      laneInput({ task, shaped, weights: plan.weights }),
    );
    expect(result.fired).toBe(false);
    expect(result.entries).toHaveLength(0);
  });
});

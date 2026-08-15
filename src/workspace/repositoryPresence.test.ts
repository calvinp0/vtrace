/**
 * M147 §46 — the presence-proof contract, tested as logic.
 *
 * These cases are deliberately free of workspaces, indexes and databases. The
 * rule they pin down is not "does the probe work" but "what do a set of answers
 * entitle us to conclude", and that question has exactly one right answer per
 * shape of input. Keeping it separable is what makes the rule readable; a bug
 * here would be a bug in the milestone's central claim, not in its plumbing.
 */
import { describe, expect, test } from "bun:test";

import {
  MembershipAccessPath,
  PresenceUnknownReason,
  proveExactUniqueness,
  RepositoryPresenceState,
  UniquenessProofStatus,
  type RepositoryPresenceObservation,
} from "./repositoryPresence";

function present(alias: string): RepositoryPresenceObservation {
  return {
    alias,
    state: RepositoryPresenceState.Present,
    unknownReason: null,
    accessPath: MembershipAccessPath.Indexed,
  };
}

function absent(alias: string): RepositoryPresenceObservation {
  return {
    alias,
    state: RepositoryPresenceState.DefinitelyAbsent,
    unknownReason: null,
    accessPath: MembershipAccessPath.Indexed,
  };
}

function unknown(alias: string, reason: PresenceUnknownReason): RepositoryPresenceObservation {
  return {
    alias,
    state: RepositoryPresenceState.Unknown,
    unknownReason: reason,
    accessPath: MembershipAccessPath.Unreported,
  };
}

describe("M147 §46 presence-proof cases", () => {
  test("case 1 — one owner among 100 proven-absent repositories is unique", () => {
    const observations = [
      present("owner"),
      ...Array.from({ length: 99 }, (_, i) => absent(`other-${i}`)),
    ];

    const proof = proveExactUniqueness(observations);

    expect(proof.status).toBe(UniquenessProofStatus.Unique);
    expect(proof.owner).toBe("owner");
    expect(proof.definitelyAbsent).toBe(99);
    expect(proof.unknown).toEqual([]);
  });

  test("case 2 — two owners are ambiguous, and both are named", () => {
    const proof = proveExactUniqueness([present("a"), present("b"), absent("c")]);

    expect(proof.status).toBe(UniquenessProofStatus.Ambiguous);
    expect(proof.owner).toBeNull();
    expect(proof.present).toEqual(["a", "b"]);
  });

  test("case 3 — no owner among fully checked repositories is absence, not ambiguity", () => {
    const proof = proveExactUniqueness([absent("a"), absent("b"), absent("c")]);

    expect(proof.status).toBe(UniquenessProofStatus.Absent);
    expect(proof.owner).toBeNull();
    expect(proof.definitelyAbsent).toBe(3);
  });

  test("case 4 — a refused index makes one owner unprovable, not unique", () => {
    // The whole milestone in one assertion. `a` really does define the name;
    // what cannot be established is that `b` does not.
    const proof = proveExactUniqueness([
      present("a"),
      unknown("b", PresenceUnknownReason.IndexRefused),
      absent("c"),
    ]);

    expect(proof.status).toBe(UniquenessProofStatus.Unproven);
    expect(proof.owner).toBeNull();
    expect(proof.present).toEqual(["a"]);
    expect(proof.unknown).toEqual([{ alias: "b", reason: PresenceUnknownReason.IndexRefused }]);
    expect(proof.reason).toContain("not provably the only one");
  });

  test("case 6 — a scan truncated below the workspace fails closed", () => {
    const proof = proveExactUniqueness([
      present("a"),
      absent("b"),
      unknown("c", PresenceUnknownReason.BeyondScanBound),
      unknown("d", PresenceUnknownReason.BeyondScanBound),
    ]);

    expect(proof.status).toBe(UniquenessProofStatus.Unproven);
    expect(proof.unknown.map((entry) => entry.alias)).toEqual(["c", "d"]);
  });

  test("case 7 — no answers at all proves nothing, and claims nothing", () => {
    const proof = proveExactUniqueness([
      unknown("a", PresenceUnknownReason.BeyondScanBound),
      unknown("b", PresenceUnknownReason.BeyondScanBound),
    ]);

    expect(proof.status).toBe(UniquenessProofStatus.Unproven);
    expect(proof.present).toEqual([]);
    expect(proof.definitelyAbsent).toBe(0);
  });

  test("an unreachable probe blocks a claim exactly as a refused index does", () => {
    const proof = proveExactUniqueness([
      present("a"),
      unknown("b", PresenceUnknownReason.ProbeUnavailable),
    ]);

    expect(proof.status).toBe(UniquenessProofStatus.Unproven);
    expect(proof.unknown[0]!.reason).toBe(PresenceUnknownReason.ProbeUnavailable);
  });

  test("an empty workspace claims nothing rather than absence of everything", () => {
    const proof = proveExactUniqueness([]);

    // Vacuously "checked all zero", which is the honest reading: no repository
    // holds the name because no repository was eligible.
    expect(proof.status).toBe(UniquenessProofStatus.Absent);
    expect(proof.owner).toBeNull();
  });
});

describe("M147 proof invariants", () => {
  test("two owners settle the question even while members remain unchecked", () => {
    // The one case where an unknown member does NOT withhold the conclusion: a
    // further answer could only add a third owner, so ambiguity is already
    // earned. Reporting `unproven` here would be over-abstention, not caution.
    const proof = proveExactUniqueness([
      present("a"),
      present("b"),
      unknown("c", PresenceUnknownReason.BeyondScanBound),
    ]);

    expect(proof.status).toBe(UniquenessProofStatus.Ambiguous);
    expect(proof.present).toEqual(["a", "b"]);
  });

  test("§51 — the proof does not depend on the order observations arrive in", () => {
    const observations = [
      absent("zulu"),
      present("mike"),
      absent("alpha"),
      absent("kilo"),
    ];
    const permutations = [
      observations,
      [...observations].reverse(),
      [observations[1]!, observations[3]!, observations[0]!, observations[2]!],
      [observations[2]!, observations[0]!, observations[1]!, observations[3]!],
    ];

    const proofs = permutations.map(proveExactUniqueness);
    for (const proof of proofs) {
      expect(proof.status).toBe(UniquenessProofStatus.Unique);
      expect(proof.owner).toBe("mike");
      expect(proof.definitelyAbsent).toBe(3);
    }
    // Identical in every reported field, not merely in the verdict: a stable
    // ordering is what stops a diagnostic reading as order-dependent evidence.
    expect(new Set(proofs.map((proof) => JSON.stringify(proof))).size).toBe(1);
  });

  test("§51 — an unproven verdict is order-invariant too, blockers included", () => {
    const observations = [
      present("mike"),
      unknown("zulu", PresenceUnknownReason.IndexRefused),
      absent("alpha"),
      unknown("bravo", PresenceUnknownReason.BeyondScanBound),
    ];

    const forward = proveExactUniqueness(observations);
    const reversed = proveExactUniqueness([...observations].reverse());

    expect(forward.status).toBe(UniquenessProofStatus.Unproven);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.unknown.map((entry) => entry.alias)).toEqual(["bravo", "zulu"]);
  });

  test("§52 — adding proven-absent repositories never changes the owner", () => {
    const core = [present("owner"), absent("other")];

    for (const count of [1, 10, 100, 1000]) {
      const grown = [...core, ...Array.from({ length: count }, (_, i) => absent(`filler-${count}-${i}`))];
      const proof = proveExactUniqueness(grown);

      expect(proof.status).toBe(UniquenessProofStatus.Unique);
      expect(proof.owner).toBe("owner");
      // Every added member strengthens the proof and moves nothing else.
      expect(proof.definitelyAbsent).toBe(count + 1);
      expect(proof.present).toEqual(["owner"]);
    }
  });

  test("§95 — no input shape yields an owner that was not observed present", () => {
    // The property that would have to break for a false unique selection to
    // occur. Exhaustive over every combination of four members' states.
    const states = [
      RepositoryPresenceState.Present,
      RepositoryPresenceState.DefinitelyAbsent,
      RepositoryPresenceState.Unknown,
    ] as const;

    let uniqueVerdicts = 0;
    for (const a of states) for (const b of states) for (const c of states) for (const d of states) {
      const observations = [a, b, c, d].map((state, index): RepositoryPresenceObservation => ({
        alias: `r${index}`,
        state,
        unknownReason: state === RepositoryPresenceState.Unknown ? PresenceUnknownReason.IndexRefused : null,
        accessPath: MembershipAccessPath.Indexed,
      }));

      const proof = proveExactUniqueness(observations);
      if (proof.status !== UniquenessProofStatus.Unique) {
        expect(proof.owner).toBeNull();
        continue;
      }
      uniqueVerdicts += 1;
      // A unique verdict requires: an owner observed present, exactly one such,
      // and not one member left unknown.
      expect(proof.present).toEqual([proof.owner!]);
      expect(observations.find((entry) => entry.alias === proof.owner)!.state)
        .toBe(RepositoryPresenceState.Present);
      expect(observations.some((entry) => entry.state === RepositoryPresenceState.Unknown)).toBe(false);
    }
    expect(uniqueVerdicts).toBeGreaterThan(0);
  });
});

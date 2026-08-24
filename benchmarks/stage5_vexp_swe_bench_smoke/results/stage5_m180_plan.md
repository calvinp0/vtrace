# M180 — plan and start state

## Start state

```text
from        291c9c8dd439cce12114e89d50988434295578b9   (harness hygiene, this milestone)
            47058f04ee189c82f49bb3fb64c4079817265957   (M179 SHA backfill)
            d5a39f93ec9b4d701d11f074ff08646f12ffc643   (M179 evidence + ledger)
            7381a57414eb0311a8f7e6e655651fcfbc5f719b   (M179 product)

M179 left    83 ordered budget pairs losing a related entry or moving the focus
             orientation -> decline at 0, and it must stay there
corpora      results/_m179_authoritative/{broad100a,broad100b}, 88 + 81 valid
             frozen objects carrying item bodies, untracked by design
```

## Question

Does response-envelope metadata compaction mutate the semantic evidence supply the
compact-orientation projector consumes, and can representation be separated from
evidence ownership so a larger budget preserves focus and related evidence?

## Workstreams

```text
A  harness hygiene + ownership architecture audit
B  frozen-authority reproduction of the 83
C  semantic ownership / lifecycle derivation
D  candidate simulation, candidate frozen before confirmation
E  minimal product repair
F  broad monotonic-preservation qualification and closure
```

STOP after F. No live agents, no Docker, no retrieval or ranking change.

## Instruments

```text
m180Ownership.ts                     semantic item identity, supply hashes,
                                     ownership observation, and the preservation
                                     semantics — fixed BEFORE any candidate
run_stage5_m180_reproduction.ts      the 83, reproduced and attributed; --arm
                                     selects the checkout under measurement
run_stage5_m180_controls.ts          synthetic aliasing, mutation timeline,
                                     known negative, identity
run_stage5_m180_qualification.ts     paired arms in one process, all ordered
                                     budget pairs, both corpora
```

The paired arm lives at `/home/calvin/bench/vtrace-m180/pre-repair`, a detached
worktree at `291c9c8d`:

```bash
git worktree add --detach /home/calvin/bench/vtrace-m180/pre-repair 291c9c8d
```

## Artifact policy

Raw `_m179_authoritative/` and `_m179_corpus/` stay untracked, as M179 left them.
M180 commits the instruments and the compact derived artifacts — hashes,
manifests, per-case rows — and no raw objects.

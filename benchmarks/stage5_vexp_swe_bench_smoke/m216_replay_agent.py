"""M216 §20, §31 — the lowest provider boundary, and nothing above it.

M215 already proved the executor against a fake agent. Repeating that would test
the interfaces again, which are not what M216 is uncertain about. What M216 must
test is the PRODUCTION path: the argv the executor assembles, the environment
M193A constructs, the sandbox, the real spawn, the streamed stdout, the parser,
the identity hook and the termination classification.

So exactly one thing is replaced, at the last possible point: which executable
the constructed argv finally names. This script stands where the Claude Code CLI
stands, receives the production argv verbatim, records it so a control can assert
what actually reached a process, and emits a recorded event stream instead of
contacting a provider.

It is not a mock of the agent. It is a real child process at the end of the real
launch path, and everything the executor does before and after it is unchanged.

    python m216_replay_agent.py --fixture <jsonl> --argv-out <json> [--delay-ms N]
                                -- <the production argv>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--argv-out", required=True)
    parser.add_argument("--delay-ms", type=int, default=0)
    parser.add_argument("--exit-code", type=int, default=0)
    parser.add_argument("--hang-after", type=int, default=-1,
                        help="emit N events then sleep, so a timeout/abort path can be exercised")
    parser.add_argument("--write-file", action="append", default=[],
                        help="PATH::CONTENT written before the stream, standing in for the edits a "
                             "real agent would make. Patch capture and the evaluator need a tree "
                             "that actually changed; only the reasoning that chose the change is "
                             "replaced.")
    parser.add_argument("--append-file", action="append", default=[],
                        help="PATH::CONTENT appended to an existing tracked file. Preferred over "
                             "--write-file for demonstrating a tracked source edit: overwriting a "
                             "real project file is also a real change, and it broke the package "
                             "install the first time this control ran.")
    parser.add_argument("--delete-file", action="append", default=[])
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    production_argv = args.rest[1:] if args.rest and args.rest[0] == "--" else args.rest
    # The whole point of recording this is that a control can assert the argv the
    # EXECUTOR built survived the spawn unaltered. An assertion made against the
    # value the executor kept in memory would prove only that it remembered it.
    os.makedirs(os.path.dirname(os.path.abspath(args.argv_out)), exist_ok=True)
    with open(args.argv_out, "w") as fh:
        json.dump({
            "argv": production_argv,
            "cwd": os.getcwd(),
            "envNames": sorted(os.environ),
            "pid": os.getpid(),
        }, fh, indent=2)

    for spec in args.write_file:
        path, _, content = spec.partition("::")
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w") as fh:
            fh.write(content.replace("\\n", "\n"))
    for spec in args.append_file:
        path, _, content = spec.partition("::")
        with open(path, "a") as fh:
            fh.write(content.replace("\\n", "\n"))
    for path in args.delete_file:
        if os.path.exists(path):
            os.remove(path)

    emitted = 0
    with open(args.fixture) as fh:
        for line in fh:
            if not line.strip():
                continue
            sys.stdout.write(line if line.endswith("\n") else line + "\n")
            sys.stdout.flush()
            emitted += 1
            if args.delay_ms:
                time.sleep(args.delay_ms / 1000.0)
            if args.hang_after >= 0 and emitted >= args.hang_after:
                # Never returns. The caller's abort watchdog or wall-clock
                # timeout is the thing under test.
                while True:
                    time.sleep(1)
    return args.exit_code


if __name__ == "__main__":
    raise SystemExit(main())

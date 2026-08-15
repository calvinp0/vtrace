"""Ordering established in one place and consumed in another."""

from selection import PRIORITY


def priority(backend):
    return PRIORITY.get(backend.kind, 99)


def ordered_candidates(data):
    """Every eligible backend, most preferred first."""
    return sorted(build_candidates(data), key=priority)


def build_candidates(data):
    found = []
    for entry in data.entries:
        if entry.eligible:
            found.append(entry)
    return found


def process(data):
    """Which candidate wins."""
    xs = ordered_candidates(data)
    return xs[0]


def log_only(names):
    """An unrelated sort. Never winning-order evidence."""
    report(", ".join(sorted(names)))
    return build_candidates(names)


def process_unordered(data):
    """No local evidence establishes how these arrived."""
    xs = log_only(data)
    return xs[0]

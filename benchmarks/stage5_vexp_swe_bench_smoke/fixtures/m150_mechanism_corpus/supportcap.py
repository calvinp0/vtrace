"""One decision, five helpers, one of which establishes the order."""


def validate(data):
    return data.checked


def annotate(entry):
    return entry.tagged


def normalise(entry):
    return entry.lower()


def audit(entry):
    record(entry)
    return entry


def ranked_candidates(data):
    """Every candidate, most preferred first."""
    return sorted(data.entries, key=lambda entry: entry.rank)


def decide(data):
    """Which entry wins."""
    validate(data)
    annotate(data)
    normalise(data)
    audit(data)
    xs = ranked_candidates(data)
    return xs[0]

"""The consumer holds every subject word; the implementer holds none.

This is the ARC shape reduced to two definitions: `rule_candidate_selector`
names the subject of the question and merely takes an element, while `prepare`
is what actually establishes the precedence being asked about.
"""

SEVERITY = {"fatal": 0, "warning": 1, "hint": 2}


def severity_of(entry):
    return SEVERITY.get(entry.level, 99)


def collect_rules(data):
    found = []
    for entry in data.entries:
        if entry.active:
            found.append(entry)
    return found


def prepare(data):
    """Establishes the precedence."""
    rules = collect_rules(data)
    return sorted(rules, key=severity_of)


def rule_candidate_selector(data):
    """Consumes the precedence and returns the winning rule candidate."""
    rules = prepare(data)
    return rules[0]

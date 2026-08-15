"""Unhelpful operand names. Only producer provenance connects them."""


def build(data):
    out = []
    for entry in data.entries:
        if entry.enabled:
            out.append(entry)
    return out


def process(data):
    xs = build(data)
    return xs[0]


def matching_backends_for(config):
    found = []
    for backend in config.backends:
        if backend.ready:
            found.append(backend)
    return found


def resolve(config):
    xs = matching_backends_for(config)
    return xs[0]

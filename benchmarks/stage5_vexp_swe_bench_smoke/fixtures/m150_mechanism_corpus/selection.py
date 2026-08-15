"""Backend selection and result parsing — the same operation, different subjects."""

PRIORITY = {"local": 0, "remote": 1, "fallback": 2}


def matching_backends(config):
    """Every backend whose capabilities satisfy the config."""
    found = []
    for backend in config.backends:
        if backend.supports(config.capability):
            found.append(backend)
    return found


def extract_frequencies(output):
    """Every vibrational frequency present in the program output."""
    values = []
    for line in output.splitlines():
        if line.startswith("Frequency"):
            values.append(float(line.split()[-1]))
    return values


def choose_backend(config):
    """Which backend handles this request."""
    candidates = matching_backends(config)
    return candidates[0]


def parse_frequency(output):
    """The lowest reported vibrational frequency."""
    frequencies = extract_frequencies(output)
    return frequencies[0]

"""First-success loops over two different subjects."""


def resolve_backend(backends):
    """Which backend handles the request."""
    for backend in backends:
        result = backend.try_resolve()
        if result is not None:
            return result
    return None


def first_valid_energy(lines):
    """The first parsable energy in the output."""
    for line in lines:
        value = parse_energy(line)
        if value is not None:
            return value
    return None

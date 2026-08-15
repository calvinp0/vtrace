"""Two fallback chains in one module."""


def select_backend(config):
    """Which backend is used when the preferred one is unavailable."""
    backend = preferred_backend(config)
    if backend is None:
        backend = default_backend(config)
    return backend


def read_geometry(output):
    """The geometry, however it can be obtained."""
    geometry = parse_geometry(output)
    if geometry is None:
        geometry = rebuild_geometry(output)
    return geometry

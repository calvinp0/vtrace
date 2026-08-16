"""First-success traversal and a fallback chain, each with its own orderer."""


def ordered_backends(config):
    """Establishes which backend is tried first."""
    ready = [backend for backend in config.backends if backend.ready]
    return sorted(ready, key=lambda backend: backend.cost)


def resolve(config):
    """Consumes that order; the first backend that answers wins."""
    for backend in ordered_backends(config):
        result = backend.try_resolve()
        if result is not None:
            return result
    return None


def routes_for(config):
    """Establishes which implementation is preferred."""
    return [primary_route(config), fallback_route(config)]


def dispatch(config):
    """Consumes that order and returns the implementation used."""
    for route in routes_for(config):
        if route is not None:
            return route
    return None

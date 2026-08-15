"""Two precedence tables in one module."""

BACKEND_PRIORITY = {"local": 0, "remote": 1}
QUALITY_PRIORITY = {"converged": 0, "partial": 1}


def choose_backend_by_priority(backends):
    """Which backend takes precedence."""
    return min(backends, key=lambda backend: BACKEND_PRIORITY[backend.kind])


def choose_best_result(results):
    """Which result is the best quality."""
    return min(results, key=lambda result: QUALITY_PRIORITY[result.status])

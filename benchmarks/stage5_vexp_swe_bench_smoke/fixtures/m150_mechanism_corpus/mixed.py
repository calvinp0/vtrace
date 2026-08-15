"""One file, two subjects. File-level topical relevance must not decide."""

from selection import extract_frequencies, matching_backends


def pick_worker(pool):
    """Which worker takes the next job."""
    workers = available_workers(pool)
    return workers[0]


def available_workers(pool):
    ready = []
    for worker in pool.members:
        if worker.idle:
            ready.append(worker)
    return ready


def first_frequency(output):
    """The first frequency in the output."""
    frequencies = extract_frequencies(output)
    return frequencies[0]


def first_backend(config):
    backends = matching_backends(config)
    return backends[0]

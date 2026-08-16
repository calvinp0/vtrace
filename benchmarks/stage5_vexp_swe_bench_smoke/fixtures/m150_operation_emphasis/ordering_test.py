"""A test that establishes an ordering. Never an answer, never an edit target."""


def test_queue_order():
    queues = [entry for entry in collect_queues() if entry.active]
    ordered = sorted(queues, key=lambda queue: queue.rank)
    assert ordered[0].name == "primary"
    return ordered

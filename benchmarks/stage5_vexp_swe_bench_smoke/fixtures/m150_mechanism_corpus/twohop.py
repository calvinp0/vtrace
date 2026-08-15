"""A two-hop producer chain. Measures whether one hop is sufficient."""

from unhelpful import matching_backends_for


def wrapper(config):
    return matching_backends_for(config)


def indirect_choice(config):
    xs = wrapper(config)
    return xs[0]

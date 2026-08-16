"""Role reversal over one implementation.

`alpha` establishes the order; `beta` consumes it and picks. Neither name says
so, which is the point: the paired queries below must reach different
definitions using mechanism evidence rather than vocabulary.
"""

PLUGIN_RANK = {"native": 0, "shim": 1, "legacy": 2}


def rank_of(plugin):
    return PLUGIN_RANK.get(plugin.kind, 99)


def weight_of(sample):
    return sample.weight


def collect(registry):
    found = []
    for plugin in registry.plugins:
        if plugin.enabled:
            found.append(plugin)
    return found


def alpha(registry):
    """Establishes the order, and nothing else."""
    plugins = collect(registry)
    return sorted(plugins)


def beta(registry):
    """Consumes the order and takes the winner."""
    plugins = alpha(registry)
    return plugins[0]


def gamma(readings):
    """An ordering over a different subject entirely."""
    samples = [entry for entry in readings if entry.valid]
    return sorted(samples, key=weight_of)

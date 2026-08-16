"""A direct implementer whose name says nothing about what it does."""

CHANNEL_RANK = {"primary": 0, "mirror": 1, "archive": 2}


def rank(channel):
    return CHANNEL_RANK.get(channel.tier, 99)


def gather(config):
    found = []
    for channel in config.channels:
        if channel.reachable:
            found.append(channel)
    return found


def process(config):
    """No word here names the operation."""
    channels = gather(config)
    return sorted(channels, key=rank)

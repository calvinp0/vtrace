"""Grid utilities for line-scan detector windows."""


class SensorGrid:
    """Describe detector geometry for a calibrated line-scan experiment."""

    def __init__(self, window: int, channels: int):
        self.window = window
        self.channels = channels

    def sample_count(self) -> int:
        return self.window * self.channels


def clamp_window(window: int) -> int:
    """Clamp detector windows to the calibrated acquisition range."""
    return max(8, min(window, 4096))

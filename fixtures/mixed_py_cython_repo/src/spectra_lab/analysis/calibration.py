from ..utils.grid import SensorGrid


class CalibrationRun:
    """Estimate dark current corrected baselines for line scan detector windows."""

    def __init__(self, grid: SensorGrid, dark_current: float):
        self.grid = grid
        self.dark_current = dark_current

    def baseline(self, signal_mean: float) -> float:
        return signal_mean - self.dark_current

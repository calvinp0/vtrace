from .analysis.background import estimate_background
from .analysis.calibration import CalibrationRun
from .utils.grid import SensorGrid


def run_calibrated_diffusion(signal_mean: float, dark_current: float) -> float:
    """Run a calibrated diffusion sweep from baseline background estimates."""
    grid = SensorGrid(window=32, channels=4)
    run = CalibrationRun(grid, dark_current)
    baseline = run.baseline(signal_mean)
    return estimate_background(baseline, dark_current)

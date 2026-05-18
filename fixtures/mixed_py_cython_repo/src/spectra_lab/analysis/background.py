from ..utils.grid import clamp_window


def estimate_background(signal_mean: float, dark_current: float) -> float:
    """Estimate background offsets for detector windows before diffusion kernels execute."""
    corrected_window = clamp_window(32)
    return signal_mean - dark_current + corrected_window / 1024.0

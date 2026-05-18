from spectra_lab.analysis.background import estimate_background
from spectra_lab.utils.grid import clamp_window
from spectra_lab.kernels.diffusion cimport declared_step
include "stencil_ops.pxi"


cpdef double diffuse_profile(double concentration, double dark_current):
    return (
        estimate_background(concentration, dark_current)
        + declared_step(concentration)
        + clamp_window(32) / 1024.0
        + stencil_smooth(concentration)
    )

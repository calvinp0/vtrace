import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIXED_PY_CYTHON_FIXTURE_FILE_COUNT = 11;
export const MIXED_PY_CYTHON_FIXTURE_SYMBOL_COUNT = 13;
export const MIXED_PY_CYTHON_FIXTURE_EDGE_COUNT = 18;
export const MIXED_PY_CYTHON_BACKGROUND_FILE_PATH = "src/spectra_lab/analysis/background.py";
export const MIXED_PY_CYTHON_KERNEL_FILE_PATH = "src/spectra_lab/kernels/diffusion_kernels.pyx";
export const MIXED_PY_CYTHON_CONTROLLED_CHANGE_SYMBOL_FQ_NAME =
  "src/spectra_lab/analysis/background.py::estimate_background";

const MIXED_PY_CYTHON_FIXTURE_ROOT = fileURLToPath(
  new URL("../../fixtures/mixed_py_cython_repo", import.meta.url),
);

const MODIFIED_BACKGROUND_FILE_CONTENT = `from ..utils.grid import clamp_window


def estimate_background(signal_mean: float, dark_current: float, smoothing_passes: int = 1) -> float:
    """Estimate background offsets for detector windows before diffusion kernels execute with optional smoothing."""
    corrected_window = clamp_window(32 + smoothing_passes)
    return signal_mean - dark_current + corrected_window / 1024.0
`;

export async function withMixedPyCythonRepo(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vexb-mixed-py-cython-"));
  const repoRoot = path.join(tempRoot, "repo");

  try {
    await cp(MIXED_PY_CYTHON_FIXTURE_ROOT, repoRoot, { recursive: true });
    await run(repoRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function applyMixedPyCythonControlledChange(repoRoot: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, MIXED_PY_CYTHON_BACKGROUND_FILE_PATH),
    MODIFIED_BACKGROUND_FILE_CONTENT,
  );
}

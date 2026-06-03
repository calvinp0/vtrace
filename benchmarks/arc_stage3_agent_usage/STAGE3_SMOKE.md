# ARC Stage 3 Smoke Result

Initial manual smoke pair:

| Task | Baseline tokens | vtrace tokens | Actual reduction | Baseline quality | Vtrace quality |
| --- | ---: | ---: | ---: | --- | --- |
| workflow_arkane_input | 43,823 | 28,408 | 35.18% | missing | strong |

Interpretation:

The baseline grep-snippet package did not expose enough information for Claude Code to identify where Arkane input is rendered. Claude returned `target_file: null` and explained that the snippets showed Gaussian/Psi4 templates and Arkane adapter usage, but not where Arkane input files were written/rendered.

The vtrace context identified:

```text
arc/statmech/arkane.py::ArkaneAdapter.render_arkane_input_template
```

This smoke pair suggests vtrace can reduce actual Claude Code session usage while improving orientation quality, but it is only one task and should not be generalized.

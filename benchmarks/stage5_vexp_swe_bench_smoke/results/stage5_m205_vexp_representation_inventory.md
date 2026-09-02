# M205 — VEXP representation inventory

Method: byte search over the artefacts the frozen M196 ledger cites; no vexp process executed; no network.

| class | evidence | counts toward A12 | markers (occurrences) | VTRACE analogue |
| --- | --- | --- | --- | --- |
| pivot_full_content | OBSERVED | true | `## Pivots (Full Content)` coreBinary x1; `## Pivot Files (Full Content)` mcpServer x1 | focus with form focused_source (FOCUS:focused_source) |
| pivot_skeleton | OBSERVED | true | `## Pivots (Skeletons` coreBinary x2; `call get_skeleton(file) for body` coreBinary x1 | focus with form signature/skeleton (FOCUS:signature observed on C-LARGE) |
| supporting_skeleton | OBSERVED | true | `## Supporting (Skeletons)` coreBinary x1; `## Supporting Context (Skeletons)` coreBinary x1 | related entry carrying code in a skeleton/signature/focused_source/excerpt/document_excerpt form (RELATED_WITH_CODE) |
| supporting_dropped | OBSERVED | false | `supporting_dropped` coreBinary x1; `call get_skeleton(file_path) for related symbols` coreBinary x1 | an absence, not a representation: relationship-only entries and the claim boundary (RELATIONSHIP_ONLY is the nearest delivered class) |
| get_skeleton_file_structure | OBSERVED | false | `# File Skeletons` mcpServer x2; `file structure without full content` coreBinary x1 | get_skeleton (A9/A10), outside the run_pipeline response the frozen A12 scores |

the frozen MATCH line of 3 equals the 3 OBSERVED classes that count: pivot full content, pivot skeleton, supporting skeleton. Structural behaviour (when a section is chosen, how it is bounded) is UNKNOWN for every class: the binary is closed.


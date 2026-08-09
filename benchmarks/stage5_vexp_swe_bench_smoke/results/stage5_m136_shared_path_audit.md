# M136 shared product-path audit

Both get_context_capsule and run_pipeline use the same progressive product-context envelope. Neither maps a retrieval hit to no_result.

```json
{
  "rows": [
    {
      "toolId": "get_context_capsule",
      "resultState": "resolved",
      "retrievalFound": true,
      "resolved": true,
      "deliveredItems": 4,
      "answerVisible": true,
      "withinEnvelope": true
    },
    {
      "toolId": "run_pipeline",
      "resultState": "resolved",
      "retrievalFound": true,
      "resolved": true,
      "deliveredItems": 3,
      "answerVisible": true,
      "withinEnvelope": true
    }
  ],
  "misleadingNoResult": false
}
```

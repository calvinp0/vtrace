# M202 — performance and resource impact

Load 6.32 7.21 5.75 on 20 cpus.

- registry creation (fresh process, median of 5): 1.2 ms, grammars loaded at creation: 0 (lazy: true)
- per-family first parse (dlopen + parse) median 5.2 ms, max 8.48 ms (php:8.48ms, csharp:8.13ms, scala:7.95ms); second parse median 0.69 ms
- RSS: registry only 66.6 MiB; all 27 grammars loaded and parsed 142 MiB (+75.4 MiB)
- mixed corpus (216 files, 27 families): 755.1 / 1200.2 / 1183.6 files/s, median 1183.6
- dependency footprint: 28 grammar packages, 815.7 MiB unpacked, 3 compiled at install

| family | first parse ms | second parse ms | RSS delta MiB |
| --- | ---: | ---: | ---: |
| javascript | 5.2 | 0.52 | 4.4 |
| go | 5.22 | 0.74 | 5 |
| rust | 7.02 | 0.95 | 6.4 |
| java | 6.53 | 0.71 | 5.2 |
| csharp | 8.13 | 1.51 | 9.6 |
| c | 6.06 | 0.7 | 5.2 |
| cpp | 7.54 | 0.87 | 8.3 |
| ruby | 5.93 | 0.52 | 5 |
| kotlin | 3.12 | 0.6 | 4.6 |
| scala | 7.95 | 0.81 | 7.2 |
| swift | 7.86 | 1.06 | 9.7 |
| dart | 3.76 | 0.81 | 4.6 |
| elixir | 4.61 | 0.69 | 5.2 |
| haskell | 7.7 | 0.77 | 8.9 |
| ocaml | 6.94 | 0.61 | 10.7 |
| lua | 3.78 | 0.42 | 3.4 |
| r | 2.88 | 0.33 | 2.7 |
| php | 8.48 | 0.84 | 6.3 |
| zig | 3.81 | 0.77 | 4.8 |
| objective_c | 6.58 | 0.55 | 8.6 |
| bash | 3.99 | 0.38 | 4.4 |
| sql | 3.09 | 0.53 | 5.8 |
| clojure | 3.6 | 0.7 | 4 |
| html | 2.12 | 0.29 | 2 |
| css | 2.78 | 0.27 | 3.1 |
| json | 2.03 | 0.28 | 2.5 |
| yaml | 1.78 | 0.23 | 2.3 |

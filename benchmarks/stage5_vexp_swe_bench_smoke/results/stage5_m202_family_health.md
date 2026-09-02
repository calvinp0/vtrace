# M202 — per-family health ledger

Registered 30; frozen count 30; health-accepted 30; verdict `M202_FAMILY_HEALTH_PASS`.

| family | tier | VEXP row | fixture | invoked | symbols | kinds | non-ASCII before decl | span truth | malformed | deterministic | status |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| JavaScript | STRUCTURAL | JavaScript | javascript/valid.js | yes | 5 | class:1 function:1 method:2 module_constant:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Go | STRUCTURAL | Go | go/valid.go | yes | 7 | class:1 function:1 interface:1 method:1 module_constant:1 module_variable:1 type_alias:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Rust | STRUCTURAL | Rust | rust/valid.rs | yes | 11 | class:2 function:2 interface:1 method:3 module_constant:1 module_variable:1 type_alias:1 | yes | yes | parse_failed | yes | HEALTHY |
| Java | STRUCTURAL | Java | java/valid.java | yes | 7 | class:3 interface:1 method:3 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| C# | STRUCTURAL | C# | csharp/valid.cs | yes | 8 | class:4 interface:1 method:3 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| C | STRUCTURAL | C | c/valid.c | yes | 6 | class:3 function:2 type_alias:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| C++ | STRUCTURAL | C++ | cpp/valid.cpp | yes | 7 | class:3 function:3 method:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Ruby | STRUCTURAL | Ruby | ruby/valid.rb | yes | 4 | class:1 function:1 method:2 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Kotlin | STRUCTURAL | Kotlin | kotlin/valid.kt | yes | 7 | class:2 function:1 interface:1 method:3 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Scala | STRUCTURAL | Scala | scala/valid.scala | yes | 7 | class:3 interface:1 method:3 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Swift | STRUCTURAL | Swift | swift/valid.swift | yes | 9 | class:3 function:1 interface:1 method:3 type_alias:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Dart | STRUCTURAL | Dart | dart/valid.dart | yes | 10 | class:4 function:1 method:4 type_alias:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Elixir | STRUCTURAL | Elixir | elixir/valid.ex | yes | 3 | function:3 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Haskell | STRUCTURAL | Haskell | haskell/valid.hs | yes | 6 | class:2 function:2 interface:1 type_alias:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| OCaml | STRUCTURAL | OCaml | ocaml/valid.ml | yes | 6 | class:2 function:2 method:1 module_variable:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Lua | STRUCTURAL | Lua | lua/valid.lua | yes | 3 | function:2 method:1 | yes | yes | parse_failed | yes | HEALTHY |
| R | STRUCTURAL | R | r/valid.R | yes | 2 | function:2 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| PHP | STRUCTURAL | PHP | php/valid.php | yes | 8 | class:3 function:1 interface:1 method:3 | yes | yes | parse_failed | yes | HEALTHY |
| Zig | STRUCTURAL | Zig | zig/valid.zig | yes | 7 | class:2 function:2 method:1 module_constant:2 | yes | yes | parse_failed | yes | HEALTHY |
| Objective-C | STRUCTURAL | Objective-C | objective_c/valid.m | yes | 5 | class:1 function:1 interface:1 method:2 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Bash/Shell | STRUCTURAL | Bash/Shell | bash/valid.sh | yes | 2 | function:2 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| SQL | STRUCTURAL | SQL | sql/valid.sql | yes | 3 | class:2 function:1 | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| Clojure | STRUCTURAL | Clojure | clojure/valid.clj | yes | 6 | class:1 function:3 interface:1 module_variable:1 | yes | yes | parse_failed | yes | HEALTHY |
| HTML | PARSED_NO_STRUCTURE | HTML/CSS | html/valid.html | yes | 0 |  | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| CSS | PARSED_NO_STRUCTURE | HTML/CSS | css/valid.css | yes | 0 |  | yes | yes | partial_with_diagnostics | yes | HEALTHY |
| JSON | PARSED_NO_STRUCTURE | YAML/JSON | json/valid.json | yes | 0 |  | yes | yes | parse_failed | yes | HEALTHY |
| YAML | DOCUMENT | YAML/JSON | yaml/valid.yml | yes | 0 |  | yes | yes | parse_failed | yes | HEALTHY |
| TypeScript | DEEP_GRAPH | TypeScript | own suite | n/a | — | — | — | — | — | — | DEEP_ADAPTER (own regression suite) |
| Python | DEEP_GRAPH | Python | own suite | n/a | — | — | — | — | — | — | DEEP_ADAPTER (own regression suite) |
| Cython | DEEP_GRAPH | — | own suite | n/a | — | — | — | — | — | — | DEEP_ADAPTER (own regression suite) |

## Falsification controls

| id | statement | result | detail |
| --- | --- | --- | --- |
| F1 | a family with a name and extensions but no functional parser must not count | PASS | toml: detected, parser=none, registered=false |
| F2 | N extensions for one family must add one family, not N | PASS | 6 C++ extensions → 1 family; frozen count 30 |
| F3 | a registered parser failing its fixture contract must fail family acceptance | PASS | go with fixtureParsed=false → accepted=false |
| F4 | an identity (UTF-16 as bytes) conversion must fail the excerpt gate | PASS | converted slice starts with 'func': true; unconverted: false |
| F5 | malformed fixtures must not yield invented declarations | PASS | invented=0, untruthful families=none |
| F6 | a perturbed symbol order must fail normalised-output equality | PASS | baseline 90f17c3551d4 vs reversed ba42fbf621f9 |
| F7 | a family absent from the production registry must not be described as registered | PASS | detached registry: registered=[go], frozen count 1 |
| F8 | a recognised extension with no parser invocation must not count as parser-backed | PASS | toml recognised, registered=false, empty-registry count=0 |
| F9 | every counted family's fixture must detect and parse as that family | PASS | all routed correctly |
| F10 | TypeScript/Python/Cython must never route to the generic weaker parser | PASS | generic parse of .ts refused=true; deep TS parser produced 1 symbols |
| F11 | eager initialisation of every grammar must cost measurably more than lazy registry creation (the A2 protection gate can fail) | PASS | fresh process: lazy registry 1.13 ms vs eager all-grammar dlopen 13.6 ms |
| F12 | a hard-coded family count must not be accepted without registry evidence | PASS | empty registry → 0; production registry → 30 (hard-coded 30 would only agree because the registry does) |

# M202 — frozen A1 audit (post)

Claim: `30 programming languages supported out of the box` — VEXP counts 30 names under `## Supported Languages (30)`; VTRACE counts enum members with a registered parser. MATCH >= 30 parser-backed families, EXCEED > 30.

## VEXP inventory (30 names)

| name | VTRACE analogue | parser technology (from vexp-core strings) | evidence |
| --- | --- | --- | --- |
| TypeScript | typescript | UNKNOWN | none |
| JavaScript | javascript | UNKNOWN | name token 'javascript' present in vexp-core |
| Python | python | UNKNOWN | none |
| Go | go | UNKNOWN | none |
| Rust | rust | UNKNOWN | none |
| Java | java | UNKNOWN | none |
| C# | csharp | TREE_SITTER_STRUCTURAL | tree_sitter_c_sharp_external_scanner_deserialize |
| C | c | UNKNOWN | none |
| C++ | cpp | TREE_SITTER_STRUCTURAL | tree_sitter_cpp_external_scanner_deserialize |
| Ruby | ruby | UNKNOWN | none |
| Kotlin | kotlin | UNKNOWN | none |
| Scala | scala | TREE_SITTER_STRUCTURAL | tree_sitter_scala_external_scanner_deserialize |
| Swift | swift | UNKNOWN | none |
| Dart | dart | UNKNOWN | none |
| Elixir | elixir | UNKNOWN | none |
| Haskell | haskell | UNKNOWN | none |
| OCaml | ocaml | UNKNOWN | none |
| Lua | lua | UNKNOWN | none |
| R | r | UNKNOWN | none |
| PHP | php | UNKNOWN | none |
| Zig | zig | UNKNOWN | none |
| HCL/Terraform | hcl | UNKNOWN | none |
| Objective-C | objective_c | UNKNOWN | none |
| Bash/Shell | bash | TREE_SITTER_STRUCTURAL | tree_sitter_bash_external_scanner_destroy |
| Dockerfile | dockerfile | UNKNOWN | none |
| Clojure | clojure | UNKNOWN | none |
| F# | fsharp | UNKNOWN | none |
| SQL | sql | UNKNOWN | none |
| HTML/CSS | html + css | UNKNOWN | none |
| YAML/JSON | yaml + json | UNKNOWN | none |

## VTRACE inventory (post): frozen count 30 → MATCHES

| language | extensions | parser registered | counted | reason |
| --- | --- | --- | --- | --- |
| typescript | .ts .tsx | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| javascript | .js .jsx .mjs .cjs | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| python | .py | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| cython | .pyx .pxd .pxi | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| yaml | .yml .yaml | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| toml | .toml | no | no | detected by extension but no parser registered: a detection rule, not language support (F7) |
| go | .go | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| rust | .rs | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| java | .java | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| csharp | .cs | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| c | .c .h | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| cpp | .cpp .cc .cxx .hpp .hh .hxx | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| ruby | .rb | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| kotlin | .kt .kts | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| scala | .scala .sc | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| swift | .swift | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| dart | .dart | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| elixir | .ex .exs | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| haskell | .hs | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| ocaml | .ml .mli | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| lua | .lua | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| r | .r .R | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| php | .php | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| zig | .zig | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| objective_c | .m | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| bash | .sh .bash | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| html | .html .htm | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| css | .css | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| json | .json | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| sql | .sql | yes | yes | enum member with a parser registered by createDefaultParserRegistry |
| clojure | .clj .cljs .cljc | yes | yes | enum member with a parser registered by createDefaultParserRegistry |

VEXP-row convention: 27/30 names fully covered; registered families outside VEXP's list: cython.


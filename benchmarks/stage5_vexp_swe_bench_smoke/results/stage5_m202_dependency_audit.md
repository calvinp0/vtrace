# M202 — parser dependency audit

Core: tree-sitter 0.21.1 (ABI 13-14) on linux-x64; 28 grammar packages, 25 prebuilt, 3 compiled at install, 815.7 MiB unpacked.

| family | package | version | ABI | artifact | licence | MiB | available |
| --- | --- | --- | ---: | --- | --- | ---: | --- |
| TypeScript | tree-sitter-typescript | 0.23.2 | 14 | prebuilt | MIT | 37.0 | yes |
| JavaScript | tree-sitter-javascript | 0.23.1 | 14 | prebuilt | MIT | 5.5 | yes |
| Go | tree-sitter-go | 0.23.4 | 14 | prebuilt | MIT | 3.5 | yes |
| Rust | tree-sitter-rust | 0.23.3 | 14 | prebuilt | MIT | 14.3 | yes |
| Java | tree-sitter-java | 0.23.5 | 14 | prebuilt | MIT | 5.9 | yes |
| C# | tree-sitter-c-sharp | 0.23.1 | 14 | prebuilt | MIT | 73.5 | yes |
| C | tree-sitter-c | 0.23.6 | 14 | prebuilt | MIT | 8.6 | yes |
| C++ | tree-sitter-cpp | 0.23.4 | 14 | prebuilt | MIT | 40.4 | yes |
| Ruby | tree-sitter-ruby | 0.23.1 | 14 | prebuilt | MIT | 29.4 | yes |
| Kotlin | @tree-sitter-grammars/tree-sitter-kotlin | 1.1.0 | 14 | prebuilt | MIT | 45.0 | yes |
| Scala | tree-sitter-scala | 0.24.0 | 14 | prebuilt | MIT | 51.7 | yes |
| Swift | tree-sitter-swift | 0.7.1 | 14 | prebuilt | MIT | 72.4 | yes |
| Dart | tree-sitter-dart-orchard | 0.6.0 | 14 | compiled | MIT | 12.6 | yes |
| Elixir | tree-sitter-elixir | 0.3.5 | 14 | prebuilt | Apache-2.0 | 22.4 | yes |
| Haskell | tree-sitter-haskell | 0.23.1 | 14 | prebuilt | MIT | 45.7 | yes |
| OCaml | tree-sitter-ocaml | 0.23.2 | 14 | prebuilt | MIT | 186.5 | yes |
| Lua | @tree-sitter-grammars/tree-sitter-lua | 0.2.0 | 14 | prebuilt | MIT | 0.9 | yes |
| R | @davisvaughan/tree-sitter-r | 1.3.0 | 14 | prebuilt | MIT | 7.7 | yes |
| PHP | tree-sitter-php | 0.23.12 | 14 | prebuilt | MIT | 22.2 | yes |
| Zig | @tree-sitter-grammars/tree-sitter-zig | 1.1.2 | 14 | prebuilt | MIT | 10.8 | yes |
| Objective-C | tree-sitter-objc | 3.0.2 | 14 | prebuilt | MIT | 63.3 | yes |
| Bash/Shell | tree-sitter-bash | 0.23.3 | 14 | prebuilt | MIT | 19.5 | yes |
| SQL | @derekstride/tree-sitter-sql | 0.3.11 | 14 | compiled | MIT | 28.9 | yes |
| Clojure | tree-sitter-clojure-orchard | 0.2.8 | 14 | compiled | CC0-1.0 | 1.7 | yes |
| HTML | tree-sitter-html | 0.23.2 | 14 | prebuilt | MIT | 0.7 | yes |
| CSS | tree-sitter-css | 0.23.2 | 14 | prebuilt | MIT | 1.7 | yes |
| JSON | tree-sitter-json | 0.24.8 | 14 | prebuilt | MIT | 0.5 | yes |
| YAML | @tree-sitter-grammars/tree-sitter-yaml | 0.7.1 | 14 | prebuilt | MIT | 3.3 | yes |

Blocked VEXP rows: F# (tree-sitter-fsharp publishes ABI 15 only (0.3.5-0.3.11); core 0.21.1 loads ABI 13-14); HCL/Terraform (@tree-sitter-grammars/tree-sitter-hcl 1.2.0 is ABI 15; no ABI-14 npm release); Dockerfile (no Dockerfile grammar is published on npm (tree-sitter-dockerfile is a security placeholder)).

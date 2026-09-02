(* Fixture — café 日本語 before declarations *)
open Printf

(** A point. *)
type point = { x : int; y : int }

(** Add two numbers. *)
let add a b = a + b

let limit = 10

module Inner = struct
  let nested x = x + 1
end

class greeter = object
  method hello name = "hi " ^ name
end

exception Failure_here of string

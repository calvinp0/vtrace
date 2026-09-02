// Fixture — café 日本語 before declarations
import Foundation

/// A greeter.
class Greeter {
    /// Say hello.
    func hello(name: String) -> String { return "hi \(name)" }
    init() {}
}

struct Point { var x: Int }

protocol Shape {
    func area() -> Double
}

enum Color { case red, blue }

typealias Identifier = String

func helper(x: Int) -> Int { return x + 1 }

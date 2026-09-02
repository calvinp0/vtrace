// Fixture — café 日本語 before declarations
package fixture

import scala.math.abs

/** A greeter. */
class Greeter(name: String) {
  /** Say hello. */
  def hello(): String = s"hi $name"
}

trait Shape {
  def area(): Double
}

object Registry {
  def lookup(id: Int): String = "x"
}

case class Pair(a: Int, b: Int)

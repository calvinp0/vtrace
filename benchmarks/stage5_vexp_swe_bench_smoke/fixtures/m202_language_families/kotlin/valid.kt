// Fixture — café 日本語 before declarations
package fixture

import kotlin.math.abs

/** A greeter. */
class Greeter(val name: String) {
    /** Say hello. */
    fun hello(): String = "hi $name"
}

interface Shape {
    fun area(): Double
}

object Registry {
    fun lookup(id: Int): String = "x"
}

fun helper(x: Int): Int = abs(x)

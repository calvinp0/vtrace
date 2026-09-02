// Fixture — café 日本語 before declarations
package fixture;

import java.util.List;

/** A greeter. */
public class Greeter {
    private int count;

    /** Say hello. */
    public String hello(String name) {
        return "hi " + name;
    }

    public Greeter() {}
}

interface Shape {
    double area();
}

enum Color { RED, BLUE }

record Pair(int a, int b) {}

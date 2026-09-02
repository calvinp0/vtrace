// Fixture — café 日本語 before declarations
#include <string>

namespace fixture {

/// A greeter.
class Greeter {
public:
    /// Say hello.
    std::string hello(const std::string& name) { return "hi " + name; }
    Greeter();
};

Greeter::Greeter() {}

struct Point { int x; };

template <typename T>
T identity(T value) { return value; }

enum class Color { Red, Blue };

int add(int a, int b) { return a + b; }

} // namespace fixture

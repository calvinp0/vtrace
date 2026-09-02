// Fixture — café 日本語 before declarations
import 'dart:math';

/// A greeter.
class Greeter {
  /// Say hello.
  String hello(String name) => 'hi $name';
  Greeter();
}

abstract class Shape {
  double area();
}

mixin Loggable {
  void log(String m) {}
}

enum Color { red, blue }

typedef Callback = void Function(int);

int helper(int x) => x + 1;

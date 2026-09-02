// Fixture — café 日本語 before declarations
using System;

namespace Fixture
{
    /// <summary>A greeter.</summary>
    public class Greeter
    {
        /// <summary>Say hello.</summary>
        public string Hello(string name) => "hi " + name;
        public Greeter() {}
    }

    public interface IShape { double Area(); }
    public struct Point { public int X; }
    public enum Color { Red, Blue }
    public record Pair(int A, int B);
}

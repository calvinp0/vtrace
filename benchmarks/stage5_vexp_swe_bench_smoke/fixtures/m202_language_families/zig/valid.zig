// Fixture — café 日本語 before declarations
const std = @import("std");

/// A point.
const Point = struct {
    x: i32,
    /// Make a point.
    pub fn init(x: i32) Point {
        return Point{ .x = x };
    }
};

const Color = enum { red, blue };

const limit: u32 = 10;

/// Add two numbers.
pub fn add(a: i32, b: i32) i32 {
    return a + b;
}

fn helper(x: i32) i32 {
    return x + 1;
}

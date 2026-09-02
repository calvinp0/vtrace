//! Crate fixture — café 日本語 before declarations
use std::fmt;

/// A point.
pub struct Point {
    x: i32,
}

impl Point {
    /// Make a point.
    pub fn new(x: i32) -> Self { Point { x } }
    fn secret(&self) -> i32 { self.x }
}

pub trait Shape {
    fn area(&self) -> f64;
}

pub enum Color { Red, Blue }

type Id = u32;
pub const LIMIT: u32 = 10;
static COUNTER: u32 = 0;

mod inner {
    pub fn nested() {}
}

fn private_helper() {}

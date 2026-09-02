<?php
// Fixture — café 日本語 before declarations
namespace Fixture;

use InvalidArgumentException;

/** A greeter. */
class Greeter
{
    /** Say hello. */
    public function hello(string $name): string { return "hi $name"; }
}

interface Shape { public function area(): float; }

trait Loggable { public function log(string $m): void {} }

enum Color { case Red; case Blue; }

function helper(int $x): int { return $x + 1; }

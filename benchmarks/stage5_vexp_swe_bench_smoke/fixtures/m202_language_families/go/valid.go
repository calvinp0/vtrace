// Package fixture — café 日本語 before declarations
package fixture

import "fmt"

// Greeter greets.
type Greeter struct {
	Name string
}

// Hello says hello.
func (g Greeter) Hello() string {
	return fmt.Sprintf("hi %s", g.Name)
}

// Shape is an interface.
type Shape interface {
	Area() float64
}

type ID = string

const Limit = 10

var counter int

func helper(x int) int { return x + 1 }

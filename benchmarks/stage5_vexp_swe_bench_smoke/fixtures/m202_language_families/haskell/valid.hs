-- Fixture — café 日本語 before declarations
module Fixture where

import Data.List (sort)

-- | A point.
data Point = Point { px :: Int, py :: Int }

newtype Wrapper = Wrapper Int

type Identifier = String

-- | A shape class.
class Shape a where
  area :: a -> Double

-- | Add two numbers.
add :: Int -> Int -> Int
add a b = a + b

helper :: [Int] -> [Int]
helper xs = sort xs
helper [] = []

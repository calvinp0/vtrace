#!/usr/bin/env bash
# Fixture — café 日本語 before declarations
source ./lib.sh

# Say hello.
hello() {
  echo "hi $1"
}

function helper {
  local x="$1"
  echo "$((x + 1))"
}

LIMIT=10
hello world

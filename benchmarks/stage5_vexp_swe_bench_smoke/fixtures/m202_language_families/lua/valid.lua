-- Fixture — café 日本語 before declarations
local json = require("json")

local M = {}

--- Add two numbers.
function M.add(a, b)
  return a + b
end

--- A local helper.
local function helper(x)
  return x + 1
end

function M.Greeter:hello(name)
  return "hi " .. name
end

return M

# Fixture — café 日本語 before declarations
require "json"

module Fixture
  # A greeter.
  class Greeter
    # Say hello.
    def hello(name)
      "hi #{name}"
    end

    def self.build
      new
    end
  end

  def helper(x)
    x + 1
  end
end

# Fixture — café 日本語 before declarations
defmodule Fixture.Greeter do
  @moduledoc "A greeter."
  import String, only: [upcase: 1]

  @doc "Say hello."
  def hello(name), do: "hi " <> upcase(name)

  defp secret(x), do: x + 1

  defmacro shout(text) do
    quote do: unquote(text)
  end
end

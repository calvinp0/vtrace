@first
@registry.second
@register("worker")
def decorated_function() -> str:
    """Function docstring."""
    return "function"


@async_task
async def decorated_async() -> str:
    """Async function docstring."""
    return "async"


@entity
class DecoratedClass:
    """Class docstring."""

    @classmethod
    def build(cls) -> "DecoratedClass":
        """Build docstring."""
        return cls()

    @staticmethod
    def version() -> str:
        """Version docstring."""
        return "1"

    @property
    def name(self) -> str:
        """Name docstring."""
        return "decorated"

    @(lambda fn: fn)
    @registry.decorators["selected"]
    @unknown(lambda value: value)
    def complex_decorated(self) -> str:
        """Complex decorator docstring."""
        return "complex"

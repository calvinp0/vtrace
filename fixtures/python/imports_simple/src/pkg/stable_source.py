import pkg.target_module
from pkg.named_target import named_target


def use_both() -> tuple[str, str]:
    return pkg.target_module.target_function(), named_target()

import pkg.runtime_target
from pkg.named_target import named_target
include "shared_defs.pxi"


def stable_entry():
    return named_target()

"""Negative controls. None of these decides anything."""


def first_character(name):
    return name[0]


def render(names):
    return ", ".join(sorted(names))


def label(entry):
    prefix = entry.tag[0]
    return prefix.upper()

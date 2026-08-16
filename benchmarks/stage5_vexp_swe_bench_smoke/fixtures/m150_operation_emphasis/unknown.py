"""Truthfulness control: nothing here establishes any order.

`take_first` selects an element of a collection somebody else ordered. Asked
what establishes precedence, retrieval may say that this takes the first
element; it may not say that this decides which one is first.
"""


def take_first(entries):
    """Which entry wins."""
    return entries[0]

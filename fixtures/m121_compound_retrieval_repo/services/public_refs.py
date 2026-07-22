def stable_public_ref(record_type: str, record_id: int) -> str:
    """Build the stable public reference for an immutable record."""
    return f"{record_type}:{record_id}"

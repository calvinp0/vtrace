class PublicRefMixin:
    public_ref: str


class RecordReproducibilityAssessment(PublicRefMixin):
    """Immutable reproducibility assessment record with supersession metadata."""

    assessment_ref: str

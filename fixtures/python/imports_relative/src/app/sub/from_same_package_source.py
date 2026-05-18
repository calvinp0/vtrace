from .feature import feature_flag


def use_feature() -> bool:
    return feature_flag()

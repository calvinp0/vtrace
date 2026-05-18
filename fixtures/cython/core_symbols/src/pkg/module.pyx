cdef int MODULE_LEVEL_VALUE = 7


def integrate(double x, double y):
    return x + y


cdef double solve_system(double x, double y):
    return x - y


cpdef int clamp(int value):
    return value


cdef class Solver:
    def method(self):
        return 1


def outer():
    def inner():
        return 1

    return inner()

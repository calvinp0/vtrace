cdef int declared_add(int left, int right)
cpdef int declared_scale(int value)

cdef extern from "math.h":
    double sin(double value)


cdef class DeclaredThing:
    cpdef int method(self)

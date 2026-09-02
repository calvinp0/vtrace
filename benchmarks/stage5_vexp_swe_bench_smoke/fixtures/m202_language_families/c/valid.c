/* Fixture — café 日本語 before declarations */
#include <stdio.h>

/* A point. */
struct point {
    int x;
    int y;
};

typedef struct point point_t;

enum color { RED, BLUE };

union value { int i; float f; };

/* Add two ints. */
int add(int a, int b) {
    return a + b;
}

static int *make_ptr(void) { return NULL; }

int prototype_only(int a);

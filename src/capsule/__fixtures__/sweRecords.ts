// Fixtures derived from the five Stage 5C evaluated SWE-bench instances.
//
// Three are large / navigation-heavy (touch query internals, regex parsing
// across modules, or the migrations autodetector) and should recommend `full`.
// Two are small / local (a single new function/method in one file) and should
// recommend `micro`. The prose is paraphrased but preserves the real file
// paths, symbols, and failing tests that drive shaping and the recommendation
// heuristic.

import type { SweIssueRecord } from "../sweQueryShaping";

// django__django-11490 — composed queries (.union()/.values()) and column
// selection: deep query/SQL compiler internals, several files and symbols.
export const SWE_11490: SweIssueRecord = {
  repo: "django/django",
  instanceId: "django__django-11490",
  problemStatement:
    "Composed queries cannot change the list of columns with values()/values_list(). "
    + "Calling .values() after .union() of two QuerySets ignores the requested columns "
    + "because the combinator query reuses the columns from the first SELECT. This involves "
    + "the SQL compiler in django/db/models/sql/compiler.py, the query construction in "
    + "django/db/models/sql/query.py, and the QuerySet wrappers in django/db/models/query.py. "
    + "The set_values() and get_combinator_sql() paths must propagate the values selection "
    + "across each combined query so cross-module column resolution stays consistent.",
  hintsText:
    "The combinator handling lives in get_combinator_sql(); set_values() on the Query needs "
    + "to be re-applied to each combined query. See also values_list() and _values().",
  failToPass: [
    "tests.queries.test_qs_combinators.QuerySetSetOperationTests.test_union_with_values",
    "tests.queries.test_qs_combinators.QuerySetSetOperationTests.test_union_with_values_list_on_annotated_and_unannotated",
  ],
};

// django__django-11728 — simplify_regexp()/replace_named_groups: regex parsing
// of URL patterns spanning admindocs utils and views.
export const SWE_11728: SweIssueRecord = {
  repo: "django/django",
  instanceId: "django__django-11728",
  problemStatement:
    "simplify_regexp() does not replace trailing named groups when the regular expression "
    + "ends with the group and has no trailing slash. The regex parsing in replace_named_groups() "
    + "walks the pattern matching parentheses but stops before the final group, so admindocs "
    + "renders the raw regex. This touches django/contrib/admindocs/utils.py where "
    + "replace_named_groups() and replace_unnamed_groups() parse the pattern, and "
    + "django/contrib/admindocs/views.py which formats the simplified URL. The group-boundary "
    + "parsing must continue to the end of the string so trailing groups are substituted.",
  hintsText:
    "Look at replace_named_groups() and replace_unnamed_groups() in admindocs/utils.py. The "
    + "parsing loop that tracks the unmatched bracket depth needs to flush the final group.",
  failToPass: [
    "tests.admin_docs.test_utils.TestUtils.test_replace_named_groups",
    "tests.admin_docs.test_utils.TestUtils.test_replace_named_groups_unmatched_angle_brackets",
  ],
};

// django__django-11740 — converting a UUIDField to a ForeignKey must add a
// migration dependency: migrations autodetector internals.
export const SWE_11740: SweIssueRecord = {
  repo: "django/django",
  instanceId: "django__django-11740",
  problemStatement:
    "Change uuid field to FK does not create dependency. When a UUIDField is altered into a "
    + "ForeignKey, the migrations autodetector generates an AlterField operation without a "
    + "dependency on the referenced model's migration, so migrate fails on a fresh database. "
    + "The fix is in django/db/migrations/autodetector.py where generate_altered_fields() builds "
    + "AlterField operations; it must compute _get_dependencies_for_foreign_key() like "
    + "generate_added_fields() does. This cross-module dependency behaviour also exercises "
    + "django/db/migrations/operations/fields.py.",
  hintsText:
    "generate_altered_fields() in the autodetector should add dependencies for new FK targets, "
    + "mirroring generate_added_fields(). See _get_dependencies_for_foreign_key().",
  failToPass: [
    "tests.migrations.test_autodetector.AutodetectorTests.test_alter_field_to_fk_dependency",
  ],
};

// django__django-10880 — add an `encoder` parameter to json_script(): a single
// small function in one utility file.
export const SWE_10880: SweIssueRecord = {
  repo: "django/django",
  instanceId: "django__django-10880",
  problemStatement:
    "Add an encoder parameter to django.utils.html.json_script(). The json_script() helper "
    + "currently hardcodes DjangoJSONEncoder; allow callers to pass a custom encoder.",
  hintsText: null,
  failToPass: [
    "tests.utils_tests.test_html.TestUtilsHtml.test_json_script_custom_encoder",
  ],
};

// django__django-11095 — add a get_inlines() hook to ModelAdmin: a single new
// method on one admin options file.
export const SWE_11095: SweIssueRecord = {
  repo: "django/django",
  instanceId: "django__django-11095",
  problemStatement:
    "Add ModelAdmin.get_inlines() hook to allow setting inlines based on the request or model "
    + "instance. Currently get_inline_instances() iterates self.inlines directly; introduce a "
    + "get_inlines(request, obj) method in django/contrib/admin/options.py that it calls.",
  hintsText: null,
  failToPass: [
    "tests.admin_inlines.tests.TestInline.test_get_inlines_override",
  ],
};

export const NAVIGATION_HEAVY_FIXTURES = [SWE_11490, SWE_11728, SWE_11740] as const;
export const LOCAL_FIXTURES = [SWE_10880, SWE_11095] as const;
export const ALL_SWE_FIXTURES = [...NAVIGATION_HEAVY_FIXTURES, ...LOCAL_FIXTURES] as const;

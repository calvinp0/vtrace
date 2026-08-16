# M153-A — behavioural cross-repository corpus: ground truth

Generated from `behavioralCrossRepoCorpus.ts` by `run_stage5_m153_corpus_export.ts`.
Do not hand-edit. Every span below was read from the pinned checkout and is
mechanically verified to match the symbol's actual line range.

## requests — HTTP client library (CALIBRATION)

Instance `psf__requests-5414` @ `39d0fdd9096f7dceccbc8f82e1eda7dd64717a8e` — 6 cases.

### `rq_adapter_selection` — selection

> How does the session decide which connection adapter handles a URL?

phrasing: behavioral_prose · falsePremise: false

Two definitions are jointly necessary. get_adapter is a first-prefix-match loop; on its own it does not explain why the match is the LONGEST prefix. mount supplies that by maintaining the ordering invariant. Neither alone is a complete answer (§19).

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `requests/sessions.py::Session.get_adapter` | `requests/sessions.py:720-732` | Iterates self.adapters and returns the first whose prefix the URL starts with. |
| ORDERING_PREREQUISITE | `requests/sessions.py::Session.mount` | `requests/sessions.py:739-748` | Re-inserts shorter prefixes after the new one, keeping adapters in descending prefix length — the reason 'first match' means 'longest match'. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `requests/sessions.py::Session.close` | same_file_unrelated | Also iterates self.adapters, decides nothing. |
| `requests/adapters.py::HTTPAdapter.get_connection` | similar_name | 'get_connection' on an adapter — picks a urllib3 pool, not an adapter. |

### `rq_adapter_ranking_false_premise` — ordering

> Where is the function that ranks the connection adapters?

phrasing: behavioral_prose · falsePremise: true · paired with `rq_rank_adapters_identifier`

There is no ranking function. Ordering is a side effect of mount() and consumption is a first-match loop in get_adapter(). A truthful answer reconstructs that pair; inventing or promoting a 'rank'-shaped symbol is the failure.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `requests/sessions.py::Session.mount` | `requests/sessions.py:739-748` | The ordering the query calls 'ranking' is established here, as a side effect of registration. |
| CONSUMER | `requests/sessions.py::Session.get_adapter` | `requests/sessions.py:720-732` | Consumes that order by taking the first match. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `requests/adapters.py::HTTPAdapter.get_connection` | similar_name | Nearest thing to a 'ranking' symbol; ranks nothing. |

### `rq_rank_adapters_identifier` — explicit_identifier_absence

> Where is rank_adapters defined?

phrasing: explicit_identifier · falsePremise: true · **expects a bounded absence** · paired with `rq_adapter_ranking_false_premise`

`rank_adapters` does not exist. Because the request is identifier syntax, the truthful answer is a bounded absence — NOT the mechanism its prose twin correctly reconstructs (§86, §87).

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `requests/sessions.py::Session.mount` | similar_name | The mechanism answer to the PROSE twin. Returning it here would convert an absence into a guess. |

### `rq_setting_precedence` — configuration_precedence

> When a value is set both on the session and on the individual request, which one is used?

phrasing: behavioral_prose · falsePremise: false

merge_setting resolves the precedence. merge_hooks delegates to it, so delivering it is defensible rather than wrong — recorded as an acceptable alternate, not a distractor to punish.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `requests/sessions.py::merge_setting` | `requests/sessions.py:50-78` | Session values seed the merge, request values update over them, and keys set to None are deleted — request wins, None removes. |

Acceptable alternates: `requests/sessions.py::merge_hooks`

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `requests/sessions.py::merge_hooks` | similar_name | Adjacent, near-identical signature, but only special-cases the hooks dict. |

### `rq_encoding_fallback` — fallback

> What happens when the server does not say what character encoding the body uses?

phrasing: behavioral_prose · falsePremise: false

A two-part fallback: the property implements the branch, the helper supplies the value it falls back to.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `requests/models.py::Response.text` | `requests/models.py:846-881` | Falls back to self.apparent_encoding when self.encoding is None, then decodes with errors='replace'. |
| ORDERING_PREREQUISITE | `requests/models.py::Response.apparent_encoding` | `requests/models.py:735-737` | Supplies the guessed encoding the fallback branch uses. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `requests/models.py::Response.content` | consumer_of_the_answer | The bytes the decision operates on; explains nothing about encoding choice. |

### `rq_redirect_auth_reuse` — project_name_reuse

> Does requests already have a helper that decides whether to drop the authorization header on a redirect?

phrasing: behavioral_prose · falsePremise: false

Natural reuse phrasing ('does <project> already have...'). The project token is legitimate ROUTING evidence and illegitimate SYMBOL evidence — the generic form of the ARC 'query says ARC, class ARC promoted' defect.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `requests/sessions.py::SessionRedirectMixin.rebuild_auth` | `requests/sessions.py:254-270` | Strips Authorization when should_strip_auth says the host changed, then reapplies any netrc credentials. |
| ORDERING_PREREQUISITE | `requests/sessions.py::SessionRedirectMixin.should_strip_auth` | `requests/sessions.py:119-142` | Holds the actual same-host/scheme-upgrade predicate. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `requests/models.py::Request` | project_name_symbol | The project name 'requests' appears in the query; this symbol must not gain relevance from that token. |
| `requests/sessions.py::Session` | project_name_symbol | Same: routing may use the project name, symbol scoring may not. |

## flask — web framework (CALIBRATION)

Instance `pallets__flask-5014` @ `7ee9ceb71e868944a46e1ff00b506772a53a4f1d` — 5 cases.

### `fl_error_handler_dispatch` — dispatch

> How does the application decide which error handler runs for a raised exception?

phrasing: behavioral_prose · falsePremise: false

The mechanism spans two FILES: the precedence loop in app.py and the key normalisation in scaffold.py. A single-symbol answer is incomplete, and both callers outrank the decision on ordinary lexical grounds.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/flask/app.py::Flask._find_error_handler` | `src/flask/app.py:1238-1259` | Three nested loops: status code then None, blueprint scopes then app, exception MRO — first hit wins. |
| ORDERING_PREREQUISITE | `src/flask/scaffold.py::Scaffold._get_exc_class_and_code` | `src/flask/scaffold.py:729-770` | Turns the raised object into the (class, code) pair the lookup is keyed on. |
| REGISTRATION_SOURCE | `src/flask/scaffold.py::Scaffold.register_error_handler` | `src/flask/scaffold.py:714-726` | Populates error_handler_spec, the structure the lookup ranges over. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/flask/app.py::Flask.handle_user_exception` | consumer_of_the_answer | Calls _find_error_handler. Leading with it is the §45 consumer inversion. |
| `src/flask/app.py::Flask.handle_http_exception` | consumer_of_the_answer | Second caller of the same decision. |

### `fl_error_handler_scoring_false_premise` — dispatch

> Where are the error handlers scored so the best match can be chosen?

phrasing: behavioral_prose · falsePremise: true

No scoring exists anywhere in the path. A truthful answer explains that ordering encodes specificity; inventing a scoring helper is the failure this case measures.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/flask/app.py::Flask._find_error_handler` | `src/flask/app.py:1238-1259` | There is no score. Specificity is encoded in the ITERATION ORDER of the nested loops. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/flask/app.py::Flask.handle_user_exception` | consumer_of_the_answer | Attractive to a query about choosing, implements no choice. |

### `fl_project_name_reuse` — project_name_reuse

> Does Flask already have a helper for finding the handler registered for an exception?

phrasing: behavioral_prose · falsePremise: false

The sharpest available generic form of the ARC defect: 'Flask' is simultaneously the project name and a real class. Correct behaviour uses it for routing and discards it for symbol relevance (§33, §53).

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/flask/app.py::Flask._find_error_handler` | `src/flask/app.py:1238-1259` | Exactly the helper being asked about. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/flask/app.py::Flask` | project_name_symbol | The project name IS a class here. The token must route to this repository without promoting the class itself. |

### `fl_response_coercion` — dispatch

> How is whatever a view function returns turned into an actual response?

phrasing: behavioral_prose · falsePremise: false

A single-symbol answer, included so the corpus is not exclusively multi-part.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/flask/app.py::Flask.make_response` | `src/flask/app.py:1732-1870` | Type-dispatches over the return value: tuple unpacking, str/bytes, dict/list, WSGI callable, Response passthrough. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/flask/app.py::Flask.finalize_request` | consumer_of_the_answer | Calls make_response then runs after-request handlers. |

### `fl_env_config_precedence` — configuration_precedence

> How are configuration values picked up from the environment?

phrasing: behavioral_prose · falsePremise: false

Three sibling loaders share a file, a prefix and a docstring vocabulary; only one reads the environment.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/flask/config.py::Config.from_prefixed_env` | `src/flask/config.py:101-163` | Selects os.environ keys by prefix, parses each with json.loads, and walks __ separators to assign into nested dicts. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/flask/config.py::Config.from_object` | same_file_unrelated | Sibling loader, different source. |
| `src/flask/config.py::Config.from_pyfile` | same_file_unrelated | Sibling loader, different source. |

## pytest — CLI test runner / plugin host (CALIBRATION)

Instance `pytest-dev__pytest-7432` @ `e6e300e729dd33956e5448d8be9a0b1540b4e53a` — 5 cases.

### `pt_fixture_applicability` — selection

> How is it decided which fixture definitions apply to a particular test?

phrasing: behavioral_prose · falsePremise: false

The public-looking method is a thin wrapper; the discriminating rule lives in the private generator it delegates to.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/_pytest/fixtures.py::FixtureManager.getfixturedefs` | `src/_pytest/fixtures.py:1668-1682` | Looks the name up in _arg2fixturedefs then filters by node relationship. |
| ORDERING_PREREQUISITE | `src/_pytest/fixtures.py::FixtureManager._matchfactories` | `src/_pytest/fixtures.py:1684-1691` | Holds the actual visibility rule: keep a fixturedef only if its baseid is an ancestor of the requesting node. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/_pytest/fixtures.py::FixtureManager.getfixtureclosure` | consumer_of_the_answer | Builds the transitive closure by calling the above. |

### `pt_fixture_override` — override_resolution

> If a fixture with the same name is defined in both a conftest and the test module, which one wins?

phrasing: behavioral_prose · falsePremise: false

Override precedence is carried entirely by a negative list index. Nothing in the code is named 'override' or 'precedence' — the case tests whether the mechanism is reachable without a lexical hook.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/_pytest/fixtures.py::FixtureRequest._getnextfixturedef` | `src/_pytest/fixtures.py:469-486` | Indexes the fixturedef list from the END with a decreasing index, so the most specific (last registered) definition is taken first. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/_pytest/fixtures.py::FixtureManager.getfixturedefs` | same_operation_wrong_subject | Decides APPLICABILITY, not precedence among applicable definitions. |

### `pt_fixture_ranking_false_premise` — ordering

> Where is the function that ranks fixtures by priority?

phrasing: behavioral_prose · falsePremise: true · paired with `pt_rank_fixtures_identifier`

No priority ranking function exists. Scope ordering (sort_by_scope inside getfixtureclosure) is a defensible alternate reading, so it is recorded as acceptable rather than wrong.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/_pytest/fixtures.py::FixtureRequest._getnextfixturedef` | `src/_pytest/fixtures.py:469-486` | The nearest real thing to 'priority': list position, consumed from the end. |

Acceptable alternates: `src/_pytest/fixtures.py::FixtureManager.getfixtureclosure`

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/_pytest/fixtures.py::FixtureManager._matchfactories` | similar_name | 'match' reads like ranking; it filters. |

### `pt_rank_fixtures_identifier` — explicit_identifier_absence

> Where is rank_fixtures defined?

phrasing: explicit_identifier · falsePremise: true · **expects a bounded absence** · paired with `pt_fixture_ranking_false_premise`

Identifier syntax for a symbol that does not exist. Absence must survive (§87).

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/_pytest/fixtures.py::FixtureRequest._getnextfixturedef` | similar_name | Correct for the prose twin, wrong here. |

### `pt_fixture_scope_ordering` — ordering

> In what order are a test's fixtures set up?

phrasing: behavioral_prose · falsePremise: false

The ordering rule is a nested helper (sort_by_scope) inside the closure builder, i.e. below symbol granularity — tests whether the enclosing definition is delivered.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `src/_pytest/fixtures.py::FixtureManager.getfixtureclosure` | `src/_pytest/fixtures.py:1526-1574` | Builds the closure then sorts argnames by fixture scope, so broader scopes are set up first. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `src/_pytest/fixtures.py::FixtureManager.getfixturedefs` | same_operation_wrong_subject | Applicability again, not ordering. |

## sphinx — documentation compiler / parser host (CALIBRATION)

Instance `sphinx-doc__sphinx-9711` @ `81a4fd973d4cfcb25d01a7b0be62cdb28f82406d` — 5 cases.

### `sp_parser_selection` — parser_selection

> How does the build decide which parser reads a given source file?

phrasing: behavioral_prose · falsePremise: false

Selection is genuinely two-stage and split across two files: suffix→filetype (config-driven, ordered, first match) then filetype→parser (dict). Delivering only one is a partial answer.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `sphinx/util/__init__.py::get_filetype` | `sphinx/util/__init__.py:94-100` | First suffix in source_suffix that the filename ends with decides the filetype; no match raises FiletypeNotFoundError. |
| PRIMARY_IMPLEMENTER | `sphinx/registry.py::SphinxComponentRegistry.get_source_parser` | `sphinx/registry.py:280-284` | Maps that filetype to the registered parser class. |
| REGISTRATION_SOURCE | `sphinx/registry.py::SphinxComponentRegistry.add_source_parser` | `sphinx/registry.py:269-278` | Builds the filetype→parser map from each parser's `supported` tuple. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `sphinx/registry.py::SphinxComponentRegistry.create_source_parser` | consumer_of_the_answer | Instantiates the chosen class; contains no selection. |
| `sphinx/registry.py::SphinxComponentRegistry.get_source_parsers` | cache_or_accessor | Plain accessor returning the map. |

### `sp_project_name_reuse` — project_name_reuse

> Does Sphinx already have a helper that maps a source file's suffix to its file type?

phrasing: behavioral_prose · falsePremise: false

Second instance of the natural reuse phrasing, in a repository where the project-name symbol is additionally the most central class. Routing may use the token; symbol relevance may not.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `sphinx/util/__init__.py::get_filetype` | `sphinx/util/__init__.py:94-100` | Precisely the helper asked for. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `sphinx/application.py::Sphinx` | project_name_symbol | Project name is also the central application class — high centrality AND name match, the worst combination. |

### `sp_xref_resolution` — fallback

> How is a cross reference matched to the object it points at when the name is not fully qualified?

phrasing: behavioral_prose · falsePremise: false

A case where the consumer is lexically the better match ('resolve_xref' vs 'find_obj') while the implementer is the answer — the §45 discrimination stated in the hardest direction.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `sphinx/domains/python.py::PythonDomain.find_obj` | `sphinx/domains/python.py:1265-1319` | Cascades module+class qualified, module qualified, bare name, then suffix-matching fuzzy search. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `sphinx/domains/python.py::PythonDomain.resolve_xref` | consumer_of_the_answer | Calls find_obj and formats the result; the name matches the query's vocabulary far better than the answer's does. |

### `sp_builder_selection` — selection

> How is the requested output builder located and instantiated?

phrasing: behavioral_prose · falsePremise: false

Ordinary two-part registry lookup with a lazy-registration prerequisite. Included as a moderate-difficulty control.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `sphinx/registry.py::SphinxComponentRegistry.create_builder` | `sphinx/registry.py:155-159` | Rejects unregistered names, otherwise constructs self.builders[name]. |
| REGISTRATION_SOURCE | `sphinx/registry.py::SphinxComponentRegistry.preload_builder` | `sphinx/registry.py:141-153` | Loads the entry-point extension that registers the builder, so an unknown name can become known first. |

### `sp_parser_registry_false_premise` — parser_selection

> Where is the list of parsers ordered by priority?

phrasing: behavioral_prose · falsePremise: true

Parsers are keyed by filetype, never prioritised. The only order is over config suffixes. The attractive wrong answer literally returns a parser collection.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `sphinx/util/__init__.py::get_filetype` | `sphinx/util/__init__.py:94-100` | The only ordering that exists is the iteration order of the source_suffix config mapping. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `sphinx/registry.py::SphinxComponentRegistry.get_source_parsers` | cache_or_accessor | Returns 'the list of parsers' literally, but carries no priority. |

## xarray — scientific array IO (HOLDOUT)

Instance `pydata__xarray-6599` @ `6bb2b855498b5c68d7cca8cceb710365d58e6048` — 4 cases.

### `xr_backend_selection` — backend_selection

> How is it decided which backend opens a given file?

phrasing: behavioral_prose · falsePremise: false

First-success over an explicitly ordered registry. get_backend is the sharpest distractor because it is the same subject (backends) and the opposite operation (explicit lookup vs inference).

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `xarray/backends/plugins.py::guess_engine` | `xarray/backends/plugins.py:107-153` | Iterates installed engines in order and returns the first whose guess_can_open accepts the spec. |
| ORDERING_PREREQUISITE | `xarray/backends/plugins.py::sort_backends` | `xarray/backends/plugins.py:73-81` | STANDARD_BACKENDS_ORDER first, remaining names alphabetically — the order 'first match' resolves against. |

Acceptable alternates: `xarray/backends/plugins.py::build_engines`

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `xarray/backends/plugins.py::get_backend` | same_file_unrelated | Resolves an EXPLICITLY named engine; performs no guessing. |
| `xarray/backends/plugins.py::list_engines` | cache_or_accessor | Enumerates entry points; decides nothing. |

### `xr_backend_scoring_false_premise` — backend_selection

> Where are the backends scored so the best match for a file can be chosen?

phrasing: behavioral_prose · falsePremise: true · paired with `xr_score_backends_identifier`

'Best match' implies comparison; the code short-circuits on the first acceptance. Truthful reconstruction names the ordering plus first-success and denies the scoring.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `xarray/backends/plugins.py::guess_engine` | `xarray/backends/plugins.py:107-153` | No scoring: the first accepting backend wins outright. |
| ORDERING_PREREQUISITE | `xarray/backends/plugins.py::sort_backends` | `xarray/backends/plugins.py:73-81` | Fixed precedence list stands in for what the query calls a score. |

### `xr_score_backends_identifier` — explicit_identifier_absence

> Where is score_backends defined?

phrasing: explicit_identifier · falsePremise: true · **expects a bounded absence** · paired with `xr_backend_scoring_false_premise`

The hardest absence case in the corpus: a real symbol differs from the requested identifier by a single word and is topically correct. Absence must still win.

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `xarray/backends/plugins.py::sort_backends` | similar_name | One token away from the requested identifier and genuinely about backend order. |

### `xr_backend_order` — registration_ordering

> What determines the order the file backends are tried in?

phrasing: behavioral_prose · falsePremise: false

Deliberate inverse of xr_backend_selection over the same two symbols: swapping the operation must swap the lead. Tests operation discrimination with subject held constant (§49).

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `xarray/backends/plugins.py::sort_backends` | `xarray/backends/plugins.py:73-81` | Directly implements the ordering the query asks about. |
| REGISTRATION_SOURCE | `xarray/backends/plugins.py::build_engines` | `xarray/backends/plugins.py:84-94` | Merges built-in and external entry points before sorting. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `xarray/backends/plugins.py::guess_engine` | consumer_of_the_answer | Consumes the order. Correct lead for the SELECTION query, wrong lead for the ORDERING query. |

## astropy — scientific library with a unified IO registry (HOLDOUT)

Instance `astropy__astropy-14598` @ `80c3854a5f4f4a6ab86c03d9db7854767fcd83c1` — 4 cases.

### `ap_format_identification` — selection

> How is a file's format worked out when the caller does not say what it is?

phrasing: behavioral_prose · falsePremise: false

Candidate generation and resolution are separate methods; both are needed.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `astropy/io/registry/base.py::_UnifiedIORegistryBase._get_valid_format` | `astropy/io/registry/base.py:349-367` | Errors on zero matches, delegates a tie, otherwise returns the single match. |
| ORDERING_PREREQUISITE | `astropy/io/registry/base.py::_UnifiedIORegistryBase.identify_format` | `astropy/io/registry/base.py:282-318` | Runs every registered identifier function to produce the candidate list. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `astropy/io/registry/base.py::_UnifiedIORegistryBase._get_format_table_str` | same_file_unrelated | Formats the error message listing available formats. |

### `ap_format_priority_tiebreak` — priority_table_lookup

> What happens when more than one format claims it can read the same file?

phrasing: behavioral_prose · falsePremise: false

The one case in the corpus where a genuine numeric priority table DOES exist — the control against concluding that behavioural questions never have scores.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `astropy/io/registry/base.py::_UnifiedIORegistryBase._get_highest_priority_format` | `astropy/io/registry/base.py:369-402` | Scans registered priorities, keeps the maximum, and raises IORegistryError when the maximum is shared. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `astropy/io/registry/base.py::_UnifiedIORegistryBase._get_valid_format` | consumer_of_the_answer | Detects the tie and delegates it. |

### `ap_registered_class_match` — override_resolution

> When a class and its parent both register a reader, which registration is used?

phrasing: behavioral_prose · falsePremise: false

MRO-nearest-ancestor resolution; a subclass registration supersedes its parent's.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `astropy/io/registry/base.py::_UnifiedIORegistryBase._is_best_match` | `astropy/io/registry/base.py:330-347` | Walks class1.__mro__ and accepts class2 only if it is the NEAREST registered ancestor. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `astropy/io/registry/base.py::_UnifiedIORegistryBase.identify_format` | consumer_of_the_answer | Calls _is_best_match once per registered identifier. |

### `ap_project_name_reuse` — project_name_reuse

> Does astropy already have a helper that decides between competing registered readers?

phrasing: behavioral_prose · falsePremise: false

Reuse phrasing in a HOLDOUT repository, so the project-name discrimination is measured on repositories that supplied no development pressure.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `astropy/io/registry/base.py::_UnifiedIORegistryBase._get_highest_priority_format` | `astropy/io/registry/base.py:369-402` | The competing-reader resolver being asked about. |

## pylint — CLI static analyser (HOLDOUT)

Instance `pylint-dev__pylint-8898` @ `1f8c4d9eb185c16a2c1d881c054f015e1c2eb334` — 4 cases.

### `pl_reporter_selection` — fallback

> How does the linter turn a reporter name given on the command line into a reporter?

phrasing: behavioral_prose · falsePremise: false

Registry-then-import fallback. The singular/plural name pair is an unusually harsh lexical trap.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `pylint/lint/pylinter.py::PyLinter._load_reporter_by_name` | `pylint/lint/pylinter.py:450-460` | Tries the built-in registry first, then falls back to importing a dotted class path. |
| ORDERING_PREREQUISITE | `pylint/lint/pylinter.py::_load_reporter_by_class` | `pylint/lint/pylinter.py:88-95` | Implements the fallback import branch. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `pylint/lint/pylinter.py::PyLinter._load_reporters` | consumer_of_the_answer | Plural caller that splits comma-separated names; lexically nearly identical to the answer. |

### `pl_checker_activation` — selection

> How is it decided which checkers actually run for a given configuration?

phrasing: behavioral_prose · falsePremise: false

Enablement filter over a registered list; registration is a prerequisite, not the answer.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `pylint/lint/pylinter.py::PyLinter.prepare_checkers` | `pylint/lint/pylinter.py:571-581` | Keeps a checker only if it owns an enabled message or an enabled report. |
| REGISTRATION_SOURCE | `pylint/lint/pylinter.py::PyLinter.get_checkers` | `pylint/lint/pylinter.py:557-559` | Supplies the ordered candidate list the filter runs over. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `pylint/lint/pylinter.py::PyLinter.register_checker` | same_operation_wrong_subject | Registration, not activation. |

### `pl_reporter_ranking_false_premise` — selection

> Where are the available reporters ranked to pick a default?

phrasing: behavioral_prose · falsePremise: true

Both halves of the premise are false (no ranking, no elected default). Correct behaviour reconstructs the lookup-or-import mechanism and denies the rest.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `pylint/lint/pylinter.py::PyLinter._load_reporter_by_name` | `pylint/lint/pylinter.py:450-460` | No ranking and no default election: the name is looked up, or imported, or an error is raised. |

### `pl_project_name_reuse` — project_name_reuse

> Does pylint already have a helper that filters checkers down to the ones with enabled messages?

phrasing: behavioral_prose · falsePremise: false

Third reuse case, in a holdout repository, where the project-name symbol is also the highest-centrality class.

| Role | Symbol | Span | Why |
| --- | --- | --- | --- |
| PRIMARY_IMPLEMENTER | `pylint/lint/pylinter.py::PyLinter.prepare_checkers` | `pylint/lint/pylinter.py:571-581` | The filter being asked about. |

| Distractor | Kind | Why it attracts |
| --- | --- | --- |
| `pylint/lint/pylinter.py::PyLinter` | project_name_symbol | 'PyLinter' is a near-exact match for the project token and the most central class in the repository. |

## Ambiguous — no single correct repository

### `amb_plugin_loading` — selection

> How does the tool decide which plugins to load at startup?

pytest, sphinx and pylint all load plugins/extensions at startup by genuinely comparable mechanisms. No repository is the answer. Bounded ambiguity or abstention is correct; a confident lead is a forced route.

### `amb_config_file_vs_cli` — configuration_precedence

> When a setting appears both in a configuration file and on the command line, which one takes effect?

pytest and pylint both resolve this, and flask resolves the adjacent file-vs-environment case. Abstention or bounded ambiguity is correct.

## Ground-truth file digests

| Repository | File | sha256[0:16] |
| --- | --- | --- |
| requests | `requests/adapters.py` | `6097ffd12d892f97` |
| requests | `requests/models.py` | `c51202c76971a029` |
| requests | `requests/sessions.py` | `66ef98f583e5c132` |
| flask | `src/flask/app.py` | `d439102c7658f90f` |
| flask | `src/flask/config.py` | `584fd038985cd82c` |
| flask | `src/flask/scaffold.py` | `12d4caff83fd4f57` |
| pytest | `src/_pytest/fixtures.py` | `7f34bd21a2c6b530` |
| sphinx | `sphinx/application.py` | `d25edd6293993cd6` |
| sphinx | `sphinx/domains/python.py` | `985527409956c2aa` |
| sphinx | `sphinx/registry.py` | `87168beaa82b18f5` |
| sphinx | `sphinx/util/__init__.py` | `b971be811c28b2d1` |
| xarray | `xarray/backends/plugins.py` | `d171ddc5699b9444` |
| astropy | `astropy/io/registry/base.py` | `03bc10343aabf53b` |
| pylint | `pylint/lint/pylinter.py` | `febc7a75f59c6274` |

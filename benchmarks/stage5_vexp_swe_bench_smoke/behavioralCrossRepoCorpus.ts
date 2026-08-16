// The behavioural cross-repository corpus.
//
// WHY THIS EXISTS
// ----------------
// Every behavioural capability from M142 through M150 was developed while
// looking at ARC. That is not an accusation of cheating — ARC was a genuine
// diagnostic — but it does mean the evidence for "VTRACE understands behaviour"
// and the evidence for "VTRACE understands ARC" have never been separated. This
// corpus separates them: it is built from repositories that supplied NONE of the
// development pressure, and its ground truth was read out of their source rather
// than inferred from anything VTRACE returned.
//
// The corpus is deliberately NOT named after M153. It is intended to outlive the
// milestone as a permanent generalisation suite (§120, §121).
//
// TWO STAGES, MEASURED SEPARATELY
// -------------------------------
// Each case is scored twice (§25). ORACLE mode forces the known repository and
// asks only whether in-repository retrieval finds the mechanism — that measures
// M150. WORKSPACE mode registers every corpus repository and gives no path or
// symbol hint — that measures repository nomination. Conflating them would let a
// routing defect masquerade as a retrieval defect, and vice versa.
//
// GROUND TRUTH DISCIPLINE
// ------------------------
// `sourceSpan` on every expected item is a real file:line range that was read.
// `fileDigests` in the provenance block pins the CONTENT of each ground-truth
// file, which is what actually protects the corpus: a commit SHA tells you the
// tree moved, a digest tells you THIS mechanism moved (§122).
//
// Queries never name the implementation symbol. They are worded the way somebody
// who has not read the code would ask, because that is the request shape the
// behavioural lane exists to serve.

/**
 * What a piece of expected evidence contributes. Aligned with VTRACE's existing
 * `OperationRole` (direct implementer / consumer) rather than a parallel
 * ontology (§20); the extra members name the producer kinds that M150 already
 * reasons about but that `OperationRole` collapses.
 */
export type EvidenceRole =
  /** Performs the requested behaviour. The answer, if there is a single one. */
  | "PRIMARY_IMPLEMENTER"
  /** Establishes the order the primary implementer then consumes. */
  | "ORDERING_PREREQUISITE"
  /** Where the candidates enter the collection the behaviour ranges over. */
  | "REGISTRATION_SOURCE"
  /** Supplies the configured input the decision reads. */
  | "CONFIG_SOURCE"
  /** Calls the decision. Useful context, never the answer (§45). */
  | "CONSUMER"
  /** Genuine background; neither necessary nor misleading. */
  | "SUPPORT";

/**
 * Why a distractor is attractive. These are the generic forms of the failures
 * ARC exposed — recorded per case so noise is measurable, not anecdotal (§21).
 */
export type DistractorKind =
  /** Performs the SAME operation on a DIFFERENT subject. The M150 core failure. */
  | "same_operation_wrong_subject"
  /** Calls the answer. Delivering it AS the answer is the §45 inversion. */
  | "consumer_of_the_answer"
  /** Shares the file, answers nothing. */
  | "same_file_unrelated"
  /** Lexically close to the query's nouns. */
  | "similar_name"
  /** Caches or exposes the result instead of computing it. */
  | "cache_or_accessor"
  /** Named after the PROJECT the query mentions. Must never gain symbol relevance. */
  | "project_name_symbol"
  /** Documentation carrying the query's vocabulary. */
  | "docs_only"
  /** Tests naming the behaviour without implementing it. */
  | "tests_only"
  /** Reached from everywhere; wins on graph position rather than meaning. */
  | "high_centrality";

export type BehaviorCategory =
  | "selection"
  | "ordering"
  | "dispatch"
  | "fallback"
  | "configuration_precedence"
  | "override_resolution"
  | "parser_selection"
  | "backend_selection"
  | "registration_ordering"
  | "priority_table_lookup"
  | "project_name_reuse"
  | "explicit_identifier_absence";

/**
 * How the request is phrased, which decides what a truthful answer looks like.
 * §86: the same missing abstraction must produce an ABSENCE for an identifier
 * lookup and a mechanism reconstruction for prose. Cases come in pairs so the
 * distinction is measured rather than assumed.
 */
export type QueryKind = "behavioral_prose" | "explicit_identifier";

export interface ExpectedEvidence {
  /** Indexed fully-qualified name: `<repo-relative path>::<dotted symbol>`. */
  readonly fqName: string;
  readonly path: string;
  readonly role: EvidenceRole;
  /** `file:startLine-endLine` as actually read. */
  readonly sourceSpan: string;
  /** Why this code, in one line, from the source. */
  readonly why: string;
}

export interface Distractor {
  readonly fqName: string;
  readonly path: string;
  readonly kind: DistractorKind;
  readonly why: string;
}

export interface BehavioralCase {
  readonly id: string;
  /** Corpus repository key, or null when the request is genuinely ambiguous. */
  readonly expectedRepository: string | null;
  readonly category: BehaviorCategory;
  readonly query: string;
  readonly queryKind: QueryKind;
  /**
   * Does the query presuppose an abstraction that does not exist? §16. When
   * true the measurement is whether VTRACE reconstructs the real mechanism or
   * invents a plausible symbol.
   */
  readonly falsePremise: boolean;
  /**
   * The truthful outcome is a bounded absence, not a mechanism. Only ever set
   * on `explicit_identifier` cases (§86, §87).
   */
  readonly expectAbsence?: boolean;
  /**
   * Several repositories genuinely implement this. Abstention or bounded
   * ambiguity is correct; a confident lead is a forced route (§81).
   */
  readonly ambiguous?: boolean;
  /** The paired case testing the same missing abstraction in the other phrasing. */
  readonly pairedControl?: string;
  readonly expected: readonly ExpectedEvidence[];
  /** Defensible alternatives that must not be scored as failures. */
  readonly acceptableAlternates?: readonly string[];
  readonly distractors: readonly Distractor[];
  /** What the source actually does, written before any VTRACE run. */
  readonly groundTruth: string;
}

export interface CorpusRepository {
  readonly key: string;
  /** SWE-bench instance whose checkout supplies the pinned tree. */
  readonly instanceId: string;
  readonly baseCommit: string;
  readonly domain: string;
  /**
   * §73: the split is by REPOSITORY, not by query. Holdout repositories supply
   * no development pressure at all, which is stronger evidence than holding out
   * a random subset of queries from repositories already being tuned against.
   */
  readonly split: "calibration" | "holdout";
}

export const CORPUS_REPOSITORIES: readonly CorpusRepository[] = [
  {
    key: "requests",
    instanceId: "psf__requests-5414",
    baseCommit: "39d0fdd9096f7dceccbc8f82e1eda7dd64717a8e",
    domain: "HTTP client library",
    split: "calibration",
  },
  {
    key: "flask",
    instanceId: "pallets__flask-5014",
    baseCommit: "7ee9ceb71e868944a46e1ff00b506772a53a4f1d",
    domain: "web framework",
    split: "calibration",
  },
  {
    key: "pytest",
    instanceId: "pytest-dev__pytest-7432",
    baseCommit: "e6e300e729dd33956e5448d8be9a0b1540b4e53a",
    domain: "CLI test runner / plugin host",
    split: "calibration",
  },
  {
    key: "sphinx",
    instanceId: "sphinx-doc__sphinx-9711",
    baseCommit: "81a4fd973d4cfcb25d01a7b0be62cdb28f82406d",
    domain: "documentation compiler / parser host",
    split: "calibration",
  },
  {
    key: "xarray",
    instanceId: "pydata__xarray-6599",
    baseCommit: "6bb2b855498b5c68d7cca8cceb710365d58e6048",
    domain: "scientific array IO",
    split: "holdout",
  },
  {
    key: "astropy",
    instanceId: "astropy__astropy-14598",
    baseCommit: "80c3854a5f4f4a6ab86c03d9db7854767fcd83c1",
    domain: "scientific library with a unified IO registry",
    split: "holdout",
  },
  {
    key: "pylint",
    instanceId: "pylint-dev__pylint-8898",
    baseCommit: "1f8c4d9eb185c16a2c1d881c054f015e1c2eb334",
    domain: "CLI static analyser",
    split: "holdout",
  },
];

export const BEHAVIORAL_CASES: readonly BehavioralCase[] = [
  // ===================================================================
  // requests — HTTP client library (CALIBRATION)
  // ===================================================================
  {
    id: "rq_adapter_selection",
    expectedRepository: "requests",
    category: "selection",
    query: "How does the session decide which connection adapter handles a URL?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "requests/sessions.py::Session.get_adapter",
        path: "requests/sessions.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "requests/sessions.py:720-732",
        why: "Iterates self.adapters and returns the first whose prefix the URL starts with.",
      },
      {
        fqName: "requests/sessions.py::Session.mount",
        path: "requests/sessions.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "requests/sessions.py:739-748",
        why: "Re-inserts shorter prefixes after the new one, keeping adapters in descending prefix length — the reason 'first match' means 'longest match'.",
      },
    ],
    distractors: [
      {
        fqName: "requests/sessions.py::Session.close",
        path: "requests/sessions.py",
        kind: "same_file_unrelated",
        why: "Also iterates self.adapters, decides nothing.",
      },
      {
        fqName: "requests/adapters.py::HTTPAdapter.get_connection",
        path: "requests/adapters.py",
        kind: "similar_name",
        why: "'get_connection' on an adapter — picks a urllib3 pool, not an adapter.",
      },
    ],
    groundTruth:
      "Two definitions are jointly necessary. get_adapter is a first-prefix-match loop; on its own it does not explain why the match is the LONGEST prefix. mount supplies that by maintaining the ordering invariant. Neither alone is a complete answer (§19).",
  },
  {
    id: "rq_adapter_ranking_false_premise",
    expectedRepository: "requests",
    category: "ordering",
    query: "Where is the function that ranks the connection adapters?",
    queryKind: "behavioral_prose",
    falsePremise: true,
    pairedControl: "rq_rank_adapters_identifier",
    expected: [
      {
        fqName: "requests/sessions.py::Session.mount",
        path: "requests/sessions.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "requests/sessions.py:739-748",
        why: "The ordering the query calls 'ranking' is established here, as a side effect of registration.",
      },
      {
        fqName: "requests/sessions.py::Session.get_adapter",
        path: "requests/sessions.py",
        role: "CONSUMER",
        sourceSpan: "requests/sessions.py:720-732",
        why: "Consumes that order by taking the first match.",
      },
    ],
    distractors: [
      {
        fqName: "requests/adapters.py::HTTPAdapter.get_connection",
        path: "requests/adapters.py",
        kind: "similar_name",
        why: "Nearest thing to a 'ranking' symbol; ranks nothing.",
      },
    ],
    groundTruth:
      "There is no ranking function. Ordering is a side effect of mount() and consumption is a first-match loop in get_adapter(). A truthful answer reconstructs that pair; inventing or promoting a 'rank'-shaped symbol is the failure.",
  },
  {
    id: "rq_rank_adapters_identifier",
    expectedRepository: "requests",
    category: "explicit_identifier_absence",
    query: "Where is rank_adapters defined?",
    queryKind: "explicit_identifier",
    falsePremise: true,
    expectAbsence: true,
    pairedControl: "rq_adapter_ranking_false_premise",
    expected: [],
    distractors: [
      {
        fqName: "requests/sessions.py::Session.mount",
        path: "requests/sessions.py",
        kind: "similar_name",
        why: "The mechanism answer to the PROSE twin. Returning it here would convert an absence into a guess.",
      },
    ],
    groundTruth:
      "`rank_adapters` does not exist. Because the request is identifier syntax, the truthful answer is a bounded absence — NOT the mechanism its prose twin correctly reconstructs (§86, §87).",
  },
  {
    id: "rq_setting_precedence",
    expectedRepository: "requests",
    category: "configuration_precedence",
    query: "When a value is set both on the session and on the individual request, which one is used?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "requests/sessions.py::merge_setting",
        path: "requests/sessions.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "requests/sessions.py:50-78",
        why: "Session values seed the merge, request values update over them, and keys set to None are deleted — request wins, None removes.",
      },
    ],
    acceptableAlternates: ["requests/sessions.py::merge_hooks"],
    distractors: [
      {
        fqName: "requests/sessions.py::merge_hooks",
        path: "requests/sessions.py",
        kind: "similar_name",
        why: "Adjacent, near-identical signature, but only special-cases the hooks dict.",
      },
    ],
    groundTruth:
      "merge_setting resolves the precedence. merge_hooks delegates to it, so delivering it is defensible rather than wrong — recorded as an acceptable alternate, not a distractor to punish.",
  },
  {
    id: "rq_encoding_fallback",
    expectedRepository: "requests",
    category: "fallback",
    query: "What happens when the server does not say what character encoding the body uses?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "requests/models.py::Response.text",
        path: "requests/models.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "requests/models.py:846-881",
        why: "Falls back to self.apparent_encoding when self.encoding is None, then decodes with errors='replace'.",
      },
      {
        fqName: "requests/models.py::Response.apparent_encoding",
        path: "requests/models.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "requests/models.py:735-737",
        why: "Supplies the guessed encoding the fallback branch uses.",
      },
    ],
    distractors: [
      {
        fqName: "requests/models.py::Response.content",
        path: "requests/models.py",
        kind: "consumer_of_the_answer",
        why: "The bytes the decision operates on; explains nothing about encoding choice.",
      },
    ],
    groundTruth:
      "A two-part fallback: the property implements the branch, the helper supplies the value it falls back to.",
  },
  {
    id: "rq_redirect_auth_reuse",
    expectedRepository: "requests",
    category: "project_name_reuse",
    query: "Does requests already have a helper that decides whether to drop the authorization header on a redirect?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "requests/sessions.py::SessionRedirectMixin.rebuild_auth",
        path: "requests/sessions.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "requests/sessions.py:254-270",
        why: "Strips Authorization when should_strip_auth says the host changed, then reapplies any netrc credentials.",
      },
      {
        fqName: "requests/sessions.py::SessionRedirectMixin.should_strip_auth",
        path: "requests/sessions.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "requests/sessions.py:119-142",
        why: "Holds the actual same-host/scheme-upgrade predicate.",
      },
    ],
    distractors: [
      {
        fqName: "requests/models.py::Request",
        path: "requests/models.py",
        kind: "project_name_symbol",
        why: "The project name 'requests' appears in the query; this symbol must not gain relevance from that token.",
      },
      {
        fqName: "requests/sessions.py::Session",
        path: "requests/sessions.py",
        kind: "project_name_symbol",
        why: "Same: routing may use the project name, symbol scoring may not.",
      },
    ],
    groundTruth:
      "Natural reuse phrasing ('does <project> already have...'). The project token is legitimate ROUTING evidence and illegitimate SYMBOL evidence — the generic form of the ARC 'query says ARC, class ARC promoted' defect.",
  },

  // ===================================================================
  // flask — web framework (CALIBRATION)
  // ===================================================================
  {
    id: "fl_error_handler_dispatch",
    expectedRepository: "flask",
    category: "dispatch",
    query: "How does the application decide which error handler runs for a raised exception?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "src/flask/app.py::Flask._find_error_handler",
        path: "src/flask/app.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/flask/app.py:1238-1259",
        why: "Three nested loops: status code then None, blueprint scopes then app, exception MRO — first hit wins.",
      },
      {
        fqName: "src/flask/scaffold.py::Scaffold._get_exc_class_and_code",
        path: "src/flask/scaffold.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "src/flask/scaffold.py:729-770",
        why: "Turns the raised object into the (class, code) pair the lookup is keyed on.",
      },
      {
        fqName: "src/flask/scaffold.py::Scaffold.register_error_handler",
        path: "src/flask/scaffold.py",
        role: "REGISTRATION_SOURCE",
        sourceSpan: "src/flask/scaffold.py:714-726",
        why: "Populates error_handler_spec, the structure the lookup ranges over.",
      },
    ],
    distractors: [
      {
        fqName: "src/flask/app.py::Flask.handle_user_exception",
        path: "src/flask/app.py",
        kind: "consumer_of_the_answer",
        why: "Calls _find_error_handler. Leading with it is the §45 consumer inversion.",
      },
      {
        fqName: "src/flask/app.py::Flask.handle_http_exception",
        path: "src/flask/app.py",
        kind: "consumer_of_the_answer",
        why: "Second caller of the same decision.",
      },
    ],
    groundTruth:
      "The mechanism spans two FILES: the precedence loop in app.py and the key normalisation in scaffold.py. A single-symbol answer is incomplete, and both callers outrank the decision on ordinary lexical grounds.",
  },
  {
    id: "fl_error_handler_scoring_false_premise",
    expectedRepository: "flask",
    category: "dispatch",
    query: "Where are the error handlers scored so the best match can be chosen?",
    queryKind: "behavioral_prose",
    falsePremise: true,
    expected: [
      {
        fqName: "src/flask/app.py::Flask._find_error_handler",
        path: "src/flask/app.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/flask/app.py:1238-1259",
        why: "There is no score. Specificity is encoded in the ITERATION ORDER of the nested loops.",
      },
    ],
    distractors: [
      {
        fqName: "src/flask/app.py::Flask.handle_user_exception",
        path: "src/flask/app.py",
        kind: "consumer_of_the_answer",
        why: "Attractive to a query about choosing, implements no choice.",
      },
    ],
    groundTruth:
      "No scoring exists anywhere in the path. A truthful answer explains that ordering encodes specificity; inventing a scoring helper is the failure this case measures.",
  },
  {
    id: "fl_project_name_reuse",
    expectedRepository: "flask",
    category: "project_name_reuse",
    query: "Does Flask already have a helper for finding the handler registered for an exception?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "src/flask/app.py::Flask._find_error_handler",
        path: "src/flask/app.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/flask/app.py:1238-1259",
        why: "Exactly the helper being asked about.",
      },
    ],
    distractors: [
      {
        fqName: "src/flask/app.py::Flask",
        path: "src/flask/app.py",
        kind: "project_name_symbol",
        why: "The project name IS a class here. The token must route to this repository without promoting the class itself.",
      },
    ],
    groundTruth:
      "The sharpest available generic form of the ARC defect: 'Flask' is simultaneously the project name and a real class. Correct behaviour uses it for routing and discards it for symbol relevance (§33, §53).",
  },
  {
    id: "fl_response_coercion",
    expectedRepository: "flask",
    category: "dispatch",
    query: "How is whatever a view function returns turned into an actual response?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "src/flask/app.py::Flask.make_response",
        path: "src/flask/app.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/flask/app.py:1732-1870",
        why: "Type-dispatches over the return value: tuple unpacking, str/bytes, dict/list, WSGI callable, Response passthrough.",
      },
    ],
    distractors: [
      {
        fqName: "src/flask/app.py::Flask.finalize_request",
        path: "src/flask/app.py",
        kind: "consumer_of_the_answer",
        why: "Calls make_response then runs after-request handlers.",
      },
    ],
    groundTruth: "A single-symbol answer, included so the corpus is not exclusively multi-part.",
  },
  {
    id: "fl_env_config_precedence",
    expectedRepository: "flask",
    category: "configuration_precedence",
    query: "How are configuration values picked up from the environment?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "src/flask/config.py::Config.from_prefixed_env",
        path: "src/flask/config.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/flask/config.py:101-163",
        why: "Selects os.environ keys by prefix, parses each with json.loads, and walks __ separators to assign into nested dicts.",
      },
    ],
    distractors: [
      {
        fqName: "src/flask/config.py::Config.from_object",
        path: "src/flask/config.py",
        kind: "same_file_unrelated",
        why: "Sibling loader, different source.",
      },
      {
        fqName: "src/flask/config.py::Config.from_pyfile",
        path: "src/flask/config.py",
        kind: "same_file_unrelated",
        why: "Sibling loader, different source.",
      },
    ],
    groundTruth:
      "Three sibling loaders share a file, a prefix and a docstring vocabulary; only one reads the environment.",
  },

  // ===================================================================
  // pytest — CLI test runner / plugin host (CALIBRATION)
  // ===================================================================
  {
    id: "pt_fixture_applicability",
    expectedRepository: "pytest",
    category: "selection",
    query: "How is it decided which fixture definitions apply to a particular test?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureManager.getfixturedefs",
        path: "src/_pytest/fixtures.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/_pytest/fixtures.py:1668-1682",
        why: "Looks the name up in _arg2fixturedefs then filters by node relationship.",
      },
      {
        fqName: "src/_pytest/fixtures.py::FixtureManager._matchfactories",
        path: "src/_pytest/fixtures.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "src/_pytest/fixtures.py:1684-1691",
        why: "Holds the actual visibility rule: keep a fixturedef only if its baseid is an ancestor of the requesting node.",
      },
    ],
    distractors: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureManager.getfixtureclosure",
        path: "src/_pytest/fixtures.py",
        kind: "consumer_of_the_answer",
        why: "Builds the transitive closure by calling the above.",
      },
    ],
    groundTruth:
      "The public-looking method is a thin wrapper; the discriminating rule lives in the private generator it delegates to.",
  },
  {
    id: "pt_fixture_override",
    expectedRepository: "pytest",
    category: "override_resolution",
    query: "If a fixture with the same name is defined in both a conftest and the test module, which one wins?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureRequest._getnextfixturedef",
        path: "src/_pytest/fixtures.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/_pytest/fixtures.py:469-486",
        why: "Indexes the fixturedef list from the END with a decreasing index, so the most specific (last registered) definition is taken first.",
      },
    ],
    distractors: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureManager.getfixturedefs",
        path: "src/_pytest/fixtures.py",
        kind: "same_operation_wrong_subject",
        why: "Decides APPLICABILITY, not precedence among applicable definitions.",
      },
    ],
    groundTruth:
      "Override precedence is carried entirely by a negative list index. Nothing in the code is named 'override' or 'precedence' — the case tests whether the mechanism is reachable without a lexical hook.",
  },
  {
    id: "pt_fixture_ranking_false_premise",
    expectedRepository: "pytest",
    category: "ordering",
    query: "Where is the function that ranks fixtures by priority?",
    queryKind: "behavioral_prose",
    falsePremise: true,
    pairedControl: "pt_rank_fixtures_identifier",
    expected: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureRequest._getnextfixturedef",
        path: "src/_pytest/fixtures.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/_pytest/fixtures.py:469-486",
        why: "The nearest real thing to 'priority': list position, consumed from the end.",
      },
    ],
    acceptableAlternates: ["src/_pytest/fixtures.py::FixtureManager.getfixtureclosure"],
    distractors: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureManager._matchfactories",
        path: "src/_pytest/fixtures.py",
        kind: "similar_name",
        why: "'match' reads like ranking; it filters.",
      },
    ],
    groundTruth:
      "No priority ranking function exists. Scope ordering (sort_by_scope inside getfixtureclosure) is a defensible alternate reading, so it is recorded as acceptable rather than wrong.",
  },
  {
    id: "pt_rank_fixtures_identifier",
    expectedRepository: "pytest",
    category: "explicit_identifier_absence",
    query: "Where is rank_fixtures defined?",
    queryKind: "explicit_identifier",
    falsePremise: true,
    expectAbsence: true,
    pairedControl: "pt_fixture_ranking_false_premise",
    expected: [],
    distractors: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureRequest._getnextfixturedef",
        path: "src/_pytest/fixtures.py",
        kind: "similar_name",
        why: "Correct for the prose twin, wrong here.",
      },
    ],
    groundTruth: "Identifier syntax for a symbol that does not exist. Absence must survive (§87).",
  },
  {
    id: "pt_fixture_scope_ordering",
    expectedRepository: "pytest",
    category: "ordering",
    query: "In what order are a test's fixtures set up?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureManager.getfixtureclosure",
        path: "src/_pytest/fixtures.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "src/_pytest/fixtures.py:1526-1574",
        why: "Builds the closure then sorts argnames by fixture scope, so broader scopes are set up first.",
      },
    ],
    distractors: [
      {
        fqName: "src/_pytest/fixtures.py::FixtureManager.getfixturedefs",
        path: "src/_pytest/fixtures.py",
        kind: "same_operation_wrong_subject",
        why: "Applicability again, not ordering.",
      },
    ],
    groundTruth:
      "The ordering rule is a nested helper (sort_by_scope) inside the closure builder, i.e. below symbol granularity — tests whether the enclosing definition is delivered.",
  },

  // ===================================================================
  // sphinx — documentation compiler / parser host (CALIBRATION)
  // ===================================================================
  {
    id: "sp_parser_selection",
    expectedRepository: "sphinx",
    category: "parser_selection",
    query: "How does the build decide which parser reads a given source file?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "sphinx/util/__init__.py::get_filetype",
        path: "sphinx/util/__init__.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "sphinx/util/__init__.py:94-100",
        why: "First suffix in source_suffix that the filename ends with decides the filetype; no match raises FiletypeNotFoundError.",
      },
      {
        fqName: "sphinx/registry.py::SphinxComponentRegistry.get_source_parser",
        path: "sphinx/registry.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "sphinx/registry.py:280-284",
        why: "Maps that filetype to the registered parser class.",
      },
      {
        fqName: "sphinx/registry.py::SphinxComponentRegistry.add_source_parser",
        path: "sphinx/registry.py",
        role: "REGISTRATION_SOURCE",
        sourceSpan: "sphinx/registry.py:269-278",
        why: "Builds the filetype→parser map from each parser's `supported` tuple.",
      },
    ],
    distractors: [
      {
        fqName: "sphinx/registry.py::SphinxComponentRegistry.create_source_parser",
        path: "sphinx/registry.py",
        kind: "consumer_of_the_answer",
        why: "Instantiates the chosen class; contains no selection.",
      },
      {
        fqName: "sphinx/registry.py::SphinxComponentRegistry.get_source_parsers",
        path: "sphinx/registry.py",
        kind: "cache_or_accessor",
        why: "Plain accessor returning the map.",
      },
    ],
    groundTruth:
      "Selection is genuinely two-stage and split across two files: suffix→filetype (config-driven, ordered, first match) then filetype→parser (dict). Delivering only one is a partial answer.",
  },
  {
    id: "sp_project_name_reuse",
    expectedRepository: "sphinx",
    category: "project_name_reuse",
    query: "Does Sphinx already have a helper that maps a source file's suffix to its file type?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "sphinx/util/__init__.py::get_filetype",
        path: "sphinx/util/__init__.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "sphinx/util/__init__.py:94-100",
        why: "Precisely the helper asked for.",
      },
    ],
    distractors: [
      {
        fqName: "sphinx/application.py::Sphinx",
        path: "sphinx/application.py",
        kind: "project_name_symbol",
        why: "Project name is also the central application class — high centrality AND name match, the worst combination.",
      },
    ],
    groundTruth:
      "Second instance of the natural reuse phrasing, in a repository where the project-name symbol is additionally the most central class. Routing may use the token; symbol relevance may not.",
  },
  {
    id: "sp_xref_resolution",
    expectedRepository: "sphinx",
    category: "fallback",
    query: "How is a cross reference matched to the object it points at when the name is not fully qualified?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "sphinx/domains/python.py::PythonDomain.find_obj",
        path: "sphinx/domains/python.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "sphinx/domains/python.py:1265-1319",
        why: "Cascades module+class qualified, module qualified, bare name, then suffix-matching fuzzy search.",
      },
    ],
    distractors: [
      {
        fqName: "sphinx/domains/python.py::PythonDomain.resolve_xref",
        path: "sphinx/domains/python.py",
        kind: "consumer_of_the_answer",
        why: "Calls find_obj and formats the result; the name matches the query's vocabulary far better than the answer's does.",
      },
    ],
    groundTruth:
      "A case where the consumer is lexically the better match ('resolve_xref' vs 'find_obj') while the implementer is the answer — the §45 discrimination stated in the hardest direction.",
  },
  {
    id: "sp_builder_selection",
    expectedRepository: "sphinx",
    category: "selection",
    query: "How is the requested output builder located and instantiated?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "sphinx/registry.py::SphinxComponentRegistry.create_builder",
        path: "sphinx/registry.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "sphinx/registry.py:155-159",
        why: "Rejects unregistered names, otherwise constructs self.builders[name].",
      },
      {
        fqName: "sphinx/registry.py::SphinxComponentRegistry.preload_builder",
        path: "sphinx/registry.py",
        role: "REGISTRATION_SOURCE",
        sourceSpan: "sphinx/registry.py:141-153",
        why: "Loads the entry-point extension that registers the builder, so an unknown name can become known first.",
      },
    ],
    distractors: [],
    groundTruth:
      "Ordinary two-part registry lookup with a lazy-registration prerequisite. Included as a moderate-difficulty control.",
  },
  {
    id: "sp_parser_registry_false_premise",
    expectedRepository: "sphinx",
    category: "parser_selection",
    query: "Where is the list of parsers ordered by priority?",
    queryKind: "behavioral_prose",
    falsePremise: true,
    expected: [
      {
        fqName: "sphinx/util/__init__.py::get_filetype",
        path: "sphinx/util/__init__.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "sphinx/util/__init__.py:94-100",
        why: "The only ordering that exists is the iteration order of the source_suffix config mapping.",
      },
    ],
    distractors: [
      {
        fqName: "sphinx/registry.py::SphinxComponentRegistry.get_source_parsers",
        path: "sphinx/registry.py",
        kind: "cache_or_accessor",
        why: "Returns 'the list of parsers' literally, but carries no priority.",
      },
    ],
    groundTruth:
      "Parsers are keyed by filetype, never prioritised. The only order is over config suffixes. The attractive wrong answer literally returns a parser collection.",
  },

  // ===================================================================
  // xarray — scientific array IO (HOLDOUT)
  // ===================================================================
  {
    id: "xr_backend_selection",
    expectedRepository: "xarray",
    category: "backend_selection",
    query: "How is it decided which backend opens a given file?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "xarray/backends/plugins.py::guess_engine",
        path: "xarray/backends/plugins.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "xarray/backends/plugins.py:107-153",
        why: "Iterates installed engines in order and returns the first whose guess_can_open accepts the spec.",
      },
      {
        fqName: "xarray/backends/plugins.py::sort_backends",
        path: "xarray/backends/plugins.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "xarray/backends/plugins.py:73-81",
        why: "STANDARD_BACKENDS_ORDER first, remaining names alphabetically — the order 'first match' resolves against.",
      },
    ],
    acceptableAlternates: ["xarray/backends/plugins.py::build_engines"],
    distractors: [
      {
        fqName: "xarray/backends/plugins.py::get_backend",
        path: "xarray/backends/plugins.py",
        kind: "same_file_unrelated",
        why: "Resolves an EXPLICITLY named engine; performs no guessing.",
      },
      {
        fqName: "xarray/backends/plugins.py::list_engines",
        path: "xarray/backends/plugins.py",
        kind: "cache_or_accessor",
        why: "Enumerates entry points; decides nothing.",
      },
    ],
    groundTruth:
      "First-success over an explicitly ordered registry. get_backend is the sharpest distractor because it is the same subject (backends) and the opposite operation (explicit lookup vs inference).",
  },
  {
    id: "xr_backend_scoring_false_premise",
    expectedRepository: "xarray",
    category: "backend_selection",
    query: "Where are the backends scored so the best match for a file can be chosen?",
    queryKind: "behavioral_prose",
    falsePremise: true,
    pairedControl: "xr_score_backends_identifier",
    expected: [
      {
        fqName: "xarray/backends/plugins.py::guess_engine",
        path: "xarray/backends/plugins.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "xarray/backends/plugins.py:107-153",
        why: "No scoring: the first accepting backend wins outright.",
      },
      {
        fqName: "xarray/backends/plugins.py::sort_backends",
        path: "xarray/backends/plugins.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "xarray/backends/plugins.py:73-81",
        why: "Fixed precedence list stands in for what the query calls a score.",
      },
    ],
    distractors: [],
    groundTruth:
      "'Best match' implies comparison; the code short-circuits on the first acceptance. Truthful reconstruction names the ordering plus first-success and denies the scoring.",
  },
  {
    id: "xr_score_backends_identifier",
    expectedRepository: "xarray",
    category: "explicit_identifier_absence",
    query: "Where is score_backends defined?",
    queryKind: "explicit_identifier",
    falsePremise: true,
    expectAbsence: true,
    pairedControl: "xr_backend_scoring_false_premise",
    expected: [],
    distractors: [
      {
        fqName: "xarray/backends/plugins.py::sort_backends",
        path: "xarray/backends/plugins.py",
        kind: "similar_name",
        why: "One token away from the requested identifier and genuinely about backend order.",
      },
    ],
    groundTruth:
      "The hardest absence case in the corpus: a real symbol differs from the requested identifier by a single word and is topically correct. Absence must still win.",
  },
  {
    id: "xr_backend_order",
    expectedRepository: "xarray",
    category: "registration_ordering",
    query: "What determines the order the file backends are tried in?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "xarray/backends/plugins.py::sort_backends",
        path: "xarray/backends/plugins.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "xarray/backends/plugins.py:73-81",
        why: "Directly implements the ordering the query asks about.",
      },
      {
        fqName: "xarray/backends/plugins.py::build_engines",
        path: "xarray/backends/plugins.py",
        role: "REGISTRATION_SOURCE",
        sourceSpan: "xarray/backends/plugins.py:84-94",
        why: "Merges built-in and external entry points before sorting.",
      },
    ],
    distractors: [
      {
        fqName: "xarray/backends/plugins.py::guess_engine",
        path: "xarray/backends/plugins.py",
        kind: "consumer_of_the_answer",
        why: "Consumes the order. Correct lead for the SELECTION query, wrong lead for the ORDERING query.",
      },
    ],
    groundTruth:
      "Deliberate inverse of xr_backend_selection over the same two symbols: swapping the operation must swap the lead. Tests operation discrimination with subject held constant (§49).",
  },

  // ===================================================================
  // astropy — unified IO registry (HOLDOUT)
  // ===================================================================
  {
    id: "ap_format_identification",
    expectedRepository: "astropy",
    category: "selection",
    query: "How is a file's format worked out when the caller does not say what it is?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "astropy/io/registry/base.py::_UnifiedIORegistryBase._get_valid_format",
        path: "astropy/io/registry/base.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "astropy/io/registry/base.py:349-367",
        why: "Errors on zero matches, delegates a tie, otherwise returns the single match.",
      },
      {
        fqName: "astropy/io/registry/base.py::_UnifiedIORegistryBase.identify_format",
        path: "astropy/io/registry/base.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "astropy/io/registry/base.py:282-318",
        why: "Runs every registered identifier function to produce the candidate list.",
      },
    ],
    distractors: [
      {
        fqName: "astropy/io/registry/base.py::_UnifiedIORegistryBase._get_format_table_str",
        path: "astropy/io/registry/base.py",
        kind: "same_file_unrelated",
        why: "Formats the error message listing available formats.",
      },
    ],
    groundTruth: "Candidate generation and resolution are separate methods; both are needed.",
  },
  {
    id: "ap_format_priority_tiebreak",
    expectedRepository: "astropy",
    category: "priority_table_lookup",
    query: "What happens when more than one format claims it can read the same file?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "astropy/io/registry/base.py::_UnifiedIORegistryBase._get_highest_priority_format",
        path: "astropy/io/registry/base.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "astropy/io/registry/base.py:369-402",
        why: "Scans registered priorities, keeps the maximum, and raises IORegistryError when the maximum is shared.",
      },
    ],
    distractors: [
      {
        fqName: "astropy/io/registry/base.py::_UnifiedIORegistryBase._get_valid_format",
        path: "astropy/io/registry/base.py",
        kind: "consumer_of_the_answer",
        why: "Detects the tie and delegates it.",
      },
    ],
    groundTruth:
      "The one case in the corpus where a genuine numeric priority table DOES exist — the control against concluding that behavioural questions never have scores.",
  },
  {
    id: "ap_registered_class_match",
    expectedRepository: "astropy",
    category: "override_resolution",
    query: "When a class and its parent both register a reader, which registration is used?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "astropy/io/registry/base.py::_UnifiedIORegistryBase._is_best_match",
        path: "astropy/io/registry/base.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "astropy/io/registry/base.py:330-347",
        why: "Walks class1.__mro__ and accepts class2 only if it is the NEAREST registered ancestor.",
      },
    ],
    distractors: [
      {
        fqName: "astropy/io/registry/base.py::_UnifiedIORegistryBase.identify_format",
        path: "astropy/io/registry/base.py",
        kind: "consumer_of_the_answer",
        why: "Calls _is_best_match once per registered identifier.",
      },
    ],
    groundTruth: "MRO-nearest-ancestor resolution; a subclass registration supersedes its parent's.",
  },
  {
    id: "ap_project_name_reuse",
    expectedRepository: "astropy",
    category: "project_name_reuse",
    query: "Does astropy already have a helper that decides between competing registered readers?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "astropy/io/registry/base.py::_UnifiedIORegistryBase._get_highest_priority_format",
        path: "astropy/io/registry/base.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "astropy/io/registry/base.py:369-402",
        why: "The competing-reader resolver being asked about.",
      },
    ],
    distractors: [],
    groundTruth:
      "Reuse phrasing in a HOLDOUT repository, so the project-name discrimination is measured on repositories that supplied no development pressure.",
  },

  // ===================================================================
  // pylint — CLI static analyser (HOLDOUT)
  // ===================================================================
  {
    id: "pl_reporter_selection",
    expectedRepository: "pylint",
    category: "fallback",
    query: "How does the linter turn a reporter name given on the command line into a reporter?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "pylint/lint/pylinter.py::PyLinter._load_reporter_by_name",
        path: "pylint/lint/pylinter.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "pylint/lint/pylinter.py:450-460",
        why: "Tries the built-in registry first, then falls back to importing a dotted class path.",
      },
      {
        fqName: "pylint/lint/pylinter.py::_load_reporter_by_class",
        path: "pylint/lint/pylinter.py",
        role: "ORDERING_PREREQUISITE",
        sourceSpan: "pylint/lint/pylinter.py:88-95",
        why: "Implements the fallback import branch.",
      },
    ],
    distractors: [
      {
        fqName: "pylint/lint/pylinter.py::PyLinter._load_reporters",
        path: "pylint/lint/pylinter.py",
        kind: "consumer_of_the_answer",
        why: "Plural caller that splits comma-separated names; lexically nearly identical to the answer.",
      },
    ],
    groundTruth:
      "Registry-then-import fallback. The singular/plural name pair is an unusually harsh lexical trap.",
  },
  {
    id: "pl_checker_activation",
    expectedRepository: "pylint",
    category: "selection",
    query: "How is it decided which checkers actually run for a given configuration?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "pylint/lint/pylinter.py::PyLinter.prepare_checkers",
        path: "pylint/lint/pylinter.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "pylint/lint/pylinter.py:571-581",
        why: "Keeps a checker only if it owns an enabled message or an enabled report.",
      },
      {
        fqName: "pylint/lint/pylinter.py::PyLinter.get_checkers",
        path: "pylint/lint/pylinter.py",
        role: "REGISTRATION_SOURCE",
        sourceSpan: "pylint/lint/pylinter.py:557-559",
        why: "Supplies the ordered candidate list the filter runs over.",
      },
    ],
    distractors: [
      {
        fqName: "pylint/lint/pylinter.py::PyLinter.register_checker",
        path: "pylint/lint/pylinter.py",
        kind: "same_operation_wrong_subject",
        why: "Registration, not activation.",
      },
    ],
    groundTruth: "Enablement filter over a registered list; registration is a prerequisite, not the answer.",
  },
  {
    id: "pl_reporter_ranking_false_premise",
    expectedRepository: "pylint",
    category: "selection",
    query: "Where are the available reporters ranked to pick a default?",
    queryKind: "behavioral_prose",
    falsePremise: true,
    expected: [
      {
        fqName: "pylint/lint/pylinter.py::PyLinter._load_reporter_by_name",
        path: "pylint/lint/pylinter.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "pylint/lint/pylinter.py:450-460",
        why: "No ranking and no default election: the name is looked up, or imported, or an error is raised.",
      },
    ],
    distractors: [],
    groundTruth:
      "Both halves of the premise are false (no ranking, no elected default). Correct behaviour reconstructs the lookup-or-import mechanism and denies the rest.",
  },
  {
    id: "pl_project_name_reuse",
    expectedRepository: "pylint",
    category: "project_name_reuse",
    query: "Does pylint already have a helper that filters checkers down to the ones with enabled messages?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    expected: [
      {
        fqName: "pylint/lint/pylinter.py::PyLinter.prepare_checkers",
        path: "pylint/lint/pylinter.py",
        role: "PRIMARY_IMPLEMENTER",
        sourceSpan: "pylint/lint/pylinter.py:571-581",
        why: "The filter being asked about.",
      },
    ],
    distractors: [
      {
        fqName: "pylint/lint/pylinter.py::PyLinter",
        path: "pylint/lint/pylinter.py",
        kind: "project_name_symbol",
        why: "'PyLinter' is a near-exact match for the project token and the most central class in the repository.",
      },
    ],
    groundTruth:
      "Third reuse case, in a holdout repository, where the project-name symbol is also the highest-centrality class.",
  },

  // ===================================================================
  // Genuinely ambiguous requests (§81) — no single correct repository
  // ===================================================================
  {
    id: "amb_plugin_loading",
    expectedRepository: null,
    category: "selection",
    query: "How does the tool decide which plugins to load at startup?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    ambiguous: true,
    expected: [],
    distractors: [],
    groundTruth:
      "pytest, sphinx and pylint all load plugins/extensions at startup by genuinely comparable mechanisms. No repository is the answer. Bounded ambiguity or abstention is correct; a confident lead is a forced route.",
  },
  {
    id: "amb_config_file_vs_cli",
    expectedRepository: null,
    category: "configuration_precedence",
    query: "When a setting appears both in a configuration file and on the command line, which one takes effect?",
    queryKind: "behavioral_prose",
    falsePremise: false,
    ambiguous: true,
    expected: [],
    distractors: [],
    groundTruth:
      "pytest and pylint both resolve this, and flask resolves the adjacent file-vs-environment case. Abstention or bounded ambiguity is correct.",
  },
];

/** Repository keys by split, derived so the two can never drift apart. */
export const CALIBRATION_REPOSITORIES: readonly string[] = CORPUS_REPOSITORIES.filter(
  (repo) => repo.split === "calibration",
).map((repo) => repo.key);

export const HOLDOUT_REPOSITORIES: readonly string[] = CORPUS_REPOSITORIES.filter(
  (repo) => repo.split === "holdout",
).map((repo) => repo.key);

/**
 * Which split a case belongs to. Ambiguous cases span repositories, so they are
 * scored in both and counted in neither aggregate.
 */
export function splitOf(caseRecord: BehavioralCase): "calibration" | "holdout" | "ambiguous" {
  if (caseRecord.expectedRepository === null) return "ambiguous";
  return HOLDOUT_REPOSITORIES.includes(caseRecord.expectedRepository) ? "holdout" : "calibration";
}

/**
 * Content digests of every file the ground truth points into, taken from the
 * pinned checkouts. A commit SHA proves the tree moved; these prove THIS
 * mechanism moved, which is the drift the corpus actually needs to detect
 * (§122). A digest mismatch invalidates the affected case, not the corpus.
 */
export interface GroundTruthFileDigest {
  readonly repository: string;
  readonly path: string;
  readonly sha256Prefix: string;
}

export const GROUND_TRUTH_FILE_DIGESTS: readonly GroundTruthFileDigest[] = [
  { repository: "requests", path: "requests/adapters.py", sha256Prefix: "6097ffd12d892f97" },
  { repository: "requests", path: "requests/models.py", sha256Prefix: "c51202c76971a029" },
  { repository: "requests", path: "requests/sessions.py", sha256Prefix: "66ef98f583e5c132" },
  { repository: "flask", path: "src/flask/app.py", sha256Prefix: "d439102c7658f90f" },
  { repository: "flask", path: "src/flask/config.py", sha256Prefix: "584fd038985cd82c" },
  { repository: "flask", path: "src/flask/scaffold.py", sha256Prefix: "12d4caff83fd4f57" },
  { repository: "pytest", path: "src/_pytest/fixtures.py", sha256Prefix: "7f34bd21a2c6b530" },
  { repository: "sphinx", path: "sphinx/application.py", sha256Prefix: "d25edd6293993cd6" },
  { repository: "sphinx", path: "sphinx/domains/python.py", sha256Prefix: "985527409956c2aa" },
  { repository: "sphinx", path: "sphinx/registry.py", sha256Prefix: "87168beaa82b18f5" },
  { repository: "sphinx", path: "sphinx/util/__init__.py", sha256Prefix: "b971be811c28b2d1" },
  { repository: "xarray", path: "xarray/backends/plugins.py", sha256Prefix: "d171ddc5699b9444" },
  { repository: "astropy", path: "astropy/io/registry/base.py", sha256Prefix: "03bc10343aabf53b" },
  { repository: "pylint", path: "pylint/lint/pylinter.py", sha256Prefix: "febc7a75f59c6274" },
];

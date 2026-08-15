// The M150 behavioural mechanism corpus.
//
// The checkpoint at `ab8e4f0` stopped deliberately because this did not exist:
// nine generic cases existed only as unit tests over the scoring helper, which
// cannot see ranking, selection or delivery. This promotes them to the product
// retrieval path and adds the discrimination cases the checkpoint's own
// regression exposed (§18, §61, §62, §63).
//
// The corpus is built around ONE hostile property. Almost every case has a
// distractor that performs the SAME generic operation on a DIFFERENT subject:
// `choose_backend` and `parse_frequency` both end in `xs[0]`, and only one of
// them answers "which backend wins?". Operation compatibility alone cannot tell
// them apart, which is precisely the defect the ARC Gaussian regression is an
// instance of.
//
// Queries never name an implementation symbol (§47). They are worded the way
// somebody who has not read the code would ask.

export interface MechanismCase {
  readonly id: string;
  readonly query: string;
  /** The definition that actually answers the request, by indexed FQN. */
  readonly expected: string;
  /**
   * Definitions that perform the SAME operation on a DIFFERENT subject. A lead
   * here is the `same_operation_wrong_subject` failure — the metric this whole
   * continuation exists to drive to zero (§32).
   */
  readonly wrongSubject: readonly string[];
  /** A statement that must appear in the delivered context, if any (§48). */
  readonly decisionStatement?: string;
  /** A helper whose ordering the decision consumes, if any (§41, §57). */
  readonly orderingHelper?: string;
  /** Definitions that must never gain mechanism relevance for this query. */
  readonly negativeControls?: readonly string[];
  readonly category: string;
}

export const MECHANISM_CASES: readonly MechanismCase[] = [
  // --- §19 same operation, correct vs wrong subject -------------------------
  {
    id: "backend_vs_frequency",
    query: "How does the system decide which backend wins?",
    expected: "selection.py::choose_backend",
    wrongSubject: ["selection.py::parse_frequency"],
    decisionStatement: "candidates[0]",
    orderingHelper: "selection.py::matching_backends",
    category: "same operation, different subject",
  },
  {
    id: "frequency_not_backend",
    query: "How does the parser obtain the first frequency?",
    expected: "selection.py::parse_frequency",
    wrongSubject: ["selection.py::choose_backend"],
    decisionStatement: "frequencies[0]",
    category: "same operation, subject reversed",
  },

  // --- §20 same file --------------------------------------------------------
  {
    id: "same_file_worker",
    query: "How is it decided which worker takes the next job?",
    expected: "mixed.py::pick_worker",
    wrongSubject: ["mixed.py::first_frequency", "mixed.py::first_backend"],
    decisionStatement: "workers[0]",
    category: "same file, different subject",
  },

  // --- §21 same class -------------------------------------------------------
  {
    id: "same_class_route_keywords",
    query: "How does the adapter decide which route keywords to emit?",
    expected: "adapters.py::ProgramAdapter.route_keywords",
    wrongSubject: ["adapters.py::ProgramAdapter.parse_energies"],
    decisionStatement: "keywords[0]",
    category: "same class, different subject (Gaussian regression shape)",
  },
  {
    id: "same_class_cache_control",
    query: "How is the route reused rather than recomputed?",
    expected: "adapters.py::ProgramAdapter.cached_route",
    wrongSubject: [],
    category: "cache contrast inside the same class",
  },

  // --- §22 / §23 unhelpful names, producer provenance -----------------------
  {
    id: "unhelpful_operand_name",
    query: "How does the system choose which backend wins?",
    expected: "unhelpful.py::resolve",
    wrongSubject: ["unhelpful.py::process"],
    decisionStatement: "xs[0]",
    orderingHelper: "unhelpful.py::matching_backends_for",
    category: "operand name carries no subject; only the producer does",
  },

  // --- §24 two-hop bound ----------------------------------------------------
  {
    id: "two_hop_producer",
    query: "How is the backend picked when the choice is made indirectly?",
    expected: "twohop.py::indirect_choice",
    wrongSubject: [],
    decisionStatement: "xs[0]",
    category: "two-hop producer chain (measures whether one hop suffices)",
  },

  // --- §26 sorting discrimination -------------------------------------------
  {
    id: "sorted_backend_preference",
    query: "How is the preferred candidate selected?",
    expected: "ordering.py::process",
    wrongSubject: ["ordering.py::process_unordered"],
    decisionStatement: "xs[0]",
    orderingHelper: "ordering.py::ordered_candidates",
    category: "sort-then-first with a real ordering producer",
  },

  // --- §27 first-success ----------------------------------------------------
  {
    id: "first_success_backend",
    query: "How does the system decide which backend to use?",
    expected: "firstsuccess.py::resolve_backend",
    wrongSubject: ["firstsuccess.py::first_valid_energy"],
    category: "first-success over two subjects",
  },

  // --- §28 fallback ---------------------------------------------------------
  {
    id: "fallback_backend",
    query: "When does the system fall back to a different backend?",
    expected: "fallbacks.py::select_backend",
    wrongSubject: ["fallbacks.py::read_geometry"],
    category: "two fallback chains, one subject",
  },

  // --- §29 priority table ---------------------------------------------------
  {
    id: "priority_backend",
    query: "How is precedence between backends determined?",
    expected: "priorities.py::choose_backend_by_priority",
    wrongSubject: ["priorities.py::choose_best_result"],
    category: "two precedence tables",
  },

  // --- §57 / §58 / §59 ordering support and truthfulness --------------------
  {
    id: "ordering_query",
    query: "What establishes the order the candidates are considered in?",
    expected: "ordering.py::ordered_candidates",
    wrongSubject: [],
    category: "ordering question, not a selection question",
  },
  {
    id: "unknown_ordering",
    query: "How is the winning candidate decided when the caller supplies them?",
    expected: "preordered.py::take_winner",
    wrongSubject: [],
    decisionStatement: "candidates[0]",
    category: "first-item selection with no local ordering evidence",
  },

  // --- §60 support cap ------------------------------------------------------
  {
    id: "support_cap",
    query: "How is it decided which entry wins?",
    expected: "supportcap.py::decide",
    wrongSubject: [],
    decisionStatement: "xs[0]",
    orderingHelper: "supportcap.py::ranked_entries",
    negativeControls: [
      "supportcap.py::validate",
      "supportcap.py::annotate",
      "supportcap.py::normalise",
      "supportcap.py::audit",
    ],
    category: "one decision, five helpers, one establishes ordering",
  },

  // --- §30 incidental negatives --------------------------------------------
  {
    id: "incidental_negatives",
    query: "How does the scheduler choose which worker wins?",
    expected: "mixed.py::pick_worker",
    wrongSubject: [],
    negativeControls: [
      "negatives.py::first_character",
      "negatives.py::render",
      "negatives.py::label",
    ],
    category: "incidental [0] and display sorting must stay inert",
  },
];

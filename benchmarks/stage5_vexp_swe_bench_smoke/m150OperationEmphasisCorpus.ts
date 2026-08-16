// The M150 primary-operation emphasis corpus.
//
// Every earlier M150 phase asked whether the right definition could be REACHED.
// This one asks which of two reachable definitions is the ANSWER, and it exists
// because the ARC ordering query exposed a case where both are generated, both
// are subject-relevant, and the wrong one leads.
//
// The corpus is built around one property the earlier corpus deliberately did
// not have: PAIRED queries over IDENTICAL code. `alpha` establishes an order and
// `beta` consumes it to pick a winner; asked what establishes precedence the
// answer is `alpha`, asked which one wins the answer is `beta`. A rule that
// simply prefers ordering code passes half of this corpus and fails the other
// half, which is exactly what §8 forbids and what a single-query corpus could
// not have detected.
//
// Symbol names are deliberately useless (§13). `alpha`, `beta`, `process` and
// `prepare` say nothing about what they do, so nothing here can be passed by
// matching a name against the question. Where a name IS informative it is on the
// WRONG definition: `rule_candidate_selector` holds every subject word in its
// query and is still not the answer to it (§21).

export interface OperationEmphasisCase {
  readonly id: string;
  readonly query: string;
  /** The operation the query asks about, for the audit artifact. */
  readonly operation: "selection" | "ordering" | "fallback";
  /**
   * The definition that DIRECTLY implements the requested operation, by indexed
   * FQN. `null` where the corpus contains no such definition — the truthfulness
   * control, where the correct behaviour is to promote nobody (§23).
   */
  readonly directImplementer: string | null;
  /**
   * The definition that consumes the requested operation's result. Legitimately
   * relevant and legitimately deliverable; simply not the answer to THIS query
   * (§39). Its leading is the headline failure this corpus measures.
   */
  readonly consumer?: string;
  /** Same operation, different subject. Must earn no operation evidence (§24). */
  readonly wrongSubject?: readonly string[];
  /** The case that asks the reverse question over the same code (§25). */
  readonly pairedWith?: string;
  readonly category: string;
}

export const OPERATION_EMPHASIS_CASES: readonly OperationEmphasisCase[] = [
  // --- §17 the primary paired acceptance, on useless names -----------------
  {
    id: "plugin_ordering",
    query: "What determines plugin precedence?",
    operation: "ordering",
    directImplementer: "emphasis.py::alpha",
    consumer: "emphasis.py::beta",
    wrongSubject: ["emphasis.py::gamma"],
    pairedWith: "plugin_selection",
    category: "paired role reversal, uninformative names",
  },
  {
    id: "plugin_selection",
    query: "How does the system decide which plugin wins?",
    operation: "selection",
    directImplementer: "emphasis.py::beta",
    consumer: "emphasis.py::alpha",
    wrongSubject: ["emphasis.py::gamma"],
    pairedWith: "plugin_ordering",
    category: "paired role reversal, reverse emphasis",
  },

  // --- §21 the ARC shape: the consumer holds the subject words -------------
  {
    id: "rule_ordering",
    query: "What determines rule candidate precedence?",
    operation: "ordering",
    directImplementer: "lexicaladv.py::prepare",
    consumer: "lexicaladv.py::rule_candidate_selector",
    pairedWith: "rule_selection",
    category: "consumer holds the stronger lexical overlap",
  },
  {
    id: "rule_selection",
    query: "How is the winning rule candidate decided?",
    operation: "selection",
    directImplementer: "lexicaladv.py::rule_candidate_selector",
    consumer: "lexicaladv.py::prepare",
    pairedWith: "rule_ordering",
    category: "consumer holds the stronger lexical overlap, reversed",
  },

  // --- §19 first-success traversal ------------------------------------------
  {
    id: "backend_ordering",
    query: "What determines backend precedence?",
    operation: "ordering",
    directImplementer: "backends.py::ordered_backends",
    consumer: "backends.py::resolve",
    pairedWith: "backend_selection",
    category: "first-success traversal",
  },
  {
    id: "backend_selection",
    query: "How does the system decide which backend succeeds?",
    operation: "selection",
    directImplementer: "backends.py::resolve",
    consumer: "backends.py::ordered_backends",
    pairedWith: "backend_ordering",
    category: "first-success traversal, reversed",
  },

  // --- §20 fallback precedence ----------------------------------------------
  {
    id: "route_ordering",
    query: "What determines fallback route precedence?",
    operation: "ordering",
    directImplementer: "backends.py::routes_for",
    consumer: "backends.py::dispatch",
    pairedWith: "route_selection",
    category: "fallback precedence",
  },
  {
    id: "route_selection",
    query: "Which route implementation is ultimately chosen?",
    operation: "selection",
    directImplementer: "backends.py::dispatch",
    consumer: "backends.py::routes_for",
    pairedWith: "route_ordering",
    category: "fallback precedence, reversed",
  },

  // --- §22 the implementer's name says nothing ------------------------------
  {
    id: "channel_ordering",
    query: "What determines channel precedence?",
    operation: "ordering",
    directImplementer: "genericname.py::process",
    category: "direct implementer with a generic name",
  },

  // --- §23 truthfulness control: nobody establishes the order ---------------
  {
    id: "unknown_ordering",
    query: "What establishes precedence between entries?",
    operation: "ordering",
    directImplementer: null,
    consumer: "unknown.py::take_first",
    category: "no indexed ordering source",
  },
];

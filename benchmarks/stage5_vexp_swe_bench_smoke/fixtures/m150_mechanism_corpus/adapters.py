"""One class, three behaviours. Class-level relevance must not decide."""

ROUTE_CACHE = {}


class ProgramAdapter:
    """Writes program input and reads program output."""

    def route_keywords(self, level):
        """Which route keywords this job emits."""
        keywords = self.candidate_route_keywords(level)
        return keywords[0]

    def candidate_route_keywords(self, level):
        options = []
        for keyword in self.keyword_table:
            if keyword.applies_to(level):
                options.append(keyword)
        return options

    def parse_energies(self, output):
        """The reported electronic energy."""
        energies = self.extract_energies(output)
        return energies[0]

    def extract_energies(self, output):
        found = []
        for line in output.splitlines():
            if "SCF Done" in line:
                found.append(float(line.split()[4]))
        return found

    def cached_route(self, level):
        """Reuse a previously computed route."""
        if level in ROUTE_CACHE:
            return ROUTE_CACHE[level]
        ROUTE_CACHE[level] = self.route_keywords(level)
        return ROUTE_CACHE[level]

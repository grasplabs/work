// The Brain's limits that hosts check up front too. Dependency-free, so a
// host's own dependency-free modules (core's operation limits, which the
// SDK loads in a browser) can re-export them.

/**
 * The longest a search or recall query may be: a question, not a
 * document. Hosts that take queries for the Brain refuse a longer one up
 * front (core's operation limits).
 */
export const searchQueryMaxLength = 500;

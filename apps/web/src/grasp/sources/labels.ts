// What Sources does with its words: the kinds in a list, counted. The words themselves are in
// words.ts.
import type { SourceKind, SourcesLabels } from "./types";

// The English moved to words.ts, the catalogue's entry; still exported from here by its old name.
export { englishLabels } from "./words";

/** The kinds in a list, most first, each with its number: ["4 files", "3 messages"]. */
export const kindsInParts = (
  kinds: readonly SourceKind[],
  labels: SourcesLabels
) => {
  const counts = new Map<SourceKind, number>();
  for (const kind of kinds) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([kind, count]) => labels.kind(kind, count));
};

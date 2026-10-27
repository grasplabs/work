// What a search's audit event says of where an empty search came closest:
// written by the Brain's search (search.ts), read back by the host's usage
// signals (core's usage-tally.ts), so both keep to one format.

/** Most collections an empty search of every collection is put down to. */
export const nearestCollectionsMax = 3;

/**
 * The collections a search of every collection that found nothing came
 * closest in, for its audit event's `detail.nearest`: their IDs,
 * comma-separated, never its words or any document. The host's usage
 * signals read it back (core's usage-tally.ts).
 */
export const nearestDetail = (collectionIds: readonly string[]): string =>
  collectionIds.slice(0, nearestCollectionsMax).join(",");

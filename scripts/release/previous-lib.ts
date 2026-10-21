/**
 * Finding the release published before the one CI builds now
 * (previous-release.ts): the newest CI release in the bucket with a lower
 * run number. Not the parent commit: pushes to main keep only the newest
 * pending run, so a burst of merges can leave commits unpublished, and a
 * limit one of them raised is raised over the release before them.
 */

const ciRelease = /^r(?<run>\d+)-[0-9a-f]{7}$/u;

/** The id of the newest CI release among `ids` with a run before `beforeRun`. */
export const previousReleaseId = (
  ids: readonly string[],
  beforeRun: number
): string | undefined => {
  let best: { id: string; run: number } | undefined;
  for (const id of ids) {
    const run = Number(ciRelease.exec(id)?.groups?.run ?? Number.NaN);
    if (run < beforeRun && (best === undefined || run > best.run)) {
      best = { id, run };
    }
  }
  return best?.id;
};

const prefixPattern = /<Prefix>releases\/(?<id>[^/<]+)\/<\/Prefix>/gu;
const truncatedPattern = /<IsTruncated>true<\/IsTruncated>/u;
const tokenPattern =
  /<NextContinuationToken>(?<token>[^<]+)<\/NextContinuationToken>/u;

/** One page of an S3 ListObjectsV2 of `releases/` by `/`: the ids, and the next page's token. */
export const parseReleaseListing = (
  xml: string
): { ids: string[]; next: string | undefined } => ({
  ids: [...xml.matchAll(prefixPattern)].flatMap(({ groups }) =>
    groups?.id === undefined ? [] : [groups.id]
  ),
  next: truncatedPattern.test(xml)
    ? tokenPattern.exec(xml)?.groups?.token
    : undefined,
});

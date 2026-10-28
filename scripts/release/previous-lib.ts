/**
 * Finding the release published before the one CI builds now
 * (previous-release.ts): the newest CI release published to the bucket
 * with a lower run number. Not the parent commit: pushes to main keep only the newest
 * pending run, so a burst of merges can leave commits unpublished, and a
 * limit one of them raised is raised over the release before them.
 */

const ciRelease = /^r(?<run>\d+)-[0-9a-f]{7}$/u;

/**
 * The CI releases among `ids` with a run before `beforeRun`, newest
 * first: the release before is the first of them whose manifest exists
 * (an upload that stopped halfway leaves blobs under a prefix, but no
 * manifest, and was never published).
 */
export const earlierReleaseIds = (
  ids: readonly string[],
  beforeRun: number
): string[] =>
  ids
    .map((id) => ({
      id,
      run: Number(ciRelease.exec(id)?.groups?.run ?? Number.NaN),
    }))
    .filter(({ run }) => run < beforeRun)
    .toSorted((one, other) => other.run - one.run)
    .map(({ id }) => id);

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

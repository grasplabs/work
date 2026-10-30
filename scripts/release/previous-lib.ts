/**
 * Finding the release published before the one CI publishes now
 * (previous-release.ts): the newest release the bucket holds, by id
 * (@grasp-os/shared/release-id). Not the parent commit: pushes to main
 * keep only the newest pending run, so a burst of merges can leave
 * commits unpublished, and a limit one of them raised is raised over the
 * release before them. CI's publish takes the next id after it, so it is
 * the release before by id too.
 */
import {
  compareReleaseIds,
  parsePublishedReleaseId,
} from "@grasp-os/shared/release-id";

/**
 * The published releases among `ids`, newest first: the release before is
 * the first of them whose manifest exists (an upload that stopped halfway
 * leaves its limit evidence under a prefix, but no manifest, and was never
 * published). Local builds (`dev-`) never count.
 */
export const newestReleaseIds = (ids: readonly string[]): string[] =>
  ids
    .filter((id) => parsePublishedReleaseId(id) !== undefined)
    .toSorted((one, other) => compareReleaseIds(other, one));

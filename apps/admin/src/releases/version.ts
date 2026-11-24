/**
 * A release's readable title, for the lists staff pick releases from. A
 * release is one merge to main, so its note is the merged pull request's
 * Conventional Commit title (`feat(admin): … (#123)`). A release is named
 * by its id (`YY.MM.N`, @grasp-os/shared/release-id) and this title.
 */

/** A Conventional Commit title's type and scope, and its pull request number at the end. */
const conventionalPrefix = /^[a-z]+(?:\([^)]*\))?!?:\s*/u;
const pullRequestSuffix = /\s*\(#\d+\)$/u;

/**
 * What a release holds, in a short line: its note without the commit type,
 * scope and pull request number, starting with a capital. Empty for a
 * release without a note.
 */
export const releaseTitle = (notes: string): string => {
  const title = notes
    .trim()
    .replace(conventionalPrefix, "")
    .replace(pullRequestSuffix, "");
  return title === ""
    ? ""
    : `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
};

/** A release in a line: its id, and its title when it has one. */
export const releaseName = (release: { id: string; notes: string }): string => {
  const title = releaseTitle(release.notes);
  return title === "" ? release.id : `${release.id} · ${title}`;
};

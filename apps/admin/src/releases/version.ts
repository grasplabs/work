/**
 * A release's version and readable name, for the lists staff pick
 * releases from. A release is one merge to main, so its note is the
 * merged pull request's Conventional Commit title (`feat(admin): …
 * (#123)`). Its version counts them: a feature starts the next major at
 * `.0`, anything else (a fix, a chore) is the next minor of the one
 * before, so `v10.3` is the tenth feature and three changes since.
 *
 * Counted in the order releases were built, not imported: the import
 * takes the newest first (src/releases/import.ts), and a release's
 * number mustn't depend on that. The import keeps only whether each note
 * is a feature (`releases.feature`), so the lists count versions without
 * reading any manifest (`versionsOf`, src/releases/queries.ts). A release
 * built earlier that is only imported later (one that failed to verify
 * at first) moves the minors after it up by one: rare, and the version
 * then says the order things shipped in.
 */

/** A note that starts the next major: a feature, scoped or not, breaking or not. */
const featureNote = /^feat[(:!]/u;

/** A Conventional Commit title's type and scope, and its pull request number at the end. */
const conventionalPrefix = /^[a-z]+(?:\([^)]*\))?!?:\s*/u;
const pullRequestSuffix = /\s*\(#\d+\)$/u;

/** Whether release note `notes` starts the next major. */
export const startsMajor = (notes: string): boolean => featureNote.test(notes);

/** A release's version as staff read it, `v<major>.<minor>`; null for one imported before versions. */
export const versionWords = ({
  versionMajor,
  versionMinor,
}: {
  versionMajor?: number | null;
  versionMinor?: number | null;
}): string | null =>
  versionMajor === null ||
  versionMajor === undefined ||
  versionMinor === null ||
  versionMinor === undefined
    ? null
    : `v${versionMajor}.${versionMinor}`;

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

/** A release in a line: its version and title when it has them, else its id. */
export const releaseName = (release: {
  id: string;
  notes: string;
  versionMajor?: number | null;
  versionMinor?: number | null;
}): string => {
  const version = versionWords(release);
  const title = releaseTitle(release.notes);
  if (version === null) {
    return title === "" ? release.id : `${release.id} · ${title}`;
  }
  return title === "" ? version : `${version} · ${title}`;
};

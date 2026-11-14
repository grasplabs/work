import { platformLimits } from "./platform-limits.ts";

/**
 * The most an App's files take, checked on every write and commit. The
 * App compiler takes as much in one build (its files are some of the
 * App's), so an App within these limits always fits a build, and the build
 * stays well inside its isolate's CPU and memory. The authoring source
 * limits are the platform's (spec 18.1). No dependencies but those, which
 * have none: the compiler's isolate imports it.
 */
export const appLimits = {
  files: platformLimits.authoringFiles,
  /** Characters in one file. */
  fileLength: platformLimits.authoringFileCharacters,
  /** Characters in all of an App's files together. */
  totalLength: platformLimits.authoringTotalCharacters,
  pathLength: 200,
  pathDepth: platformLimits.authoringPathDepth,
  nameLength: 100,
  descriptionLength: 1000,
  /** Integrations a builder adds to an App by hand. */
  addedIntegrations: 50,
} as const;

/**
 * One folder or file name in an App's path (`appPathSchema`): letters,
 * digits, `_`, `-`, `$`, `(`, `)` and `.`, not starting with a `.`. That
 * rules out `.` and `..`, so a path can't step out of the App, and hidden
 * files; a name never holds a `/`. The rest is how TanStack Router names
 * its file routes: `$` a parameter (`tasks.$taskId.tsx`), a leading `_`
 * a pathless layout (`_layout.inbox.tsx`), a trailing one a route out of
 * its parent's layout (`tasks_.new.tsx`), and `(…)` a route group, a
 * folder that adds nothing to the address (`(admin)/settings.tsx`).
 */
export const appPathSegmentPattern = /^[\w$()-][\w.$()-]*$/u;

/**
 * The most bytes of an App's manifest's text, as UTF-8, checked before it
 * is parsed: room for the schema's own megabyte and every function's
 * descriptors. Whatever the size of its source, an App's manifest is
 * never more (the SDK's `readAppManifest`).
 */
export const appManifestMaxBytes = 4 * 1024 * 1024;

/**
 * Whose code called `console.error` in a screen's frame, read from the
 * call's stack: the App's own modules (in the directory of the screen's
 * own module, where core serves every App module of the frame, a
 * preview's later ones too) or anything else, the kit's (React's
 * development warnings, a UI library's), which core serves from a
 * directory of its own. What the screen runtime reports App code's calls
 * as a problem by, and the rest as a warning, which shows but fails
 * nothing (spec 22.7: only errors block a draft's check).
 *
 * The first frame outside `own` (the runtime's own module, which made the
 * stack) decides. A stack with no frame to read is the App's: a call is
 * never let off as a warning on a guess.
 */

/** A frame's address: `https://…`, up to its line and column. */
const framePattern = /(?<url>https?:\/\/[^\s()@]+?)(?::\d+){1,2}\)?$/u;

/** The addresses of a stack's frames, outermost last, as engines write them. */
const frameAddresses = (stack: string): string[] =>
  stack.split("\n").flatMap((line) => {
    const url = framePattern.exec(line.trim())?.groups?.url;
    return url === undefined ? [] : [url];
  });

/**
 * Whether the call whose `stack` this is came from the App's own code:
 * its first frame outside `own` is in `appDirectory`, the directory of the
 * screen's own module.
 */
export const calledByApp = (
  stack: string | undefined,
  own: string,
  appDirectory: string
): boolean => {
  const caller = frameAddresses(stack ?? "").find((url) => url !== own);
  return caller === undefined || caller.startsWith(appDirectory);
};

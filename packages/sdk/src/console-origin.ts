/**
 * Whose code called `console.error` in a screen's frame, read from the
 * call's stack: the App's own modules (their addresses in the frame's
 * import map, or a `data:` module, as a preview's update is evaluated),
 * or anything else, the kit's (React's development warnings, a UI
 * library's). What the screen runtime reports App code's calls as a
 * problem by, and the rest as a warning, which shows but fails nothing
 * (spec 22.7: only errors block a draft's check).
 *
 * The first frame outside `own` (the runtime's own module, which made the
 * stack) decides. A stack with no frame to read is the App's: a call is
 * never let off as a warning on a guess.
 */

/** A frame's address: `https://…` or `data:…`, up to its line and column. */
const framePattern =
  /(?<url>(?:https?:\/\/|data:)[^\s()@]+?)(?::\d+){1,2}\)?$/u;

/** An address without its query, as two loads of one module compare. */
const withoutQuery = (address: string): string =>
  address.startsWith("data:") ? address : (address.split("?")[0] ?? address);

/** The addresses of a stack's frames, outermost last, as engines write them. */
const frameAddresses = (stack: string): string[] =>
  stack.split("\n").flatMap((line) => {
    const url = framePattern.exec(line.trim())?.groups?.url;
    return url === undefined ? [] : [withoutQuery(url)];
  });

/**
 * Whether the call whose `stack` this is came from the App's own code:
 * its first frame outside `own` is one of `appModules` (addresses, a
 * query or not) or a `data:` module.
 */
export const calledByApp = (
  stack: string | undefined,
  own: string,
  appModules: ReadonlySet<string>
): boolean => {
  const self = withoutQuery(own);
  const apps = new Set([...appModules].map((address) => withoutQuery(address)));
  const caller = frameAddresses(stack ?? "").find((url) => url !== self);
  return caller === undefined || caller.startsWith("data:") || apps.has(caller);
};

/** The App's modules' addresses, as the frame's import map names them (`app~…`). */
export const appModuleAddresses = (importMap = ""): Set<string> => {
  try {
    const parsed: unknown = JSON.parse(importMap === "" ? "{}" : importMap);
    const imports =
      typeof parsed === "object" && parsed !== null && "imports" in parsed
        ? parsed.imports
        : undefined;
    if (typeof imports !== "object" || imports === null) {
      return new Set();
    }
    return new Set(
      Object.entries(imports).flatMap(([name, address]) =>
        name.startsWith("app~") && typeof address === "string" ? [address] : []
      )
    );
  } catch {
    return new Set();
  }
};

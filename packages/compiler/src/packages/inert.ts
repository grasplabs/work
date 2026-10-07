/**
 * Whether files an artifact carries can load or run anything: SVGs a
 * browser opens as documents, and the CSS esbuild wrote. Pure checks on
 * bytes and text, run in the package builder's isolate after esbuild,
 * which doesn't resolve every URL a stylesheet can name (`image-set()`
 * strings never reach a plugin).
 */

/** Data URLs that stay inline as they are: images and fonts, never SVG. */
export const inertDataUrl =
  /^data:(?:image\/(?:png|jpeg|gif|webp|avif)|font\/[a-z0-9]+|application\/font-woff2?)[;,]/iu;

/** `text` with each match of `pattern` replaced by what `replace` makes of it. */
export const replaced = (
  text: string,
  pattern: RegExp,
  replace: (groups: Record<string, string | undefined>, whole: string) => string
): string => {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    out += text.slice(at, match.index) + replace(match.groups ?? {}, match[0]);
    at = match.index + match[0].length;
  }
  return out + text.slice(at);
};

/** A code point as text, or nothing for one Unicode doesn't have. */
export const character = (code: number): string =>
  Number.isInteger(code) && code > 0 && code <= 0x10_ff_ff
    ? String.fromCodePoint(code)
    : "";

/** A URL that reaches outside the artifact: a scheme, or `//`. */
const outside = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/**
 * Strings in CSS that browsers fetch when they name a URL (`image-set()`
 * takes strings): any with a scheme that loads something, or `//`.
 */
const fetchedString =
  /^(?:(?:https?|ftp|wss?|file|blob|javascript|vbscript|data):|\/\/)/iu;

const cssEscape = /\\(?:(?<hex>[0-9a-f]{1,6})\s?|(?<char>[^\n]))/giu;

/** CSS text with its escapes (`\74`, `\:`) read as the characters they are. */
export const cssUnescape = (text: string): string =>
  replaced(text, cssEscape, ({ hex, char }) =>
    hex === undefined ? (char ?? "") : character(Number.parseInt(hex, 16))
  );

const cssUrl = /url\(\s*(?<value>[^)]*?)\s*\)/giu;
const imageSet = /(?:-webkit-)?image-set\((?<args>(?:[^()]|\([^()]*\))*)\)/giu;
const cssString = /(?<quote>["'])(?<value>(?:\\.|(?!\k<quote>).)*)\k<quote>/gu;
const quoted = /^(?<quote>["'])(?<inner>.*)\k<quote>$/u;

/**
 * The options of an `image-set()`, split at its top-level commas: each is
 * an image (a string, `url()` or another image function) and then its
 * resolution and `type()`.
 */
const imageSetOptions = (args: string): string[] => {
  const options: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let at = 0; at < args.length; at += 1) {
    const char = args[at];
    if (quote !== undefined) {
      if (char === "\\") {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      options.push(args.slice(start, at));
      start = at + 1;
    }
  }
  options.push(args.slice(start));
  return options;
};

/** An option's image, if it is a string: the image position only. */
const leadingString =
  /^\s*(?<quote>["'])(?<value>(?:\\.|(?!\k<quote>).)*)\k<quote>/u;

/**
 * Strings `image-set()` names a local file by, in image position:
 * esbuild resolves `url()`s in it but leaves strings as they are, so they
 * would name paths the artifact doesn't have. A `type("image/png")` is
 * the option's type, not an image. Up to `limit`.
 */
export const unbundledInCss = (css: string, limit = 50): string[] => {
  const found = new Set<string>();
  for (const set of css.matchAll(imageSet)) {
    for (const option of imageSetOptions(set.groups?.args ?? "")) {
      const image = leadingString.exec(option)?.groups?.value;
      const value = image === undefined ? undefined : cssUnescape(image).trim();
      if (
        value !== undefined &&
        found.size < limit &&
        !fetchedString.test(value) &&
        !inertDataUrl.test(value)
      ) {
        found.add(value.slice(0, 120));
      }
    }
  }
  return [...found];
};

/**
 * The globals that load code or files at run time from outside the
 * artifact, and what esbuild replaces each with (`define`): only real
 * references in code are replaced, never text in strings, templates,
 * regular expressions or comments, so the build's output names a marker
 * exactly where the code uses one.
 */
export const runtimeLoadMarkers = {
  Worker: "__grasp_refused_Worker",
  "self.Worker": "__grasp_refused_Worker",
  "window.Worker": "__grasp_refused_Worker",
  "globalThis.Worker": "__grasp_refused_Worker",
  SharedWorker: "__grasp_refused_SharedWorker",
  "self.SharedWorker": "__grasp_refused_SharedWorker",
  "window.SharedWorker": "__grasp_refused_SharedWorker",
  "globalThis.SharedWorker": "__grasp_refused_SharedWorker",
  importScripts: "__grasp_refused_importScripts",
  "self.importScripts": "__grasp_refused_importScripts",
  "globalThis.importScripts": "__grasp_refused_importScripts",
  "import.meta.url": "__grasp_refused_import_meta_url",
} as const;

const runtimeLoadReasons: Readonly<Record<string, string>> = {
  __grasp_refused_Worker: "starts a worker",
  __grasp_refused_SharedWorker: "starts a worker",
  __grasp_refused_importScripts: "loads scripts into a worker",
  __grasp_refused_import_meta_url:
    "loads a file next to itself at run time (import.meta.url)",
};

const marker = /\b(?<typeof>typeof\s+)?(?<name>__grasp_refused_\w+)\b/gu;

/**
 * Why a module esbuild wrote would load code or files at run time that
 * aren't part of the artifact: a use of a global `runtimeLoadMarkers`
 * replaced, other than asking whether it exists (`typeof Worker`).
 */
export const runtimeLoadsInJs = (code: string): string[] => {
  const reasons = new Set<string>();
  for (const match of code.matchAll(marker)) {
    const reason = runtimeLoadReasons[match.groups?.name ?? ""];
    if (match.groups?.typeof === undefined && reason !== undefined) {
      reasons.add(reason);
    }
  }
  return [...reasons];
};

/**
 * Every place a stylesheet esbuild wrote names a URL that would load
 * something from outside the artifact: `url()` values and quoted strings
 * (`@import "…"`, `image-set("…")`). Inline image and font data URLs and
 * fragment-only references (`url(#id)`) stay.
 */
export const remoteInCss = (css: string, limit = 50): string[] => {
  const found = new Set<string>();
  const flag = (value: string, fetched: RegExp): void => {
    const url = cssUnescape(value).trim();
    if (fetched.test(url) && !inertDataUrl.test(url)) {
      found.add(url.slice(0, 120));
    }
  };
  // Scanning stops once `limit` are found: never every one a stylesheet has.
  for (const match of css.matchAll(cssUrl)) {
    if (found.size >= limit) {
      return [...found];
    }
    const value = match.groups?.value ?? "";
    flag(quoted.exec(value)?.groups?.inner ?? value, outside);
  }
  for (const match of css.matchAll(cssString)) {
    if (found.size >= limit) {
      return [...found];
    }
    flag(match.groups?.value ?? "", fetchedString);
  }
  return [...found];
};

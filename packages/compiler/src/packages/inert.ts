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

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Elements that run or embed something, under any namespace prefix. */
const activeElement =
  /<\s*(?:[\w.-]+:)?(?:script|foreignObject|iframe|embed|object|handler)\b/iu;

/** An event handler attribute, under any namespace prefix. */
const eventAttribute = /[\s/"'](?:[\w.-]+:)?on[\w-]*\s*=/iu;

/** A script or HTML URL, once entities and whitespace are taken out. */
const scriptUrl = /(?:javascript|vbscript|livescript):|data:text\/html/iu;

const namedEntities: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  colon: ":",
  gt: ">",
  lt: "<",
  newline: "\n",
  quot: '"',
  tab: "\t",
};

/** `text` with each match of `pattern` replaced by what `replace` makes of it. */
const replaced = (
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
const character = (code: number): string =>
  Number.isInteger(code) && code > 0 && code <= 0x10_ff_ff
    ? String.fromCodePoint(code)
    : "";

const entity = /&(?:#x(?<hex>[0-9a-f]+)|#(?<decimal>\d+)|(?<name>[a-z]+));?/giu;

/** `text` with numeric and the common named character references decoded. */
const decodeEntities = (text: string): string =>
  replaced(text, entity, ({ hex, decimal, name }, whole) => {
    if (hex !== undefined) {
      return character(Number.parseInt(hex, 16));
    }
    if (decimal !== undefined) {
      return character(Number(decimal));
    }
    return namedEntities[(name ?? "").toLowerCase()] ?? whole;
  });

/** `text` without whitespace and control characters, which URLs may hide. */
const squeezed = (text: string): string => {
  let kept = "";
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0x20) {
      kept += char;
    }
  }
  return kept;
};

const notUtf8 = "is an SVG that isn't plain UTF-8";

/** Whether bytes start with a byte-order mark: UTF-8's or UTF-16's. */
const hasBom = ([first = 0, second = 0, third = 0]: Uint8Array): boolean =>
  (first === 0xef && second === 0xbb && third === 0xbf) ||
  (first === 0xfe && second === 0xff) ||
  (first === 0xff && second === 0xfe);

/** The SVG's text, if it is plain UTF-8: no mark, no invalid bytes, no NUL. */
const plainText = (bytes: Uint8Array): string | undefined => {
  if (hasBom(bytes)) {
    return undefined;
  }
  try {
    const text = strictUtf8.decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
};

/** An SVG's references: `href`/`xlink:href`/`src` values and CSS `url()`s. */
const svgReferences = (text: string): string[] => [
  ...[
    ...text.matchAll(
      /[\s/"'](?:[\w.-]+:)?(?:href|src)\s*=\s*(?<quote>["']?)(?<value>.*?)\k<quote>(?=[\s/>])/giu
    ),
  ].map((match) => match.groups?.value ?? ""),
  ...[
    ...text.matchAll(/url\(\s*(?<quote>["']?)(?<value>.*?)\k<quote>\s*\)/giu),
  ].map((match) => match.groups?.value ?? ""),
];

/**
 * Whether a reference leaves the SVG: anything but a same-document
 * fragment (`#id`) or an inline image or font data URL.
 */
const leaves = (reference: string): boolean => {
  const value = squeezed(reference);
  return !(value.startsWith("#") || inertDataUrl.test(value));
};

/**
 * Why an SVG could run script when opened as a document, or undefined if
 * nothing in it can. Anything that isn't plain UTF-8 (a byte-order mark,
 * UTF-16, invalid bytes, NULs) is refused rather than guessed at.
 */
export const svgRefusal = (bytes: Uint8Array): string | undefined => {
  const text = plainText(bytes);
  if (text === undefined) {
    return notUtf8;
  }
  if (/<!ENTITY/iu.test(text)) {
    return "is an SVG that declares its own entities";
  }
  if (activeElement.test(text)) {
    return "is an SVG with an element that can run or embed something";
  }
  if (eventAttribute.test(text)) {
    return "is an SVG with an event handler";
  }
  const decoded = decodeEntities(text);
  if (scriptUrl.test(squeezed(decoded))) {
    return "is an SVG that links to script";
  }
  if (/@import/iu.test(decoded) || svgReferences(decoded).some(leaves)) {
    return "is an SVG that loads something from outside itself";
  }
  return undefined;
};

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
const cssUnescape = (text: string): string =>
  replaced(text, cssEscape, ({ hex, char }) =>
    hex === undefined ? (char ?? "") : character(Number.parseInt(hex, 16))
  );

const cssUrl = /url\(\s*(?<value>[^)]*?)\s*\)/giu;
const imageSet = /(?:-webkit-)?image-set\((?<args>(?:[^()]|\([^()]*\))*)\)/giu;
const cssString = /(?<quote>["'])(?<value>(?:\\.|(?!\k<quote>).)*)\k<quote>/gu;
const quoted = /^(?<quote>["'])(?<inner>.*)\k<quote>$/u;

/**
 * Strings `image-set()` names a local file by: esbuild resolves `url()`s
 * in it but leaves strings as they are, so they would name paths the
 * artifact doesn't have. Up to `limit`.
 */
export const unbundledInCss = (css: string, limit = 50): string[] => {
  const found = new Set<string>();
  for (const set of css.matchAll(imageSet)) {
    // `url()`s in it are esbuild's to resolve, and were.
    const strings = (set.groups?.args ?? "").replaceAll(cssUrl, "");
    for (const match of strings.matchAll(cssString)) {
      const value = cssUnescape(match.groups?.value ?? "").trim();
      if (
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

/** What a module would load at run time that isn't in the artifact. */
const runtimeLoads: readonly [RegExp, string][] = [
  [
    /new\s+URL\s*\([^)]*import\.meta\.url/u,
    "loads a file next to itself at run time (new URL(…, import.meta.url))",
  ],
  [/\bnew\s+(?:Shared)?Worker\s*\(/u, "starts a worker"],
  [/\bimportScripts\s*\(/u, "loads scripts into a worker"],
];

/**
 * Why a module esbuild wrote would load code or files at run time that
 * aren't part of the artifact: files next to it by URL, and workers
 * (not in the first package release).
 */
export const runtimeLoadsInJs = (code: string): string[] =>
  runtimeLoads.filter(([pattern]) => pattern.test(code)).map(([, why]) => why);

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

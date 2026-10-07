/**
 * Whether an SVG an artifact carries can run script or load anything when
 * a browser opens it as a document. An allowlist, not a denylist: the SVG
 * is parsed as XML, and only drawing elements, attributes whose references
 * stay inside the document (`#id`) or are inline images, and CSS whose
 * `url()`s do the same are taken. Anything else, including what this
 * parser can't read, is refused.
 *
 * What it takes care of: event handlers and script, embedding elements
 * under any prefix, external `href`/`src` on any element under any prefix
 * or in any case, `xml:base`, `<a>` to elsewhere, character references
 * hiding a scheme, CSS `url()`/`@import`/`image-set()` in `<style>` (CDATA
 * or not, split by XML or CSS comments, written with CSS escapes) or in
 * attributes, document type declarations and their entities, processing
 * instructions such as `xml-stylesheet`, and anything not plain UTF-8.
 */
import { cssUnescape, inertDataUrl, replaced } from "./inert.ts";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Elements that draw, group, paint or describe: all an SVG may have. */
const drawingElements = new Set([
  "a",
  "circle",
  "clipPath",
  "defs",
  "desc",
  "ellipse",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "filter",
  "g",
  "image",
  "line",
  "linearGradient",
  "marker",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialGradient",
  "rect",
  "stop",
  "style",
  "svg",
  "switch",
  "symbol",
  "text",
  "textPath",
  "title",
  "tspan",
  "use",
  "view",
]);

/** Elements whose `href` may be an inline image rather than a fragment. */
const imageElements = new Set(["image", "feImage"]);

const notUtf8 = "is an SVG that isn't plain UTF-8";
const active = "is an SVG with an element that can run or embed something";
const loadsOutside = "is an SVG that loads something from outside itself";
const unreadable = "is an SVG Grasp can't read";

/** A script or HTML URL, once whitespace and controls are taken out. */
const scriptUrl = /(?:javascript|vbscript|livescript):|data:text\/html/iu;

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

/** Thrown inside the parser with why the SVG is refused. */
class SvgRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SvgRefusedError";
  }
}

const refuse = (reason: string): never => {
  throw new SvgRefusedError(reason);
};

const xmlEntities: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/**
 * An attribute value with XML's character references decoded: numeric
 * ones and the five XML defines. Any other named reference needs a
 * document type declaration, which is refused, so it is refused here too.
 */
const xmlReference =
  /&(?:#x(?<hex>[0-9a-f]+)|#(?<decimal>\d+)|(?<name>[a-z]+));/giu;

/** A character reference's code point, if it is a numeric one. */
const codeOf = (hex?: string, decimal?: string): number | undefined => {
  if (hex !== undefined) {
    return Number.parseInt(hex, 16);
  }
  return decimal === undefined ? undefined : Number(decimal);
};

const decodeXml = (value: string): string => {
  if (/&(?!(?:#x[0-9a-f]+|#\d+|[a-z]+);)/iu.test(value)) {
    // An ampersand that starts no reference isn't XML.
    refuse(unreadable);
  }
  return replaced(value, xmlReference, ({ hex, decimal, name }) => {
    const code = codeOf(hex, decimal);
    if (code !== undefined) {
      return code > 0 && code <= 0x10_ff_ff
        ? String.fromCodePoint(code)
        : refuse(unreadable);
    }
    return xmlEntities[name ?? ""] ?? refuse(unreadable);
  });
};

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

/** Checks a reference: a fragment, or (where `image`) an inline image. */
const checkReference = (value: string, image: boolean): void => {
  const reference = squeezed(value);
  if (scriptUrl.test(reference)) {
    refuse("is an SVG that links to script");
  }
  if (!(reference.startsWith("#") || (image && inertDataUrl.test(reference)))) {
    refuse(loadsOutside);
  }
};

/**
 * Checks CSS from a `<style>` or an attribute, read as a browser would:
 * escapes decoded and comments taken out. No `@import`, no `image-set()`,
 * and every `url()` a fragment or an inline image.
 */
const checkCss = (css: string): void => {
  const read = squeezed(cssUnescape(css.replaceAll(/\/\*[\s\S]*?\*\//gu, "")));
  if (/@import|image-set\(|expression\(/iu.test(read)) {
    refuse(loadsOutside);
  }
  if (scriptUrl.test(read)) {
    refuse("is an SVG that links to script");
  }
  for (const match of read.matchAll(/url\((?<value>[^)]*)\)/giu)) {
    const value = (match.groups?.value ?? "").replaceAll(/^["']|["']$/gu, "");
    checkReference(value, true);
  }
  if (/url\(/iu.test(read.replaceAll(/url\([^)]*\)/giu, ""))) {
    refuse(unreadable);
  }
};

/** A name's local part: `xlink:href` is `href`. */
const localName = (name: string): string => name.slice(name.indexOf(":") + 1);

/** Checks one attribute of an element. */
const checkAttribute = (element: string, name: string, raw: string): void => {
  const value = decodeXml(raw);
  const local = localName(name).toLowerCase();
  if (name === "xmlns" || name.startsWith("xmlns:")) {
    // Namespace names: identifiers, never loaded.
    return;
  }
  if (local.startsWith("on")) {
    refuse("is an SVG with an event handler");
  }
  if (local === "base") {
    refuse(loadsOutside);
  }
  if (local === "href" || local === "src") {
    checkReference(value, local === "href" && imageElements.has(element));
    return;
  }
  if (
    local === "style" ||
    /url\(|@import|image-set/iu.test(cssUnescape(value))
  ) {
    checkCss(value);
  }
  if (scriptUrl.test(squeezed(value))) {
    refuse("is an SVG that links to script");
  }
};

const attributePattern =
  /^\s+(?<name>[A-Za-z_][\w.:-]*)\s*=\s*(?:"(?<double>[^"<]*)"|'(?<single>[^'<]*)')/u;

/** Reads a start tag's attributes from `body`, checking each. */
const checkAttributes = (element: string, body: string): void => {
  let rest = body;
  for (;;) {
    const match = attributePattern.exec(rest);
    if (match === null) {
      break;
    }
    const groups = match.groups ?? {};
    checkAttribute(
      element,
      groups.name ?? "",
      groups.double ?? groups.single ?? ""
    );
    rest = rest.slice(match[0].length);
  }
  if (rest.trim() !== "") {
    refuse(unreadable);
  }
};

/** Where `marker` ends in `text` from `from`, or refuses the SVG. */
const endOf = (text: string, from: number, marker: string): number => {
  const at = text.indexOf(marker, from);
  return at === -1 ? refuse(unreadable) : at;
};

/** Checks one start or end tag at `at`; returns where it ends and what it is. */
/**
 * Where the tag opened at `at` ends: its first `>` outside a quoted
 * attribute value, as XML reads it.
 */
const tagEnd = (text: string, at: number): number => {
  let quote: string | undefined;
  for (let index = at + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return refuse(unreadable);
};

const readTag = (
  text: string,
  at: number
): { end: number; name: string; closing: boolean; empty: boolean } => {
  const end = tagEnd(text, at);
  const tag = text.slice(at + 1, end);
  const closing = tag.startsWith("/");
  const empty = tag.endsWith("/");
  const inner = tag.slice(closing ? 1 : 0, empty ? -1 : undefined);
  const name = /^[A-Za-z_][\w.:-]*/u.exec(inner)?.[0];
  if (name === undefined) {
    return refuse(unreadable);
  }
  const element = localName(name);
  if (!closing) {
    if (!drawingElements.has(element)) {
      refuse(
        /^(?:script|foreignObject|iframe|embed|object|handler)$/iu.test(element)
          ? active
          : `is an SVG with an element that isn't drawing: ${element.slice(0, 40)}`
      );
    }
    checkAttributes(element, inner.slice(name.length));
  }
  return { end: end + 1, name: element, closing, empty };
};

/** Walks the SVG's markup, checking every tag, attribute and stylesheet. */
const checkMarkup = (text: string): void => {
  let at = 0;
  let style: string | undefined;
  while (at < text.length) {
    const open = text.indexOf("<", at);
    const next = open === -1 ? text.length : open;
    if (style !== undefined) {
      // Character references in text are decoded before CSS reads it, as
      // a browser does (CDATA, below, is taken as it is).
      style += decodeXml(text.slice(at, next));
    }
    if (open === -1) {
      break;
    }
    if (text.startsWith("<!--", open)) {
      // Comments go, so what they split reads joined, as XML reads it.
      // `<!-->` isn't a comment: its end is looked for past its start.
      at = endOf(text, open + 4, "-->") + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      const end = endOf(text, open, "]]>");
      if (style !== undefined) {
        style += text.slice(open + 9, end);
      }
      at = end + 3;
    } else if (text.startsWith("<?", open)) {
      const end = endOf(text, open, "?>");
      // The XML declaration only, at the very start; never a stylesheet.
      if (!(open === 0 && /^<\?xml\s/u.test(text.slice(0, end)))) {
        refuse(loadsOutside);
      }
      at = end + 2;
    } else if (text.startsWith("<!", open)) {
      return refuse(
        "is an SVG that declares its own entities or document type"
      );
    } else {
      const tag = readTag(text, open);
      if (tag.name === "style" && !tag.closing && !tag.empty) {
        style = "";
      } else if (tag.name === "style" && tag.closing) {
        checkCss(style ?? "");
        style = undefined;
      }
      at = tag.end;
    }
  }
  if (style !== undefined) {
    refuse(unreadable);
  }
};

/**
 * Why an SVG could run script or load anything when opened as a
 * document, or undefined if it only draws.
 */
export const svgRefusal = (bytes: Uint8Array): string | undefined => {
  const text = plainText(bytes);
  if (text === undefined) {
    return notUtf8;
  }
  try {
    checkMarkup(text);
  } catch (error) {
    if (error instanceof SvgRefusedError) {
      return error.message;
    }
    throw error;
  }
  return undefined;
};

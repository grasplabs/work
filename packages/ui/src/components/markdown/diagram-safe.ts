// What a `mermaid` fence may be for Pele to draw it, and what its drawing may hold (diagram.tsx
// draws it). Pele draws a string with links and pictures off, but a fence that holds any way to an
// address is never given to it: its source is weighed first, as written and with its character
// references read, and is code when it holds one. Then its drawing is read as SVG and held to
// SVG's own shapes.

/**
 * Words in a fence that could lead its drawing elsewhere: a picture node (`img`), a style's
 * `url(…)` or `image-set(…)`, an address (`//`), `@import`, and a backslash, with which CSS writes
 * any of them another way. A diagram with a web address in a label is code too: the price of
 * weighing the words, not each diagram type's reading of them.
 */
const LEADS = /url\(|image-set\(|img|\/\/|\\|@import/iu;
// A sequence diagram's `properties` (JSON whose `icon` names a picture, at any address, relative
// ones too) and `details` (JSON read from an element of the page, by its id): refused by their
// statement, whatever they hold.
const STATEMENTS = /^\s*(?:properties|details)\s+[^\n:]*:/imu;

/**
 * `code` with its character references read as Mermaid's syntax writes them: `#name;` and `#123;`
 * are its own way to write `&name;` and `&#123;`, and named ones are read too.
 */
const decoded = (code: string) => {
  const references = code.replaceAll(/#(?<name>\w+);/gu, (_, name: string) =>
    /^\d+$/u.test(name) ? `&#${name};` : `&${name};`
  );
  return (
    new DOMParser().parseFromString(
      `<textarea>${references.replaceAll("<", "&lt;")}</textarea>`,
      "text/html"
    ).body.textContent ?? ""
  );
};
const leadsAway = (code: string) => LEADS.test(code) || STATEMENTS.test(code);

/**
 * The most a fence may hold and be drawn, for every diagram type: characters, lines (a `;` ends one
 * too), and parts: the words outside its labels (a block diagram names a hundred blocks on one
 * line), or the edges that words joined by `&` stand for. Pele has no time limit of its own: these
 * bound how long a draw holds the page. The measurements, at the worst fences of each type these
 * allow, are in the pull requests that moved diagrams to Pele and bounded them.
 */
export const MOST_CHARACTERS = 1500;
export const MOST_LINES = 40;
export const MOST_PARTS = 100;
// A label: quoted, in brackets, between bars, or after a colon to the line's end.
const LABELS =
  /"[^"\n]*"|\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}|\|[^|\n]*\||:[^\n;]*/gu;
/**
 * The parts of one line: its words outside its labels, or, when words are joined by `&`, the edges
 * they stand for if those are more (`a & b --> c & d` is four): each run of joined words meets
 * every word of the run next to it.
 */
const partsOfLine = (line: string) => {
  const runs: number[] = [];
  let joined = false;
  for (const [piece] of line.matchAll(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu)) {
    if (/^[^\p{L}\p{N}_]/u.test(piece)) {
      joined = piece.trim() === "&";
    } else if (joined && runs.length > 0) {
      runs[runs.length - 1] = (runs.at(-1) ?? 0) + 1;
    } else {
      runs.push(1);
    }
  }
  const words = runs.reduce((sum, run) => sum + run, 0);
  const edges = runs.reduce(
    (sum, run, at) => sum + run * (runs[at + 1] ?? 0),
    0
  );
  return Math.max(words, edges);
};
const partsOf = (code: string) =>
  code
    .replaceAll(LABELS, " ")
    .split(/[\n;]/u)
    .reduce((sum, line) => sum + partsOfLine(line), 0);

/** The lines of `code` that hold something, a `;` ending one as a newline does. */
const linesOf = (code: string) =>
  code.split(/[\n;]/u).filter((line) => line.trim() !== "").length;

/**
 * Why Pele may not draw this fence, if it may not: `limit` past a bound on its size, `source` for
 * a way to an address in it; null when it may.
 */
export const refusalOf = (code: string): "limit" | "source" | null => {
  if (
    code.length > MOST_CHARACTERS ||
    linesOf(code) > MOST_LINES ||
    partsOf(code) > MOST_PARTS
  ) {
    return "limit";
  }
  return leadsAway(code) || leadsAway(decoded(code)) ? "source" : null;
};

/** Whether Pele may draw this fence: small enough, and with no way to an address in it. */
export const drawable = (code: string) => refusalOf(code) === null;

// What a drawing may hold: SVG's own shapes, text and styles, nothing that leads or loads.
const TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "defs",
  "marker",
  "title",
  "desc",
  "clipPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "mask",
  "symbol",
  "use",
]);
// A value's way to anywhere but the drawing itself (in a `style` or a fill), or a backslash that
// could write one.
const ELSEWHERE = /url\(\s*(?!['"]?#)|image-set\(|\\|@import/iu;
const SVG = "http://www.w3.org/2000/svg";

/**
 * Pele's drawing, read as SVG (never as HTML) and held to TAGS in SVG's own namespace: a link is
 * its words, a `<style>` goes (Pele writes its styles in attributes), and no handler, `data-`
 * attribute, address or `url()` to anywhere but the drawing itself stays. The drawing's root, read
 * once for the page to take as it is; null when it is no SVG.
 */
export const safeSvg = (svg: string): Element | null => {
  // A link's `xlink:href` written without its namespace declared, which SVG's own reading refuses:
  // declared here, so the link can be read, and taken out.
  const declared = svg.includes("xmlns:xlink=")
    ? svg
    : svg.replace(
        /^<svg\b/u,
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink"'
      );
  const read = new DOMParser().parseFromString(declared, "image/svg+xml");
  const root = read.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== SVG ||
    read.querySelector("parsererror") !== null
  ) {
    return null;
  }
  for (const link of [...root.querySelectorAll("a")].toReversed()) {
    link.replaceWith(...link.childNodes);
  }
  for (const element of root.querySelectorAll("*")) {
    if (!TAGS.has(element.localName) || element.namespaceURI !== SVG) {
      element.remove();
    }
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    // Their names, a list of its own: one taken out of the live list as it is read skips the next.
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? "";
      const leads = /href$/iu.test(name) && !value.startsWith("#");
      // A `data-` attribute is the renderer's own note (a node's id, an icon's name, an address
      // too): nothing the drawing needs.
      if (/^(?:on|data-)/iu.test(name) || leads || ELSEWHERE.test(value)) {
        element.removeAttribute(name);
      }
    }
  }
  return root;
};

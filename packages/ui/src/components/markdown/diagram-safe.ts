// What a `mermaid` fence may be for Mermaid to draw it, and what its drawing may hold (diagram.tsx
// draws it). A fence that could make Mermaid load anything is never given to it: its source is
// weighed first, as written and with its character references read, and is code when it holds any
// way to an address. Then its drawing is read as SVG and held to SVG's own shapes.

/**
 * Words in a fence that could lead its drawing elsewhere: a picture node (`img`), a style's
 * `url(…)` or `image-set(…)`, an address (`//`), `@import`, and a backslash, with which CSS writes
 * any of them another way. A diagram with a web address in a label is code too: the price of
 * weighing the words, not each diagram type's reading of them.
 */
const LEADS = /url\(|image-set\(|img|\/\/|\\|@import/iu;
// A sequence diagram's `properties` (JSON whose `icon` Mermaid draws as a picture, from any address,
// relative ones too) and `details` (JSON read from any element of the page, by its id): refused by
// their statement, whatever they hold.
const STATEMENTS = /^\s*(?:properties|details)\s+[^\n:]*:/imu;

/**
 * `code` with its character references read as Mermaid reads them: `#name;` and `#123;` are its own
 * way to write `&name;` and `&#123;`, and DOMPurify, through which a label goes, reads named ones.
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
 * too), and parts, the words outside its labels (a block diagram names a hundred blocks on one
 * line). At these, the slowest type (a class diagram) holds a slow machine's page for about 400
 * ms; past them, for seconds (a mindmap of 20,000 characters, 35 s). The measurements are in the
 * pull request that set them.
 */
export const MOST_CHARACTERS = 1500;
export const MOST_LINES = 40;
export const MOST_PARTS = 100;
// A label: quoted, in brackets, between bars, or after a colon to the line's end.
const LABELS =
  /"[^"\n]*"|\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}|\|[^|\n]*\||:[^\n;]*/gu;
const partsOf = (code: string) =>
  code.replaceAll(LABELS, " ").match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;

/** The lines of `code` that hold something, a `;` ending one as a newline does. */
const linesOf = (code: string) =>
  code.split(/[\n;]/u).filter((line) => line.trim() !== "").length;

/** Whether Mermaid may draw this fence: small enough, and with no way to an address in it. */
export const drawable = (code: string) =>
  code.length <= MOST_CHARACTERS &&
  linesOf(code) <= MOST_LINES &&
  partsOf(code) <= MOST_PARTS &&
  !leadsAway(code) &&
  !leadsAway(decoded(code));

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
  "style",
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
// A style's way to anywhere but the drawing itself, or a backslash that could write one.
const ELSEWHERE = /url\(\s*['"]?(?!#)|image-set\(|\\|@import/iu;
const SVG = "http://www.w3.org/2000/svg";

/**
 * A drawing's styles, only the rules for the drawing itself (each of its selectors under `#id`)
 * and its animations' keyframes: none reaches the page round it.
 */
const ownStyle = (css: string, id: string) => {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return "";
  }
  return [...sheet.cssRules]
    .filter((rule) =>
      rule instanceof CSSStyleRule
        ? rule.selectorText
            .split(",")
            .every((selector) => selector.trim().startsWith(`#${id}`))
        : rule instanceof CSSKeyframesRule
    )
    .map((rule) => rule.cssText)
    .join("\n");
};

/**
 * Mermaid's drawing of the diagram `id`, read as SVG (never as HTML), held to TAGS in SVG's own
 * namespace: a link is its words, a style keeps only its rules for the drawing, and no handler,
 * address or `url()` to anywhere but the drawing itself stays. Null when it is no SVG.
 */
export const safeSvg = (svg: string, id: string) => {
  // Mermaid writes a link's `xlink:href` without declaring its namespace, which SVG's own reading
  // refuses: declared here, so the link can be read, and taken out.
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
    } else if (element.localName === "style") {
      const css = ownStyle(element.textContent ?? "", id);
      if (css === "" || ELSEWHERE.test(css)) {
        element.remove();
      } else {
        element.textContent = css;
      }
    }
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    // Their names, a list of its own: one taken out of the live list as it is read skips the next.
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? "";
      const leads = /href$/iu.test(name) && !value.startsWith("#");
      if (/^on/iu.test(name) || leads || ELSEWHERE.test(value)) {
        element.removeAttribute(name);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
};

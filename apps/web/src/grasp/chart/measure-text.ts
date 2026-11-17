// How big words are drawn, measured in the engine the page runs in: each is set in a hidden SVG
// text with the same class as the label that will show it, and its box is read. A canvas measure
// with a guessed font came out a pixel or more short in Firefox and WebKit, where names then touched
// or ran past the chart. Read once per class and words, then kept. Only in a browser: on the server
// every box is empty, and the parts that call it draw only once they have a width.
const SVG = "http://www.w3.org/2000/svg";

const kept = new Map<string, { width: number; height: number }>();

/** Each of `words`' drawn width and height, in CSS pixels, as an SVG text with `className`. */
export const measureText = (
  words: readonly string[],
  className: string | undefined
): { width: number; height: number }[] => {
  if (typeof document === "undefined") {
    return words.map(() => ({ width: 0, height: 0 }));
  }
  const fresh = new Map<string, { width: number; height: number }>();
  const missing = words.filter(
    (word) => !kept.has(`${className ?? ""}\n${word}`)
  );
  if (missing.length > 0) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("visibility", "hidden");
    const texts = missing.map((word) => {
      const text = document.createElementNS(SVG, "text");
      text.setAttribute("class", className ?? "");
      text.textContent = word;
      svg.append(text);
      return text;
    });
    document.body.append(svg);
    // Kept only once the page's fonts are in: a box read in the fallback font is read again.
    const settled = document.fonts.status === "loaded";
    for (const [index, text] of texts.entries()) {
      const box = text.getBBox();
      fresh.set(`${className ?? ""}\n${missing[index] ?? ""}`, {
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      });
    }
    if (settled) {
      for (const [key, box] of fresh) {
        kept.set(key, box);
      }
    }
    svg.remove();
  }
  return words.map(
    (word) =>
      kept.get(`${className ?? ""}\n${word}`) ??
      fresh.get(`${className ?? ""}\n${word}`) ?? { width: 0, height: 0 }
  );
};

// Lengths the virtual viewport needs as numbers: a token's size (a table's row, the gap between
// pages), read from the page's styles, so the numbers always match what CSS draws.

/** The number a length starts with, its unit left off: what `parseFloat` reads. */
const leadingNumber = (value: string) => {
  const found = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iu.exec(value);
  return found === null ? Number.NaN : Number(found[0]);
};

/** A CSS length in pixels or rem, in pixels. */
export const pixels = (value: string) => {
  const number = leadingNumber(value);
  if (Number.isNaN(number)) {
    return 0;
  }
  return value.trim().endsWith("rem")
    ? number *
        leadingNumber(getComputedStyle(document.documentElement).fontSize)
    : number;
};

/** A size token (`viewer-row`), in pixels, as the element sees it. */
export const tokenPixels = (
  name: string,
  element: Element = document.documentElement
) => pixels(getComputedStyle(element).getPropertyValue(`--grasp-${name}`));

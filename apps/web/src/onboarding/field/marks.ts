import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";

// What Stephen does with a component he holds: he takes its own picture,
// the brand logo it carries (a provider's, a source's), and
// draws it small in his dither at the component's far end, in the logo's
// own colours, so it reads as that logo (Ruben: large and in mint, nobody
// knew what it was), building up while he is on it and fading where it is
// when he leaves. Drawn on one canvas over the page, in cells as the flags
// are; nothing is drawn over the component's words. A component that is too narrow for a picture beside its words, or
// has none, or draws its own (a canvas), gets none.

/** A cell's side in CSS pixels: the flags' own. */
const CELL = 4;

/** A component this much wider than tall has room for a picture beside its words. */
const ROOMY = 2.4;

/** The picture's height, as times the component's: well inside it. */
const SCALE = 0.6;

/** How far the picture stands in from the component's far edge, in CSS pixels. */
const INSET = 16;

const bayerAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[y % 4]?.[x % 4] ?? 0) + 0.5) / DITHER_LEVELS;

/** The least free room beside a component's words, in CSS pixels, that a picture is drawn in. */
const LEAST_ROOM = 72;

/** How far a picture keeps from the words, in CSS pixels. */
const CLEAR = 12;

/** A picture as cells: each one's colour, or none where it is clear, read once from the component's own mark, and the free room it has. */
interface Mark {
  columns: number;
  rows: number;
  /** A cell's colour as CSS, null where it is clear, or "ink" where a one-colour logo takes the page's ink: drawn in the light's colour. */
  lit: (string | null)[];
  /** From the component's far edge to the end of its words, in CSS pixels. */
  room: number;
}

/** How much free room a component has after its words, toward its far edge. */
const roomAfterWords = (element: Element): number => {
  const box = element.getBoundingClientRect();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let end = box.left;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.textContent ?? "").trim() !== "") {
      range.selectNodeContents(node);
      end = Math.max(end, range.getBoundingClientRect().right);
    }
  }
  return box.right - end;
};

/** What is known of each component's mark: being read, read, or none. */
const marks = new WeakMap<Element, Mark | "reading" | null>();

/**
 * The component's own picture, if it has room for one: its brand's logo.
 * Only a logo (Damsko's BrandIcon): a control's icon, a select's chevron
 * or a speaker, is how it works, not what it is, and drawn large it reads
 * as a fault.
 */
const pictureOf = (element: Element): SVGSVGElement | null => {
  const { width, height } = element.getBoundingClientRect();
  if (width < height * ROOMY || element.querySelector("canvas") !== null) {
    return null;
  }
  return element.querySelector("[data-slot=brand-icon] svg");
};

/** Reads `svg` at `size` cells high into which cells are lit. */
const readMark = async (svg: SVGSVGElement, rows: number): Promise<Mark> => {
  const copy = svg.cloneNode(true);
  if (!(copy instanceof SVGSVGElement)) {
    return { columns: 0, rows: 0, lit: [], room: 0 };
  }
  const box = svg.viewBox.baseVal;
  const aspect = box.width > 0 && box.height > 0 ? box.width / box.height : 1;
  const columns = Math.max(1, Math.round(rows * aspect));
  copy.setAttribute("width", String(columns * 4));
  copy.setAttribute("height", String(rows * 4));
  // Its own colours stay; what takes the page's ink (currentColor, or no fill at all) is drawn
  // in pure black here, and drawn in the light's colour later.
  copy.removeAttribute("class");
  copy.setAttribute("fill", "#000");
  copy.setAttribute("color", "#000");
  // The page allows pictures from itself and `data:` addresses only, not `blob:`.
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new XMLSerializer().serializeToString(copy)
  )}`;
  const image = new Image();
  image.src = source;
  await image.decode();
  const flat = document.createElement("canvas");
  flat.width = columns;
  flat.height = rows;
  const context = flat.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    return { columns: 0, rows: 0, lit: [], room: 0 };
  }
  context.drawImage(image, 0, 0, columns, rows);
  const { data } = context.getImageData(0, 0, columns, rows);
  const lit: Mark["lit"] = [];
  for (let at = 0; at < columns * rows; at += 1) {
    const [red = 0, green = 0, blue = 0, alpha = 0] = data.subarray(
      at * 4,
      at * 4 + 4
    );
    if (alpha <= 96) {
      lit.push(null);
    } else if (red + green + blue < 24) {
      lit.push("ink");
    } else {
      lit.push(`rgb(${red} ${green} ${blue})`);
    }
  }
  return { columns, rows, lit, room: 0 };
};

/** The mark of a component, once read; it starts reading it the first time it is asked. */
const markOf = (element: Element, height: number): Mark | null => {
  const known = marks.get(element);
  if (known !== undefined) {
    return known === "reading" ? null : known;
  }
  const svg = pictureOf(element);
  // Never over its words: a component whose words fill it (a button) has no room for one.
  const room = roomAfterWords(element);
  if (svg === null || room < LEAST_ROOM) {
    marks.set(element, null);
    return null;
  }
  marks.set(element, "reading");
  const rows = Math.max(5, Math.round((height * SCALE) / CELL));
  void (async () => {
    try {
      marks.set(element, { ...(await readMark(svg, rows)), room });
    } catch {
      marks.set(element, null);
    }
  })();
  return null;
};

/** One component he holds, as the marks are drawn: where it is, how much of him is there. */
export interface Held {
  element: Element;
  box: readonly [number, number, number, number];
  on: number;
}

/**
 * Draws each held component's mark on `canvas` (over the page, the
 * window's size), in `colour`, a little alive: the cells on the fade's
 * edge come and go with `time`.
 */
export const drawMarks = (
  canvas: HTMLCanvasElement,
  held: readonly Held[],
  colour: string,
  time: number
) => {
  const context = canvas.getContext("2d");
  if (context === null) {
    return;
  }
  const ratio = Math.min(window.devicePixelRatio, 2);
  const wide = Math.round(window.innerWidth * ratio);
  const high = Math.round(window.innerHeight * ratio);
  if (canvas.width !== wide || canvas.height !== high) {
    canvas.width = wide;
    canvas.height = high;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (const { element, box, on } of held) {
    if (on < 0.01) {
      continue;
    }
    const [x, y, width, height] = box;
    const mark = markOf(element, height);
    if (mark === null || mark.columns === 0) {
      continue;
    }
    const left = x + width - INSET - mark.columns * CELL;
    const top = y + (height - mark.rows * CELL) / 2;
    // Clear of its words: none drawn where they are.
    const free = x + width - mark.room + CLEAR;
    context.save();
    context.beginPath();
    context.rect(free, y, x + width - free, height);
    context.clip();
    for (let row = 0; row < mark.rows; row += 1) {
      for (let column = 0; column < mark.columns; column += 1) {
        const tone = mark.lit[row * mark.columns + column];
        if (tone === null || tone === undefined) {
          continue;
        }
        // The whole logo builds up through the dither, a little alive while he is on it.
        const flicker = 0.06 * Math.sin(time * 2.2 + column * 0.7 + row * 1.3);
        const much = on * 1.1 + flicker;
        if (bayerAt(column, row) >= much) {
          continue;
        }
        context.fillStyle = tone === "ink" ? colour : tone;
        context.globalAlpha = Math.min(1, 0.35 + much);
        context.fillRect(
          left + column * CELL,
          top + row * CELL,
          CELL - 1,
          CELL - 1
        );
      }
    }
    context.restore();
  }
  context.globalAlpha = 1;
};

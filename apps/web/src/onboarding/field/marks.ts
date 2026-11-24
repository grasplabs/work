import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";

// What Stephen does with a component he holds: he takes its own picture,
// the brand logo it carries (a provider's, a source's), and
// draws it large in his dither across the component's free side, as the
// language cards draw their flags: whole at the far edge, thinning out
// toward the words, building up while he is on it and fading where it is
// when he leaves. Drawn on one canvas over the page, in cells as the flags
// are, in the light's own colour; nothing is drawn over the component's
// words. A component that is too narrow for a picture beside its words, or
// has none, or draws its own (a canvas), gets none.

/** A cell's side in CSS pixels: the flags' own. */
const CELL = 4;

/** A component this much wider than tall has room for a picture beside its words. */
const ROOMY = 2.4;

/** The picture's height, as times the component's: it bleeds off the far edge. */
const SCALE = 2.1;

/** How much of the component's width, from its far edge, the picture fades over. */
const REACH = 0.6;

const bayerAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[y % 4]?.[x % 4] ?? 0) + 0.5) / DITHER_LEVELS;

/** The least free room beside a component's words, in CSS pixels, that a picture is drawn in. */
const LEAST_ROOM = 72;

/** How far a picture keeps from the words, in CSS pixels. */
const CLEAR = 12;

/** A picture as cells: which are lit, read once from the component's own mark, and the free room it has. */
interface Mark {
  columns: number;
  rows: number;
  lit: Uint8Array;
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
    return { columns: 0, rows: 0, lit: new Uint8Array(), room: 0 };
  }
  const box = svg.viewBox.baseVal;
  const aspect = box.width > 0 && box.height > 0 ? box.width / box.height : 1;
  const columns = Math.max(1, Math.round(rows * aspect));
  copy.setAttribute("width", String(columns * 4));
  copy.setAttribute("height", String(rows * 4));
  // Its look comes from the page's classes, which a picture alone doesn't have: solid, in one ink.
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
    return { columns: 0, rows: 0, lit: new Uint8Array(), room: 0 };
  }
  context.drawImage(image, 0, 0, columns, rows);
  const { data } = context.getImageData(0, 0, columns, rows);
  const lit = new Uint8Array(columns * rows);
  for (let at = 0; at < lit.length; at += 1) {
    lit[at] = (data[at * 4 + 3] ?? 0) > 96 ? 1 : 0;
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
  const rows = Math.max(8, Math.round((height * SCALE) / CELL));
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
  context.fillStyle = colour;
  for (const { element, box, on } of held) {
    if (on < 0.01) {
      continue;
    }
    const [x, y, width, height] = box;
    const mark = markOf(element, height);
    if (mark === null || mark.columns === 0) {
      continue;
    }
    const left = x + width - mark.columns * CELL * 0.82;
    const top = y + (height - mark.rows * CELL) / 2;
    const free = x + width - mark.room + CLEAR;
    const fadeFrom = Math.max(x + width * (1 - REACH), free);
    // Kept inside the component, clear of its edge and of its words, so his ring and the words stay clean.
    context.save();
    context.beginPath();
    context.rect(free, y + 3, x + width - 3 - free, height - 6);
    context.clip();
    for (let row = 0; row < mark.rows; row += 1) {
      for (let column = 0; column < mark.columns; column += 1) {
        if (mark.lit[row * mark.columns + column] !== 1) {
          continue;
        }
        const cellX = left + column * CELL;
        const cellY = top + row * CELL;
        // Whole at the far edge, thinning out toward the words.
        const across = Math.min(
          1,
          Math.max(0, (cellX - fadeFrom) / (x + width - fadeFrom))
        );
        const flicker = 0.06 * Math.sin(time * 2.2 + column * 0.7 + row * 1.3);
        const much = on * across ** 1.4 + flicker;
        if (bayerAt(column, row) >= much) {
          continue;
        }
        context.globalAlpha = Math.min(1, 0.25 + much);
        context.fillRect(cellX, cellY, CELL - 1, CELL - 1);
      }
    }
    context.restore();
  }
  context.globalAlpha = 1;
};

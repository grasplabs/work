import { lightness, rgba } from "./dot-ink.ts";
import { seeded } from "./reveal-motion.ts";

/**
 * Where the dots land when they build a page: points on what the page draws, read off the page
 * itself, each with the size of dot it takes and how dark it is, 0 to 1. Words become short rows
 * of dots, edges become dotted outlines, dark fills fill with dots, and icons and charts are
 * traced along their lines, so the page stands there in dots before it shows. Ported from the
 * prototype (grasplabs/prototype, packages/grasp: components/onboarding/reveal-targets.ts).
 */
export interface RevealTargets {
  count: number;
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  tone: Float32Array;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The dots gathered so far, and the ways to add them. */
interface Collector {
  x: number[];
  y: number[];
  r: number[];
  tone: number[];
  add: (x: number, y: number, r: number, tone: number) => void;
  /** A dotted line, one dot every `step`. */
  line: (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    step: number,
    r: number,
    tone: number
  ) => void;
  /** The edge of a box with rounded corners, one dot every `step`. */
  outline: (
    box: Box,
    radius: number,
    step: number,
    r: number,
    tone: number
  ) => void;
  /** A box filled with dots on a grid, one every `step`, leaving out the rounded corners. */
  fill: (
    box: Box,
    radius: number,
    step: number,
    r: number,
    tone: number
  ) => void;
}

const collector = (width: number, height: number): Collector => {
  const dots: Pick<Collector, "x" | "y" | "r" | "tone"> = {
    x: [],
    y: [],
    r: [],
    tone: [],
  };
  const add = (x: number, y: number, r: number, tone: number) => {
    if (x < 0 || y < 0 || x > width || y > height) {
      return;
    }
    dots.x.push(x);
    dots.y.push(y);
    dots.r.push(r);
    dots.tone.push(tone);
  };
  const line: Collector["line"] = (x1, y1, x2, y2, step, r, tone) => {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const count = Math.max(1, Math.round(length / step));
    for (let index = 0; index <= count; index += 1) {
      add(
        x1 + ((x2 - x1) * index) / count,
        y1 + ((y2 - y1) * index) / count,
        r,
        tone
      );
    }
  };
  const outline: Collector["outline"] = (box, radius, step, r, tone) => {
    const { left, top, right, bottom } = box;
    const round = Math.max(
      0,
      Math.min(radius, (right - left) / 2, (bottom - top) / 2)
    );
    line(left + round, top, right - round, top, step, r, tone);
    line(right, top + round, right, bottom - round, step, r, tone);
    line(right - round, bottom, left + round, bottom, step, r, tone);
    line(left, bottom - round, left, top + round, step, r, tone);
    if (round < 1) {
      return;
    }
    const corners: [number, number, number][] = [
      [right - round, top + round, -Math.PI / 2],
      [right - round, bottom - round, 0],
      [left + round, bottom - round, Math.PI / 2],
      [left + round, top + round, Math.PI],
    ];
    const count = Math.max(1, Math.round((Math.PI * round) / 2 / step));
    for (const [cx, cy, from] of corners) {
      for (let index = 1; index < count; index += 1) {
        const angle = from + (Math.PI / 2) * (index / count);
        add(
          cx + Math.cos(angle) * round,
          cy + Math.sin(angle) * round,
          r,
          tone
        );
      }
    }
  };
  const fill: Collector["fill"] = (box, radius, step, r, tone) => {
    const { left, top, right, bottom } = box;
    const round = Math.max(
      0,
      Math.min(radius, (right - left) / 2, (bottom - top) / 2)
    );
    for (let y = top + step / 2; y < bottom; y += step) {
      for (let x = left + step / 2; x < right; x += step) {
        const dx = Math.max(left + round - x, x - (right - round), 0);
        const dy = Math.max(top + round - y, y - (bottom - round), 0);
        if (dx * dx + dy * dy <= round * round) {
          add(x, y, r, tone);
        }
      }
    }
  };
  return { ...dots, add, line, outline, fill };
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** A computed length, such as "12px", in pixels; 0 when it is none. */
// oxlint-disable-next-line unicorn/prefer-number-coercion -- a computed length carries its unit: Number("12px") is NaN
const lengthOf = (value: string): number => Number.parseFloat(value) || 0;

const SOMETHING = /\S/u;
const WORD = /\S+/gu;

/** At most `budget` of the collected dots, picked evenly at random, so every part keeps its share. */
const pick = (dots: Collector, budget: number): RevealTargets => {
  const total = dots.x.length;
  const order = Array.from({ length: total }, (_, index) => index);
  const random = seeded(11);
  const count = Math.min(total, budget);
  for (let index = 0; index < count; index += 1) {
    const swap = index + Math.floor(random() * (total - index));
    const kept = order[index] ?? 0;
    order[index] = order[swap] ?? 0;
    order[swap] = kept;
  }
  const targets: RevealTargets = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    r: new Float32Array(count),
    tone: new Float32Array(count),
  };
  for (let index = 0; index < count; index += 1) {
    const from = order[index] ?? 0;
    targets.x[index] = dots.x[from] ?? 0;
    targets.y[index] = dots.y[from] ?? 0;
    targets.r[index] = dots.r[from] ?? 0;
    targets.tone[index] = dots.tone[from] ?? 0;
  }
  return targets;
};

/**
 * Reads the page under `root` into target dots, as it is drawn now in an area of `width` by
 * `height` whose top left is at `origin` on the screen; `skip` is left out, as is anything hidden.
 * `ground` is how light the page's own background is, so darkness is measured against it. At most
 * `budget` dots, picked evenly when there are more.
 */
export const sampleTargets = (
  root: Element,
  {
    width,
    height,
    origin = { x: 0, y: 0 },
    skip,
    ground,
    budget,
  }: {
    width: number;
    height: number;
    origin?: { x: number; y: number };
    skip: Element;
    ground: number;
    budget: number;
  }
): RevealTargets => {
  const dots = collector(width, height);
  const range = document.createRange();
  // Where a box on the screen lies in the area.
  const within = (box: DOMRect) =>
    new DOMRect(box.x - origin.x, box.y - origin.y, box.width, box.height);
  const inView = (box: DOMRect) =>
    box.width > 0 &&
    box.height > 0 &&
    box.right > 0 &&
    box.bottom > 0 &&
    box.left < width &&
    box.top < height;
  // How dark a colour reads on the page, 0 to 1, for its dots' ink.
  const darkness = (color: string, floor: number) => {
    const found = rgba(color);
    return clamp(
      Math.abs(lightness(found) - ground) * found[3] * 1.25,
      floor,
      1
    );
  };

  const words = (node: Text, style: CSSStyleDeclaration) => {
    const text = node.data;
    if (!SOMETHING.test(text) || rgba(style.color)[3] < 0.1) {
      return;
    }
    const tone = darkness(style.color, 0.22);
    const size = lengthOf(style.fontSize) || 14;
    const step = clamp(size * 0.3, 2.8, 6.5);
    const dot = clamp(size * 0.075, 0.75, 2);
    const rows = size >= 20 ? 2 : 1;
    const gap = size * 0.26;
    for (const word of text.matchAll(WORD)) {
      range.setStart(node, word.index);
      range.setEnd(node, word.index + word[0].length);
      for (const rect of range.getClientRects()) {
        const box = within(rect);
        if (!inView(box)) {
          continue;
        }
        const middle = box.top + box.height * 0.54;
        for (let row = 0; row < rows; row += 1) {
          const level = middle + (row - (rows - 1) / 2) * gap;
          dots.line(
            box.left + step / 2,
            level,
            Math.max(box.left + step / 2, box.right - step / 2),
            level,
            step,
            dot,
            tone
          );
        }
      }
    }
  };

  // Icons and charts, traced along their own lines.
  const drawing = (svg: SVGSVGElement, style: CSSStyleDeclaration) => {
    const box = within(svg.getBoundingClientRect());
    if (!inView(box)) {
      return;
    }
    const icon = box.width <= 32 && box.height <= 32;
    const tone = darkness(style.color, 0.3);
    for (const shape of svg.querySelectorAll<SVGGeometryElement>(
      "path, line, polyline, polygon, circle, ellipse, rect"
    )) {
      let length = 0;
      try {
        length = shape.getTotalLength();
      } catch {
        // A shape that cannot be measured is left out.
        continue;
      }
      const matrix = shape.getScreenCTM();
      if (!(matrix && length)) {
        continue;
      }
      const scale =
        Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
      const count = Math.min(
        400,
        Math.max(2, Math.ceil((length * scale) / (icon ? 1.7 : 3.5)))
      );
      for (let index = 0; index < count; index += 1) {
        const point = shape.getPointAtLength((index / count) * length);
        dots.add(
          matrix.a * point.x + matrix.c * point.y + matrix.e - origin.x,
          matrix.b * point.x + matrix.d * point.y + matrix.f - origin.y,
          icon ? 0.7 : 1,
          tone
        );
      }
    }
  };

  // Borders become dotted outlines; a dark fill fills with dots; a surface that stands off the page gets its edge.
  const surface = (
    element: Element,
    style: CSSStyleDeclaration,
    box: DOMRect
  ) => {
    const radius = lengthOf(style.borderTopLeftRadius);
    const border = Math.max(
      ...[
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ].map(lengthOf)
    );
    const edged =
      border >= 0.5 &&
      style.borderTopStyle !== "none" &&
      rgba(style.borderTopColor)[3] >= 0.12;
    // The page's own frame is the screen itself: its edge says nothing.
    const everything = box.width * box.height > width * height * 0.8;
    if (edged && !everything) {
      dots.outline(box, radius, 5, 0.8, darkness(style.borderTopColor, 0.2));
    }
    if (
      element instanceof HTMLImageElement ||
      element instanceof HTMLCanvasElement ||
      element instanceof HTMLVideoElement
    ) {
      dots.fill(box, radius, 6, 1, 0.45);
    }
    const background = rgba(style.backgroundColor);
    if (background[3] < 0.35 || everything) {
      return;
    }
    const contrast = Math.abs(lightness(background) - ground) * background[3];
    if (contrast > 0.45) {
      dots.fill(box, radius, 4.5, 1.1, clamp(contrast * 1.2, 0.5, 1));
    } else if (
      !edged &&
      (contrast > 0.015 || style.boxShadow !== "none") &&
      box.width * box.height > 400
    ) {
      dots.outline(box, radius, 6, 0.75, clamp(0.25 + contrast * 2, 0.25, 0.6));
    }
  };

  const visit = (element: Element) => {
    if (element === skip) {
      return;
    }
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) < 0.05
    ) {
      return;
    }
    if (element instanceof SVGSVGElement) {
      drawing(element, style);
      return;
    }
    const box = within(element.getBoundingClientRect());
    if (inView(box)) {
      surface(element, style, box);
    }
    for (const child of element.childNodes) {
      if (child instanceof Text) {
        words(child, style);
      } else if (child instanceof Element) {
        visit(child);
      }
    }
  };
  visit(root);
  return pick(dots, budget);
};

/**
 * A page drawn in dots when the page itself cannot be read: a sidebar of rows, a header, a title,
 * a box to type in and a few cards, roughly where the platform has them.
 */
export const sketchTargets = (
  width: number,
  height: number,
  budget: number
): RevealTargets => {
  const dots = collector(width, height);
  const side = Math.min(240, width * 0.22);
  for (let row = 0; row < 11; row += 1) {
    dots.line(
      28,
      76 + row * 34,
      28 + 70 + ((row * 37) % 70),
      76 + row * 34,
      4,
      1,
      0.7
    );
  }
  dots.outline(
    { left: side + 8, top: 8, right: width - 8, bottom: height - 8 },
    14,
    6,
    0.75,
    0.3
  );
  dots.line(side + 32, 32, side + 140, 32, 4, 1, 0.6);
  const middle = side + (width - side) / 2;
  dots.line(middle - 160, height * 0.4, middle + 120, height * 0.4, 4, 1.6, 1);
  dots.outline(
    {
      left: middle - 240,
      top: height * 0.46,
      right: middle + 240,
      bottom: height * 0.46 + 110,
    },
    16,
    5,
    0.8,
    0.45
  );
  for (let card = 0; card < 3; card += 1) {
    dots.outline(
      {
        left: middle - 240 + card * 164,
        top: height * 0.46 + 140,
        right: middle - 240 + card * 164 + 152,
        bottom: height * 0.46 + 220,
      },
      12,
      5,
      0.8,
      0.35
    );
  }
  return pick(dots, budget);
};

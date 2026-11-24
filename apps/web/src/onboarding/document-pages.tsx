import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { extensionOf } from "./document-files.ts";

// The documents step's drop zone with the kinds of file Grasp reads lying
// over it as pages, cell by cell in the system's one dither, the way the
// welcome's cards draw their flags (flag-picture.tsx): a PDF, a Word
// document, a sheet, a slide and a plain text, each in its own colour and
// with its own kind of content, fanned out at the zone's two edges and
// thinning out toward its words, so the words stand clear. Each kind shared
// already lies on a small pile of its own, a sheet for each, up to three.
// While the pointer is on the zone or files are dragged over it, the pages
// fan open and rise a little, as if to take them. At rest they are still;
// under reduced motion they never move.

const styles = stylex.create({
  // The zone and the pages over it, in one box.
  box: { position: "relative", display: "grid" },
  // Over the whole zone, under nothing it says, never in the way of a drop or a press.
  cover: {
    position: "absolute",
    inset: 0,
    display: "block",
    pointerEvents: "none",
  },
  canvas: {
    display: "block",
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
  },
});

/** A cell's side in CSS pixels: the flags' own. */
const cell = 4;

type Kind = "pdf" | "word" | "sheet" | "slides" | "text";

/** Each kind's own colour, as its makers paint it. */
const colourOf: Record<Kind, string> = {
  pdf: "#d6403a",
  word: "#2b5797",
  sheet: "#1e7145",
  slides: "#c9512c",
  text: "#56626b",
};

/** The kind of a shared document, by its name's extension. */
const kindOfName = (name: string): Kind => {
  const extension = extensionOf(name);
  if (extension === "pdf") {
    return "pdf";
  }
  if (["docx", "doc", "html", "htm"].includes(extension)) {
    return "word";
  }
  if (["xlsx", "xls", "csv", "tsv"].includes(extension)) {
    return "sheet";
  }
  if (["pptx", "ppt"].includes(extension)) {
    return "slides";
  }
  return "text";
};

/** A cell's threshold in the system's dither, 0 to 1. */
const bayerAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[((y % 4) + 4) % 4]?.[((x % 4) + 4) % 4] ?? 0) + 0.5) /
  DITHER_LEVELS;

/** A number from 0 to 1, always the same for the same inputs: a little chance. */
const chance = (x: number, y: number, seed: number): number => {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43_758.5453;
  return value - Math.floor(value);
};

const mix = (hex: string, toward: number, amount: number): string => {
  const part = (at: number) => {
    const own = Number.parseInt(hex.slice(at, at + 2), 16);
    return Math.round(own + (toward - own) * amount);
  };
  return `rgb(${part(1)}, ${part(3)}, ${part(5)})`;
};

/** What a cell of a page shows: its paper, its paper in shade, what is written on it, or its folded corner. */
type Ink = "paper" | "shade" | "ink" | "fold";

/** A spot on a page's writing area: its cell, the page's height, the writing's edges, and a line drawn from `from`, `length` long. */
interface Spot {
  x: number;
  y: number;
  h: number;
  left: number;
  width: number;
  line: (from: number, length: number) => Ink;
}

/** What each kind has written on it: lines of text, a grid, a slide's title and bars. */
const writing: Record<Kind, (spot: Spot) => Ink> = {
  pdf: ({ y, h, left, width, line }) => {
    if (y === 2) {
      return line(left, Math.round(width * 0.55));
    }
    if (y >= 5 && y < h - 2 && y % 2 === 1) {
      return line(left, Math.round(width * (1 - chance(y, 3, 5) * 0.45)));
    }
    return "paper";
  },
  word: ({ x, y, h, left, width, line }) => {
    if (y === 2) {
      return line(left, Math.round(width * 0.7));
    }
    if (y < 5 || y >= h - 2 || y % 2 === 0) {
      return "paper";
    }
    // A few lines in the middle are a list, each with its point.
    if (y >= 11 && y <= 15) {
      return x === left
        ? "ink"
        : line(left + 2, Math.round(width * (0.4 + chance(y, 1, 7) * 0.4)));
    }
    return line(left, Math.round(width * (0.6 + chance(y, 2, 7) * 0.4)));
  },
  sheet: ({ x, y, h, left }) => {
    if (y < 2 || y >= h - 2) {
      return "paper";
    }
    if (y < 4) {
      return "ink";
    }
    return (x - left) % 4 === 0 || (y - 4) % 3 === 2 ? "ink" : "paper";
  },
  slides: ({ x, y, h, left, width, line }) => {
    if (y === 2 || y === 3) {
      return line(left, Math.round(width * 0.6));
    }
    // Four bars, standing on the slide's foot.
    const foot = h - 3;
    const bar = Math.floor((x - left) / 3);
    const inBar = (x - left) % 3 !== 2 && bar < 4;
    const tall = [0.35, 0.6, 0.45, 0.85][bar] ?? 0;
    const top = foot - Math.round((foot - 6) * tall);
    return inBar && y >= top && y <= foot ? "ink" : "paper";
  },
  text: ({ y, h, left, width, line }) => {
    if (y < 2 || y >= h - 2 || y % 2 === 1) {
      return "paper";
    }
    const indent = [0, 0, 2, 2, 4, 2, 0, 2, 4][(y / 2) % 9] ?? 0;
    return line(
      left + indent,
      Math.round((width - indent) * (0.3 + chance(y, 4, 9) * 0.6))
    );
  },
};

/** A page's folded corner, in cells: none on a slide. */
const foldOf = (kind: Kind): number => (kind === "slides" ? 0 : 4);

/**
 * What lies at (u, v) on a page of `kind`, `w` by `h` cells: its paper,
 * what is written on it, or its folded corner. `null` outside the page.
 */
const inkAt = (
  kind: Kind,
  u: number,
  v: number,
  w: number,
  h: number
): Ink | null => {
  if (u < 0 || v < 0 || u >= w || v >= h) {
    return null;
  }
  const fold = foldOf(kind);
  const intoCorner = u - (w - fold);
  if (fold > 0 && intoCorner >= 0 && v < fold) {
    return intoCorner > v + 0.5 ? null : "fold";
  }
  const x = Math.floor(u);
  const y = Math.floor(v);
  const left = 2;
  const right = w - 2;
  if (x < left || x >= right) {
    return "paper";
  }
  const line = (from: number, length: number): Ink =>
    x >= from && x < Math.min(right, from + length) ? "ink" : "paper";
  return writing[kind]({ x, y, h, left, width: right - left, line });
};

/** One page as it lies: its kind, size in cells, where its middle is in CSS pixels, and how it turns. */
interface Page {
  kind: Kind;
  w: number;
  h: number;
  x: number;
  y: number;
  turn: number;
  /** Sheets of its kind already shared, lying under it. */
  pile: number;
}

/** How much the pages are awake: open (pointer on the zone) and taking (files over it). */
interface Life {
  open: number;
  taking: number;
}

/** The pages at each edge, the outer one first, each a little turned. */
const sides: { kind: Kind; side: -1 | 1; inner: boolean; turn: number }[] = [
  { kind: "word", side: -1, inner: false, turn: -0.07 },
  { kind: "pdf", side: -1, inner: true, turn: 0.05 },
  { kind: "sheet", side: 1, inner: false, turn: 0.07 },
  { kind: "slides", side: 1, inner: true, turn: -0.05 },
];

/** Where the zone's words are: how far they reach either way from its middle, in CSS pixels. */
interface Words {
  width: number;
  height: number;
  clear: number;
}

/**
 * Where each page lies in the zone, as awake as `life`: whole, in the room
 * beside the words, as tall as fits; none where there is no room.
 */
const lay = (
  { width, height, clear }: Words,
  life: Life,
  piles: Record<Kind, number>
): Page[] => {
  const room = width / 2 - clear;
  const margin = Math.min(room * 0.2, 28);
  const byHeight = Math.round((height * 0.72) / cell);
  // Two pages a side where they fit, overlapping; else the outer one alone, whole.
  const fitting = (much: number) =>
    Math.min(byHeight, Math.floor((room - margin) / (much * 0.76 * cell)));
  const both = fitting(1.75) >= 12;
  const tall = both ? fitting(1.75) : fitting(1.1);
  if (tall < 10) {
    return [];
  }
  const wide = Math.round(tall * 0.76) * cell;
  const spread = life.open * 0.25 + life.taking * 0.5;
  const lift = (life.open * 0.04 + life.taking * 0.1) * height;
  return sides
    .filter(({ inner }) => both || !inner)
    .map(({ kind, side, inner, turn }) => {
      const landscape = kind === "slides";
      const h = landscape ? Math.round(tall * 0.68) : tall;
      const w = landscape ? Math.round(h * 1.4) : Math.round(tall * 0.76);
      // The outer page a step in from the edge; the inner one overlapping it, toward the words.
      const fromEdge =
        Math.min(room * 0.2, 28) +
        wide * 0.5 +
        (inner ? wide * (0.55 + spread) : 0);
      return {
        kind,
        w,
        h,
        x: side < 0 ? fromEdge : width - fromEdge,
        y: height / 2 + (inner ? cell : -cell) - lift * (inner ? 1.4 : 1),
        turn: turn * (1 + life.open * 0.8 + life.taking * 1.6),
        pile: piles[kind],
      };
    });
};

/** How much of the drawing stands at `x` CSS pixels across: all of it toward the edges, thinning out to none at the words. */
const presence = (x: number, { width, clear }: Words): number => {
  const fromWords = Math.abs(x - width / 2) - clear;
  // The pages stand whole: only a page brought close to the words, as it opens, thins out at them.
  const run = cell * 3;
  const t = Math.min(1, Math.max(0, fromWords / run));
  return t ** 1.5;
};

/** From this much on, cells are whole; below it they shrink and pale, as the flags' do. */
const whole = 0.7;
const minSide = 0.25;
const minAlpha = 0.18;

const draw = (
  context: CanvasRenderingContext2D,
  words: Words,
  pages: Page[]
) => {
  const { width, height } = words;
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  // Front to back: the first page a cell finds is the one it shows.
  const front = pages.toReversed();
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const px = (column + 0.5) * cell;
      const much = presence(px, words);
      if (much <= 0) {
        continue;
      }
      const threshold =
        bayerAt(column + 1, row + 2) * 0.8 + chance(column, row, 3) * 0.2;
      if (threshold >= much * 1.15) {
        continue;
      }
      const py = (row + 0.5) * cell;
      let fill: string | null = null;
      for (const page of front) {
        const cos = Math.cos(page.turn);
        const sin = Math.sin(page.turn);
        const dx = px - page.x;
        const dy = py - page.y;
        const u = (dx * cos + dy * sin) / cell + page.w / 2;
        const v = (-dx * sin + dy * cos) / cell + page.h / 2;
        const colour = colourOf[page.kind];
        const ink = inkAt(page.kind, u, v, page.w, page.h);
        if (ink !== null) {
          if (ink === "ink") {
            fill = mix(colour, 255, 0.72);
          } else if (ink === "fold") {
            fill = mix(colour, 255, 0.35);
          } else {
            // The page's own edge, a cell deep at its foot and far side: it lies on the zone.
            const edge = u >= page.w - 1 || v >= page.h - 1;
            fill = edge ? mix(colour, 0, 0.3) : colour;
          }
          break;
        }
        // Under a page, the sheets of its kind already shared, each a step down and out.
        for (let sheet = 1; sheet <= page.pile; sheet += 1) {
          const offset = sheet * 1.5;
          const under = inkAt(
            "text",
            u - offset * (page.x < width / 2 ? -1 : 1),
            v - offset,
            page.w,
            page.h
          );
          if (under !== null) {
            fill = mix(colour, 0, 0.18 + sheet * 0.1);
            break;
          }
        }
        if (fill !== null) {
          break;
        }
      }
      if (fill === null) {
        continue;
      }
      const eased = Math.min(1, much / whole);
      const side = cell * (minSide + (1 - minSide) * eased ** 0.6);
      const inset = (cell - side) / 2;
      context.globalAlpha = minAlpha + (1 - minAlpha) * eased ** 0.7;
      context.fillStyle = fill;
      context.fillRect(column * cell + inset, row * cell + inset, side, side);
    }
  }
  context.globalAlpha = 1;
};

/**
 * The drop zone (`children`) with the pages over it. `shared` are the
 * names of the documents shared so far, for the piles under each kind.
 */
export const DocumentPages = ({
  shared,
  children,
}: {
  shared: readonly string[];
  children: ReactNode;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wanted = useRef<Life>({ open: 0, taking: 0 });
  const wake = useRef<(() => void) | null>(null);
  const piles = { pdf: 0, word: 0, sheet: 0, slides: 0, text: 0 };
  for (const name of shared) {
    const kind = kindOfName(name);
    piles[kind] = Math.min(3, piles[kind] + 1);
  }
  const pileKey = Object.values(piles).join(",");
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element === null || context === null || context === undefined) {
      return () => {
        // Nothing drawn.
      };
    }
    const [pdf = 0, word = 0, sheet = 0, slides = 0, text = 0] = pileKey
      .split(",")
      .map(Number);
    const own = { pdf, word, sheet, slides, text };
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const life: Life = { ...wanted.current };
    let frame = 0;
    let last = 0;
    const paint = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      const wide = Math.round(width * ratio);
      const high = Math.round(height * ratio);
      if (element.width !== wide || element.height !== high) {
        element.width = wide;
        element.height = high;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      // Only over the drop zone itself, inside its own corners: not over the files listed under it.
      const zone = box.current?.querySelector(
        "[data-slot=file-input-dropzone]"
      );
      if (zone === null || zone === undefined) {
        return;
      }
      const at = element.getBoundingClientRect();
      const area = zone.getBoundingClientRect();
      const corner = Number(
        getComputedStyle(zone).borderTopLeftRadius.replace("px", "")
      );
      context.save();
      context.translate(area.left - at.left, area.top - at.top);
      context.beginPath();
      context.roundRect(
        0,
        0,
        area.width,
        area.height,
        Number.isNaN(corner) ? 0 : corner
      );
      context.clip();
      // The words in the zone: its icon, its line, its button. The pages keep out of their way.
      const middle = area.left + area.width / 2;
      let clear = 0;
      for (const part of zone.children) {
        const { left, right, width: across } = part.getBoundingClientRect();
        if (across > 0) {
          clear = Math.max(clear, middle - left, right - middle);
        }
      }
      const words: Words = {
        width: area.width,
        height: area.height,
        clear: clear + cell * 4,
      };
      draw(context, words, lay(words, life, own));
      context.restore();
    };
    const step = (now: number) => {
      const elapsed = Math.min(now - last, 64);
      last = now;
      // Halfway there every 60 ms: settled well within 300.
      const toward = 0.5 ** (elapsed / 60);
      life.open =
        wanted.current.open + (life.open - wanted.current.open) * toward;
      life.taking =
        wanted.current.taking + (life.taking - wanted.current.taking) * toward;
      const settled =
        Math.abs(life.open - wanted.current.open) < 0.004 &&
        Math.abs(life.taking - wanted.current.taking) < 0.004;
      if (settled) {
        life.open = wanted.current.open;
        life.taking = wanted.current.taking;
      }
      paint();
      frame = settled ? 0 : requestAnimationFrame(step);
    };
    wake.current = () => {
      if (still.matches) {
        return;
      }
      if (frame === 0) {
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    };
    paint();
    // Drawn again whenever the zone or its words change size: the button arrives once the page runs.
    const resized = new ResizeObserver(paint);
    resized.observe(element);
    const zone = box.current?.querySelector("[data-slot=file-input-dropzone]");
    if (zone !== null && zone !== undefined) {
      for (const part of [zone, ...zone.children]) {
        resized.observe(part);
      }
    }
    return () => {
      resized.disconnect();
      cancelAnimationFrame(frame);
      wake.current = null;
    };
  }, [pileKey]);
  const want = (life: Partial<Life>) => {
    wanted.current = { ...wanted.current, ...life };
    wake.current?.();
  };
  return (
    <div
      onDragEnter={() => {
        want({ taking: 1 });
      }}
      onDragLeave={(event) => {
        const into = event.relatedTarget;
        const inside =
          into instanceof Node && box.current?.contains(into) === true;
        if (!inside) {
          want({ taking: 0 });
        }
      }}
      onDrop={() => {
        want({ taking: 0 });
      }}
      onPointerEnter={() => {
        want({ open: 1 });
      }}
      onPointerLeave={() => {
        want({ open: 0 });
      }}
      ref={box}
      {...stylex.props(styles.box)}
    >
      {children}
      <span {...stylex.props(styles.cover)}>
        <canvas
          aria-hidden="true"
          ref={canvas}
          {...stylex.props(styles.canvas)}
        />
      </span>
    </div>
  );
};

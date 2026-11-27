import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { bayerAt, chance } from "./dither.ts";
import { extensionOf } from "./document-files.ts";

// The documents step's drop zone with the kinds of file Grasp reads lying
// over it as pages, cell by cell in the system's one dither, the way the
// welcome's cards draw their flags (flag-picture.tsx): a PDF, a Word
// document, a sheet, a slide and a plain text, each in its own colour and
// with its own kind of content, fanned out at the zone's two edges and
// thinning out toward its words, so the words stand clear.
// Empty at first. Each thing thrown in, a file dropped or a visitor's toss
// (document-visitors.tsx), leaves a page of its kind on the side it came
// from, dithering in, and it stays: two a side at most, so a third on a side
// takes the oldest one's place, which dithers away. The documents shared
// before lie there from the start. Under reduced motion they just appear.

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

export type Kind = "pdf" | "word" | "sheet" | "slides" | "text";

/** Every kind, in the order the visitors (document-visitors.tsx) hold them. */
export const kindNames: readonly Kind[] = [
  "pdf",
  "word",
  "sheet",
  "slides",
  "text",
];

/** Each kind's own colour, as its makers paint it. */
export const colourOf: Record<Kind, string> = {
  pdf: "#d6403a",
  word: "#2b5797",
  sheet: "#1e7145",
  slides: "#c9512c",
  text: "#56626b",
};

/** The kind of a shared document, by its name's extension. */
export const kindOfName = (name: string): Kind => {
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

/** One page as it lies: its kind, size in cells, where its middle is in CSS pixels, how it turns, and how much it is there (0 to 1). */
interface Page {
  kind: Kind;
  w: number;
  h: number;
  x: number;
  y: number;
  turn: number;
  shown: number;
}

/** A side of the zone: -1 its start, 1 its end. */
export type Side = -1 | 1;

/** The most pages a side holds: a third thrown in takes the oldest's place. */
const perSide = 2;

/**
 * A page thrown in, as it settles: its kind and side, its place on its side
 * (0 the outer, 1 the inner, eased toward where it belongs), how much it is
 * there, and whether it is on its way out.
 */
interface Placed {
  kind: Kind;
  side: Side;
  slot: number;
  shown: number;
  leaving: boolean;
}

/** Each place's turn: the outer and the inner page of each side, a little askew. */
const turnOf = (side: Side, slot: number): number =>
  side < 0 ? -0.07 + slot * 0.12 : 0.07 - slot * 0.12;

/** Where the zone's words are: how far they reach either way from its middle, in CSS pixels. */
interface Words {
  width: number;
  height: number;
  clear: number;
}

/**
 * Where each page thrown in lies, as much as the zone is `taking` one: in
 * the room beside the words, as tall as fits; none where there is no room.
 */
const lay = (
  { width, height, clear }: Words,
  taking: number,
  placed: readonly Placed[]
): Page[] => {
  const room = width / 2 - clear;
  const margin = Math.min(room * 0.2, 28);
  // Small, so they stay a passing sign and not a picture: about half the zone, never past 22 cells.
  const byHeight = Math.min(22, Math.round((height * 0.5) / cell));
  // Two pages a side where they fit, overlapping; else the outer one alone, whole.
  const fitting = (much: number) =>
    Math.min(byHeight, Math.floor((room - margin) / (much * 0.76 * cell)));
  const both = fitting(1.75) >= 12;
  const tall = both ? fitting(1.75) : fitting(1.1);
  if (tall < 10) {
    return [];
  }
  const wide = Math.round(tall * 0.76) * cell;
  const spread = taking * 0.3;
  const lift = taking * 0.06 * height;
  // The outer pages first, so an inner one lies over its neighbour.
  return placed
    .filter(({ slot }) => both || slot < 0.5)
    .toSorted((one, other) => one.slot - other.slot)
    .map(({ kind, side, slot, shown }) => {
      const landscape = kind === "slides";
      const h = landscape ? Math.round(tall * 0.68) : tall;
      const w = landscape ? Math.round(h * 1.4) : Math.round(tall * 0.76);
      // The outer page a step in from the edge; the inner one overlapping it, toward the words.
      const fromEdge = margin + wide * 0.5 + slot * wide * (0.55 + spread);
      return {
        kind,
        w,
        h,
        x: side < 0 ? fromEdge : width - fromEdge,
        // Each rises into its place as it comes.
        y:
          height / 2 +
          (slot > 0.5 ? cell : -cell) -
          lift +
          (1 - shown) * cell * 4,
        turn: turnOf(side, slot) * (1 + taking * 1.6),
        shown,
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
      const py = (row + 0.5) * cell;
      let fill: string | null = null;
      for (const page of front) {
        // Each page dithers in and out on its own: cell by cell, never a fade.
        if (threshold >= much * page.shown * 1.15) {
          continue;
        }
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

/** Each one's place on its side, the oldest outermost; the ones on their way out keep theirs. */
const slotsOf = (
  placed: readonly Placed[],
  side: Side
): Map<Placed, number> => {
  const staying = placed.filter((each) => each.side === side && !each.leaving);
  return new Map(staying.map((each, index) => [each, index]));
};

/** Puts a page of `kind` on `side`, the oldest there leaving when the side is full. */
const placeOn = (placed: Placed[], kind: Kind, side: Side) => {
  const staying = placed.filter((each) => each.side === side && !each.leaving);
  if (staying.length >= perSide) {
    const [oldest] = staying;
    if (oldest !== undefined) {
      oldest.leaving = true;
    }
  }
  const before = slotsOf(placed, side).size;
  placed.push({ kind, side, slot: before, shown: 0, leaving: false });
};

/** Where the pages lie from the start: the documents already shared, the newest last, a side each in turn. */
const seeded = (shared: readonly string[]): Placed[] => {
  const placed: Placed[] = [];
  for (const [index, name] of shared.entries()) {
    placeOn(placed, kindOfName(name), index % 2 === 0 ? -1 : 1);
    const gone = placed.findIndex((each) => each.leaving);
    if (gone !== -1) {
      placed.splice(gone, 1);
    }
  }
  for (const side of [-1, 1] as const) {
    for (const [each, slot] of slotsOf(placed, side)) {
      each.slot = slot;
      each.shown = 1;
    }
  }
  return placed;
};

const isKind = (value: unknown): value is Kind =>
  kindNames.some((kind) => kind === value);

/** What a toss carries: the kind of page and the side it came from (document-visitors.tsx). */
export interface Toss {
  kind: Kind;
  side: Side;
}

/**
 * The drop zone (`children`) with the pages thrown into it over it.
 * `shared` are the names of the documents shared before, for the pages it
 * starts with. A `documentcaught` event on the zone, its detail a `Toss`,
 * puts the page tossed on its side.
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
  // How much the zone is taking a page: files over it, or one just landed.
  const wantedTaking = useRef(0);
  const placed = useRef<Placed[] | null>(null);
  const wake = useRef<(() => void) | null>(null);
  const first = useRef(shared);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element === null || context === null || context === undefined) {
      return () => {
        // Nothing drawn.
      };
    }
    const pages = placed.current ?? seeded(first.current);
    placed.current = pages;
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    let taking = wantedTaking.current;
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
      if (zone === null || zone === undefined || pages.length === 0) {
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
      draw(context, words, lay(words, taking, pages));
      context.restore();
    };
    /** Every page where it belongs at once, the ones leaving gone: under reduced motion, or once settled. */
    const settle = () => {
      taking = wantedTaking.current;
      for (const side of [-1, 1] as const) {
        for (const [each, slot] of slotsOf(pages, side)) {
          each.slot = slot;
          each.shown = 1;
        }
      }
      const gone = pages.filter((each) => each.leaving);
      for (const each of gone) {
        pages.splice(pages.indexOf(each), 1);
      }
    };
    const step = (now: number) => {
      const elapsed = Math.min(now - last, 64);
      last = now;
      // Halfway there every 60 ms: settled well within 300; a page comes and goes a little slower.
      const toward = 0.5 ** (elapsed / 60);
      const slower = 0.5 ** (elapsed / 110);
      taking = wantedTaking.current + (taking - wantedTaking.current) * toward;
      let settled = Math.abs(taking - wantedTaking.current) < 0.004;
      for (const side of [-1, 1] as const) {
        const slots = slotsOf(pages, side);
        for (const each of pages.filter((one) => one.side === side)) {
          const slot = slots.get(each) ?? each.slot;
          const shown = each.leaving ? 0 : 1;
          each.slot = slot + (each.slot - slot) * slower;
          each.shown = shown + (each.shown - shown) * slower;
          if (
            Math.abs(each.slot - slot) > 0.004 ||
            Math.abs(each.shown - shown) > 0.004
          ) {
            settled = false;
          }
        }
      }
      if (settled) {
        settle();
      }
      paint();
      frame = settled ? 0 : requestAnimationFrame(step);
    };
    wake.current = () => {
      if (still.matches) {
        settle();
        paint();
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
  }, []);
  // Something thrown in: a visitor's toss or a real drop. Its page comes up on its side, the zone
  // opening a little to take it, and stays.
  const later = useRef(0);
  const landed = (tosses: readonly Toss[]) => {
    const pages = placed.current;
    if (pages === null) {
      return;
    }
    for (const { kind, side } of tosses) {
      placeOn(pages, kind, side);
    }
    wantedTaking.current = 0.7;
    clearTimeout(later.current);
    later.current = window.setTimeout(() => {
      wantedTaking.current = 0;
      wake.current?.();
    }, 320);
    wake.current?.();
  };
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return () => {
        // Nothing to catch with.
      };
    }
    const caught = (event: Event) => {
      const toss: unknown = event instanceof CustomEvent ? event.detail : null;
      if (
        typeof toss === "object" &&
        toss !== null &&
        "kind" in toss &&
        "side" in toss &&
        isKind(toss.kind) &&
        (toss.side === -1 || toss.side === 1)
      ) {
        landed([{ kind: toss.kind, side: toss.side }]);
      }
    };
    element.addEventListener("documentcaught", caught);
    return () => {
      element.removeEventListener("documentcaught", caught);
    };
  });
  useEffect(
    () => () => {
      clearTimeout(later.current);
    },
    []
  );
  return (
    <div
      onDragEnter={() => {
        wantedTaking.current = 1;
        wake.current?.();
      }}
      onDragLeave={(event) => {
        const into = event.relatedTarget;
        const inside =
          into instanceof Node && box.current?.contains(into) === true;
        if (!inside) {
          wantedTaking.current = 0;
          wake.current?.();
        }
      }}
      onDrop={(event) => {
        // Each file dropped lies on the side it was dropped on, as its kind.
        const middle =
          (box.current?.getBoundingClientRect().left ?? 0) +
          (box.current?.getBoundingClientRect().width ?? 0) / 2;
        const side: Side = event.clientX < middle ? -1 : 1;
        landed(
          Array.from(event.dataTransfer.files, (file) => ({
            kind: kindOfName(file.name),
            side,
          }))
        );
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

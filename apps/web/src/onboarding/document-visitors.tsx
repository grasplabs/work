import { font } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import type { Kind, Toss } from "./document-pages.tsx";
import { colourOf, kindNames } from "./document-pages.tsx";
import { pixelCursor } from "./pixel-cursor.stylex.ts";
import {
  Arrow,
  arrowCell,
  arrowCells,
  between,
  bezier,
  easeIn,
  easeInOut,
  easeOut,
  frames,
  keysOf,
  useStill,
  wait,
} from "./pixel-cursor.tsx";
import type { Point } from "./pixel-cursor.tsx";

// Two visitors on the documents step, the way colleagues' cursors move over
// a shared canvas: a pixel arrow in its own colour drifts in from the
// window's edge to beside the drop zone, types a short ask in its label
// ("Have an invoice we can look at?"), takes a little pixel page of that
// kind, and tosses it in an arc into the zone, which catches it as it would
// a real drop (document-pages.tsx lays that page on its side, where it
// stays). Then it drifts away and
// another comes from the other side. Only where there is room beside the
// zone, so they never lie over the step's words; never in the way of a
// press or a drop; not at all under reduced motion; and none while a
// question or the picker is open. Everything they say is shown, not read:
// the step's own words say what to share.

const styles = stylex.create({
  // The whole window, over the step and under nothing that can be pressed.
  layer: {
    position: "fixed",
    inset: 0,
    zIndex: 1,
    overflow: "hidden",
    pointerEvents: "none",
  },
  visitor: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    opacity: 0,
    willChange: "transform",
  },
  // The arrow's tip is its corner: the visitor's own point.
  arrow: {
    display: "block",
    transformOrigin: "0 0",
    filter: "drop-shadow(2px 2px 0 rgb(0 0 0 / 0.16))",
  },
  // The label, under and after the tip, with its corners stepped as pixels are.
  label: {
    position: "absolute",
    insetBlockStart: 26,
    insetInlineStart: 16,
    filter: "drop-shadow(2px 2px 0 rgb(0 0 0 / 0.14))",
  },
  bubble: {
    display: "grid",
    opacity: 0,
    transformOrigin: "0 0",
    paddingBlock: 6,
    paddingInline: 10,
    backgroundColor: "currentColor",
    clipPath: pixelCursor.steppedCorners,
  },
  line: {
    gridArea: "1 / 1",
    whiteSpace: "nowrap",
    color: "white",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
  },
  // The whole line, unseen and out of the flow: only measured, for the room the label will need.
  unseen: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    visibility: "hidden",
  },
  // A block caret, a pixel wide, blinking as a terminal's does.
  caret: {
    display: "inline-block",
    width: 2,
    height: "1em",
    marginInlineStart: 1,
    verticalAlign: "-0.12em",
    backgroundColor: "white",
    animationName: stylex.keyframes({
      "0%, 49%": { opacity: 1 },
      "50%, 100%": { opacity: 0 },
    }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "step-end",
  },
  page: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    opacity: 0,
    willChange: "transform",
  },
  pageArt: {
    display: "block",
    filter: "drop-shadow(2px 2px 0 rgb(0 0 0 / 0.18))",
  },
  hidden: { display: "none" },
  bit: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    width: 4,
    height: 4,
    opacity: 0,
  },
});

/** The visitors' colours, one each, bright as colleagues' cursors are. */
const colours = ["#7a5af8", "#e0457b", "#ef8a17", "#0e9f6e", "#2e78e6"];

/** What each kind of page has written on it, a character a cell: paper (.), ink (#), its folded corner (/), its edge (_). */
const pageCells: Record<Kind, string[]> = {
  pdf: [
    "......//",
    ".####./",
    "........_",
    ".#######_",
    "........_",
    ".######._",
    "........_",
    ".#######_",
    "........_",
    ".####...._",
    "_________",
  ],
  word: [
    "......//",
    ".#####./",
    "........_",
    ".#######_",
    "........_",
    ".#.####._",
    "........_",
    ".#.#####_",
    "........_",
    ".######._",
    "_________",
  ],
  sheet: [
    "......//",
    "######./",
    "#.#.#.#._",
    "#######._",
    "#.#.#.#._",
    "#######._",
    "#.#.#.#._",
    "#######._",
    "#.#.#.#._",
    "........_",
    "_________",
  ],
  slides: [
    "............",
    ".######.....",
    "............",
    "........#...",
    "..#.....#...",
    "..#..#..#...",
    "..#..#..#.#.",
    "..#..#..#.#.",
    "____________",
  ],
  text: [
    "......//",
    ".####../",
    "........_",
    ".######._",
    "...####._",
    ".#####.._",
    "...#####_",
    ".####..._",
    "........_",
    ".###....._",
    "_________",
  ],
};

/** A cell's side in a page, in CSS pixels. */
const pageCell = 3;

const mix = (hex: string, toward: number, amount: number): string => {
  const part = (at: number) => {
    const own = Number.parseInt(hex.slice(at, at + 2), 16);
    return Math.round(own + (toward - own) * amount);
  };
  return `rgb(${part(1)}, ${part(3)}, ${part(5)})`;
};

const PageArt = ({ kind }: { kind: Kind }) => {
  const cells = pageCells[kind];
  const colour = colourOf[kind];
  const wide = Math.max(...cells.map((row) => row.length));
  const fills: Record<string, string> = {
    ".": colour,
    "#": mix(colour, 255, 0.72),
    "/": mix(colour, 255, 0.35),
    _: mix(colour, 0, 0.3),
  };
  return (
    <svg
      height={cells.length * pageCell}
      shapeRendering="crispEdges"
      width={wide * pageCell}
    >
      {cells.flatMap((row, y) =>
        keysOf(row).map((mark, x) => (
          <rect
            fill={fills[mark] ?? colour}
            height={pageCell}
            key={`${String(x)},${String(y)}`}
            width={pageCell}
            x={x * pageCell}
            y={y * pageCell}
          />
        ))
      )}
    </svg>
  );
};

/** One ask: what a visitor types, and the kind of page it tosses in. */
interface Ask {
  words: string;
  kind: Kind;
}

const useAsks = (): Ask[] => {
  const { t } = useLingui();
  return [
    { words: t`Have an invoice we can look at?`, kind: "pdf" },
    { words: t`Have a price list? Upload it!`, kind: "sheet" },
    { words: t`A work instruction, maybe?`, kind: "word" },
    { words: t`Got a checklist? Toss it in!`, kind: "text" },
    { words: t`That training deck helps too`, kind: "slides" },
    { words: t`Your quote template, perhaps?`, kind: "pdf" },
  ];
};

/** The zone the visitors toss pages into: Damsko's drop zone on this step. */
const zoneOf = (): Element | null =>
  document.querySelector("[data-slot=file-input-dropzone]");

/** What each visitor is drawn with. */
interface Parts {
  visitor: HTMLDivElement;
  arrow: SVGSVGElement;
  bubble: HTMLDivElement;
  line: HTMLSpanElement;
  typed: HTMLSpanElement;
  page: HTMLDivElement;
  arts: Map<Kind, HTMLSpanElement>;
  bits: HTMLDivElement;
}

/** The bits a caught page breaks into. */
const bitNames = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

/** The side of the window between a visitor's tip and the zone: room for its label and a little more. */
const gap = 36;

/**
 * One visitor's visit from the `side` of the zone: in, the ask typed, the
 * page tossed, out. Nothing if that side has no room for it.
 */
const visit = async (
  parts: Parts,
  ask: Ask,
  side: -1 | 1,
  colour: string,
  signal: AbortSignal
): Promise<boolean> => {
  const zone = zoneOf();
  if (zone === null) {
    return false;
  }
  const { visitor, arrow, bubble, line, typed, page, arts, bits } = parts;
  visitor.style.color = colour;
  line.textContent = ask.words;
  typed.textContent = "";
  const labelWide = line.offsetWidth + 20 + 16;
  const first = zone.getBoundingClientRect();
  const room =
    side < 0 ? first.left : document.documentElement.clientWidth - first.right;
  if (room < labelWide + gap + 16) {
    return false;
  }
  // Where it all happens, beside the zone: everything is kept from its corner, so scrolling carries the visitor along.
  const rest: Point = {
    x:
      side < 0
        ? -(labelWide + gap + between(0, Math.min(40, room - labelWide - gap)))
        : first.width + gap + between(0, 30),
    y: between(-first.height * 0.15, first.height * 0.45),
  };
  const outside = (): Point => {
    const area = zone.getBoundingClientRect();
    return {
      x:
        side < 0
          ? -area.left - 40
          : document.documentElement.clientWidth - area.left + 40,
      y: rest.y + between(-160, 160),
    };
  };
  let at = outside();
  const phase = Math.random() * 6;
  let held = false;
  let calm = 0;
  const paint = () => {
    const area = zone.getBoundingClientRect();
    const now = performance.now();
    // A hand is never quite still.
    const sway = {
      x: Math.sin(now / 640 + phase) * 1.6 * calm,
      y: Math.cos(now / 820 + phase) * 2.2 * calm,
    };
    const x = area.left + at.x + sway.x;
    const y = area.top + at.y + sway.y;
    visitor.style.transform = `translate3d(${String(x)}px, ${String(y)}px, 0)`;
    if (held) {
      page.style.transform = `translate3d(${String(x + 12)}px, ${String(y + 16)}px, 0) rotate(${String(-side * 8)}deg)`;
    }
  };
  /** Moves the tip to `to` along a gentle curve, as a hand does. */
  const glide = async (
    to: Point,
    ms: number,
    ease: (t: number) => number,
    bend: number
  ) => {
    const from = at;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const across = Math.hypot(dx, dy) || 1;
    const nx = (-dy / across) * across * bend;
    const ny = (dx / across) * across * bend;
    const one = { x: from.x + dx * 0.3 + nx, y: from.y + dy * 0.3 + ny };
    const two = {
      x: from.x + dx * 0.75 + nx * 0.4,
      y: from.y + dy * 0.75 + ny * 0.4,
    };
    await frames(ms, signal, (t) => {
      at = bezier(from, one, two, to, ease(t));
      paint();
    });
  };
  for (const [kind, art] of arts) {
    art.style.display = kind === ask.kind ? "block" : "none";
  }
  try {
    paint();
    visitor.style.opacity = "1";
    // In, from the window's edge.
    await glide(rest, between(1100, 1500), easeInOut, between(-0.25, 0.25));
    calm = 1;
    await frames(between(250, 450), signal, paint);
    // The label opens, and the ask is typed into it, a key at a time.
    bubble.animate(
      [
        { opacity: 0, transform: "scale(0.4)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      {
        duration: 220,
        easing: "cubic-bezier(0.2, 0.9, 0.3, 1.25)",
        fill: "forwards",
      }
    );
    const keys = keysOf(ask.words);
    const times: number[] = [];
    let total = 260;
    for (const key of keys) {
      total += between(34, 72) + (/[\s,?!.]/u.test(key) ? between(20, 90) : 0);
      times.push(total);
    }
    await frames(total, signal, (t) => {
      const now = t * total;
      const count = times.filter((time) => time <= now).length;
      if (typed.textContent.length !== count) {
        typed.textContent = keys.slice(0, count).join("");
      }
      paint();
    });
    await frames(between(900, 1300), signal, paint);
    // The label gives way to the page, picked up at the tip.
    bubble.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.6)" }], {
      duration: 160,
      easing: "ease-in",
      fill: "forwards",
    });
    held = true;
    page.style.opacity = "1";
    paint();
    page.firstElementChild?.animate(
      [{ transform: "scale(0)" }, { transform: "scale(1)" }],
      { duration: 240, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.4)" }
    );
    arrow.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(0.82)" },
        { transform: "scale(1)" },
      ],
      { duration: 220, easing: "ease-out" }
    );
    await frames(420, signal, paint);
    // A swing back, and the toss.
    calm = 0;
    await glide({ x: at.x - side * 26, y: at.y + 10 }, 280, easeOut, 0);
    await glide({ x: at.x + side * 46, y: at.y - 18 }, 150, easeIn, 0);
    held = false;
    const area = zone.getBoundingClientRect();
    const from = {
      x: area.left + at.x + 12,
      y: area.top + at.y + 16,
    };
    const landing = {
      x:
        side < 0
          ? area.width * between(0.14, 0.24)
          : area.width * between(0.76, 0.86),
      y: area.height * between(0.35, 0.55),
    };
    const spin = side * between(300, 420);
    const flight = between(560, 680);
    const glideOut = glide(
      { x: at.x + side * 18, y: at.y - 6 },
      300,
      easeOut,
      0
    );
    await frames(flight, signal, (t) => {
      const now = zone.getBoundingClientRect();
      const to = { x: now.left + landing.x - 12, y: now.top + landing.y - 16 };
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t - Math.sin(Math.PI * t) * 110;
      const scale = 1 - 0.35 * easeIn(t);
      page.style.transform = `translate3d(${String(x)}px, ${String(y)}px, 0) rotate(${String(-side * 8 + spin * easeOut(t))}deg) scale(${String(scale)})`;
    });
    await glideOut;
    // Caught: the page is gone into the zone in a puff of pixels, and its pages take it.
    page.style.opacity = "0";
    const toss: Toss = { kind: ask.kind, side };
    zone.dispatchEvent(
      new CustomEvent("documentcaught", { bubbles: true, detail: toss })
    );
    const now = zone.getBoundingClientRect();
    const colourOfKind = colourOf[ask.kind];
    for (const [index, bit] of [...bits.children].entries()) {
      if (!(bit instanceof HTMLElement)) {
        continue;
      }
      const angle =
        (index / bits.children.length) * Math.PI * 2 + between(-0.3, 0.3);
      const far = between(18, 34);
      const x = Math.round((now.left + landing.x) / 4) * 4;
      const y = Math.round((now.top + landing.y) / 4) * 4;
      bit.style.backgroundColor =
        index % 3 === 0 ? mix(colourOfKind, 255, 0.6) : colourOfKind;
      bit.animate(
        [
          {
            transform: `translate(${String(x)}px, ${String(y)}px)`,
            opacity: 1,
          },
          {
            transform: `translate(${String(x + Math.round((Math.cos(angle) * far) / 4) * 4)}px, ${String(y + Math.round((Math.sin(angle) * far) / 4) * 4)}px)`,
            opacity: 0,
          },
        ],
        { duration: 480, easing: "steps(6, end)", fill: "forwards" }
      );
    }
    calm = 1;
    await frames(between(500, 800), signal, paint);
    // And away, back the way it came.
    calm = 0;
    await glide(outside(), between(1000, 1300), easeInOut, between(-0.2, 0.2));
    return true;
  } finally {
    held = false;
    visitor.style.opacity = "0";
    page.style.opacity = "0";
  }
};

/** A visitor's parts, found by their names in its drawing. */
const partsIn = (element: Element): Parts | null => {
  const find = (name: string) => element.querySelector(`[data-part=${name}]`);
  const visitor = find("visitor");
  const arrow = find("arrow");
  const bubble = find("bubble");
  const line = find("line");
  const typed = find("typed");
  const page = find("page");
  const bits = find("bits");
  if (
    !(visitor instanceof HTMLDivElement) ||
    !(arrow instanceof SVGSVGElement) ||
    !(bubble instanceof HTMLDivElement) ||
    !(line instanceof HTMLSpanElement) ||
    !(typed instanceof HTMLSpanElement) ||
    !(page instanceof HTMLDivElement) ||
    !(bits instanceof HTMLDivElement)
  ) {
    return null;
  }
  const arts = new Map<Kind, HTMLSpanElement>();
  for (const kind of kindNames) {
    const art = element.querySelector(`[data-kind=${kind}]`);
    if (art instanceof HTMLSpanElement) {
      arts.set(kind, art);
    }
  }
  return { visitor, arrow, bubble, line, typed, page, arts, bits };
};

/** Lets the visitors in `element` come and go, asking from `asks()`, resting while `paused()`, until the returned controller aborts. */
const welcome = (
  element: HTMLElement,
  asks: () => Ask[],
  paused: () => boolean
): AbortController => {
  const leaving = new AbortController();
  const { signal } = leaving;
  let next = Math.floor(Math.random() * asks().length);
  let tint = Math.floor(Math.random() * colours.length);
  const taken = (): { ask: Ask; colour: string } => {
    const list = asks();
    const ask = list[next % list.length] ?? list[0];
    next += 1;
    tint += 1;
    return {
      ask: ask ?? { words: "", kind: "pdf" },
      colour: colours[tint % colours.length] ?? "#7a5af8",
    };
  };
  // Each side its own visitor, coming and going in turn: now and then both are there at once.
  const come = async (which: number, side: -1 | 1, first: number) => {
    const own = element.children[which];
    const parts = own === undefined ? null : partsIn(own);
    if (parts === null) {
      return;
    }
    await wait(first, signal);
    while (!signal.aborted) {
      if (!paused()) {
        const { ask, colour } = taken();
        // oxlint-disable-next-line no-await-in-loop -- one visit after the other, by design
        await visit(parts, ask, side, colour, signal);
      }
      // oxlint-disable-next-line no-await-in-loop -- a pause between visits
      await wait(between(3500, 6500), signal);
    }
  };
  const left = Math.random() < 0.5 ? -1 : 1;
  const both = async () => {
    try {
      await Promise.all([come(0, left, 900), come(1, left < 0 ? 1 : -1, 5200)]);
    } catch {
      // Gone with the step.
    }
  };
  void both();
  return leaving;
};

/**
 * The visitors, over the step while it is open; resting while `paused`
 * (a question or the picker is open), and none under reduced motion.
 */
export const DocumentVisitors = ({ paused }: { paused: boolean }) => {
  const still = useStill();
  const asks = useAsks();
  const asksNow = useRef(asks);
  const pausedNow = useRef(paused);
  useEffect(() => {
    asksNow.current = asks;
    pausedNow.current = paused;
  });
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = layer.current;
    if (still || element === null) {
      return () => {
        // Nobody visits.
      };
    }
    const leaving = welcome(
      element,
      () => asksNow.current,
      () => pausedNow.current
    );
    return () => {
      leaving.abort();
    };
  }, [still]);
  if (still) {
    return null;
  }
  return createPortal(
    <div aria-hidden="true" ref={layer} {...stylex.props(styles.layer)}>
      {[0, 1].map((which) => (
        <div key={which}>
          <div data-part="page" {...stylex.props(styles.page)}>
            <span {...stylex.props(styles.pageArt)}>
              {kindNames.map((kind) => (
                <span
                  data-kind={kind}
                  key={kind}
                  {...stylex.props(styles.hidden)}
                >
                  <PageArt kind={kind} />
                </span>
              ))}
            </span>
          </div>
          <div data-part="visitor" {...stylex.props(styles.visitor)}>
            <svg
              data-part="arrow"
              height={arrowCells.length * arrowCell}
              shapeRendering="crispEdges"
              width={10 * arrowCell}
              {...stylex.props(styles.arrow)}
            >
              <Arrow />
            </svg>
            <div {...stylex.props(styles.label)}>
              <div data-part="bubble" {...stylex.props(styles.bubble)}>
                <span
                  data-part="line"
                  {...stylex.props(styles.line, styles.unseen)}
                />
                <span {...stylex.props(styles.line)}>
                  <span data-part="typed" />
                  <span {...stylex.props(styles.caret)} />
                </span>
              </div>
            </div>
          </div>
          <div data-part="bits">
            {bitNames.map((bit) => (
              <span key={bit} {...stylex.props(styles.bit)} />
            ))}
          </div>
        </div>
      ))}
    </div>,
    document.body
  );
};

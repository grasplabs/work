// One page of a PDF: a white sheet the size of the page, its drawing on a canvas, and its words as
// real text over the drawing (PDF.js's text layer), so they can be selected, found by the
// browser's find in page, and read by a screen reader. A page has a canvas only while it is near
// the screen: when it leaves, its drawing is cancelled and its canvas emptied.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RefObject } from "react";

import { centreIn } from "../artifact-viewer/dom";
import { markClass } from "../artifact-viewer/find";
import { arrive } from "../motion/arrive";
import { grasp, media } from "../tokens/tokens.stylex";
import { TextLayer } from "./pdfjs";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
  TextContent,
  TextItem,
} from "./pdfjs";

/** The sharpest a page is drawn: twice the CSS pixels, on a screen that has more. */
const MOST_RATIO = 2;
/** The most pixels one page's canvas holds; past it, a page is drawn less sharp, never larger. */
const MOST_PIXELS = 2 ** 23;

const styles = stylex.create({
  // The room a page takes in the list: the page, and the gap below it.
  row: { paddingBlockEnd: grasp.viewerGap },
  last: { paddingBlockEnd: 0 },
  // A sheet of paper on the ground. It stays as the PDF draws it in dark mode too: light colours
  // inside it, never inverted.
  sheet: {
    position: "relative",
    marginInline: "auto",
    overflow: "hidden",
    colorScheme: "light",
    forcedColorAdjust: "none",
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
    outline: {
      default: "none",
      [media.forced]: `${grasp.hairline} solid CanvasText`,
    },
    // A fieldset's own border, padding, margin and least width, gone: it is only the page's group.
    minWidth: 0,
    marginBlock: 0,
    padding: 0,
    borderWidth: 0,
  },
  size: (width: number, height: number, scale: number) => ({
    width,
    height,
    // PDF.js sizes the words in the text layer by this.
    "--total-scale-factor": scale,
  }),
  canvas: {
    position: "absolute",
    inset: 0,
    display: "block",
    width: "100%",
    height: "100%",
  },
  // The text layer, as PDF.js's own viewer styles it: its words are transparent, laid exactly over
  // the drawn ones, so a selection or a match tints the drawing beneath.
  text: {
    position: "absolute",
    insetBlockStart: 0,
    left: 0,
    transformOrigin: "0 0",
    overflow: "clip",
    lineHeight: 1,
    letterSpacing: "normal",
    wordSpacing: "normal",
    textAlign: "initial",
    textSizeAdjust: "none",
    color: "transparent",
    caretColor: "CanvasText",
    // The words are drawn on the canvas under this layer: a tint here would lie over them and wash
    // them out. Multiplied onto the page (a PDF's page is always light), a tint darkens only the
    // paper round the words, and they keep their full strength, in dark as in light.
    mixBlendMode: { default: "multiply", [media.forced]: "normal" },
    "--text-scale-factor":
      "calc(var(--total-scale-factor) * var(--min-font-size))",
    "--min-font-size-inv": "calc(1 / var(--min-font-size))",
    "::selection": {
      backgroundColor: grasp.viewerTextSelection,
      color: "transparent",
    },
    // A comment's tint over the drawn words: see-through, as search's is.
    "::highlight(viewer-comment)": {
      backgroundColor: {
        default: `color-mix(in srgb, ${grasp.viewerComment} 70%, transparent)`,
        [media.forced]: "Mark",
      },
      color: { default: "transparent", [media.forced]: "MarkText" },
    },
    "::highlight(viewer-comment-active)": {
      backgroundColor: {
        default: `color-mix(in srgb, ${grasp.viewerCommentActive} 70%, transparent)`,
        [media.forced]: "Highlight",
      },
      color: { default: "transparent", [media.forced]: "HighlightText" },
    },
  },
  // Each run of words PDF.js places: its size and stretch come from the properties PDF.js sets on it.
  run: {
    position: "absolute",
    whiteSpace: "pre",
    cursor: "text",
    transformOrigin: "0% 0%",
    color: "transparent",
    fontSize: "calc(var(--text-scale-factor) * var(--font-height))",
    transform:
      "rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(var(--min-font-size-inv))",
    "::selection": {
      backgroundColor: grasp.viewerTextSelection,
      color: "transparent",
    },
  },
  marked: { display: "contents" },
});

/** A page's words as one text: each run's words, and a line break where PDF.js says a line ends. */
export const pageText = (content: TextContent) => {
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) {
      continue;
    }
    text += item.str + (item.hasEOL ? "\n" : "");
  }
  return text;
};

// Runs one job, then says it is done, whether it drew or failed: a failed drawing leaves its page
// blank, and the next job still runs.
const settle = async (run: () => Promise<void>, done: () => void) => {
  try {
    await run();
  } catch {
    // Nothing to show: the page stays blank.
  }
  done();
};

/** Runs drawing jobs one or two at a time, after a pause, so pages that only fly past are never drawn. */
export const makeQueue = (at = 2, pause = 60) => {
  const waiting: { run: () => Promise<void>; dropped: boolean }[] = [];
  const state = { busy: 0 };
  const pump = () => {
    const done = () => {
      state.busy -= 1;
      pump();
    };
    while (state.busy < at && waiting.length > 0) {
      const job = waiting.shift();
      if (job !== undefined && !job.dropped) {
        state.busy += 1;
        void settle(job.run, done);
      }
    }
  };
  return (run: () => Promise<void>) => {
    const job = { run, dropped: false };
    waiting.push(job);
    setTimeout(pump, pause);
    return () => {
      job.dropped = true;
    };
  };
};
export type Queue = ReturnType<typeof makeQueue>;

// How a page's text layer is turned for /Rotate, from PDF.js's viewer: about its top left corner,
// then moved back onto the sheet.
const TURN: Record<number, string> = {
  90: "rotate(90deg) translateY(-100%)",
  180: "rotate(180deg) translate(-100%, -100%)",
  270: "rotate(270deg) translateX(-100%)",
};

/** The class of each part of a text layer, set once on what PDF.js made. */
const RUN = stylex.props(styles.run).className ?? "";
const MARKED = stylex.props(styles.marked).className ?? "";

interface Layer {
  /** PDF.js's runs of words, in the order of the page's text. */
  runs: HTMLElement[];
  /** Each run's own words, and where it starts in the page's text. */
  words: string[];
  starts: number[];
}

export interface PageProps {
  doc: PDFDocumentProxy;
  index: number;
  /** Its name: "Page 3". */
  label: string;
  /** CSS pixels for each of the PDF's points. */
  scale: number;
  /** Its size in points before it has loaded: the first page's. */
  fallback: { width: number; height: number };
  last: boolean;
  queue: Queue;
  /** The pages drawn once already in this viewer: they appear without fading when drawn again. */
  drawnBefore: Set<number>;
  /** Where search found matches in this page's text, the current one, and their length. */
  found: readonly number[];
  current: number | undefined;
  length: number;
  /** Its text, once read, for search. */
  onText: (index: number, text: string) => void;
}

// Search's matches, marked in the runs of words they fall in; a match across two runs is marked in
// both. Gives back how to put the runs back as PDF.js made them. Outside the component: it changes
// the text layer's elements, which the component holds in state.
const markMatches = (
  layer: {
    runs: readonly HTMLElement[];
    words: readonly string[];
    starts: readonly number[];
  },
  found: readonly number[],
  current: number | undefined,
  length: number
) => {
  const { runs, words, starts } = layer;
  const marks = new Map<number, { from: number; to: number; now: boolean }[]>();
  let run = 0;
  for (const at of found) {
    while (
      run + 1 < starts.length &&
      (starts[run + 1] ?? Number.POSITIVE_INFINITY) <= at
    ) {
      run += 1;
    }
    for (let piece = run; piece < runs.length; piece += 1) {
      const start = starts[piece] ?? Number.POSITIVE_INFINITY;
      if (start >= at + length) {
        break;
      }
      const from = Math.max(0, at - start);
      const to = Math.min((words[piece] ?? "").length, at + length - start);
      if (to > from) {
        const list = marks.get(piece) ?? [];
        list.push({ from, to, now: at === current });
        marks.set(piece, list);
      }
    }
  }
  for (const [piece, list] of marks) {
    const element = runs[piece];
    const own = words[piece];
    if (element === undefined || own === undefined) {
      continue;
    }
    element.textContent = "";
    let cursor = 0;
    for (const { from, to, now } of list) {
      if (from < cursor) {
        continue;
      }
      if (from > cursor) {
        element.append(own.slice(cursor, from));
      }
      const tint = document.createElement("mark");
      tint.className = markClass(now);
      if (now) {
        tint.dataset.match = "current";
      }
      tint.textContent = own.slice(from, to);
      element.append(tint);
      cursor = to;
    }
    if (cursor < own.length) {
      element.append(own.slice(cursor));
    }
  }
  return () => {
    for (const piece of marks.keys()) {
      const element = runs[piece];
      if (element !== undefined) {
        element.textContent = words[piece] ?? "";
      }
    }
  };
};

// Loads the page, unless the page left first. A page that cannot be read stays a blank sheet.
const loadPage = async (
  doc: PDFDocumentProxy,
  index: number,
  session: { live: boolean },
  setPage: (page: PDFPageProxy) => void
) => {
  try {
    const loaded = await doc.getPage(index + 1);
    if (session.live) {
      setPage(loaded);
    }
  } catch {
    // Nothing to show: the sheet stays blank.
  }
};

interface Drawing {
  page: PDFPageProxy;
  scale: number;
  queue: Queue;
  index: number;
  drawnBefore: Set<number>;
  sheet: RefObject<HTMLElement | null>;
  drawn: RefObject<HTMLCanvasElement | null>;
}

// Draws the page after a pause, on a canvas of its own. The old drawing stays, stretched, until the
// new one is ready, so a zoom never shows a blank page. Gives back how to stop.
const drawPage = ({
  page,
  scale,
  queue,
  index,
  drawnBefore,
  sheet,
  drawn,
}: Drawing) => {
  const canvas = document.createElement("canvas");
  let task: RenderTask | null = null;
  let placed = false;
  let gone = false;
  const drop = queue(async () => {
    if (gone) {
      return;
    }
    const viewport = page.getViewport({ scale });
    let ratio = Math.min(window.devicePixelRatio || 1, MOST_RATIO);
    if (viewport.width * viewport.height * ratio * ratio > MOST_PIXELS) {
      ratio = Math.sqrt(MOST_PIXELS / (viewport.width * viewport.height));
    }
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.setAttribute("aria-hidden", "true");
    task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    await task.promise;
    // Cleaned up while it drew: its canvas may already be emptied, and must not be shown.
    const box = sheet.current;
    if (gone || !box) {
      return;
    }
    const old = drawn.current;
    // The first drawing of a page in this viewer replaces the blank sheet, so it fades in. A page
    // drawn again (scrolled back to, or zoomed) simply appears: pages do not fade as you scroll.
    canvas.className =
      stylex.props(styles.canvas, !old && !drawnBefore.has(index) && arrive.in)
        .className ?? "";
    drawnBefore.add(index);
    box.prepend(canvas);
    placed = true;
    drawn.current = canvas;
    if (old) {
      old.remove();
      old.width = 0;
      old.height = 0;
    }
  });
  return () => {
    gone = true;
    drop();
    task?.cancel();
    if (!placed) {
      canvas.width = 0;
      canvas.height = 0;
    }
  };
};

interface Laying {
  page: PDFPageProxy;
  queue: Queue;
  sheet: RefObject<HTMLElement | null>;
  tell: (text: string) => void;
  setLayer: (layer: Layer) => void;
}

// Lays the page's words out over its drawing, once: they are sized by the sheet's scale, so a zoom
// needs no new text layer. Gives back how to take them away.
const layOut = ({ page, queue, sheet, tell, setLayer }: Laying) => {
  let made: TextLayer | null = null;
  let holder: HTMLDivElement | null = null;
  let gone = false;
  const drop = queue(async () => {
    if (gone) {
      return;
    }
    const content = await page.getTextContent();
    tell(pageText(content));
    if (gone) {
      return;
    }
    holder = document.createElement("div");
    holder.className = stylex.props(styles.text).className ?? "";
    const viewport = page.getViewport({ scale: 1 });
    made = new TextLayer({
      textContentSource: content,
      container: holder,
      viewport,
    });
    await made.render();
    if (gone) {
      return;
    }
    // The layer is the page unturned, sized by the sheet's scale, then turned as the page is, as
    // PDF.js's own viewer does it: its words are placed on the page as it was drawn, before /Rotate.
    // The page's size before /Rotate is its view box's, as PDF.js reads it.
    const [left = 0, bottom = 0, right = 0, top = 0] = viewport.viewBox;
    holder.style.width = `calc(var(--total-scale-factor) * ${right - left}px)`;
    holder.style.height = `calc(var(--total-scale-factor) * ${top - bottom}px)`;
    holder.style.transform = TURN[viewport.rotation] ?? "";
    for (const part of holder.querySelectorAll<HTMLElement>("span, br")) {
      part.className = part.classList.contains("markedContent") ? MARKED : RUN;
    }
    const words = made.textContentItemsStr;
    const starts: number[] = [];
    let offset = 0;
    const items = content.items.filter(
      (item): item is TextItem => "str" in item
    );
    for (const [at, item] of items.entries()) {
      starts.push(offset);
      // Where its words start in the page's text: what a selection and a comment map to.
      const run = made.textDivs[at];
      if (run) {
        run.dataset.offset = String(offset);
      }
      offset += (words[at] ?? item.str).length + (item.hasEOL ? 1 : 0);
    }
    sheet.current?.append(holder);
    setLayer({ runs: made.textDivs, words, starts });
  });
  return () => {
    gone = true;
    drop();
    made?.cancel();
    holder?.remove();
  };
};

interface Showing {
  layer: Layer;
  found: readonly number[];
  current: number | undefined;
  length: number;
  shown: RefObject<number | null>;
  sheet: RefObject<HTMLElement | null>;
}

// Marks search's matches, and brings the current one into view within its page, once each time it
// moves here. Gives back how to put the runs back as PDF.js made them.
const showMatches = ({
  layer,
  found,
  current,
  length,
  shown,
  sheet,
}: Showing) => {
  const restore = markMatches(layer, found, current, length);
  if (current !== undefined && shown.current !== current) {
    shown.current = current;
    // Centred in the viewer's own view, which scrolls; the page around the viewer stays put.
    const mark = sheet.current?.querySelector('mark[data-match="current"]');
    const scroller = mark?.closest('[role="document"]');
    if (
      mark !== null &&
      mark !== undefined &&
      scroller instanceof HTMLElement
    ) {
      centreIn(scroller, mark);
    }
  }
  if (current === undefined) {
    shown.current = null;
  }
  return restore;
};

export const Page = ({
  doc,
  index,
  label,
  scale,
  fallback,
  last,
  queue,
  drawnBefore,
  found,
  current,
  length,
  onText,
}: PageProps) => {
  const sheet = useRef<HTMLFieldSetElement>(null);
  const drawn = useRef<HTMLCanvasElement | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [layer, setLayer] = useState<Layer | null>(null);

  useEffect(() => {
    const session = { live: true };
    void loadPage(doc, index, session, setPage);
    return () => {
      session.live = false;
    };
  }, [doc, index]);

  // Drawn after a pause, and drawn again at a new zoom.
  useEffect(
    () =>
      page === null
        ? undefined
        : drawPage({ page, scale, queue, index, drawnBefore, sheet, drawn }),
    [page, scale, queue, index, drawnBefore]
  );

  // The renderer's, read as it is now: a new one is no reason to lay the words out again.
  const tell = useEffectEvent((text: string) => {
    onText(index, text);
  });
  // Its words, once.
  useEffect(
    () =>
      page === null
        ? undefined
        : layOut({
            page,
            queue,
            sheet,
            tell: (text) => {
              tell(text);
            },
            setLayer,
          }),
    [page, queue]
  );

  // The page leaves: its canvas is emptied at once, and PDF.js lets go of what it kept for it.
  useEffect(
    () => () => {
      const canvas = drawn.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
      }
      drawn.current = null;
    },
    []
  );
  useEffect(
    () => () => {
      void page?.cleanup();
    },
    [page]
  );

  // Search's matches, marked in the runs of words they fall in; a match across two runs is marked
  // in both. Runs are put back as PDF.js made them first.
  const shown = useRef<number | null>(null);
  useEffect(
    () =>
      layer === null
        ? undefined
        : showMatches({ layer, found, current, length, shown, sheet }),
    [layer, found, current, length]
  );

  const width =
    (page ? page.getViewport({ scale: 1 }).width : fallback.width) * scale;
  const height =
    (page ? page.getViewport({ scale: 1 }).height : fallback.height) * scale;
  return (
    <div {...stylex.props(styles.row, last && styles.last)}>
      {/* A rendering of the page at its own scale: its words layer is invisible, laid over the drawn
          words at their size, so a page fitted to a phone carries text far under the interface's
          smallest, by design. data-rendering tells the width sweep so; the zoom brings it up. */}
      <fieldset
        aria-label={label}
        data-part={index}
        data-rendering=""
        ref={sheet}
        {...stylex.props(styles.sheet, styles.size(width, height, scale))}
      />
    </div>
  );
};

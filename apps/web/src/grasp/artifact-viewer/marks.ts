// Highlights where the browser cannot draw them (no CSS Custom Highlight API, or Firefox, whose
// ::highlight styles do not reach words inside the element they are set on): the same tints,
// drawn as boxes in a layer inside the viewer's scroller, over the words. The words themselves are never touched, so
// their text and offsets stay as they are. Each tint blends with what is under it (multiply on a
// light ground, screen on a dark one), so the words show through at full strength. In forced
// colours a box draws only a line in the system's colours.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";

const styles = stylex.create({
  // No box of its own: its marks are placed against the scroller, and scroll with the words.
  layer: { display: "contents" },
  box: {
    position: "absolute",
    pointerEvents: "none",
    userSelect: "none",
    forcedColorAdjust: "none",
    borderRadius: grasp.cornerMark,
  },
  light: { mixBlendMode: "multiply" },
  dark: { mixBlendMode: "screen" },
  "viewer-comment": {
    backgroundColor: {
      default: grasp.viewerComment,
      [media.forced]: "transparent",
    },
    outline: { default: null, [media.forced]: `${grasp.hairline} solid Mark` },
  },
  "viewer-comment-active": {
    backgroundColor: {
      default: grasp.viewerCommentActive,
      [media.forced]: "transparent",
    },
    outline: {
      default: null,
      [media.forced]: `${grasp.ringWidth} solid Highlight`,
    },
  },
  // Struck: a line through the middle over the tint, as ::highlight's line-through draws it.
  "viewer-proposal": {
    backgroundColor: {
      default: grasp.diffRemovedWord,
      [media.forced]: "transparent",
    },
    backgroundImage: {
      default: `linear-gradient(transparent calc(50% - 0.5px), ${grasp.danger} calc(50% - 0.5px), ${grasp.danger} calc(50% + 0.5px), transparent calc(50% + 0.5px))`,
      [media.forced]:
        "linear-gradient(transparent calc(50% - 0.5px), CanvasText calc(50% - 0.5px), CanvasText calc(50% + 0.5px), transparent calc(50% + 0.5px))",
    },
    outline: { default: null, [media.forced]: `${grasp.hairline} dashed Mark` },
  },
  // Underlined: a line along the foot.
  "viewer-edited": {
    backgroundColor: {
      default: grasp.diffAddedWord,
      [media.forced]: "transparent",
    },
    boxShadow: {
      default: `inset 0 -1px 0 ${grasp.success}`,
      [media.forced]: "inset 0 -2px 0 Highlight",
    },
  },
});

type Name =
  | "viewer-comment"
  | "viewer-comment-active"
  | "viewer-proposal"
  | "viewer-edited";
// Drawn in this order, so the open comment lies over the others.
const ORDER: readonly Name[] = [
  "viewer-comment",
  "viewer-proposal",
  "viewer-edited",
  "viewer-comment-active",
];

interface Layer {
  scroller: HTMLElement;
  element: HTMLElement;
  ranges: Map<string, Range[]>;
  drawn: string;
  /** Stops everything that asks for the layer to be drawn again. */
  stop: () => void;
  /** Watches the rows the words are in: a zoom resizes them without a change in the page. */
  rows: ResizeObserver;
  frame: number;
}

const layers = new Map<string, Layer>();

// What a layer stops before it has started anything.
const idle = () => {
  // Nothing to stop yet.
};

const transparent = (colour: string) =>
  colour === "transparent" || /^rgba\(.*,\s*0\)$/u.test(colour);

// Whether the ground under some words is dark: the first background drawn behind them (the page of
// a document, else the viewer's own ground), in the scheme the viewer resolved, read back from a
// canvas once for each colour seen. Never the computer's setting: a site can be dark on a light one.
const grounds = new Map<string, boolean>();
const isDark = (words: Element) => {
  let ground = "";
  for (
    let element: Element | null = words;
    element;
    element = element.parentElement
  ) {
    const colour = getComputedStyle(element).backgroundColor;
    if (!transparent(colour)) {
      ground = colour;
      break;
    }
  }
  if (!ground) {
    return getComputedStyle(words).colorScheme.includes("dark");
  }
  const known = grounds.get(ground);
  if (known !== undefined) {
    return known;
  }
  const context = document.createElement("canvas").getContext("2d");
  if (!context) {
    return false;
  }
  context.fillStyle = ground;
  context.fillRect(0, 0, 1, 1);
  const [red = 255, green = 255, blue = 255] = context.getImageData(
    0,
    0,
    1,
    1
  ).data;
  const dark = 0.2126 * red + 0.7152 * green + 0.0722 * blue < 128;
  grounds.set(ground, dark);
  return dark;
};

const draw = (layer: Layer) => {
  layer.frame = 0;
  const { scroller, element } = layer;
  if (!scroller.isConnected) {
    return;
  }
  // Kept last in the scroller, where the renderer's own children never are.
  if (element.parentElement !== scroller || element.nextSibling) {
    scroller.append(element);
  }
  const box = scroller.getBoundingClientRect();
  const left = box.left + scroller.clientLeft - scroller.scrollLeft;
  const top = box.top + scroller.clientTop - scroller.scrollTop;
  const parts: { name: Name; words: string; rects: DOMRect[] }[] = [];
  let first: Element | null = null;
  for (const name of ORDER) {
    for (const range of layer.ranges.get(name) ?? []) {
      if (!range.startContainer.isConnected) {
        continue;
      }
      const rects = [...range.getClientRects()].filter(
        (rect) => rect.width > 0 && rect.height > 0
      );
      if (!rects.length) {
        continue;
      }
      parts.push({ name, words: range.toString(), rects });
      const holder =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement;
      first ??= holder;
      // The row the words are in, watched for a change of size (observing it twice does nothing).
      const row = holder?.closest("[data-row]");
      if (row) {
        layer.rows.observe(row);
      }
    }
  }
  const blend = first && isDark(first) ? styles.dark : styles.light;
  // Drawn again only when something moved: the viewer watches its scroller for changes, and this
  // layer is in it, so an unchanged layer must not change.
  const key = JSON.stringify([
    blend === styles.dark,
    parts.map(({ name, words, rects }) => [
      name,
      words,
      rects.map((rect) =>
        [rect.left - left, rect.top - top, rect.width, rect.height].map(
          Math.round
        )
      ),
    ]),
  ]);
  if (key === layer.drawn) {
    return;
  }
  layer.drawn = key;
  const out: HTMLElement[] = [];
  for (const { name, words, rects } of parts) {
    const group = document.createElement("div");
    // What the checks read where CSS.highlights is missing.
    group.dataset.highlight = name;
    group.dataset.words = words;
    for (const rect of rects) {
      const mark = document.createElement("div");
      const { className } = stylex.props(styles.box, styles[name], blend);
      if (className !== undefined && className !== "") {
        mark.className = className;
      }
      mark.style.left = `${rect.left - left}px`;
      mark.style.top = `${rect.top - top}px`;
      mark.style.width = `${rect.width}px`;
      mark.style.height = `${rect.height}px`;
      group.append(mark);
    }
    out.push(group);
  }
  element.replaceChildren(...out);
};

const later = (layer: Layer) => {
  if (!layer.frame) {
    layer.frame = requestAnimationFrame(() => {
      draw(layer);
    });
  }
};

/** Draws one viewer's ranges for a highlight name, in a browser without the Highlight API. */
export const drawMarks = (name: string, viewer: string, ranges: Range[]) => {
  let layer = layers.get(viewer);
  if (!layer) {
    const start = ranges[0]?.startContainer;
    const scroller = (
      start instanceof Element ? start : start?.parentElement
    )?.closest<HTMLElement>('[role="document"]');
    if (!scroller) {
      return;
    }
    const element = document.createElement("div");
    element.setAttribute("aria-hidden", "true");
    element.dataset.slot = "artifact-viewer-marks";
    const { className } = stylex.props(styles.layer);
    if (className !== undefined && className !== "") {
      element.className = className;
    }
    const made: Layer = {
      scroller,
      element,
      ranges: new Map(),
      drawn: "",
      stop: idle,
      rows: new ResizeObserver(() => {
        later(made);
      }),
      frame: 0,
    };
    const again = () => {
      later(made);
    };
    // The words move without the page changing: the viewer resized, a zoom, a view switched (the
    // rows are placed by their style), the direction or the theme changed on the way down, a font
    // loaded, or content that arrives finished moving in.
    const sized = new ResizeObserver(again);
    sized.observe(scroller);
    const placed = new MutationObserver(again);
    placed.observe(scroller, {
      attributes: true,
      subtree: true,
      attributeFilter: ["style", "class", "dir"],
    });
    const themed = new MutationObserver(again);
    for (
      let above = scroller.parentElement;
      above;
      above = above.parentElement
    ) {
      themed.observe(above, {
        attributes: true,
        attributeFilter: ["class", "style", "dir", "data-theme", "data-ground"],
      });
    }
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", again);
    document.fonts?.addEventListener("loadingdone", again);
    scroller.addEventListener("animationend", again);
    scroller.addEventListener("transitionend", again);
    made.stop = () => {
      sized.disconnect();
      placed.disconnect();
      themed.disconnect();
      made.rows.disconnect();
      scheme.removeEventListener("change", again);
      document.fonts?.removeEventListener("loadingdone", again);
      scroller.removeEventListener("animationend", again);
      scroller.removeEventListener("transitionend", again);
    };
    layer = made;
    layers.set(viewer, layer);
  }
  if (ranges.length) {
    layer.ranges.set(name, ranges);
  } else {
    layer.ranges.delete(name);
  }
  if (!layer.ranges.size) {
    cancelAnimationFrame(layer.frame);
    layer.stop();
    layer.element.remove();
    layers.delete(viewer);
    return;
  }
  draw(layer);
};

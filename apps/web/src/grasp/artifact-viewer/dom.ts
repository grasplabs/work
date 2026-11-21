// Between the page and the text: where a selection is in the file's text, and where a piece of
// the text is on the page. Each renderer marks the elements that hold the file's own words with
// `data-offset` (where their words start in the text) and, when its words are not a plain slice of
// the source (Markdown's quotes, entities, escapes), `data-shift` (source-map.ts). A PDF's page carries `data-part`, its
// page index, as each page has its own text. Only rows near the screen are in the page, so only
// they can be mapped; that is all a selection or a highlight needs.

import { drawMarks } from "./marks";
import { readShifts, toRendered, toSource } from "./source-map";
import type { Shifts } from "./source-map";

/** A run of the file's words on the page. */
interface Run {
  element: HTMLElement;
  part: number;
  start: number;
  /** Where its source ends. */
  end: number;
  length: number;
  shifts: Shifts;
}

const runOf = (element: HTMLElement): Run => {
  const start = Number(element.dataset.offset);
  const part = Number(
    element.closest<HTMLElement>("[data-part]")?.dataset.part ?? 0
  );
  const length = element.textContent?.length ?? 0;
  const shifts = readShifts(element.dataset.shift);
  return {
    element,
    part,
    start,
    end: toSource(start, shifts, Math.max(0, length - 1)) + (length ? 1 : 0),
    length,
    shifts,
  };
};

/** Every run of words in the page, in order. */
export const runsIn = (root: ParentNode): Run[] =>
  [...root.querySelectorAll<HTMLElement>("[data-offset]")].map(runOf);

// How many characters of a run come before a point in it.
const charactersBefore = (run: HTMLElement, node: Node, offset: number) => {
  const range = document.createRange();
  range.selectNodeContents(run);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
};

/** Where a place in the run is in the text: its character's source offset, or the run's end. */
const sourceAt = (run: Run, characters: number) =>
  characters >= run.length
    ? run.end
    : toSource(run.start, run.shifts, characters);

/**
 * Where a selection is in the file's text: its part, start and end. Null outside the file's words.
 * `began` is where it began when that was last in the words: a selection whose first rows have
 * left the page (scrolled away while it was made) keeps its start.
 */
export const textRangeOf = (
  range: Range,
  root: HTMLElement,
  began: { part: number; start: number } | null = null
): { part: number; start: number; end: number } | null => {
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) {
    return null;
  }
  const hits = runsIn(root).filter((run) => range.intersectsNode(run.element));
  const [first] = hits;
  if (first === undefined) {
    return null;
  }
  // One part only: a selection over two PDF pages holds on to the first.
  const last = hits.findLast((run) => run.part === first.part) ?? first;
  const inFirst = first.element.contains(range.startContainer);
  const here = inFirst
    ? sourceAt(
        first,
        charactersBefore(first.element, range.startContainer, range.startOffset)
      )
    : first.start;
  const keeps =
    !inFirst &&
    began !== null &&
    began.part === first.part &&
    began.start < here;
  const start = keeps ? began.start : here;
  const end = last.element.contains(range.endContainer)
    ? sourceAt(
        last,
        charactersBefore(last.element, range.endContainer, range.endOffset)
      )
    : last.end;
  return end > start ? { part: first.part, start, end } : null;
};

// The document's ways to find the words under a point. Either can be missing: a browser without
// `caretPositionFromPoint` has only the older `caretRangeFromPoint`, and some have only the newer.
interface Carets {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/** Where a point on the screen is in the file's text, if on its words. */
export const textPointAt = (
  x: number,
  y: number,
  root: HTMLElement
): { part: number; offset: number } | null => {
  const carets: Carets = document;
  const caret = carets.caretPositionFromPoint?.(x, y);
  const node =
    caret?.offsetNode ?? carets.caretRangeFromPoint?.(x, y)?.startContainer;
  const offset =
    caret?.offset ?? carets.caretRangeFromPoint?.(x, y)?.startOffset ?? 0;
  if (!node || !root.contains(node)) {
    return null;
  }
  const element = (
    node instanceof Element ? node : node.parentElement
  )?.closest<HTMLElement>("[data-offset]");
  if (!element) {
    return null;
  }
  const run = runOf(element);
  return {
    part: run.part,
    offset: sourceAt(run, charactersBefore(element, node, offset)),
  };
};

// The text node and offset `characters` into a run.
const pointIn = (run: HTMLElement, characters: number): [Node, number] => {
  const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
  let left = characters;
  let last: Node | null = null;
  // Only text nodes: a text node's value is its text.
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const { length } = node.nodeValue ?? "";
    if (left <= length) {
      return [node, left];
    }
    left -= length;
    last = node;
  }
  return last ? [last, (last.nodeValue ?? "").length] : [run, 0];
};

/** The page's ranges over a piece of the text: one per run it touches, for the runs in the page. */
export const domRangesOf = (
  runs: readonly Run[],
  part: number,
  start: number,
  end: number
): Range[] => {
  const ranges: Range[] = [];
  for (const run of runs) {
    if (run.part !== part || run.end <= start || run.start >= end) {
      continue;
    }
    const { length } = run;
    const from = Math.max(0, toRendered(run.start, run.shifts, start, length));
    const to = Math.max(
      from,
      end >= run.end ? length : toRendered(run.start, run.shifts, end, length)
    );
    if (to === from) {
      continue;
    }
    const range = document.createRange();
    range.setStart(...pointIn(run.element, from));
    range.setEnd(...pointIn(run.element, to));
    ranges.push(range);
  }
  return ranges;
};

// The highlights of every viewer on the page, joined: CSS names a highlight for the whole document.
// Older browsers have no CSS Custom Highlight API, though the DOM's types always declare it.
interface HighlightScope {
  CSS?: { highlights?: HighlightRegistry };
  Highlight?: typeof Highlight;
}
const scope: HighlightScope = globalThis;
const registry = () => scope.CSS?.highlights;
const owned = new Map<string, Map<string, Range[]>>();

// Whether this browser draws the viewer's highlights: it has the CSS Custom Highlight API, and the
// tint set on the viewer reaches the words inside it. Firefox 159 has the API, but a ::highlight
// style there holds only for text directly in the element it is set on, and the words are always
// in a run or a line inside; so nothing showed. Asked once, of the first words highlighted.
let native: boolean | undefined;
const drawsHighlights = (words: Node | undefined) => {
  if (native !== undefined) {
    return native;
  }
  if (!registry() || !scope.Highlight) {
    return (native = false);
  }
  const element = words instanceof Element ? words : words?.parentElement;
  if (!element) {
    return true;
  }
  const tint = getComputedStyle(
    element,
    "::highlight(viewer-comment)"
  ).backgroundColor;
  return (native =
    Boolean(tint) && tint !== "transparent" && tint !== "rgba(0, 0, 0, 0)");
};

/**
 * Sets one viewer's ranges for a highlight name; the name's highlight is every viewer's together.
 * Where the browser cannot draw it, the viewer draws the same tints as boxes over the words
 * (marks.ts).
 */
export const setHighlight = (name: string, viewer: string, ranges: Range[]) => {
  const [firstRange] = ranges;
  if (
    native === false ||
    (firstRange !== undefined && !drawsHighlights(firstRange.startContainer))
  ) {
    drawMarks(name, viewer, ranges);
    return;
  }
  const all = registry();
  const { Highlight: HighlightClass } = scope;
  if (!all || !HighlightClass) {
    drawMarks(name, viewer, ranges);
    return;
  }
  const byViewer = owned.get(name) ?? new Map<string, Range[]>();
  owned.set(name, byViewer);
  if (ranges.length) {
    byViewer.set(viewer, ranges);
  } else {
    byViewer.delete(viewer);
  }
  const joined = [...byViewer.values()].flat();
  if (joined.length) {
    all.set(name, new HighlightClass(...joined));
  } else {
    all.delete(name);
  }
};

/** Tries something once a frame until it says it is done, `most` times at most. */
export const eachFrameUntil = (done: () => boolean, most: number) => {
  let left = most;
  const attempt = () => {
    if (done() || left <= 0) {
      return;
    }
    left -= 1;
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
};

// The nearest box above an element that scrolls, or none when the page itself does.
const scrollingParent = (from: Element | null): HTMLElement | null => {
  for (let element = from; element !== null; element = element.parentElement) {
    if (element === document.body || element === document.documentElement) {
      return null;
    }
    const { overflowY } = getComputedStyle(element);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight &&
      element instanceof HTMLElement
    ) {
      return element;
    }
  }
  return null;
};

/**
 * Brings an element the viewer shows over its own document (an agent's proposed edit) into the
 * view of whatever scrolls the viewer: the box round it, or the page. It moves only as far as it
 * must, and not at all when the element is already in view; never so far that its top goes out.
 */
export const bringIntoView = (
  element: HTMLElement,
  viewer: HTMLElement,
  behavior: ScrollBehavior
) => {
  const margin = 16;
  const rect = element.getBoundingClientRect();
  const parent = scrollingParent(viewer.parentElement);
  const view = parent
    ? parent.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight };
  const below = rect.bottom + margin - view.bottom;
  const above = view.top - (rect.top - margin);
  let by = 0;
  if (below > 0) {
    by = Math.max(0, Math.min(below, rect.top - margin - view.top));
  } else if (above > 0) {
    by = -above;
  }
  if (Math.abs(by) < 1) {
    return;
  }
  (parent ?? window).scrollBy({ top: by, behavior });
};

/**
 * Brings a place in the file to the middle of the viewer's own view, scrolling the viewer and never
 * the page: a link's hash, or the person, decided where the page is.
 */
export const centreIn = (scroller: HTMLElement, target: Element) => {
  const view = scroller.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const top = rect.top - view.top - (view.height - rect.height) / 2;
  let left = 0;
  if (rect.left < view.left) {
    left = rect.left - view.left - 16;
  } else if (rect.right > view.right) {
    left = rect.right - view.right + 16;
  }
  scroller.scrollBy({ top, left });
};

// Arrive, with nothing round a word: how the words of an answer still being written fade in, in
// Damsko. No element is added for the fade. The newest text is marked by ranges over the text
// nodes themselves, held in named highlights (the CSS Custom Highlight API), and each highlight
// draws the text a step paler than its own colour. Every frame a range moves to the next step, and
// when it has arrived it is let go. Nothing in the page changes for the fade, so no line is ever
// measured again and no word moves.
//
//   const fader = startFading(box);   // box: the element the words are written into
//   settleFading(fader);              // no more is coming: what is fading finishes, then it stops
//
// It reads what is new from the page itself, in the order of its text: what is added past the text
// it had is new, and fades in from the frame it is drawn. Text that is replaced rather than added to
// (a mark closed, a half line turned into a table row) makes nothing new, so a word that has
// arrived never fades in again. use-arriving.ts holds it for a part.
//
// What belongs to a word arrives with it: a link's arrow and the chip behind code in a sentence are
// not text, so no highlight draws them. While a link's or a code's words fade, the element carries
// the step its newest words are at (`data-arrive-step`, 0 to 7), and its own styles draw the arrow
// and the chip at that step (Link's mark, Markdown's inlineCode): opacity and a fill, never size.
// A link made whole after its words have arrived (its address came later) brings its arrow in the
// same way, from the moment it is drawn.
//
// Where it fades: Chromium 105, Safari 17.2 and Firefox 140 have the API. Any other browser, reduced
// motion and forced colours: no fade, and the words simply appear as the pace lets them out.

/**
 * How strong each step of the fade draws the text, as a share of its own colour, faint to nearly
 * whole. Eight steps over the fade's length is a step about every 28ms, under two frames at 60Hz,
 * which the eye takes as one smooth fade; fewer (five, 44ms each) showed as flicker on large type.
 * They ease out a little, as the one curve does (grasp.ease): most of the change comes early, so a
 * word is readable from its second frame.
 */
export const ARRIVE_STEPS = [
  0.14, 0.3, 0.45, 0.58, 0.7, 0.8, 0.88, 0.95,
] as const;

/** How long a word takes to arrive, in ms: today's fade, well within the 300ms a step may take. */
export const ARRIVE_LENGTH = 220;

/** The prefix of every highlight this registers, so a check can count what is fading. */
export const ARRIVE_NAME = "grasp-arrive";

/** How many colours of text get a fade of their own; text of any colour past these simply appears. */
const MOST_COLOURS = 48;

const STEP_LENGTH = ARRIVE_LENGTH / ARRIVE_STEPS.length;

/** What arrives with its words: a link (its arrow) and code in a sentence (its chip). */
const COMPANIONS = "a, code";

/** The attribute that carries a companion's step while its words fade. */
export const ARRIVE_STEP = "data-arrive-step";

interface Piece {
  range: Range;
  /** The highlight it is in now. */
  name: string;
  /** The highlights of its colour, a step each. */
  steps: readonly string[];
  /** The link or code its words are in, which arrives with them. */
  companion: Element | null;
}

interface Stretch {
  start: number;
  end: number;
  /** When it was drawn, in ms on the page's clock. */
  born: number;
  step: number;
  pieces: Piece[];
}

/** What a fader holds: the text nodes it has read, in order, and what is fading. */
export interface Fader {
  root: HTMLElement;
  nodes: Text[];
  /** Where each node's text starts in the whole text, and its text when it was read. */
  starts: number[];
  texts: string[];
  /** Each node's place in `nodes`. */
  at: Map<Text, number>;
  total: number;
  stretches: Stretch[];
  observer: MutationObserver | null;
  /** What changed on the page since the last frame, read at the start of the next. */
  pending: MutationRecord[];
  frame: number;
  /** Each element's colour, read once a frame. */
  colours: Map<Element, string>;
  /** Links and code drawn new without new words (a link made whole later), and when. */
  joins: { element: Element; born: number }[];
  /** The step each companion carries now. */
  marked: Map<Element, number>;
}

/** Whether words can fade here: the API is there, and the person has not asked for less motion or forced colours. */
export const canFade = () =>
  typeof window !== "undefined" &&
  typeof CSS !== "undefined" &&
  "highlights" in CSS &&
  typeof Highlight === "function" &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
  !window.matchMedia("(forced-colors: active)").matches;

// The steps' rules, one set per colour of text, in a stylesheet made here once and given to the
// document (never a style tag or a style attribute). A highlight cannot take the colour under it:
// Chromium draws `currentColor` in a highlight as the page's text colour, not the word's own (a
// link or code in a sentence went grey), so each colour is read from the page and gets its steps.
const inks = new Map<string, readonly string[]>();
let sheet: CSSStyleSheet | null = null;

const adopt = () => {
  const made = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, made];
  return made;
};

/** The highlights for text of this colour, a step each; null past the most colours there may be. */
const stepsFor = (colour: string): readonly string[] | null => {
  const known = inks.get(colour);
  if (known !== undefined) {
    return known;
  }
  if (inks.size >= MOST_COLOURS) {
    return null;
  }
  const index = inks.size;
  const names = ARRIVE_STEPS.map(
    (_, step) => `${ARRIVE_NAME}-${String(index)}-${String(step)}`
  );
  sheet ??= adopt();
  for (const [step, name] of names.entries()) {
    const share = Math.round((ARRIVE_STEPS[step] ?? 1) * 100);
    sheet.insertRule(
      `@media (forced-colors: none) and (prefers-reduced-motion: no-preference) { ::highlight(${name}) { color: color-mix(in srgb, ${colour} ${String(share)}%, transparent); } }`,
      sheet.cssRules.length
    );
  }
  inks.set(colour, names);
  return names;
};

const paint = (name: string, range: Range) => {
  const held = CSS.highlights.get(name);
  if (held === undefined) {
    CSS.highlights.set(name, new Highlight(range));
    return;
  }
  held.add(range);
};

const unpaint = (piece: Piece) => {
  const held = CSS.highlights.get(piece.name);
  held?.delete(piece.range);
  // A highlight with nothing in it is let go, so the page has none to look through.
  if (held?.size === 0) {
    CSS.highlights.delete(piece.name);
  }
};

const colourOf = (fader: Fader, element: Element) => {
  const known = fader.colours.get(element);
  if (known !== undefined) {
    return known;
  }
  const colour = getComputedStyle(element).color;
  fader.colours.set(element, colour);
  return colour;
};

/** The link or code in a sentence a word is in, inside the box; code in a fenced block has no chip. */
const companionOf = (fader: Fader, element: Element) => {
  const found = element.closest(COMPANIONS);
  return found !== null &&
    fader.root.contains(found) &&
    found.closest("pre") === null
    ? found
    : null;
};

/** Each companion's step now: its newest fading words', or its own when it was drawn later. */
const wantedSteps = (fader: Fader, now: number) => {
  const wanted = new Map<Element, number>();
  const take = (element: Element, step: number) => {
    wanted.set(element, Math.min(wanted.get(element) ?? step, step));
  };
  for (const stretch of fader.stretches) {
    for (const piece of stretch.pieces) {
      if (piece.companion !== null) {
        take(piece.companion, stretch.step);
      }
    }
  }
  fader.joins = fader.joins.filter(
    (join) => now - join.born < ARRIVE_LENGTH && join.element.isConnected
  );
  for (const join of fader.joins) {
    take(join.element, Math.floor(Math.max(now - join.born, 0) / STEP_LENGTH));
  }
  return wanted;
};

/** Gives each companion its step, and takes it off those whose words have arrived. */
const markCompanions = (fader: Fader, now: number) => {
  const wanted = wantedSteps(fader, now);
  for (const [element, step] of wanted) {
    if (fader.marked.get(element) !== step) {
      element.setAttribute(ARRIVE_STEP, String(step));
    }
  }
  for (const element of fader.marked.keys()) {
    if (!wanted.has(element)) {
      element.removeAttribute(ARRIVE_STEP);
    }
  }
  fader.marked = wanted;
};

/** Links and code drawn new in a change: each arrives from now, whether its words are new or not. */
const joinAdded = (fader: Fader, records: MutationRecord[], now: number) => {
  for (const record of records) {
    for (const added of record.addedNodes) {
      if (added instanceof Element && added.isConnected) {
        const found = [
          ...(added.matches(COMPANIONS) ? [added] : []),
          ...added.querySelectorAll(COMPANIONS),
        ];
        for (const element of found) {
          if (element.closest("pre") === null) {
            fader.joins.push({ element, born: now });
          }
        }
      }
    }
  }
};

/** The last node whose text starts at or before `offset`. */
const nodeAt = (fader: Fader, offset: number) => {
  let low = 0;
  let high = fader.starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((fader.starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

const pieceOf = (
  fader: Fader,
  index: number,
  stretch: Stretch
): Piece | null => {
  const node = fader.nodes[index];
  const start = fader.starts[index] ?? 0;
  const text = fader.texts[index] ?? "";
  const from = Math.max(stretch.start - start, 0);
  const to = Math.min(stretch.end - start, text.length);
  const element = node?.parentElement;
  // Spaces alone draw nothing: no range for them.
  if (
    node === undefined ||
    element === null ||
    element === undefined ||
    to <= from ||
    text.slice(from, to).trim() === ""
  ) {
    return null;
  }
  const steps = stepsFor(colourOf(fader, element));
  if (steps === null) {
    return null;
  }
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const name = steps[Math.min(stretch.step, steps.length - 1)] ?? "";
  paint(name, range);
  return { range, name, steps, companion: companionOf(fader, element) };
};

/** The stretch's ranges made again from where its text is now. */
const repaint = (fader: Fader, stretch: Stretch) => {
  for (const piece of stretch.pieces) {
    unpaint(piece);
  }
  stretch.pieces = [];
  if (fader.nodes.length === 0) {
    return;
  }
  for (
    let index = nodeAt(fader, stretch.start);
    index < fader.nodes.length && (fader.starts[index] ?? 0) < stretch.end;
    index += 1
  ) {
    const piece = pieceOf(fader, index, stretch);
    if (piece !== null) {
      stretch.pieces.push(piece);
    }
  }
};

/** Reads the colour of every element the stretches' words are in, before anything is painted. */
const readColours = (fader: Fader, stretches: Stretch[]) => {
  for (const stretch of stretches) {
    for (
      let index = nodeAt(fader, stretch.start);
      index < fader.nodes.length && (fader.starts[index] ?? 0) < stretch.end;
      index += 1
    ) {
      const element = fader.nodes[index]?.parentElement;
      if (element !== null && element !== undefined) {
        colourOf(fader, element);
      }
    }
  }
};

const forget = (stretch: Stretch) => {
  for (const piece of stretch.pieces) {
    unpaint(piece);
  }
  stretch.pieces = [];
};

/** Reads the text nodes again from `from` on: the ones before it are as they were. */
const readFrom = (fader: Fader, from: number) => {
  for (const node of fader.nodes.slice(from)) {
    fader.at.delete(node);
  }
  fader.nodes.length = from;
  fader.starts.length = from;
  fader.texts.length = from;
  const last = fader.nodes.at(-1);
  // The node to go on from must still be where it was; if it is not, everything is read again.
  if (last !== undefined && !fader.root.contains(last)) {
    readFrom(fader, 0);
    return;
  }
  const walker = document.createTreeWalker(fader.root, NodeFilter.SHOW_TEXT);
  let total = 0;
  if (last !== undefined) {
    walker.currentNode = last;
    total = (fader.starts.at(-1) ?? 0) + (fader.texts.at(-1)?.length ?? 0);
  }
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      fader.at.set(node, fader.nodes.length);
      fader.nodes.push(node);
      fader.starts.push(total);
      fader.texts.push(node.data);
      total += node.data.length;
    }
  }
  fader.total = total;
};

/** The first read node a removed node held, or past the end when it held none. */
const firstRemoved = (fader: Fader, removed: Node) => {
  if (removed instanceof Text) {
    return fader.at.get(removed) ?? fader.nodes.length;
  }
  let first = fader.nodes.length;
  const walker = document.createTreeWalker(removed, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const index = node instanceof Text ? fader.at.get(node) : undefined;
    first = Math.min(first, index ?? first);
  }
  return first;
};

/** Where an added node stands among the read ones: just after the read text before it. */
const placeOfAdded = (fader: Fader, added: Node) => {
  if (!added.isConnected || !fader.root.contains(added)) {
    return fader.nodes.length;
  }
  const walker = document.createTreeWalker(fader.root, NodeFilter.SHOW_TEXT);
  walker.currentNode = added;
  for (
    let node = walker.previousNode();
    node !== null;
    node = walker.previousNode()
  ) {
    const index = node instanceof Text ? fader.at.get(node) : undefined;
    if (index !== undefined) {
      return index + 1;
    }
  }
  return 0;
};

/** The first read node a change may have touched. Streaming adds at the end, so it is mostly the last. */
const firstTouched = (fader: Fader, record: MutationRecord) => {
  if (record.type === "characterData") {
    return record.target instanceof Text
      ? (fader.at.get(record.target) ?? fader.nodes.length)
      : 0;
  }
  let first = fader.nodes.length;
  for (const removed of record.removedNodes) {
    first = Math.min(first, firstRemoved(fader, removed));
  }
  for (const added of record.addedNodes) {
    first = Math.min(first, placeOfAdded(fader, added));
  }
  return first;
};

/** How many characters two texts share from their start. */
const shared = (one: string, other: string) => {
  let length = 0;
  while (
    length < one.length &&
    length < other.length &&
    one[length] === other[length]
  ) {
    length += 1;
  }
  return length;
};

const moveOn = (stretch: Stretch) => {
  for (const piece of stretch.pieces) {
    const name =
      piece.steps[Math.min(stretch.step, piece.steps.length - 1)] ?? piece.name;
    if (name !== piece.name) {
      unpaint(piece);
      piece.name = name;
      paint(name, piece.range);
    }
  }
};

/**
 * The page changed: read what changed, and mark what was added past the old text as new. It runs
 * at the start of the next frame, before that frame is painted, so a new word is never drawn whole
 * first, and what it reads of the page (each new word's colour) is read once the frame's styles are
 * worked out anyway, not in the middle of the task that changed the page.
 */
const changed = (fader: Fader, records: MutationRecord[], now: number) => {
  let from = fader.nodes.length;
  for (const record of records) {
    from = Math.min(from, firstTouched(fader, record));
  }
  const start = fader.starts[from] ?? fader.total;
  const before = fader.texts.slice(from).join("");
  const { total } = fader;
  readFrom(fader, from);
  const after = fader.texts.slice(from).join("");
  joinAdded(fader, records, now);
  if (after.startsWith(before)) {
    if (fader.total > total) {
      fader.stretches.push({
        start: total,
        end: fader.total,
        born: now,
        step: 0,
        pieces: [],
      });
    }
  } else {
    // Replaced, not added to: nothing is new, and what was fading past the change is let go whole.
    const cut = start + shared(before, after);
    for (const stretch of fader.stretches.filter((one) => one.end > cut)) {
      forget(stretch);
    }
    fader.stretches = fader.stretches.filter((one) => one.end <= cut);
  }
  // What was fading in the part read again is drawn again from its new nodes. Every colour is read
  // first: a highlight changed between two reads would make the page work out its styles twice.
  const again = fader.stretches.filter((one) => one.end > start);
  readColours(fader, again);
  for (const stretch of again) {
    repaint(fader, stretch);
  }
};

/** One frame: each stretch a step on, and let go once it has arrived. */
const tick = (fader: Fader, now: number) => {
  fader.frame = 0;
  fader.colours.clear();
  if (fader.pending.length > 0) {
    changed(fader, fader.pending.splice(0), now);
  }
  const gone = !fader.root.isConnected;
  const left: Stretch[] = [];
  for (const stretch of fader.stretches) {
    const step = Math.floor(Math.max(now - stretch.born, 0) / STEP_LENGTH);
    if (gone || step >= ARRIVE_STEPS.length) {
      forget(stretch);
    } else {
      if (step !== stretch.step) {
        stretch.step = step;
        moveOn(stretch);
      }
      left.push(stretch);
    }
  }
  fader.stretches = left;
  markCompanions(fader, gone ? Infinity : now);
  if (left.length > 0 || fader.joins.length > 0) {
    fader.frame = requestAnimationFrame((time) => {
      tick(fader, time);
    });
  }
};

const loop = (fader: Fader) => {
  if (fader.frame === 0) {
    fader.frame = requestAnimationFrame((now) => {
      tick(fader, now);
    });
  }
};

/**
 * Starts fading in whatever text is added inside `root` from now on; what is there now has arrived.
 * Null where words cannot fade (no API, reduced motion, forced colours): they simply appear.
 */
export const startFading = (root: HTMLElement): Fader | null => {
  if (!canFade()) {
    return null;
  }
  const fader: Fader = {
    root,
    nodes: [],
    starts: [],
    texts: [],
    at: new Map(),
    total: 0,
    stretches: [],
    observer: null,
    pending: [],
    frame: 0,
    colours: new Map(),
    joins: [],
    marked: new Map(),
  };
  readFrom(fader, 0);
  fader.observer = new MutationObserver((records) => {
    fader.pending.push(...records);
    loop(fader);
  });
  fader.observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return fader;
};

/** No more is coming: nothing new is marked, and what is fading finishes, then nothing is held. */
export const settleFading = (fader: Fader | null) => {
  if (fader === null) {
    return;
  }
  fader.observer?.disconnect();
  fader.observer = null;
  if (fader.stretches.length === 0 && fader.joins.length === 0) {
    cancelAnimationFrame(fader.frame);
    fader.frame = 0;
    markCompanions(fader, Infinity);
  }
};

/** How many ranges are fading now, over every part on the page: for checks. */
export const fadingNow = () => {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) {
    return 0;
  }
  let count = 0;
  for (const [name, held] of CSS.highlights) {
    if (name.startsWith(ARRIVE_NAME)) {
      count += held.size;
    }
  }
  return count;
};

// Focus: the one way Damsko shows where the keyboard is. Every component and every site block
// takes its focus look from here, last in its stylex.props(), and sets no outline of its own.
//
//   stylex.props(styles.button, focus.ring)        a control: button, checkbox, tab, segment, chip
//   stylex.props(styles.box, focus.mark)          a small mark whose own edge is a line (a checkbox,
//                                                  a radio, a switch): the ring stands off it
//   stylex.props(styles.thumb, focus.within)       a part whose focus is on a hidden input inside it
//                                                  (a slider's thumb): the ring on the part itself
//   stylex.props(styles.link, focus.words)         words: a link, a row's name
//   stylex.props(styles.scroller, focus.inside)    a box its parent clips: a code view, a nav row
//   stylex.props(styles.page, inFrame && focus.frame)  the box round an iframe, while focus is in
//                                                  the frame (the component says when)
//   stylex.props(styles.input, focus.field)        a field you type in: the ring for the keyboard,
//                                                  its soft halo for a press (fieldWithin, fieldSlot,
//                                                  fieldInside for a field drawn as a box round it)
//   stylex.props(styles.row, focus.row)            the row of an item that holds focus and its
//                                                  children too (a tree's item): the ring on the row
//   stylex.props(styles.tab, focusMarker, focus.carrier)  a control drawn edge to edge with no
//   stylex.props(styles.words, focus.label)        corner of its own (a line tab): the ring goes
//                                                  round its words, with a small corner, not round
//                                                  the whole box
//
// A control shows focus only for the keyboard (:focus-visible), so a click shows nothing extra.
// A field shows it whenever it has focus (a text field always matches :focus-visible), because
// typing needs to know where it goes. The ring sits on the control's edge and follows its shape:
// one mark, not a second frame.
//
// A field (focus.field on the field itself, focus.fieldWithin on a box round the input that types,
// focus.fieldSlot on a cell of a one-time code) takes the same ring as every control when the
// keyboard brought focus to it, on its own edge, and drops its soft halo: the ring wins. A pointer
// press keeps the soft halo (grasp.fieldFocus) and no ring. A text field matches :focus-visible on
// a press as well, so the press is told apart here: a pointer press marks the element it focuses
// with data-focus-pointer until it loses focus (watchPointerFocus, below), and the ring asks for
// :focus-visible without it. In forced colours, where shadows are dropped, a pointer-focused field
// keeps a thin real outline and a keyboard-focused one the thick Highlight ring.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";
import { focusMarker } from "./focus.stylex";

export { focusMarker } from "./focus.stylex";

const line = `${grasp.ringWidth} solid ${grasp.ring}`;
// In forced colours a control already has a line of its own at rest (its edge), and the ring on
// that edge would look like rest: the ring is twice as thick, in the system's Highlight, and stands
// off the edge, so a focused control is told from one at rest. Normal colours are untouched.
const forcedLine = `calc(2 * ${grasp.ringWidth}) solid Highlight`;
const forcedThin = `${grasp.ringWidth} solid`;

// Focus the keyboard brought: on the field itself, or on the input inside a field's box.
const KEY = ":focus-visible:not([data-focus-pointer])";
const KEY_IN =
  ":has(:is(input, textarea):focus-visible:not([data-focus-pointer]))";
const ANY_KEY_IN = ":has(:focus-visible:not([data-focus-pointer]))";
const ANY_IN = ":has(:is(input, textarea):focus-visible)";

/**
 * Marks an element a pointer press focuses with data-focus-pointer, and takes it off when it loses
 * focus, so a field focused by a press keeps its soft halo and one the keyboard reached shows the
 * ring. Once per document; in the browser only.
 */
const watchPointerFocus = (root: Document) => {
  const flag = "graspPointerFocus";
  if (root.documentElement.dataset[flag] === "") {
    return;
  }
  root.documentElement.dataset[flag] = "";
  let pointer = false;
  // A press on what already has focus moves no focus, so focusin never hears it: the element is
  // marked here, so a ring the keyboard drew earlier goes with the press (a press never shows the
  // ring). A key on it brings the ring back.
  root.addEventListener(
    "pointerdown",
    (event) => {
      pointer = true;
      const active = root.activeElement;
      if (
        active instanceof HTMLElement &&
        event.target instanceof Node &&
        active.contains(event.target)
      ) {
        active.dataset.focusPointer = "";
      }
    },
    { capture: true, passive: true }
  );
  root.addEventListener(
    "keydown",
    () => {
      pointer = false;
      const active = root.activeElement;
      if (active instanceof HTMLElement) {
        delete active.dataset.focusPointer;
      }
    },
    { capture: true, passive: true }
  );
  root.addEventListener(
    "focusin",
    (event) => {
      if (pointer && event.target instanceof HTMLElement) {
        event.target.dataset.focusPointer = "";
      }
    },
    { capture: true }
  );
  root.addEventListener(
    "focusout",
    (event) => {
      if (event.target instanceof HTMLElement) {
        delete event.target.dataset.focusPointer;
      }
    },
    { capture: true }
  );
};
if (typeof document !== "undefined") {
  watchPointerFocus(document);
}

export const focus = stylex.create({
  // The keyboard's focus only: never after a press (data-focus-pointer), even on an element the
  // keyboard focused before it was pressed.
  ring: {
    outline: {
      default: "none",
      [KEY]: { default: line, [media.forced]: forcedLine },
    },
    outlineOffset: {
      default: grasp.ringOffset,
      [media.forced]: grasp.ringOffsetMark,
    },
  },
  // A small mark whose own edge is already a line: on that edge the ring would be lost, so it
  // stands off it, a gap of the ground between them.
  mark: {
    outline: {
      default: "none",
      [KEY]: { default: line, [media.forced]: forcedLine },
    },
    outlineOffset: grasp.ringOffsetMark,
  },
  within: {
    outline: { default: "none", ":has(:focus-visible)": line },
    outlineOffset: grasp.ringOffset,
  },
  // The box round a frame (an iframe), while focus is in the frame. No selector can say so: the
  // frame's own page holds the focus, and in the page round it neither :focus nor :focus-within
  // matches. So the component watches for it (the window loses focus to its frame) and adds this
  // while it lasts: the same ring, drawn just inside the box's edge where nothing clips it.
  // In forced colours such a box already has a line of its own at rest (its edge, a shadow, is
  // dropped there), so the ring is three times as thick and in the system's Highlight: told from rest.
  frame: {
    outline: {
      default: line,
      [media.forced]: `calc(3 * ${grasp.ringWidth}) solid Highlight`,
    },
    outlineOffset: {
      default: `calc(-1 * ${grasp.ringWidth})`,
      [media.forced]: `calc(-3 * ${grasp.ringWidth})`,
    },
  },
  words: {
    outline: { default: "none", [KEY]: line },
    // 1px off the words, a pixel in from ring-offset-words: clears the letters and the next word.
    outlineOffset: `calc(${grasp.ringOffsetWords} - 1px)`,
  },
  inside: {
    outline: { default: "none", [KEY]: line },
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
  },
  field: {
    outline: {
      default: "none",
      ":focus-visible": { default: "none", [media.forced]: forcedThin },
      [KEY]: { default: line, [media.forced]: forcedLine },
    },
    outlineOffset: {
      default: grasp.ringOffset,
      [media.forced]: grasp.ringOffsetMark,
    },
    // The keyboard's focus: the field's own focus look (its halo) becomes its rest, the ring alone shows.
    "--grasp-field-focus": { default: null, [KEY]: grasp.fieldRest },
    "--grasp-field-focus-invalid": { default: null, [KEY]: grasp.fieldInvalid },
  },
  // A field whose box sits flush in a surface (Command's search): the ring drawn just inside it.
  fieldInside: {
    outline: {
      default: "none",
      ":focus-visible": { default: "none", [media.forced]: forcedThin },
      [KEY]: { default: line, [media.forced]: forcedLine },
    },
    outlineOffset: {
      default: `calc(-1 * ${grasp.ringWidth})`,
      [media.forced]: `calc(-2 * ${grasp.ringWidth})`,
    },
  },
  // A box round the input that types (Number input, Tag input, Date picker, Input group): the
  // ring on the box while its input has the keyboard's focus. The input inside takes focus.carrier.
  fieldWithin: {
    outline: {
      default: "none",
      [ANY_IN]: { default: "none", [media.forced]: forcedThin },
      [KEY_IN]: { default: line, [media.forced]: forcedLine },
    },
    outlineOffset: {
      default: grasp.ringOffset,
      [media.forced]: grasp.ringOffsetMark,
    },
    "--grasp-field-focus": { default: null, [KEY_IN]: grasp.fieldRest },
    "--grasp-field-focus-invalid": {
      default: null,
      [KEY_IN]: grasp.fieldInvalid,
    },
  },
  // A control made of parts, one rounded box (Filter builder's segments): the ring round the whole
  // box while the keyboard has focus on any part; the part says which by its own fill.
  fieldGroup: {
    outline: {
      default: "none",
      [ANY_KEY_IN]: { default: line, [media.forced]: forcedLine },
    },
    outlineOffset: {
      default: grasp.ringOffset,
      [media.forced]: grasp.ringOffsetMark,
    },
  },
  // A cell of a one-time code, the one typing goes to, inside a root that carries focusMarker and
  // holds the code's one input.
  fieldSlot: {
    outline: {
      default: "none",
      [stylex.when.ancestor(ANY_IN, focusMarker)]: {
        default: "none",
        [media.forced]: forcedThin,
      },
      [stylex.when.ancestor(KEY_IN, focusMarker)]: {
        default: line,
        [media.forced]: forcedLine,
      },
    },
    outlineOffset: {
      default: grasp.ringOffset,
      [media.forced]: grasp.ringOffsetMark,
    },
    "--grasp-field-focus": {
      default: null,
      [stylex.when.ancestor(KEY_IN, focusMarker)]: grasp.fieldRest,
    },
    "--grasp-field-focus-invalid": {
      default: null,
      [stylex.when.ancestor(KEY_IN, focusMarker)]: grasp.fieldInvalid,
    },
  },
  // A control whose ring is drawn on its words (focus.label): it draws none itself.
  carrier: {
    outline: "none",
  },
  // The words of a focus.carrier: the ring round them, keyboard only, with the small corner.
  label: {
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    outline: {
      default: "none",
      [stylex.when.ancestor(KEY, focusMarker)]: line,
    },
    outlineOffset: grasp.ringOffsetWords,
  },
  // Focus on a tree's item, which holds its children as well as its row: the ring on the row
  // only, inside it, so it never goes round the children.
  row: {
    outline: {
      default: "none",
      ":is([data-slot=tree-item]:focus-visible > *)": line,
    },
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
  },
  // A row whose whole width is one press (a row list's row, cloud/data): the ring round the row
  // when the press inside it has keyboard focus, drawn inside so the card never clips it.
  band: {
    outline: { default: "none", ":has([data-row-press]:focus-visible)": line },
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
  },
});

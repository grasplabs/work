"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { grasp } from "../tokens/tokens.stylex";
import type { ComposerFile } from "./attachments";
import {
  composerPictureToken,
  composerReference,
  composerTextParts,
} from "./references";

export {
  composerPictureToken,
  composerReference,
  composerTextParts,
} from "./references";
export type { ComposerReference } from "./references";

/**
 * Where a chip's thumbnail is drawn: an em and an en space, 1.5em, in the text and the layer alike.
 * The thumbnail takes 1.25em of it (4 by 3: 19 by 14px at the 15px text, 20 by 15 at 16px), and the
 * rest is the gap before the name.
 */
export const PICTURE_MARK = "  ";
/** A four-per-em space at each end of a chip: the room inside its fill, before the thumbnail and after the name. */
const PAD = " ";

/** One picture in the text: its file's id, its name in the text, its thumbnail and when it was added. */
export interface ComposerPicture {
  id: string;
  /** "Image 1". */
  label: string;
  /** The thumbnail's address: the file's `preview`, never anything from the text. */
  preview: string | undefined;
  /** When it was added: the file's `addedAt`, else when the Composer first had it. */
  at: Date;
}

/** A picture: an image the host holds. It is a chip while the text names it, whatever its upload's state. */
export const isPicture = (file: ComposerFile) =>
  file.type?.startsWith("image/") ?? false;

/** A picture goes in the text, not the strip: an image, not failed or refused (those keep the strip too, to try again). */
export const isInlinePicture = (file: ComposerFile) =>
  isPicture(file) && file.status !== "failed" && file.status !== "refused";

/** A picture's chip as it stands in the shown text. */
export const pictureToken = (label: string) =>
  `${PAD}${PICTURE_MARK}${label}${PAD}`;

// ---- The shown form, and an edit mapped back -----------------------------------------------------------

/** One piece of the shown text: words (as the canonical text has them), or a chip, with where it stands. */
export type Piece =
  | { chip: false; text: string; from: number; to: number }
  | { chip: true; id: string; label: string; from: number; to: number };

/** The canonical text's pieces in the shown form: each reference to a known picture a chip, everything else words as written. */
export const piecesOf = (
  canonical: string,
  known: ReadonlySet<string>
): Piece[] => {
  const pieces: Piece[] = [];
  let at = 0;
  const words = (text: string) => {
    const last = pieces.at(-1);
    if (last !== undefined && !last.chip) {
      last.text += text;
      last.to += text.length;
    } else {
      pieces.push({ chip: false, text, from: at, to: at + text.length });
    }
    at += text.length;
  };
  for (const part of composerTextParts(canonical)) {
    if (typeof part === "string") {
      words(part);
    } else if (part.kind === "attachment" && known.has(part.id)) {
      const shown = pictureToken(part.label);
      pieces.push({
        chip: true,
        id: part.id,
        label: part.label,
        from: at,
        to: at + shown.length,
      });
      at += shown.length;
    } else {
      // Unknown stays text: its reference as written, never a chip.
      words(composerReference(part.kind, part.id, part.label));
    }
  }
  return pieces;
};

export const shownOf = (pieces: Piece[]) =>
  pieces
    .map((piece) => (piece.chip ? pictureToken(piece.label) : piece.text))
    .join("");

/** The shown text for a canonical one. */
export const showText = (canonical: string, known: ReadonlySet<string>) =>
  shownOf(piecesOf(canonical, known));

/** How many characters the person sees: a chip counts as one. */
export const seenLength = (pieces: Piece[]) =>
  pieces.reduce((sum, piece) => sum + (piece.chip ? 1 : piece.text.length), 0);

/**
 * Inserted characters, read back. A canonical reference stays one (it shows as a chip when its id is
 * known). A chip's characters are bound by their label only when the browser puts back what it took
 * (undo and redo, `byLabel`); otherwise, as from a paste from outside, their spaces go and the words stay.
 */
const insertedOf = (
  text: string,
  idOf: ReadonlyMap<string, string>,
  byLabel: boolean
) => {
  let out = text;
  if (byLabel) {
    for (const [label, id] of idOf) {
      out = out.replaceAll(
        pictureToken(label),
        composerPictureToken(id, label)
      );
    }
  }
  return out.replaceAll(PICTURE_MARK, "").replaceAll(PAD, "");
};

/** How the inserted span of an edit is read. */
export interface Insertion {
  /** The canonical text the composer itself put in (its own paste, a new picture's chip), read as it is. */
  canonical?: string;
  /** Undo or redo: the browser puts back a chip's characters, bound by their label. */
  byLabel?: boolean;
}

/**
 * An edit of the shown text, mapped back to the canonical one. The edit is the one span where the
 * old and new shown texts differ; a chip that span touches, even in part, goes whole. Returns the
 * canonical text, and the canonical text up to the end of what was put in (for the caret).
 */
export const mapBack = (
  oldPieces: Piece[],
  oldShown: string,
  newShown: string,
  idOf: ReadonlyMap<string, string>,
  insertion: Insertion = {}
) => {
  let start = 0;
  const most = Math.min(oldShown.length, newShown.length);
  while (start < most && oldShown[start] === newShown[start]) {
    start += 1;
  }
  let end = 0;
  while (
    end < most - start &&
    oldShown[oldShown.length - 1 - end] === newShown[newShown.length - 1 - end]
  ) {
    end += 1;
  }
  const oldTo = oldShown.length - end;
  const inserted =
    insertion.canonical ??
    insertedOf(
      newShown.slice(start, newShown.length - end),
      idOf,
      insertion.byLabel ?? false
    );
  let before = "";
  let after = "";
  for (const piece of oldPieces) {
    if (piece.chip) {
      // A chip the span overlaps goes whole; one that only meets its edge stays.
      const overlaps =
        start < oldTo
          ? piece.from < oldTo && piece.to > start
          : piece.from < start && piece.to > start;
      const token = composerPictureToken(piece.id, piece.label);
      if (!overlaps && piece.to <= start) {
        before += token;
      } else if (!overlaps) {
        after += token;
      }
    } else {
      before += piece.text.slice(
        0,
        Math.max(0, Math.min(piece.text.length, start - piece.from))
      );
      after += piece.text.slice(
        Math.max(0, Math.min(piece.text.length, oldTo - piece.from))
      );
    }
  }
  return {
    canonical: `${before}${inserted}${after}`,
    upToCaret: `${before}${inserted}`,
  };
};

/** The canonical text of a span of the shown one: a chip it touches comes whole. */
export const canonicalSlice = (pieces: Piece[], from: number, to: number) =>
  pieces
    .filter((piece) => piece.from < to && piece.to > from)
    .map((piece) =>
      piece.chip
        ? composerPictureToken(piece.id, piece.label)
        : piece.text.slice(
            Math.max(0, from - piece.from),
            Math.min(piece.text.length, to - piece.from)
          )
    )
    .join("");

/** A canonical text as a person reads it: each reference as its label. */
export const readableText = (canonical: string) =>
  composerTextParts(canonical)
    .map((part) => (typeof part === "string" ? part : part.label))
    .join("");

/** The pictures the host holds that the text no longer names: they are not sent, and are let go when the draft ends. */
export const composerUnreferenced = (
  text: string,
  attachments: readonly ComposerFile[]
) => {
  const named = new Set(
    composerTextParts(text).flatMap((part) =>
      typeof part !== "string" && part.kind === "attachment" ? [part.id] : []
    )
  );
  return attachments.filter((file) => isPicture(file) && !named.has(file.id));
};

/**
 * An edit of the field through the browser's own editing (`insertText`, or `delete` with null), so it
 * joins the field's undo stack; where the browser refuses, the same edit by `setRangeText` and an
 * `input` event, which leaves undo behind. Which ran is kept on the field (`data-edit-path`).
 */
export const editField = (field: HTMLTextAreaElement, text: string | null) => {
  // The one way an edit joins a field's own undo stack: deprecated, still in every browser.
  // oxlint-disable-next-line typescript/no-deprecated -- execCommand keeps undo; setRangeText (below) does not
  const command = document.execCommand.bind(document);
  const name = text === null ? "delete" : "insertText";
  // oxlint-disable-next-line typescript/no-deprecated -- the same call, as above
  const done = command(name, false, text ?? "");
  if (done) {
    field.dataset.editPath = "command";
    return;
  }
  field.setRangeText(
    text ?? "",
    field.selectionStart,
    field.selectionEnd,
    "end"
  );
  field.dataset.editPath = "range";
  field.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: text === null ? "deleteContentBackward" : "insertText",
      data: text,
    })
  );
};

/** The chip the caret stands against in the shown text: the one ending at it (`before`), starting at it (`after`), or the one it is inside. */
const meets = (
  piece: Piece,
  at: number,
  side: "before" | "after" | "inside"
) => {
  if (side === "before") {
    return piece.to === at;
  }
  if (side === "after") {
    return piece.from === at;
  }
  return piece.from < at && piece.to > at;
};

export const chipAt = (
  pieces: Piece[],
  at: number,
  side: "before" | "after" | "inside"
) => {
  const chip = pieces.find((piece) => piece.chip && meets(piece, at, side));
  return chip?.chip === true
    ? { id: chip.id, label: chip.label, start: chip.from, end: chip.to }
    : null;
};

/**
 * A selection that cuts into a chip, widened to take the chip whole, so an edit of it is the
 * browser's own (and undo keeps it), never a rewrite of the field. True when it widened.
 */
export const wholeChips = (field: HTMLTextAreaElement, pieces: Piece[]) => {
  const { selectionStart: start, selectionEnd: end } = field;
  if (start === end) {
    return false;
  }
  let from = start;
  let to = end;
  for (const piece of pieces) {
    if (piece.chip && piece.from < end && piece.to > start) {
      from = Math.min(from, piece.from);
      to = Math.max(to, piece.to);
    }
  }
  if (from === start && to === end) {
    return false;
  }
  field.setSelectionRange(from, to, field.selectionDirection);
  return true;
};

/** The clipboard type that carries the canonical text, so a paste binds by id. */
export const COMPOSER_CLIPBOARD = "application/x-damsko-composer";

const styles = stylex.create({
  // The thumbnail over the em space: the space keeps the room in the text, the picture fills it.
  slot: {
    position: "relative",
  },
  // 4 by 3, the whole picture on its own quiet ground (zoomed out, never a crop of its middle),
  // with its own small corner, inside the chip's fill.
  // The frame is the shape: it clips the picture to its four round corners, its quiet ground shows
  // round a picture of another shape, and its edge is a layer over the picture (as Avatar's).
  thumb: {
    position: "absolute",
    insetInlineStart: 0,
    top: "50%",
    width: "1.25em",
    height: "0.9375em",
    transform: "translateY(-50%)",
  },
  // In the mention menu: the same shape, at an icon's height.
  rowThumb: {
    position: "relative",
    flexShrink: 0,
    width: `calc(${grasp.iconMd} * 4 / 3)`,
    height: grasp.iconMd,
  },
  frame: {
    display: "block",
    overflow: "hidden",
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
  },
  picture: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  // The system's edge for a picture on a ground (avatar-edge): a hairline ring inside the frame, so a
  // white picture keeps its rim on the chip's grey, and it adds no size.
  edge: {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.avatarEdge,
    pointerEvents: "none",
  },
  chip: {
    color: "transparent",
    // Grey in light and dark alike: the ink, faintly, over whatever the card is.
    backgroundColor: `color-mix(in oklch, ${grasp.ink} 7%, transparent)`,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
});

/** A picture's thumbnail: the whole picture in a 4 by 3 frame with four round corners and its edge. */
export const PictureFrame = ({
  preview,
  look,
}: {
  preview: string | undefined;
  look?: stylex.StyleXStyles;
}) => (
  <span
    aria-hidden="true"
    data-slot="composer-picture-frame"
    {...stylex.props(styles.frame, look)}
  >
    {preview === undefined ? null : (
      <img alt="" src={preview} {...stylex.props(styles.picture)} />
    )}
    <span {...stylex.props(styles.edge)} />
  </span>
);

/** The thumbnail drawn over a chip's em space, in the chip layer (or a sent message). */
export const PictureSlot = ({ preview }: { preview: string | undefined }) => (
  <span {...stylex.props(styles.slot)}>
    <PictureFrame preview={preview} look={styles.thumb} />
    {PICTURE_MARK}
  </span>
);

/** A picture's chip in the chip layer: the same characters as its token, the thumbnail over its room. */
export const PictureChip = ({
  label,
  preview,
}: {
  label: string;
  preview: string | undefined;
}) => (
  <mark data-kind="pictures" {...stylex.props(styles.chip)}>
    {PAD}
    <PictureSlot preview={preview} />
    {label}
    {PAD}
  </mark>
);

/** A picture's thumbnail at an icon's size, for the mention menu's row. */
export const PictureRowThumb = ({
  preview,
}: {
  preview: string | undefined;
}) => <PictureFrame preview={preview} look={styles.rowThumb} />;

interface Known {
  id: string;
  n: number;
  at: Date;
}

/** The number in a label ("Image 12" is 12), or 0. */
const numberIn = (label: string) =>
  Number(/(?<n>\d+)\s*$/u.exec(label)?.groups?.n ?? "0");

interface PicturesInput {
  attachments: ComposerFile[];
  /** The canonical text. */
  text: string;
  area: RefObject<HTMLTextAreaElement | null>;
  label: (n: number) => string;
  /** Puts a new canonical text in, as the composer's own edit (when the field cannot take it through the browser). */
  write: (next: string) => void;
  /** Says what canonical text the composer's own next edit of the field puts in. */
  expect: (canonical: string) => void;
}

/**
 * The pictures in the text. Each picture is bound by its id. Its label comes from the text when the
 * text names it; a picture added in this session takes the next free number (one more than the
 * highest in the text and the highest given), which it keeps. A new picture's chip goes in at the
 * caret of its paste or drop through the browser's own editing, so undo takes it out again.
 */
export const useInlinePictures = ({
  attachments,
  text,
  area,
  label,
  write,
  expect,
}: PicturesInput) => {
  const [known, setKnown] = useState<Known[]>([]);
  // Every label given or read in this session, by id, so an undo that brings a chip back finds its picture.
  const [given, setGiven] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  // Where the next pictures go in: the caret when they were pasted or dropped.
  const pending = useRef<number | null>(null);
  const mounted = useRef(false);

  const named = new Map<string, string>();
  for (const part of composerTextParts(text)) {
    if (typeof part !== "string" && part.kind === "attachment") {
      named.set(part.id, part.label);
    }
  }
  const labelOf = (id: string) => named.get(id) ?? given.get(id);
  const pictures: ComposerPicture[] = attachments.flatMap((file) => {
    const name = labelOf(file.id);
    if (!isPicture(file) || name === undefined) {
      return [];
    }
    const at =
      known.find((each) => each.id === file.id)?.at ??
      (file.addedAt === undefined ? new Date(0) : new Date(file.addedAt));
    return [{ id: file.id, label: name, preview: file.preview, at }];
  });
  const ids = new Set(attachments.filter(isPicture).map((file) => file.id));
  // Label to id, for reading chips back: every label this session knows, for a picture still held.
  const idOf = new Map<string, string>();
  for (const id of ids) {
    const name = labelOf(id);
    if (name !== undefined) {
      idOf.set(name, id);
    }
  }

  // The latest of what the effect needs, kept by an effect, so it runs only as the pictures change.
  const latest = useRef({ text, known, given, write, expect, label, named });
  useEffect(() => {
    latest.current = { text, known, given, write, expect, label, named };
  });

  useEffect(() => {
    const now = latest.current;
    const first = !mounted.current;
    mounted.current = true;
    const isKnown = (id: string) => now.known.some((each) => each.id === id);
    const arrived = attachments.filter(
      (file) => isPicture(file) && !isKnown(file.id)
    );
    const gone = now.known.filter(
      (each) => !attachments.some((file) => file.id === each.id)
    );
    if (arrived.length === 0 && gone.length === 0) {
      return;
    }
    setKnown([
      ...now.known.filter((each) => !gone.includes(each)),
      ...arrived.map((file) => ({
        id: file.id,
        n: 0,
        at: file.addedAt === undefined ? new Date() : new Date(file.addedAt),
      })),
    ]);
    // Every label known so far: the text's, and those given before.
    const labels = new Map([...now.given, ...now.named]);
    // A picture the host took away takes its references with it (the host's own act, not undone here).
    let next = now.text;
    for (const each of gone) {
      const name = labels.get(each.id);
      if (name !== undefined) {
        next = next
          .replaceAll(`${composerPictureToken(each.id, name)} `, "")
          .replaceAll(composerPictureToken(each.id, name), "");
      }
    }
    // A picture already named by the text (a draft brought back) gets no new chip, and nor does one
    // the host held from the start: only a picture that arrives after mount goes in, at the next free number.
    const fresh = first
      ? []
      : arrived.filter(
          (file) => isInlinePicture(file) && !now.named.has(file.id)
        );
    let highest = Math.max(0, ...[...labels.values()].map(numberIn));
    for (const file of fresh) {
      highest += 1;
      labels.set(file.id, now.label(highest));
    }
    setGiven(labels);
    const caret = pending.current;
    pending.current = null;
    const field = area.current;
    const nameOf = (file: ComposerFile) => labels.get(file.id) ?? "";
    if (
      fresh.length > 0 &&
      next === now.text &&
      field !== null &&
      caret !== null
    ) {
      // Through the browser's own editing, so undo takes the chips out again.
      field.focus({ preventScroll: true });
      field.setSelectionRange(caret, caret);
      const { value } = field;
      const space = caret > 0 && !/\s/u.test(value[caret - 1] ?? "") ? " " : "";
      const trail = /^\s/u.test(value.slice(caret)) ? "" : " ";
      now.expect(
        `${space}${fresh.map((file) => composerPictureToken(file.id, nameOf(file))).join(" ")}${trail}`
      );
      editField(
        field,
        `${space}${fresh.map((file) => pictureToken(nameOf(file))).join(" ")}${trail}`
      );
      return;
    }
    if (fresh.length > 0) {
      const space = next === "" || /\s$/u.test(next) ? "" : " ";
      next = `${next}${space}${fresh.map((file) => composerPictureToken(file.id, nameOf(file))).join(" ")} `;
    }
    if (next !== now.text) {
      now.write(next);
    }
  }, [attachments, area]);

  // A label the text brings (a draft, a paste) is kept for the session, so an undo finds it after it goes.
  const unseen = [...named].filter(([id, name]) => given.get(id) !== name);
  useEffect(() => {
    if (unseen.length > 0) {
      // oxlint-disable-next-line react/set-state-in-effect -- the labels come from the text as it changes
      setGiven(new Map([...given, ...unseen]));
    }
  }, [unseen, given]);

  /** Remembers where the pictures of a paste or a drop go in. */
  const markAt = (at: number | null) => {
    pending.current = at;
  };

  return { pictures, ids, idOf, markAt };
};

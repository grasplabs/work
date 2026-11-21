// A picture's chip in a sent message (message.tsx): the same chip the Composer drew in its text,
// "Image 1" with its thumbnail, in the line of words. Pressing it opens the picture. The message's
// text carries each chip as the Composer sends it, `@[Image 1](attachment:<id>)`.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { PictureFrame, composerTextParts } from "../composer/pictures";
import { focus } from "../focus/focus";
import { grasp, media } from "../tokens/tokens.stylex";

/** A picture a sent message names: its attachment's id and its thumbnail's address. */
export interface ChatMessagePicture {
  id: string;
  preview?: string;
}

const styles = stylex.create({
  // The Composer's chip (composer/pictures.tsx): a soft grey squircle with no edge, the room of a
  // four-per-em space at each end, the 4 by 3 thumbnail whole on its quiet ground, a quarter em
  // before the name. On the words' line, never taller than it.
  chip: {
    // Inline-block: its words stand on the sentence's baseline, the thumbnail on their middle.
    display: "inline-block",
    verticalAlign: "baseline",
    margin: 0,
    padding: 0,
    paddingInline: "0.25em",
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: `color-mix(in oklch, ${grasp.ink} 7%, transparent)`,
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
    },
    color: "inherit",
    font: "inherit",
    // As tall as the Composer's chip (its words' own box), so chips on two lines never touch.
    lineHeight: "1.25",
    cursor: "pointer",
  },
  thumb: {
    position: "relative",
    display: "inline-block",
    verticalAlign: "middle",
    width: "1.25em",
    height: "0.9375em",
    marginInlineEnd: "0.25em",
  },
});

/** The words of a sent message, each picture's reference drawn as its chip; any other reference as its label. */
export const withPictures = (
  text: string,
  pictures: ChatMessagePicture[],
  onOpen: ((id: string) => void) | undefined
): ReactNode => {
  const parts = composerTextParts(text);
  if (parts.every((part) => typeof part === "string")) {
    return text;
  }
  return parts.map((part, index) => {
    if (typeof part === "string") {
      return part;
    }
    const picture = pictures.find((each) => each.id === part.id);
    // Unknown stays words: a reference to anything not in `pictures` reads as its label, never a chip.
    if (part.kind !== "attachment" || picture === undefined) {
      return part.label;
    }
    const { preview } = picture;
    return (
      <button
        key={index}
        type="button"
        data-slot="chat-message-picture"
        data-id={part.id}
        onClick={() => onOpen?.(part.id)}
        {...stylex.props(styles.chip, focus.ring)}
      >
        <PictureFrame preview={preview} look={styles.thumb} />
        {part.label}
      </button>
    );
  });
};

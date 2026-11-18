// PanelText: a long text card for an inspector (an agent's instructions, a note), after Profound's:
// it stands {inspector-long} tall, its words fade out at the foot, and a button in its top corner
// opens it to its full height and closes it again. Hand it Markdown, or any words.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Expand, Minus } from "../icons";
import { RowListAction } from "../row-list";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { panelWords } from "./words";

/** Every prop a PanelText takes. */
export interface PanelTextProps {
  /** The words: a Markdown, or paragraphs. */
  children: ReactNode;
  /**
   * The name of the button in its corner that opens the words to their full height and closes
   * them again, said to a screen reader.
   * @default "Show all"
   */
  openLabel?: string;
  /**
   * Open at its full height at first.
   * @default false
   */
  defaultOpen?: boolean;
}

const styles = stylex.create({
  card: {
    position: "relative",
    minWidth: 0,
  },
  body: {
    boxSizing: "border-box",
    paddingBlock: grasp.space4,
    paddingInlineStart: grasp.inspectorInset,
    // Room for the button in the corner, so no word runs under it.
    paddingInlineEnd: `calc(${grasp.controlXs} + ${grasp.space4})`,
    fontSize: grasp.inspectorText,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  shut: {
    maxHeight: grasp.inspectorLong,
    overflow: "hidden",
    maskImage: `linear-gradient(to bottom, black calc(100% - ${grasp.inspectorLongFade}), transparent)`,
  },
  corner: {
    position: "absolute",
    // On the first line's centre, as a heading's line stands: at a fixed 8px it rode 5px above a
    // heading's middle ("What changed").
    top: `calc(${grasp.space4} + (${grasp.textMdLine} - ${grasp.controlXs}) / 2)`,
    insetInlineEnd: grasp.space2,
    zIndex: 1,
    borderRadius: grasp.cornerMark,
    backgroundColor: { default: grasp.raised, [media.forced]: "Canvas" },
  },
});

/** A long text in a card: faded at the foot, opened in place. */
export const PanelText = ({
  children,
  openLabel: openLabelGiven,
  defaultOpen = false,
}: PanelTextProps) => {
  const { showAll: openLabel } = withGiven(useWords("panel", panelWords), {
    showAll: openLabelGiven,
  });
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // Opened by a press, the words it brings are scrolled into view: the card grows below the
  // panel's fold, and only the icon changed where the eye was.
  useEffect(() => {
    if (open && opened.current) {
      body.current?.scrollIntoView({ block: "start" });
    }
    opened.current = true;
  }, [open]);
  return (
    <div data-slot="panel-text" {...stylex.props(styles.card)}>
      <span {...stylex.props(styles.corner)}>
        <RowListAction
          icon={open ? Minus : Expand}
          aria-label={openLabel}
          expanded={open}
          controls={id}
          onPress={() => {
            setOpen((was) => !was);
          }}
        />
      </span>
      <div
        ref={body}
        id={id}
        data-open={open ? "" : undefined}
        {...stylex.props(styles.body, !open && styles.shut)}
      >
        {children}
      </div>
    </div>
  );
};

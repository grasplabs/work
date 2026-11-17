// Copy field: a value you can copy, as one quiet line. The value in the mono face on a quiet fill in
// the system's corner, the Copy icon at its end. A press anywhere on it copies the value; the icon
// turns into the tick for a moment and the page's one polite voice says so. The docs' install line
// made general: an install command, an id, a key, a token's name or its value.
//
//   <CopyField value="bunx shadcn add @grasp/button" label="Copy the install command" />
//   <CopyField size="sm" value="--grasp-mint" label="Copy --grasp-mint" swatch="var(--grasp-mint)" />
//
// It is one button (the icon), so a keyboard reaches it once and a screen reader hears its name;
// the field round it is a label for that button, so a press on the value presses it too. A value
// longer than its room stays on one line and scrolls sideways inside the field, its far end fading;
// it never breaks and is never cut short. The timing, the tick and the words are the library's own
// for every copy (useCopy in ../button/copy.tsx, src/announce): the same as Code block's, Chat
// message's and Key value's copy.
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { useEffect, useRef, useState } from "react";

import { announce } from "../announce/announce";
import { useCopy } from "../button/copy";
import { focus } from "../focus/focus";
import { Copy, Failed, Icon, Tick } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { copyFieldMarker } from "./copy-field.stylex";
import { styles } from "./styles";

/** What a caller may style: where the field sits and how wide it is. Never its look. */
export type CopyFieldLayoutStyle = LayoutStyle;

/** Every prop a CopyField takes. */
export interface CopyFieldProps {
  /** What is shown and copied, exactly: a command, an id, a token's name or value. */
  value: string;
  /** The button's name, saying what it copies ("Copy the install command", "Copy --grasp-mint"). */
  label: string;
  /**
   * What is said once it is copied, and what the tick means.
   * @default "Copied"
   */
  copiedLabel?: string;
  /**
   * What is said when it could not copy.
   * @default "Could not copy"
   */
  failedLabel?: string;
  /**
   * `sm` 28px, for a list of values (a token's name and values); `md` 32px, for one value on its own
   * (an install command). On a touch screen the button has a 44px target either way.
   * @default "md"
   */
  size?: "sm" | "md";
  /** A colour shown as a small round before the value, for a colour's name or value: any CSS colour. */
  swatch?: string;
  /** Called with the value once it is on the clipboard. */
  onCopy?: (value: string) => void;
  /** Layout only: margins, width and alignment. The look belongs to the field. */
  style?: CopyFieldLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: CopyFieldLayoutStyle;
}

/** Which end of the value has more beyond it, as data-more says it. */
type More = "start" | "end" | "both" | undefined;

const moreOf = (box: HTMLElement): More => {
  // The value reads left to right in every page direction (dir="ltr"), so these are its ends.
  const start = box.scrollLeft > 1;
  const end = box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
  if (start && end) {
    return "both";
  }
  if (start) {
    return "start";
  }
  return end ? "end" : undefined;
};

/** Marks which end of the value has more beyond it, on load, when its room changes and as it scrolls. */
const useMore = () => {
  const box = useRef<HTMLElement>(null);
  const [more, setMore] = useState<More>();
  useEffect(() => {
    const element = box.current;
    const mark = () => {
      if (element !== null) {
        setMore(moreOf(element));
      }
    };
    mark();
    element?.addEventListener("scroll", mark, { passive: true });
    const sizes =
      element === null || typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(mark);
    if (element !== null) {
      sizes?.observe(element);
    }
    return () => {
      element?.removeEventListener("scroll", mark);
      sizes?.disconnect();
    };
  }, []);
  return [box, more] as const;
};

/** The three marks in one cell: only one is seen at a time. */
const Marks = () => (
  <>
    <span aria-hidden="true" {...stylex.props(styles.mark, styles.copy)}>
      <Icon icon={Copy} />
    </span>
    <span aria-hidden="true" {...stylex.props(styles.mark, styles.tick)}>
      <Icon icon={Tick} />
    </span>
    <span aria-hidden="true" {...stylex.props(styles.mark, styles.failed)}>
      <Icon icon={Failed} />
    </span>
  </>
);

/** A value you can copy, as one quiet line with the Copy icon at its end. */
export const CopyField = ({
  value,
  label,
  copiedLabel = "Copied",
  failedLabel = "Could not copy",
  size = "md",
  swatch,
  onCopy,
  style: styleProp,
  layout,
}: CopyFieldProps) => {
  const [box, more] = useMore();
  const copy = useCopy(value, { done: copiedLabel, failed: failedLabel });
  const copied =
    copy.state === "done" || copy.state === "failed" ? copy.state : undefined;
  const hasSwatch = swatch !== undefined && swatch !== "";
  return (
    // A label round the button: a press anywhere on the field presses the button, once.
    <label
      data-slot="copy-field"
      data-size={size}
      data-copied={copied}
      {...stylex.props(
        copyFieldMarker,
        styles.field,
        styles[size],
        focus.within,
        layout ?? styleProp
      )}
    >
      {hasSwatch ? (
        <span aria-hidden="true" {...stylex.props(styles.swatch(swatch))} />
      ) : null}
      <span
        ref={box}
        data-slot="copy-field-value"
        data-more={more}
        dir="ltr"
        {...stylex.props(styles.value)}
      >
        {value}
      </span>
      <PressPrimitive
        aria-label={label}
        data-copy-field-button=""
        // Silent while it works: the result is said once, by the page's one voice.
        pendingAnnouncement=""
        onClick={async () => {
          const result = await copy.run();
          if ("busy" in result) {
            return;
          }
          announce(result.ok ? copiedLabel : failedLabel);
          if (!result.ok) {
            // An agent's press fails with the same words a person hears.
            throw new Error(failedLabel);
          }
          onCopy?.(value);
        }}
        {...stylex.props(styles.button)}
      >
        <span aria-hidden="true" {...stylex.props(styles.target)} />
        <Marks />
      </PressPrimitive>
    </label>
  );
};

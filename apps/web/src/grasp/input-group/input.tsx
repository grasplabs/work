// InputGroupInput: the input inside an InputGroup (input-group.tsx), on UI SDK's Input. It has no
// edge or fill of its own: the group draws them round it and its neighbours.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Input as InputPrimitive } from "@ui-sdk/react/input";
import { useEffect, useState } from "react";
import type { ComponentProps, Ref } from "react";

import { grasp, media } from "../tokens/tokens.stylex";
import { useGroupSize } from "./context";

type PrimitiveProps = ComponentProps<typeof InputPrimitive>;

/** Every prop an InputGroupInput takes: these, and the rest of UI SDK's Input and an <input>. */
export interface InputGroupInputProps extends Omit<
  PrimitiveProps,
  "className" | "style" | "render" | "size" | "children" | "width" | "height"
> {
  /**
   * What kind of text: `text`, `email`, `search`, `tel` or `url`. It brings the right keyboard on
   * a phone and the browser's own check.
   * @default "text"
   */
  type?: "text" | "email" | "search" | "tel" | "url";
  /** The value it starts with. A form reset returns here. */
  defaultValue?: string;
  /** The value, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /**
   * Called with the new value and why it changed. `details.source` is `"agent"` when an agent
   * changed it.
   */
  onValueChange?: PrimitiveProps["onValueChange"];
  /** An example of what goes in, never the label ("grasp.studio"). */
  placeholder?: string;
  /** Needs a value before the form is sent. @default false */
  required?: boolean;
  /** Can be read and copied, not changed. The group takes a quieter fill. @default false */
  readOnly?: boolean;
  /** Out of use: the whole group is at half strength. @default false */
  disabled?: boolean;
  /** Its name when no FieldLabel names it ("Website"). The words beside it are not its name. */
  "aria-label"?: string;
  /** The <input> itself, to focus it or read it. */
  ref?: Ref<HTMLInputElement>;
}

const CLIP_TEXT =
  "@supports (background-clip: text) and (not (-moz-appearance: none))";
const FADE_END = `linear-gradient(to right, currentColor calc(100% - ${grasp.space5}), transparent)`;
const FADE_END_RTL = `linear-gradient(to left, currentColor calc(100% - ${grasp.space5}), transparent)`;

const styles = stylex.create({
  input: {
    // Above the group's touch area, so a press on the words puts the caret where it lands.
    position: "relative",
    flexGrow: 1,
    alignSelf: "stretch",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    paddingBlock: 0,
    appearance: "none",
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    // The group shows focus round all its parts.
    outline: "none",
    // Read only: the words a step quieter (field-ink-read), as Input's.
    color: {
      default: grasp.ink,
      ":read-only:not(:disabled)": grasp.fieldInkRead,
    },
    caretColor: grasp.ink,
    font: "inherit",
    letterSpacing: "normal",
    textAlign: "start",
    // A placeholder too long ends in an ellipsis, never mid-word: Chromium reads the input's own
    // text-overflow for it, so it is set while the placeholder shows (third look A3-text-04).
    textOverflow: { default: "clip", ":placeholder-shown": "ellipsis" },
    // A value longer than the input fades out at its end, as Input's does, never a cut through a
    // letter: the words are painted through a gradient that ends in transparent over the last
    // space-5. Plain ink while it has focus, so the caret's end always shows.
    WebkitTextFillColor: {
      default: null,
      [CLIP_TEXT]: {
        default: "transparent",
        ":focus": "currentColor",
        [media.forced]: "currentColor",
      },
    },
    // Drawn only while the value is longer than the input (fits, below: third look A3-text-05).
    // In forced colours the background is dropped, so the words keep their own colour there.
    backgroundImage: {
      default: null,
      [CLIP_TEXT]: { default: FADE_END, ":dir(rtl)": FADE_END_RTL },
    },
    backgroundOrigin: { default: null, [CLIP_TEXT]: "content-box" },
    backgroundClip: { default: null, [CLIP_TEXT]: "text" },
    // One tile: words past the content box take no paint, so stay unseen.
    backgroundRepeat: { default: null, [CLIP_TEXT]: "no-repeat" },
    cursor: { default: "text", ":disabled": "not-allowed" },
    // The group's own clear square empties a search; the browser's cross would make two.
    // display: none, not appearance: none: WebKit draws its own cross with appearance none too.
    "::-webkit-search-cancel-button": { display: "none" },
    "::selection": { backgroundColor: grasp.fieldSelection, color: grasp.ink },
    "::placeholder": {
      color: grasp.muted,
      WebkitTextFillColor: grasp.muted,
      opacity: 1,
      // A hint too long for the field ends in an ellipsis, never mid-word.
      textOverflow: "ellipsis",
    },
  },
  // A value that fits: no fade, every letter at full ink.
  fits: {
    WebkitTextFillColor: null,
    backgroundImage: null,
    backgroundOrigin: null,
    backgroundClip: null,
    backgroundRepeat: null,
  },
  // Room at each end: the field's own padding at the group's edge, a small gap beside a neighbour.
  // The group's touch area is always its first child, so the first part is the second.
  md: {
    paddingInlineStart: {
      default: grasp.space2,
      ":nth-child(2)": grasp.space3,
    },
    paddingInlineEnd: { default: grasp.space2, ":last-child": grasp.space3 },
  },
  lg: {
    paddingInlineStart: {
      default: grasp.space2,
      ":nth-child(2)": grasp.space3,
    },
    paddingInlineEnd: { default: grasp.space2, ":last-child": grasp.space3 },
  },
});

/** Whether an input's value is longer than the input shows. */
const overflows = (input: HTMLInputElement) =>
  input.scrollWidth > input.clientWidth + 1;

/** Sets whether the input's value runs long; nothing when there is no input yet. */
const measureInto = (
  input: HTMLInputElement | null,
  setLong: (long: boolean) => void
) => {
  if (input !== null) {
    setLong(overflows(input));
  }
};

/** The input inside an InputGroup. */
export const InputGroupInput = ({
  type = "text",
  ref,
  ...rest
}: InputGroupInputProps) => {
  const size = useGroupSize();
  // The end fade only while the value runs past the input (Input's useRunsLong, the same here).
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [long, setLong] = useState(false);
  const attach = (element: HTMLInputElement | null) => {
    setInput(element);
    if (typeof ref === "function") {
      ref(element);
    } else if (ref) {
      ref.current = element;
    }
  };
  // Read on typing, on leaving the field (a value set from code is read then too), and on a resize.
  useEffect(() => {
    const measure = () => {
      measureInto(input, setLong);
    };
    measure();
    input?.addEventListener("input", measure);
    input?.addEventListener("focusout", measure);
    const observer =
      input === null || typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (input !== null) {
      observer?.observe(input);
    }
    return () => {
      input?.removeEventListener("input", measure);
      input?.removeEventListener("focusout", measure);
      observer?.disconnect();
    };
  }, [input]);
  return (
    <InputPrimitive
      {...rest}
      type={type}
      ref={attach}
      render={(props: Record<string, unknown>) => (
        <input
          {...props}
          {...stylex.props(styles.input, !long && styles.fits, styles[size])}
        />
      )}
    />
  );
};

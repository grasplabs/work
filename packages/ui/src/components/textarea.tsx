// Textarea: several lines of text,
// in StyleX, built on UI SDK's Textarea, with Input's fill, hairline,
// focus edge and words, so a form's fields are one family. It grows with its text up to
// textarea-height, then its text scrolls inside it.
//
//   <Textarea aria-label="Notes" placeholder="What should the team know?" />
//   <Textarea rows={6} autoResize={false} />                    a fixed height the person can drag
//   <Textarea submitShortcut="mod+enter" />                     Cmd or Ctrl+Enter sends the form
"use client";

import * as stylex from "@stylexjs/stylex";
import { Textarea as TextareaPrimitive } from "@ui-sdk/react/textarea";
import type { TextareaState } from "@ui-sdk/react/textarea";
import { useEffect, useRef } from "react";
import type { ComponentProps, Ref } from "react";

import { focusField, inputStyles, scrollbarHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { assignRef, isInvalid, warnUnnamed } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";

type PrimitiveProps = ComponentProps<typeof TextareaPrimitive>;

/** Every prop a Textarea takes: these, and the rest of UI SDK's Textarea and a <textarea>. */
export interface TextareaProps extends Omit<
  PrimitiveProps,
  "className" | "style" | "render" | "children" | "rows" | "autoResize"
> {
  /**
   * How many lines it shows when empty, and the least it shrinks to (up to six).
   * @default 3
   */
  rows?: number;
  /**
   * Words a machine reads, in the system's mono face: a JSON body, a cron line, a prompt's code.
   * A step smaller, on the same lines, so the field keeps its height; 16px on a touch screen as
   * every field is. No colours: it is a field, not a code view.
   * @default false
   */
  mono?: boolean;
  /**
   * Grows and shrinks with its text, up to textarea-height; past that, the text scrolls inside.
   * Turn it off for a fixed height the person can drag taller.
   * @default true
   */
  autoResize?: boolean;
  /** The value it starts with. A form reset returns here. */
  defaultValue?: string;
  /** The value, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /**
   * Called with the new value and why it changed. `details.source` is `"agent"` when an agent
   * changed it, and `details.cancel()` keeps the value as it was.
   */
  onValueChange?: PrimitiveProps["onValueChange"];
  /** An example of what goes in, never the label or an instruction. It goes when typing starts. */
  placeholder?: string;
  /**
   * The keys that send its form: `"mod+enter"` (Cmd or Ctrl+Enter, Enter starts a line) or
   * `"enter"` (Shift+Enter starts a line). Without it, Enter always starts a line.
   */
  submitShortcut?: PrimitiveProps["submitShortcut"];
  /**
   * Needs a value before the form is sent. Inside a Field, its label shows the required mark.
   * @default false
   */
  required?: boolean;
  /**
   * Can be read, selected and copied, and is sent with the form, but not changed. Drawn on a
   * quieter fill, with no hover.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Out of use: not focusable, not sent, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** Where it sits: margins, alignment and width. Colours, corners and padding belong to it. */
  style?: LayoutStyle;
  /** The <textarea> itself, to focus it or read it. */
  ref?: Ref<HTMLTextAreaElement>;
}

const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const TYPING = media.maxSmOrCoarse;

// The least height of `rows` lines: the lines and the padding round them, as a default control's.
const linesHigh = (rows: number) =>
  `calc(${rows} * ${font.textSmLine} + ${size.controlDefault} - ${font.textSmLine})`;

const styles = stylex.create({
  area: {
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    maxHeight: size.textareaHeight,
    margin: 0,
    appearance: "none",
    // No border: the edge is a hairline drawn inside, as in Input. A real one in forced colours.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    // A default Input's corner, so a field and a textarea in one form are cut the same.
    borderRadius: `min(${radius.xl}, calc(${size.controlDefault} / 2))`,
    cornerShape: radius.shape,
    backgroundColor: colors.inputBg,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`,
      ":focus-visible": size.inputFocus,
    },
    color: colors.foreground,
    caretColor: colors.foreground,
    fontFamily: font.sans,
    // 16px on a phone or a touch screen, or Safari zooms the page in when the field takes focus.
    fontSize: { default: font.textSm, [TYPING]: size.inputTextTouch },
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    textAlign: "start",
    overflowWrap: "anywhere",
    // A default Input's padding: the first line stands where an Input's words stand.
    paddingBlock: `calc((${size.controlDefault} - ${font.textSmLine}) / 2)`,
    paddingInline: space[3],
    transitionProperty: "box-shadow, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
    // Selected words in the system's own tone, never the browser's blue.
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    "::placeholder": {
      color: colors.mutedForeground,
      opacity: 1,
    },
  },
  // Words a machine reads: the mono face a step smaller, on the same lines.
  mono: {
    fontFamily: font.mono,
    fontSize: { default: font.textXs, [TYPING]: size.inputTextTouch },
  },
  // One line is never under a finger's 44px on a touch screen.
  rows1: {
    minHeight: {
      default: linesHigh(1),
      [COARSE]: `max(${linesHigh(1)}, ${size.tapTarget})`,
    },
  },
  rows2: { minHeight: linesHigh(2) },
  rows3: { minHeight: linesHigh(3) },
  rows4: { minHeight: linesHigh(4) },
  rows5: { minHeight: linesHigh(5) },
  rows6: { minHeight: linesHigh(6) },
  // Growing with its text: no handle to drag.
  grows: {
    resize: "none",
    // Grows before any script runs, where the browser can; UI SDK's autoResize does it everywhere.
    fieldSizing: "content",
  },
  // A fixed height: a handle to drag it taller, never wider.
  drags: {
    resize: "vertical",
    maxHeight: "none",
  },
  // Settled, as Input's: the soft ground, a hairline, no lift, its words a step quieter. Disabled
  // is the weaker look.
  readOnly: {
    backgroundColor: colors.inputBgRead,
    color: colors.inputForegroundRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}`,
      ":focus-visible": size.inputFocusRead,
    },
  },
});

/** The least height for `rows` lines, one to six. */
const rowsStyle = (rows: number) => {
  const lines = Math.min(Math.max(Math.round(rows), 1), 6);
  switch (lines) {
    case 1: {
      return styles.rows1;
    }
    case 2: {
      return styles.rows2;
    }
    case 3: {
      return styles.rows3;
    }
    case 4: {
      return styles.rows4;
    }
    case 5: {
      return styles.rows5;
    }
    default: {
      return styles.rows6;
    }
  }
};

export const Textarea = ({
  rows = 3,
  autoResize = true,
  mono = false,
  style,
  ref,
  ...rest
}: TextareaProps) => {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const attach = (element: HTMLTextAreaElement | null) => {
    own.current = element;
    assignRef(ref, element);
  };
  // In development, say so when nothing names it: no label, no aria-label.
  useEffect(() => {
    warnUnnamed("Textarea", own.current);
  }, []);

  // The send keys check the form first, as its button does, so an empty required field shows its
  // error and takes focus instead of nothing happening. A caller's own onSubmit wins.
  const send = () => {
    const form = own.current?.form;
    if (form?.reportValidity() === true) {
      form.requestSubmit();
    }
  };

  return (
    <TextareaPrimitive
      onSubmit={rest.submitShortcut ? send : undefined}
      {...rest}
      rows={rows}
      autoResize={autoResize}
      ref={attach}
      // UI SDK's props (its ref among them) go on our own <textarea>, styled from its state.
      render={(props: Record<string, unknown>, state: TextareaState) => (
        <textarea
          {...props}
          data-slot="textarea"
          {...stylex.props(
            styles.area,
            mono && styles.mono,
            rowsStyle(rows),
            autoResize ? styles.grows : styles.drags,
            !(state.disabled || state.readOnly) && inputStyles.enabled,
            state.readOnly && styles.readOnly,
            state.disabled && inputStyles.disabled,
            isInvalid(props["aria-invalid"]) && inputStyles.invalid,
            scrollbarHidden,
            focusField.default,
            style
          )}
        />
      )}
    />
  );
};

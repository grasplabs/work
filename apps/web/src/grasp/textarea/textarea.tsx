// Textarea: several lines of text, from shadcn's (registry/bases/base/ui/textarea.tsx, on Base UI),
// converted from Tailwind to StyleX and rebuilt on UI SDK's Textarea, then made Grasp's: Input's
// fill, hairline, focus edge and words, so a form's fields are one family. It grows with its text
// up to textarea-height, then its text scrolls inside it.
//
//   <Field>
//     <FieldLabel>Notes</FieldLabel>
//     <Textarea placeholder="What should the team know?" />
//   </Field>
//   <Textarea rows={6} autoResize={false} />                    a fixed height the person can drag
//   <Textarea submitShortcut="mod+enter" />                     Cmd or Ctrl+Enter sends the form
//
// Every value is a token (src/tokens). A caller may set layout and width only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { Textarea as TextareaPrimitive } from "@ui-sdk/react/textarea";
import type { TextareaState } from "@ui-sdk/react/textarea";
import { useEffect, useRef } from "react";
import type { ComponentProps, Ref } from "react";

import { focus } from "../focus/focus";
import type { LayoutStyle } from "../layout/layout";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";

/** What a caller may style: where the textarea sits and how wide it is. Never its look. */
export type TextareaLayoutStyle = LayoutStyle;

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
  /** Layout only: margins, alignment and width. Colours, corners and padding belong to it. */
  style?: TextareaLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: TextareaLayoutStyle;
  /** The <textarea> itself, to focus it or read it. */
  ref?: Ref<HTMLTextAreaElement>;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;

const styles = stylex.create({
  area: {
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    maxHeight: grasp.textareaHeight,
    margin: 0,
    appearance: "none",
    // No border: the edge is a hairline drawn inside, as in Input. A real one in forced colours.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    // Input md's corner, so a field and a textarea in one form are cut the same.
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.fieldFill,
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`,
      ":focus-visible": grasp.fieldFocus,
    },
    color: grasp.ink,
    caretColor: grasp.ink,
    fontFamily: grasp.fontSans,
    // 16px on a phone or a touch screen (media.typing), or Safari zooms the page in when the field takes focus.
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    letterSpacing: "normal",
    textAlign: "start",
    overflowWrap: "anywhere",
    // Input md's padding: the first line stands where an Input's words stand.
    paddingBlock: `calc((${grasp.controlMd} - ${grasp.textSmLine}) / 2)`,
    paddingInline: grasp.space3,
    transitionProperty: "box-shadow, background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
    // Selected words in our own tone (field-selection), never the browser's blue.
    "::selection": { backgroundColor: grasp.fieldSelection, color: grasp.ink },
    "::placeholder": {
      color: grasp.muted,
      opacity: 1,
    },
  },
  // The least height: `rows` lines and the padding round them (static, one per count, so the
  // server and the browser write the same class), and never under a finger's 44px on a touch screen.
  rows1: {
    minHeight: {
      default: `calc(1 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
      [COARSE]: `max(calc(1 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine}), ${grasp.tap})`,
    },
  },
  rows2: {
    minHeight: {
      default: `calc(2 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
      [COARSE]: `calc(2 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
    },
  },
  rows3: {
    minHeight: {
      default: `calc(3 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
      [COARSE]: `calc(3 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
    },
  },
  rows4: {
    minHeight: {
      default: `calc(4 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
      [COARSE]: `calc(4 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
    },
  },
  rows5: {
    minHeight: {
      default: `calc(5 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
      [COARSE]: `calc(5 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
    },
  },
  rows6: {
    minHeight: {
      default: `calc(6 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
      [COARSE]: `calc(6 * ${grasp.textSmLine} + ${grasp.controlMd} - ${grasp.textSmLine})`,
    },
  },
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
  live: {
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`,
      // Hover never covers the focus edge: the pointer often rests on a field while you type.
      ":hover:not(:focus-visible)": {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${grasp.fieldEdgeHover}, ${grasp.fieldLift}`,
      },
      ":focus-visible": grasp.fieldFocus,
    },
  },
  // Settled, as Input's: the soft ground, a hairline, no lift, its words a step quieter. Disabled
  // is the weaker look.
  readOnly: {
    backgroundColor: grasp.fieldFillRead,
    color: grasp.fieldInkRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}`,
      ":focus-visible": grasp.fieldFocus,
    },
  },
  disabled: {
    opacity: grasp.dim,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
    cursor: "not-allowed",
  },
  invalid: {
    boxShadow: {
      default: grasp.fieldInvalid,
      ":focus-visible": grasp.fieldFocusInvalid,
    },
    // In forced colours the danger tint is dropped: a wrong field's edge turns dashed instead, the
    // same 1px, so it is no bigger than the fields beside it.
    borderStyle: { default: "solid", [FORCED]: "dashed" },
  },
});

const rowStyles = [
  styles.rows1,
  styles.rows2,
  styles.rows3,
  styles.rows4,
  styles.rows5,
  styles.rows6,
] as const;

const isInvalid = (value: unknown) => value === true || value === "true";

export const Textarea = ({
  rows = 3,
  autoResize = true,
  style: styleProp,
  layout,
  ref,
  ...rest
}: TextareaProps) => {
  // In development, say so when nothing names it: no Field label, no aria-label.
  const own = useRef<HTMLTextAreaElement | null>(null);
  const attach = (element: HTMLTextAreaElement | null) => {
    own.current = element;
    if (typeof ref === "function") {
      ref(element);
    } else if (ref) {
      ref.current = element;
    }
  };
  useEffect(() => {
    const area = own.current;
    if (!(import.meta.env?.DEV && area)) {
      return;
    }
    const named =
      (area.labels?.length ?? 0) > 0 ||
      Boolean(area.getAttribute("aria-label")?.trim()) ||
      Boolean(area.getAttribute("aria-labelledby"));
    if (!named) {
      console.error(
        "Textarea: nothing names it. Put it in a Field with a FieldLabel, or give it an aria-label."
      );
    }
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
          {...stylex.props(
            styles.area,
            rowStyles[Math.min(Math.max(Math.round(rows), 1), 6) - 1],
            autoResize ? styles.grows : styles.drags,
            !(state.disabled || state.readOnly) && styles.live,
            state.readOnly && styles.readOnly,
            state.disabled && styles.disabled,
            isInvalid(props["aria-invalid"]) && styles.invalid,
            scroll.bar,
            focus.field,
            layout ?? styleProp
          )}
        />
      )}
    />
  );
};

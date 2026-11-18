// Input: one line of text, from shadcn's (registry/bases/base/ui/input.tsx, on Base UI), converted
// from Tailwind to StyleX and rebuilt on UI SDK's Input, then made Grasp's: the quiet button's fill,
// a hairline that can be found on every ground, one corner, and the heights of Button, so a field
// and a button stand level in one row.
//
//   <Field>
//     <FieldLabel>Work email</FieldLabel>
//     <Input type="email" autoComplete="email" required />
//   </Field>
//   <Input aria-label="Search projects" type="search" />       no visible label: aria-label names it
//   <Input type="password" />                                    an agent may fill it, never read it
//   <Input secret />                                             the same for any value, like a key
//
// Every value is a token (src/tokens). A caller may set layout and width only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Input as InputPrimitive, InputGroup } from "@ui-sdk/react/input";
import type { InputState } from "@ui-sdk/react/input";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, Ref } from "react";

import { focus } from "../focus/focus";
import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

export type InputSize = "sm" | "md" | "lg";

/** What a caller may style: where the input sits and how wide it is. Never its look or height. */
export type InputLayoutStyle = LayoutStyle;

type PrimitiveProps = ComponentProps<typeof InputPrimitive>;

/** Every prop an Input takes: these, and the rest of UI SDK's Input and an <input>. */
export interface InputProps extends Omit<
  PrimitiveProps,
  "className" | "style" | "render" | "size" | "children" | "width" | "height"
> {
  /**
   * The height, the same as Button's: `sm` 32px, `md` 36px, `lg` 44px. On a touch screen every
   * size has a 44px target and 16px words.
   * @default "md"
   */
  size?: InputSize;
  /**
   * What kind of text: `text`, `email`, `password`, `search`, `tel` or `url`. It brings the right
   * keyboard on a phone and the browser's own check. `time` is a time of day in the field's look:
   * typed or stepped with the arrow keys, a phone's own picker on a tap; its value is `HH:mm`.
   * @default "text"
   */
  type?: "text" | "email" | "password" | "search" | "tel" | "url" | "time";
  /**
   * Words a machine reads, in the system's mono face: a cron line, an id, a key. A step smaller,
   * on the same line, so the field keeps its height; 16px on a touch screen as every field is.
   * @default false
   */
  mono?: boolean;
  /**
   * The value it starts with. A form reset returns here. For a value you keep in state, pass
   * `value` and `onValueChange` instead.
   */
  defaultValue?: string;
  /** The value, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /**
   * Called with the new value and why it changed: typing (`input-change`), a form reset (`reset`),
   * or code and agents (`imperative`). `details.source` is `"agent"` when an agent changed it, and
   * `details.cancel()` keeps the value as it was.
   */
  onValueChange?: PrimitiveProps["onValueChange"];
  /**
   * An example of what goes in, never the label or an instruction ("name@company.com"). It goes
   * when typing starts, so what the field is for belongs in its label.
   */
  placeholder?: string;
  /**
   * Needs a value before the form is sent. Inside a Field, its label shows the required mark.
   * @default false
   */
  required?: boolean;
  /**
   * Can be read, selected and copied, and is sent with the form, but not changed. Drawn on a
   * quieter fill, with no hover, so it does not invite typing.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Out of use: not focusable, not sent, half strength. Say why near it. Prefer `readOnly` for a
   * value someone may still want to copy.
   * @default false
   */
  disabled?: boolean;
  /**
   * An agent may fill it in but never read it back: a key, a token, a tax number. Passwords are
   * secret without it.
   * @default false
   */
  secret?: boolean;
  /** An icon at the start, when it says what goes in faster than the label alone: Search. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** @deprecated Use `layout`. */
  style?: InputLayoutStyle;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the input. */
  layout?: InputLayoutStyle;
  /** The <input> itself, to focus it or read it. */
  ref?: Ref<HTMLInputElement>;
}

// ---- The look --------------------------------------------------------------------------------------

// Hover only where a pointer can hover, so a tap never leaves a field lit.
const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;
const CLIP_TEXT =
  "@supports (background-clip: text) and (not (-moz-appearance: none))";
const FADE_END = `linear-gradient(to right, currentColor calc(100% - ${grasp.space5}), transparent), linear-gradient(transparent, transparent)`;
const FADE_END_RTL = `linear-gradient(to left, currentColor calc(100% - ${grasp.space5}), transparent), linear-gradient(transparent, transparent)`;

export const inputStyles = stylex.create({
  // The box holds the input and its touch target. It is as wide as the column it stands in.
  box: {
    position: "relative",
    display: "flex",
    alignItems: "stretch",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    maxWidth: "100%",
  },
  // A finger needs 44px: on a touch screen an invisible area makes up the difference, under the
  // input. A press on it reaches the input through UI SDK's group.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: 0,
  },
  targetSm: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
  },
  targetMd: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlMd} - ${grasp.tap}) / 2)`,
    },
  },
  targetLg: { insetBlock: 0 },

  // An icon at the start: it stands over the input, in muted, and lets presses through to it.
  icon: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: 0,
    insetInlineStart: grasp.space3,
    display: "flex",
    alignItems: "center",
    color: grasp.muted,
    pointerEvents: "none",
  },
  iconLg: { insetInlineStart: grasp.space3 },
  // The words start after the icon and the gap beside it.
  iconStartSm: {
    paddingInlineStart: `calc(${grasp.space3} + ${grasp.iconSm} + ${grasp.space2})`,
  },
  iconStartLg: {
    paddingInlineStart: `calc(${grasp.space3} + ${grasp.iconSm} + ${grasp.space2})`,
  },

  input: {
    // Above its touch target, so a press on the words puts the caret where it lands.
    position: "relative",
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    appearance: "none",
    // No border: the edge is a hairline drawn inside, which adds no size. In forced colours the
    // shadow is dropped, so a real one appears there.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
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
    // A placeholder too long for the field ends in an ellipsis, never mid-word: Chromium reads the
    // input's own text-overflow for its placeholder, so it is set while the placeholder shows
    // (third look A3-text-04). A typed value fades instead (below).
    textOverflow: { default: "clip", ":placeholder-shown": "ellipsis" },
    paddingInline: grasp.space3,
    // A value longer than the field fades out at its end, as Tabs and Code block do, never a cut
    // through a letter. The words are painted through a gradient (clipped to the text) that ends in
    // transparent over the last space-5 of the content box; a short value never reaches it. While
    // the field has focus the words are plain ink, so the caret's end of the value always shows.
    // The second, empty layer keeps the field's fill on its whole box.
    // Input draws it only while the value is longer than the field (fits, below).
    WebkitTextFillColor: {
      default: null,
      [CLIP_TEXT]: {
        default: "transparent",
        ":focus": "currentColor",
        [FORCED]: "currentColor",
      },
    },
    // In forced colours the background is dropped, so the words keep their own colour there.
    backgroundImage: {
      default: null,
      [CLIP_TEXT]: { default: FADE_END, ":dir(rtl)": FADE_END_RTL },
    },
    backgroundOrigin: {
      default: null,
      [CLIP_TEXT]: "content-box, padding-box",
    },
    backgroundClip: { default: null, [CLIP_TEXT]: "text, padding-box" },
    // One tile: words past the content box (in the end padding) take no paint, so stay unseen.
    backgroundRepeat: { default: null, [CLIP_TEXT]: "no-repeat" },
    // Focus is the edge itself (field-focus, in live and invalid below) and focus.field (src/focus).
    transitionProperty: "box-shadow, background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
    // One look for clearing a field in the library: Input group's own clear button
    // (InputGroupClear). A search field here shows no cross of the browser's; Escape still
    // empties it where the browser does that.
    // display: none, not appearance: none: WebKit draws its own cross with appearance none too.
    "::-webkit-search-cancel-button": { display: "none" },
    // A time field in one look in every engine: Chromium's clock button goes (Firefox and Safari
    // draw none on a computer); its parts sit on the field's own line.
    "::-webkit-calendar-picker-indicator": { display: "none" },
    "::-webkit-datetime-edit": { padding: 0 },
    // Selected words in our own tone (field-selection), never the browser's blue.
    "::selection": { backgroundColor: grasp.fieldSelection, color: grasp.ink },
    "::placeholder": {
      color: grasp.muted,
      // Its own colour, not the transparent fill the value's fade sets on the input.
      WebkitTextFillColor: grasp.muted,
      opacity: 1,
      // A hint too long for the field ends in an ellipsis, never mid-word.
      textOverflow: "ellipsis",
    },
  },
  // A value that fits the field: no fade, every letter at full ink (third look A3-text-05). Input
  // adds it while its value fits (useRunsLong); parts that share these styles keep the fade on.
  fits: {
    WebkitTextFillColor: null,
    backgroundImage: null,
    backgroundOrigin: null,
    backgroundClip: null,
    backgroundRepeat: null,
  },

  // Sizes: the same heights, corners and side padding as Button's. The height comes from the line
  // plus padding, so larger text makes the field taller and never cuts it off.
  sm: {
    minHeight: grasp.controlSm,
    paddingBlock: `calc((${grasp.controlSm} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
  },
  md: {
    minHeight: grasp.controlMd,
    paddingBlock: `calc((${grasp.controlMd} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
  },
  lg: {
    minHeight: grasp.controlLg,
    paddingBlock: `calc((${grasp.controlLg} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`,
  },

  // Words a machine reads: the mono face a step smaller, on the same line.
  mono: {
    fontFamily: grasp.fontMono,
    fontSize: { default: grasp.textXs, [media.typing]: grasp.fieldTextTouch },
  },

  // Open for typing: the hairline deepens under a pointer.
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
  // Can be read and copied, not changed: settled. The soft ground (field-fill-read), a hairline and
  // no lift or hover, its words a step quieter (field-ink-read). Between rest and disabled: disabled
  // is the weaker look.
  readOnly: {
    backgroundColor: grasp.fieldFillRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}`,
      ":focus-visible": grasp.fieldFocus,
    },
    color: grasp.fieldInkRead,
  },
  disabled: {
    opacity: grasp.dim,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
    cursor: "not-allowed",
  },
  // Wrong: its hairline tinted red, drawn inside (field-invalid), under a pointer too, so it is as
  // big as the fields beside it. The message under it says what is wrong.
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

const styles = inputStyles;
export const sizeStyles = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
} as const;
export const targetStyles = {
  sm: styles.targetSm,
  md: styles.targetMd,
  lg: styles.targetLg,
} as const;
export const iconStartStyles = {
  sm: styles.iconStartSm,
  md: styles.iconStartSm,
  lg: styles.iconStartLg,
} as const;

export const isInvalid = (value: unknown) => value === true || value === "true";

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

/**
 * Watches an input for a value longer than it shows: on typing, on leaving it, and when it is
 * resized. Returns `setInput`, to call with the input element, and
 * whether the value runs long, so the end fade is drawn only then (third look A3-text-05).
 */
export const useRunsLong = () => {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [long, setLong] = useState(false);
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
  return { setInput, long };
};

export const Input = ({
  size = "md",
  type = "text",
  secret = false,
  mono = false,
  icon,
  style: styleProp,
  layout,
  ref,
  ...rest
}: InputProps) => {
  const { setInput, long } = useRunsLong();
  // In development, say so when nothing names the input: no Field label, no aria-label.
  const own = useRef<HTMLInputElement | null>(null);
  const attach = (element: HTMLInputElement | null) => {
    own.current = element;
    setInput(element);
    if (typeof ref === "function") {
      ref(element);
    } else if (ref) {
      ref.current = element;
    }
  };
  useEffect(() => {
    const input = own.current;
    if (!(import.meta.env?.DEV && input)) {
      return;
    }
    const named =
      (input.labels?.length ?? 0) > 0 ||
      Boolean(input.getAttribute("aria-label")?.trim()) ||
      Boolean(input.getAttribute("aria-labelledby"));
    if (!named) {
      console.error(
        "Input: nothing names it. Put it in a Field with a FieldLabel, or give it an aria-label."
      );
    }
  }, []);

  return (
    <InputGroup {...stylex.props(styles.box, layout ?? styleProp)}>
      <span
        aria-hidden="true"
        {...stylex.props(styles.target, targetStyles[size])}
      />
      {icon && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.icon, size === "lg" && styles.iconLg)}
        >
          <Icon icon={icon} />
        </span>
      )}
      <InputPrimitive
        {...rest}
        type={type}
        ref={attach}
        data-agent-secret={secret ? "" : undefined}
        // UI SDK's props (its ref among them) go on our own <input>, styled from its state.
        render={(props: Record<string, unknown>, state: InputState) => (
          <input
            {...props}
            {...stylex.props(
              styles.input,
              !long && styles.fits,
              sizeStyles[size],
              mono && styles.mono,
              icon && iconStartStyles[size],
              !(state.disabled || state.readOnly) && styles.live,
              state.readOnly && styles.readOnly,
              state.disabled && styles.disabled,
              isInvalid(props["aria-invalid"]) && styles.invalid,
              focus.field
            )}
          />
        )}
      />
    </InputGroup>
  );
};

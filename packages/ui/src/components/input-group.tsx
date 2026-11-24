// InputGroup: an input with words, an icon or a button inside its edge, in StyleX, built
// on UI SDK's InputGroup. The group draws an input's look (lib/styles' field box) round all its
// parts, so "https://", the words typed and a Copy button read as one field. A press on an addon's
// words or icon puts the caret in the input.
//
//   <InputGroup>
//     <InputGroupAddon><InputGroupText>https://</InputGroupText></InputGroupAddon>
//     <InputGroupInput aria-label="Website" placeholder="example.com" />
//   </InputGroup>
//   <InputGroup>
//     <InputGroupAddon><Icon icon={SearchIcon} /></InputGroupAddon>
//     <InputGroupInput type="search" aria-label="Search projects" />
//     <InputGroupClear aria-label="Clear search" />
//   </InputGroup>
//
// The input inside is UI SDK's Input, drawn here, so a Field round the group names it, describes
// it and says when it is wrong. A caller may set layout and width only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  InputClear as ClearPrimitive,
  InputGroup as GroupPrimitive,
  Input as InputPrimitive,
} from "@ui-sdk/react/input";
import { Textarea as TextareaPrimitive } from "@ui-sdk/react/textarea";
import { createContext, use } from "react";
import type { ComponentProps, ReactNode, Ref } from "react";

import { useRunsLong } from "../hooks/use-runs-long";
import { Icon, XIcon } from "../lib/icons";
import { focusField, focusRing, scrollbarHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { assignRef } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, ringInsetMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonProps, ButtonVariant } from "./button";

/** The group's height: the same as Input's and Button's. */
export type InputGroupSize = "sm" | "default" | "lg";

// The group's height, read by its parts so the words, the button and the clear square line up.
const SizeContext = createContext<InputGroupSize>("default");

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const TYPING = media.maxSmOrCoarse;

const edge = `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`;

// ---- InputGroup -----------------------------------------------------------------------------------

const groupStyles = stylex.create({
  group: {
    position: "relative",
    display: "flex",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    maxWidth: "100%",
    // An addon above or below the input (`block-start`, `block-end`): the parts stand in a column,
    // each the group's full width.
    flexDirection: {
      default: "row",
      ":has(> [data-align=block-start], > [data-align=block-end])": "column",
    },
    // A textarea, or an addon above or below: the group grows with what it holds.
    alignItems: {
      default: "center",
      ":has(> textarea, > [data-align=block-start], > [data-align=block-end])":
        "stretch",
    },
    // No border: the field's hairline drawn inside, which adds no size. In forced colours the shadow
    // is dropped, so a real one appears there; a wrong field's turns dashed, the same 1px, as the
    // destructive tint is dropped there.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: {
      default: "solid",
      [FORCED]: {
        default: "solid",
        ":has(:is(input, textarea)[aria-invalid=true])": "dashed",
      },
    },
    borderColor: "currentColor",
    cornerShape: radius.shape,
    backgroundColor: {
      default: colors.inputBg,
      ":has(:is(input, textarea):read-only:not(:disabled))": colors.inputBgRead,
    },
    // The group shows what its input is doing: the edge deepens under a pointer, takes the focus
    // edge while you type, and turns red when the input is wrong.
    boxShadow: {
      default: edge,
      // Only an input open for typing hovers, so a wrong one stays red under a pointer.
      ":hover:not(:has(:is(input, textarea):focus-visible, :is(input, textarea):read-only, :is(input, textarea)[aria-invalid=true]))":
        {
          default: null,
          [HOVER]: `inset 0 0 0 1px ${colors.inputBorderHover}, ${shadow.inputShadow}`,
        },
      ":has(:is(input, textarea):focus-visible)": sizes.inputFocus,
      ":has(:is(input, textarea)[aria-invalid=true])": sizes.inputInvalid,
      // Read only: settled, its hairline and no lift; focus from the keys darkens the hairline, no
      // halo (Input's readOnly).
      ":has(:is(input, textarea):read-only:not(:disabled))": `inset 0 0 0 1px ${colors.input}`,
      ":has(:is(input, textarea):read-only:not(:disabled):focus-visible:not([data-focus-pointer]))":
        sizes.inputFocusRead,
      ":has(:is(input, textarea)[aria-invalid=true]:focus-visible)":
        sizes.inputFocusInvalid,
      ":has(:is(input, textarea):disabled)": `inset 0 0 0 1px ${colors.input}`,
    },
    opacity: {
      default: 1,
      ":has(:is(input, textarea):disabled)": sizes.opacityDisabled,
    },
    cursor: {
      default: "text",
      ":has(:is(input, textarea):read-only:not(:disabled))": "default",
      ":has(:is(input, textarea):disabled)": "not-allowed",
    },
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: { default: font.textSm, [TYPING]: sizes.inputTextTouch },
    lineHeight: font.textSmLine,
    transitionProperty: "box-shadow, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  sm: {
    minHeight: sizes.controlSm,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlSm} / 2))`,
  },
  default: {
    minHeight: sizes.controlDefault,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlDefault} / 2))`,
  },
  lg: {
    minHeight: sizes.controlLg,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlLg} / 2))`,
  },
  // A finger needs 44px: on a touch screen an unseen area makes up the difference, as Input's. A
  // press on it reaches the input through UI SDK's group.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: 0,
  },
  targetSm: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${sizes.controlSm} - ${sizes.tapTarget}) / 2)`,
    },
  },
  targetDefault: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${sizes.controlDefault} - ${sizes.tapTarget}) / 2)`,
    },
  },
});

/** Every prop an InputGroup takes. */
export interface InputGroupProps {
  /**
   * The parts, in reading order: an InputGroupInput or InputGroupTextarea, with InputGroupAddons,
   * an InputGroupButton or an InputGroupClear before or after it.
   */
  children: ReactNode;
  /**
   * The height, the same as Input's and Button's: `sm` 32px (a settings row's field), `default`
   * 36px, `lg` 44px. On a touch screen every size has a 44px target and 16px words.
   * @default "default"
   */
  size?: InputGroupSize;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the group. */
  style?: LayoutStyle;
}

/** An input with words, an icon or a button inside the same edge. */
export const InputGroup = ({
  children,
  size = "default",
  style,
}: InputGroupProps) => (
  <SizeContext value={size}>
    <GroupPrimitive
      render={<div data-slot="input-group" />}
      {...stylex.props(
        stylex.defaultMarker(),
        ringInsetMarker,
        groupStyles.group,
        groupStyles[size],
        focusField.withinEditable,
        style
      )}
    >
      <span
        aria-hidden="true"
        {...stylex.props(
          groupStyles.target,
          size === "sm" && groupStyles.targetSm,
          size === "default" && groupStyles.targetDefault
        )}
      />
      {children}
    </GroupPrimitive>
  </SizeContext>
);

// ---- InputGroupAddon and InputGroupText -----------------------------------------------------------

// An addon that holds a button stands it on the group's edge by the button's own inset, not its
// padding.

const addonStyles = stylex.create({
  addon: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    // Above the group's touch area (an addon before the input comes first in `order`, under the
    // area otherwise), so a press on it lands here and UI SDK's group focuses the input from it.
    position: "relative",
    zIndex: 1,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space[2],
    color: colors.mutedForeground,
    whiteSpace: "nowrap",
    userSelect: "none",
    cursor: "text",
  },
  "inline-start": {
    order: -1,
    paddingInlineStart: {
      default: space[3],
      ":has(> [data-slot=input-group-button])": 0,
    },
  },
  "inline-end": {
    order: 1,
    paddingInlineEnd: {
      default: space[3],
      ":has(> [data-slot=input-group-button])": 0,
    },
  },
  // Above or below the input, across the group, its words at the start.
  "block-start": {
    order: -1,
    justifyContent: "space-between",
    paddingInline: space[3],
    paddingBlockStart: space[2],
  },
  "block-end": {
    order: 1,
    justifyContent: "space-between",
    paddingInline: space[3],
    paddingBlockEnd: space[2],
  },
  text: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
  },
});

/** Where an addon stands: before or after the input on its line, or above or below it. */
type InputGroupAddonAlign =
  | "inline-start"
  | "inline-end"
  | "block-start"
  | "block-end";

/** Every prop an InputGroupAddon takes. */
export interface InputGroupAddonProps {
  /** An icon, an InputGroupText, or an InputGroupButton. Shown, never sent with the form. */
  children: ReactNode;
  /**
   * Where it stands: `inline-start` before the input, `inline-end` after it, `block-start` above
   * it and `block-end` below it, across the group.
   * @default "inline-start"
   */
  align?: InputGroupAddonAlign;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Words, an icon or a button beside the input, inside the group's edge. A press on its words focuses the input. */
export const InputGroupAddon = ({
  children,
  align = "inline-start",
  style,
}: InputGroupAddonProps) => (
  <div
    data-slot="input-group-addon"
    data-align={align}
    {...stylex.props(addonStyles.addon, addonStyles[align], style)}
  >
    {children}
  </div>
);

/** Every prop an InputGroupText takes. */
export interface InputGroupTextProps {
  /** The words: a prefix ("https://"), a suffix (".com") or a unit ("GB"), with an icon if it helps. Short, never a label. */
  children: ReactNode;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Words in an InputGroupAddon: a prefix, a suffix or a unit. */
export const InputGroupText = ({ children, style }: InputGroupTextProps) => (
  <span data-slot="input-group-text" {...stylex.props(addonStyles.text, style)}>
    {children}
  </span>
);

// ---- InputGroupInput and InputGroupTextarea -------------------------------------------------------

// Where the words can be painted through a gradient, a long value fades at its end.
// Not in Firefox: it passes the test, but a form control's words are not clipped there, so the
// gradient filled the whole box and every value drew as a dark bar. There a long value is cut by the
// box's edge as it scrolls.
const CLIP_TEXT =
  "@supports (background-clip: text) and (not (-moz-appearance: none))";
const FADE_END = `linear-gradient(to right, currentColor calc(100% - ${space[5]}), transparent)`;
const FADE_END_RTL = `linear-gradient(to left, currentColor calc(100% - ${space[5]}), transparent)`;

const fieldStyles = stylex.create({
  // What the input and the textarea share: no edge or fill of their own, the group draws them.
  base: {
    // Above the group's touch area, so a press on the words puts the caret where it lands.
    position: "relative",
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    appearance: "none",
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    // The group shows focus round all its parts.
    outline: "none",
    // Read only: the words a step quieter, as Input's.
    color: {
      default: colors.foreground,
      ":read-only:not(:disabled)": colors.inputForegroundRead,
    },
    // Read only: no caret, nothing says type here (Input's readOnly).
    caretColor: { default: colors.foreground, ":read-only": "transparent" },
    font: "inherit",
    letterSpacing: "normal",
    textAlign: "start",
    cursor: {
      default: "text",
      ":read-only:not(:disabled)": "default",
      ":disabled": "not-allowed",
    },
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    "::placeholder": {
      color: colors.mutedForeground,
      WebkitTextFillColor: colors.mutedForeground,
      opacity: 1,
      // A hint too long for the field ends in an ellipsis, never mid-word.
      textOverflow: "ellipsis",
    },
    // Room at each end: the field's own padding at the group's edge, a small gap beside an addon.
    paddingInlineStart: {
      default: space[3],
      [stylex.when.ancestor(":has(> [data-align=inline-start])")]: space[2],
    },
    paddingInlineEnd: {
      default: space[3],
      [stylex.when.ancestor(
        ":has(> [data-align=inline-end], > [data-slot=input-group-button], > [data-slot=input-group-clear])"
      )]: space[2],
    },
  },
  input: {
    alignSelf: "stretch",
    paddingBlock: 0,
    // A placeholder too long ends in an ellipsis, never mid-word: Chromium reads the input's own
    // text-overflow for it, so it is set while the placeholder shows.
    textOverflow: { default: "clip", ":placeholder-shown": "ellipsis" },
    // A value longer than the input fades out at its end, as Input's does, never a cut through a
    // letter: the words are painted through a gradient that ends in transparent over the last
    // space-5. Plain ink while it has focus, so the caret's end always shows.
    WebkitTextFillColor: {
      default: null,
      [CLIP_TEXT]: {
        default: "transparent",
        ":focus": "currentColor",
        [FORCED]: "currentColor",
      },
    },
    // Drawn only while the value is longer than the input (fits, below). In forced colours the
    // background is dropped, so the words keep their own colour there.
    backgroundImage: {
      default: null,
      [CLIP_TEXT]: { default: FADE_END, ":dir(rtl)": FADE_END_RTL },
    },
    backgroundOrigin: { default: null, [CLIP_TEXT]: "content-box" },
    backgroundClip: { default: null, [CLIP_TEXT]: "text" },
    // One tile: words past the content box take no paint, so stay unseen.
    backgroundRepeat: { default: null, [CLIP_TEXT]: "no-repeat" },
    // The group's own clear square empties a search; the browser's cross would make two.
    // display: none, not appearance: none: WebKit draws its own cross with appearance none too.
    "::-webkit-search-cancel-button": { display: "none" },
  },
  // A value that fits: no fade, every letter at full ink.
  fits: {
    WebkitTextFillColor: null,
    backgroundImage: null,
    backgroundOrigin: null,
    backgroundClip: null,
    backgroundRepeat: null,
  },
  // Several lines, growing with its text up to textarea-height, then scrolling inside.
  textarea: {
    resize: "none",
    fieldSizing: "content",
    minHeight: `calc(3 * ${font.textSmLine} + 2 * ${space[2]})`,
    maxHeight: sizes.textareaHeight,
    paddingBlock: space[2],
    overflowY: "auto",
  },
});

type InputPrimitiveProps = ComponentProps<typeof InputPrimitive>;

/** Every prop an InputGroupInput takes: these, and the rest of UI SDK's Input and an <input>. */
export interface InputGroupInputProps extends Omit<
  InputPrimitiveProps,
  "className" | "style" | "render" | "size" | "children" | "width" | "height"
> {
  /**
   * What kind of text: `text`, `email`, `search`, `tel` or `url`. It brings the right keyboard on
   * a phone and the browser's own check. `password` masks it, for a key with a show button beside it.
   * @default "text"
   */
  type?: "text" | "email" | "search" | "tel" | "url" | "password";
  /** The value it starts with. A form reset returns here. */
  defaultValue?: string;
  /** The value, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /**
   * Called with the new value and why it changed. `details.source` is `"agent"` when an agent
   * changed it.
   */
  onValueChange?: InputPrimitiveProps["onValueChange"];
  /** An example of what goes in, never the label ("example.com"). */
  placeholder?: string;
  /** Needs a value before the form is sent. @default false */
  required?: boolean;
  /**
   * Can be read and copied, not changed. The group takes a quieter fill, with no caret or focus
   * ring; focus from the keys shows as its hairline a step stronger.
   * @default false
   */
  readOnly?: boolean;
  /** Out of use: the whole group is at half strength. @default false */
  disabled?: boolean;
  /** Its name when no FieldLabel names it ("Website"). The words beside it are not its name. */
  "aria-label"?: string;
  /** The <input> itself, to focus it or read it. */
  ref?: Ref<HTMLInputElement>;
}

/** The input inside an InputGroup. */
export const InputGroupInput = ({
  type = "text",
  ref,
  ...rest
}: InputGroupInputProps) => {
  // The end fade only while the value runs past the input.
  const { setInput, long } = useRunsLong();
  const attach = (element: HTMLInputElement | null) => {
    setInput(element);
    assignRef(ref, element);
  };
  return (
    <InputPrimitive
      {...rest}
      type={type}
      ref={attach}
      render={(props: Record<string, unknown>) => (
        <input
          {...props}
          data-slot="input-group-input"
          {...stylex.props(
            fieldStyles.base,
            fieldStyles.input,
            !long && fieldStyles.fits
          )}
        />
      )}
    />
  );
};

type TextareaPrimitiveProps = ComponentProps<typeof TextareaPrimitive>;

/** Every prop an InputGroupTextarea takes: these, and the rest of UI SDK's Textarea and a <textarea>. */
export interface InputGroupTextareaProps extends Omit<
  TextareaPrimitiveProps,
  "className" | "style" | "render" | "children"
> {
  /** The value it starts with. A form reset returns here. */
  defaultValue?: string;
  /** The value, when you keep it in state. Pair it with `onValueChange`. */
  value?: string;
  /** An example of what goes in, never the label. */
  placeholder?: string;
  /** Its name when no FieldLabel names it ("Message"). */
  "aria-label"?: string;
  /** The <textarea> itself, to focus it or read it. */
  ref?: Ref<HTMLTextAreaElement>;
}

/** Several lines inside an InputGroup, with an addon above or below it: a message and its Send. */
export const InputGroupTextarea = (props: InputGroupTextareaProps) => (
  <TextareaPrimitive
    {...props}
    render={(own: Record<string, unknown>) => (
      <textarea
        {...own}
        data-slot="input-group-textarea"
        {...stylex.props(
          fieldStyles.base,
          fieldStyles.textarea,
          scrollbarHidden
        )}
      />
    )}
  />
);

// ---- InputGroupButton -----------------------------------------------------------------------------

const buttonStyles = stylex.create({
  // The button's place in the group: it neither grows nor shrinks.
  slot: { position: "relative", display: "inline-flex", flexShrink: 0 },
  // Set in from the group's edge by the same room on every side.
  "sm-xs": {
    marginInline: `calc((${sizes.controlSm} - ${sizes.controlXs}) / 2)`,
  },
  "sm-sm": { marginInline: 0 },
  "default-xs": {
    marginInline: `calc((${sizes.controlDefault} - ${sizes.controlXs}) / 2)`,
  },
  "default-sm": {
    marginInline: `calc((${sizes.controlDefault} - ${sizes.controlSm}) / 2)`,
  },
  "lg-xs": {
    marginInline: `calc((${sizes.controlLg} - ${sizes.controlXs}) / 2)`,
  },
  "lg-sm": {
    marginInline: `calc((${sizes.controlLg} - ${sizes.controlSm}) / 2)`,
  },
});

/** The heights an InputGroupButton takes: a small button with words, or a small square for an icon. */
type InputGroupButtonSize = "xs" | "sm" | "icon-xs" | "icon-sm";

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The props an InputGroupButton reads first; the rest are a Button's. */
interface InputGroupButtonOwn {
  /**
   * The Button's weight: `ghost` inside a field, `default` for the one step the field is for (Send).
   * @default "ghost"
   */
  variant?: ButtonVariant;
  /**
   * Its height: `xs` or `sm` with words, `icon-xs` or `icon-sm` for an icon with an `aria-label`.
   * @default "sm", or "xs" in a small group; "icon-sm" ("icon-xs" in a small group) with `aria-label` and no words
   */
  size?: InputGroupButtonSize;
  /** The words, a verb first ("Send"), with an `<Icon />` if it helps; or the `<Icon />` alone with an `aria-label`. */
  children: ReactNode;
  /** The name of an icon-only button, for a screen reader and an agent ("Copy link"). */
  "aria-label"?: string;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Every prop an InputGroupButton takes: these, and a Button's others. */
export type InputGroupButtonProps = InputGroupButtonOwn &
  Without<
    ButtonProps,
    "size" | "style" | "variant" | "children" | "aria-label"
  >;

/** The button's height when the caller gives none: small, extra small in a small group. */
const sizeOf = (
  given: InputGroupButtonSize | undefined,
  group: InputGroupSize,
  iconOnly: boolean
): InputGroupButtonSize => {
  if (given !== undefined) {
    return given;
  }
  if (iconOnly) {
    return group === "sm" ? "icon-xs" : "icon-sm";
  }
  return group === "sm" ? "xs" : "sm";
};

/** The inset that sets a button of this height in from the group's edge. */
const insetOf = (group: InputGroupSize, height: "xs" | "sm") => {
  if (group === "sm") {
    return height === "xs" ? buttonStyles["sm-xs"] : buttonStyles["sm-sm"];
  }
  if (group === "lg") {
    return height === "xs" ? buttonStyles["lg-xs"] : buttonStyles["lg-sm"];
  }
  return height === "xs"
    ? buttonStyles["default-xs"]
    : buttonStyles["default-sm"];
};

/** The Button's props: the caller's, with the size the group gives it. */
const buttonPropsOf = (own: object) =>
  // SAFETY: the caller's own Button props, with the size the group gives it; an icon size comes
  // with the caller's `aria-label`, as an icon-only Button needs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  own as ButtonProps;

/** A button inside an InputGroup: Copy, Send, Search. A small Button, set in from the group's edge. */
export const InputGroupButton = ({
  variant = "ghost",
  size: given,
  style,
  children,
  ...rest
}: InputGroupButtonProps) => {
  const group = use(SizeContext);
  const iconOnly =
    rest["aria-label"] !== undefined && typeof children !== "string";
  const size = sizeOf(given, group, iconOnly);
  const props = buttonPropsOf({ ...rest, variant, size, children });
  const inset = insetOf(group, size.endsWith("xs") ? "xs" : "sm");
  // The wrapper names the slot and sets the button in from the group's edge; the button is Button.
  return (
    <span
      data-slot="input-group-button"
      {...stylex.props(buttonStyles.slot, inset, style)}
    >
      <Button {...props} />
    </span>
  );
};

// ---- InputGroupClear ------------------------------------------------------------------------------

const clearStyles = stylex.create({
  // A square in the group's end square, set in from its edge by space-1 on every side, so its focus
  // ring stands inside the group and never steps over its edge. Muted, ink under a pointer.
  clear: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    position: "relative",
    order: 1,
    flexShrink: 0,
    alignSelf: "stretch",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBlock: space[1],
    marginInline: space[1],
    padding: 0,
    borderWidth: 0,
    // Its corner nests inside the group's, space-1 in.
    borderRadius: `max(0px, calc(${radius.xl} - ${space[1]}))`,
    cornerShape: radius.shape,
    backgroundColor: "transparent",
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  sm: { width: `calc(${sizes.controlSm} - 2 * ${space[1]})` },
  default: { width: `calc(${sizes.controlDefault} - 2 * ${space[1]})` },
  lg: { width: `calc(${sizes.controlLg} - 2 * ${space[1]})` },
  // A finger needs 44px round it too; at rest the press covers the whole end square.
  target: {
    position: "absolute",
    inset: {
      default: `calc(-1 * ${space[1]})`,
      [COARSE]: `calc((100% - ${sizes.tapTarget}) / 2)`,
    },
  },
});

/** Every prop an InputGroupClear takes. */
export interface InputGroupClearProps {
  /** Its name, for a screen reader, a voice command and an agent: "Clear search". */
  "aria-label": string;
}

/** Empties the input in its group and puts the caret back; shown only while there is text. */
export const InputGroupClear = ({
  "aria-label": label,
}: InputGroupClearProps) => {
  const size = use(SizeContext);
  return (
    <ClearPrimitive
      aria-label={label}
      render={
        <button
          type="button"
          data-slot="input-group-clear"
          aria-label={label}
        />
      }
      {...stylex.props(
        clearStyles.clear,
        size === "sm" && clearStyles.sm,
        size === "default" && clearStyles.default,
        size === "lg" && clearStyles.lg,
        focusRing
      )}
    >
      <span aria-hidden="true" {...stylex.props(clearStyles.target)} />
      <Icon icon={XIcon} />
    </ClearPrimitive>
  );
};

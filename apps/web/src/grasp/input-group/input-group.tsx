// InputGroup: an input with words, an icon or a button inside its edge, from shadcn's
// (registry/bases/base/ui/input-group.tsx, on Base UI), converted from Tailwind to StyleX and
// rebuilt on UI SDK's InputGroup. The group draws Input's look (input.tsx) round all its parts, so
// "https://", the words typed and a Copy button read as one field. A press on its words focuses
// the input.
//
//   <InputGroup>
//     <InputGroupText>https://</InputGroupText>
//     <InputGroupInput aria-label="Website" placeholder="grasp.studio" />
//   </InputGroup>
//   <InputGroup>
//     <InputGroupText icon={Search} />
//     <InputGroupInput type="search" aria-label="Search projects" />
//     <InputGroupClear label="Clear search" />
//   </InputGroup>
//
// Every value is a token (src/tokens). A caller may set layout and width only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { InputGroup as GroupPrimitive } from "@ui-sdk/react/input";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { SizeContext } from "./context";
import type { InputGroupSize } from "./context";

/** What a caller may style: where the group sits and how wide it is. Never its look or height. */
export type InputGroupLayoutStyle = LayoutStyle;

/** Every prop an InputGroup takes. */
export interface InputGroupProps {
  /**
   * The parts, in reading order: an InputGroupInput, and InputGroupText, InputGroupButton or
   * InputGroupClear before or after it.
   */
  children: ReactNode;
  /**
   * The height, the same as Input's and Button's: `md` 36px, `lg` 44px. On a touch screen both
   * have a 44px target and 16px words.
   * @default "md"
   */
  size?: InputGroupSize;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the group. */
  style?: InputGroupLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: InputGroupLayoutStyle;
}

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;

const edge = `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`;

const styles = stylex.create({
  group: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    maxWidth: "100%",
    // No border: Input's hairline drawn inside, which adds no size. In forced colours the shadow
    // is dropped, so a real one appears there.
    // In forced colours a real edge; a wrong field's turns dashed, the same 1px, as the danger tint
    // is dropped there.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: {
      default: "solid",
      [FORCED]: {
        default: "solid",
        ":has(input[aria-invalid=true])": "dashed",
      },
    },
    borderColor: "currentColor",
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: grasp.fieldFill,
      ":has(input:read-only:not(:disabled))": grasp.fieldFillRead,
    },
    // The group shows what its input is doing: the edge deepens under a pointer, takes the focus
    // colour while you type, and turns red when the input is wrong.
    boxShadow: {
      default: edge,
      // Only an input open for typing hovers, so a wrong one stays red under a pointer.
      ":hover:not(:has(input:focus-visible, input:read-only, input[aria-invalid=true]))":
        {
          default: null,
          [HOVER]: `inset 0 0 0 1px ${grasp.fieldEdgeHover}, ${grasp.fieldLift}`,
        },
      ":has(input:focus-visible)": grasp.fieldFocus,
      ":has(input[aria-invalid=true])": grasp.fieldInvalid,
      // Read only: settled, its hairline and no lift.
      ":has(input:read-only:not(:disabled))": `inset 0 0 0 1px ${grasp.fieldEdge}`,
      ":has(input:read-only:not(:disabled):focus-visible)": grasp.fieldFocus,
      ":has(input[aria-invalid=true]:focus-visible)": grasp.fieldFocusInvalid,
      ":has(input:disabled)": `inset 0 0 0 1px ${grasp.fieldEdge}`,
    },
    opacity: { default: 1, ":has(input:disabled)": grasp.dim },
    cursor: { default: "text", ":has(input:disabled)": "not-allowed" },
    // Focus, the ring for the keyboard and a real outline in forced colours: focus.fieldWithin.
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    transitionProperty: "box-shadow, background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  md: {
    minHeight: grasp.controlMd,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
  },
  // A finger needs 44px: on a touch screen an unseen area makes up the difference, as Input's. A
  // press on it reaches the input through UI SDK's group.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: 0,
  },
  targetMd: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlMd} - ${grasp.tap}) / 2)`,
    },
  },
  lg: {
    minHeight: grasp.controlLg,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`,
  },
});

/** An input with words, an icon or a button inside the same edge. */
export const InputGroup = ({
  children,
  size = "md",
  style: styleProp,
  layout,
}: InputGroupProps) => (
  <SizeContext.Provider value={size}>
    <GroupPrimitive
      {...stylex.props(
        styles.group,
        styles[size],
        focus.fieldWithin,
        layout ?? styleProp
      )}
    >
      <span
        aria-hidden="true"
        data-input-group-target=""
        {...stylex.props(styles.target, size === "md" && styles.targetMd)}
      />
      {children}
    </GroupPrimitive>
  </SizeContext.Provider>
);

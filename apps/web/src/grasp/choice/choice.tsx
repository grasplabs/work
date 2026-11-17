// The choice row: what Checkbox, Radio and Switch share. A control and its words on one row, at
// least 44px tall, that a press on the control, its label or the space around them works: a
// reach inside the button, behind the words, makes the button's own hit area the whole row. Each
// component draws its own control; this draws the row, the words and their wiring.
//
//   <ChoiceRow box={id} label="Weekly summary" description="Every Monday." grouped={inGroup}>
//     {(wiring) => <CheckboxPrimitive id={id} {...wiring}>…</CheckboxPrimitive>}
//   </ChoiceRow>
//
// Alone, the row is its own field (UI SDK's Field), which ties its label, description and error
// to the control and takes the control's validity. In a group it is not: the group's field takes
// the validity of every control in it, so its error shows, and the row wires its label and
// description by id. A row inside a field another row's field holds would hide that validity.
//
// Also here, for Checkbox and Radio: the box's looks (`boxStyles`), the same for a square and a
// circle, so the two stand in one column and answer a pointer and a press alike.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Field as FieldPrimitive,
  FieldLabel as FieldLabelPrimitive,
} from "@ui-sdk/react/field";
import { Label as LabelPrimitive } from "@ui-sdk/react/label";
import type { ReactNode } from "react";

import { FieldDescription, FieldError } from "../field";
import type { FieldErrorWords } from "../field";
import { noteStyles } from "../field/field";
import { fieldMarker } from "../field/field.stylex";
import { RequiredMark, labelStyles } from "../label/label";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { choiceMarker, choiceVars } from "./choice.stylex";

// Hover only where a pointer can hover, so a tap never leaves a control lit.
const HOVER = media.hover;
const REDUCED = media.reduced;
const FORCED = media.forced;

const rowStyles = stylex.create({
  row: {
    position: "relative",
    isolation: "isolate",
    display: "grid",
    alignItems: "start",
    minWidth: 0,
    margin: 0,
    paddingBlock: `calc((${grasp.tap} - ${grasp.textSmLine}) / 2)`,
  },
  // The control first, then its words: a checkbox, a radio.
  start: {
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space3,
  },
  // The words first, then the control at the end: a switch, as in a list of settings.
  end: {
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: grasp.space4,
  },
  words: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: grasp.space1,
    minWidth: 0,
  },
});

/** The reach: inside the button, behind the row's words, so a press anywhere on the row lands on it. */
export const reachStyles = stylex.create({
  reach: {
    position: "absolute",
    zIndex: -1,
    inset: 0,
  },
});

/** The wiring a row hands its control: its name, and its description when it has one. */
export interface ChoiceWiring {
  "aria-labelledby": string;
  "aria-describedby"?: string;
  /** In a group, where no field of its own says it: the control is wrong. */
  "aria-invalid"?: true;
}

export interface ChoiceRowProps {
  /** The control's id. */
  box: string;
  label: ReactNode;
  description?: ReactNode;
  /** The error under the words, alone or in a group. */
  error?: FieldErrorWords;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  /** In a group, whose field holds the validity. */
  grouped?: boolean;
  /** The control at the end of the row, after its words (a switch). */
  end?: boolean;
  /** Layout from the caller, and a component's own (a nested checkbox's indent). */
  // Typed loosely: each component's own layout style type narrows what a caller may pass.
  style?: readonly unknown[];
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: readonly unknown[];
  /** The control, given its wiring. */
  children: (wiring: ChoiceWiring) => ReactNode;
}

interface GroupedRowProps extends Pick<
  ChoiceRowProps,
  | "box"
  | "label"
  | "description"
  | "error"
  | "invalid"
  | "disabled"
  | "children"
> {
  end: boolean;
  mark: ReactNode;
  row: ReturnType<typeof stylex.props>;
}

/**
 * A row in a group. The group's field holds the group's validity; this row wires its words by id,
 * and says its own error under them, tied to its control, as its own field would. `data-disabled`
 * dims the words as a field would.
 */
const GroupedRow = ({
  box,
  label,
  description,
  error,
  invalid,
  disabled,
  end,
  mark,
  row,
  children,
}: GroupedRowProps) => {
  const name = `${box}-label`;
  const said = `${box}-description`;
  const wrong = `${box}-error`;
  const off = disabled === true ? true : undefined;
  const says = error !== undefined && error !== null && error !== "";
  const describedBy = [description !== undefined && said, says && wrong]
    .filter(Boolean)
    .join(" ");
  const control = children({
    "aria-labelledby": name,
    ...(describedBy !== "" && { "aria-describedby": describedBy }),
    ...(invalid === true && { "aria-invalid": true }),
  });
  return (
    <div {...row}>
      {!end && control}
      <div {...stylex.props(rowStyles.words)}>
        <LabelPrimitive
          id={name}
          htmlFor={box}
          data-disabled={off}
          {...stylex.props(labelStyles.label)}
        >
          {label}
          {mark}
        </LabelPrimitive>
        {description !== undefined && (
          <p
            id={said}
            data-disabled={off}
            {...stylex.props(noteStyles.note, noteStyles.description)}
          >
            {description}
          </p>
        )}
        {says && (
          <p id={wrong} {...stylex.props(noteStyles.note, noteStyles.error)}>
            {error}
          </p>
        )}
      </div>
      {end && control}
    </div>
  );
};

export const ChoiceRow = ({
  box,
  label,
  description,
  error,
  required = false,
  invalid,
  disabled,
  grouped = false,
  end = false,
  style,
  layout,
  children,
}: ChoiceRowProps) => {
  const name = `${box}-label`;
  const row = stylex.props(
    choiceMarker,
    rowStyles.row,
    end ? rowStyles.end : rowStyles.start,
    // SAFETY: each component types its own layout styles (SwitchLayoutStyle and the like), all
    // StyleX styles; they are typed loosely here only because their shapes differ.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    ...((layout ?? style ?? []) as never[])
  );
  const mark = required && <RequiredMark />;

  if (grouped) {
    return (
      <GroupedRow
        box={box}
        label={label}
        description={description}
        error={error}
        invalid={invalid}
        disabled={disabled}
        end={end}
        mark={mark}
        row={row}
      >
        {children}
      </GroupedRow>
    );
  }

  const control = children({ "aria-labelledby": name });
  return (
    <FieldPrimitive invalid={invalid} disabled={disabled} {...row}>
      {!end && control}
      <div {...stylex.props(rowStyles.words)}>
        <FieldLabelPrimitive
          id={name}
          htmlFor={box}
          {...stylex.props(labelStyles.label)}
        >
          {label}
          {mark}
        </FieldLabelPrimitive>
        {description !== undefined && (
          <FieldDescription>{description}</FieldDescription>
        )}
        {/* Only when there is something to say: an empty error would still take its gap. */}
        {error !== undefined && error !== null && error !== "" && (
          <FieldError>{error}</FieldError>
        )}
      </div>
      {end && control}
    </FieldPrimitive>
  );
};

// ---- The box of a checkbox or a radio ----------------------------------------------------------------

// Wrong, by its own field (aria-invalid) or by the group's field around it (data-invalid, read
// through stylex.when.ancestor, which must be written inline: the compiler cannot read a constant).
const WRONG = ":is([aria-invalid=true])";

export const boxStyles = stylex.create({
  // The button: on the first line of the words. It holds the focus ring; the face inside it draws
  // the box, so a press can scale the box while the ring and the reach stay. Its size and corner
  // are the component's own.
  control: {
    [choiceVars.edge]: {
      default: grasp.choiceEdge,
      [WRONG]: grasp.choiceEdgeInvalid,
      [stylex.when.ancestor(":is([data-invalid])", fieldMarker)]:
        grasp.choiceEdgeInvalid,
    },
    [choiceVars.wrong]: {
      default: "transparent",
      [WRONG]: grasp.choiceEdgeInvalid,
      [stylex.when.ancestor(":is([data-invalid])", fieldMarker)]:
        grasp.choiceEdgeInvalid,
    },
    appearance: "none",
    display: "grid",
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: grasp.actionText,
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    cursor: "pointer",
  },
  // Under a pointer anywhere on the row, an empty box's edge one step stronger; never when it is
  // wrong, so the danger stays.
  controlLive: {
    [choiceVars.edge]: {
      default: grasp.choiceEdge,
      [stylex.when.ancestor(":hover", choiceMarker)]: {
        default: null,
        [HOVER]: {
          default: grasp.choiceEdgeHover,
          [WRONG]: grasp.choiceEdgeInvalid,
        },
      },
      [WRONG]: grasp.choiceEdgeInvalid,
      [stylex.when.ancestor(":is([data-invalid])", fieldMarker)]:
        grasp.choiceEdgeInvalid,
    },
  },
  disabled: {
    opacity: grasp.dim,
    cursor: "not-allowed",
  },
  readOnly: {
    cursor: "default",
  },
  face: {
    display: "grid",
    placeItems: "center",
    boxSizing: "border-box",
    // No border: the edge is a ring drawn inside, which adds no size. In forced colours shadows
    // are dropped, so a real one appears there, doubled when it is wrong.
    borderWidth: {
      default: 0,
      [FORCED]: {
        default: 1,
        [stylex.when.ancestor(":is([data-invalid])", fieldMarker)]: 2,
      },
    },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: "inherit",
    cornerShape: "inherit",
    transitionProperty: "transform, background-color, box-shadow",
    // With reduced motion the press still shows, at once, without travelling.
    transitionDuration: `${simply.press}, ${grasp.durationHover}, ${grasp.durationHover}`,
    transitionTimingFunction: grasp.ease,
  },
  // Empty: no fill, a soft hairline drawn inside (choice-edge), as Palermo's: it reads by its shape.
  empty: {
    backgroundColor: "transparent",
    boxShadow: `inset 0 0 0 ${grasp.checkboxEdgeWidth} ${choiceVars.edge}`,
  },
  // Under a pointer anywhere on the row, a faint fill; pressed, one step deeper.
  emptyLive: {
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":hover", choiceMarker)]: {
        default: null,
        [HOVER]: grasp.ghostFillHover,
      },
      [stylex.when.ancestor(":active", choiceMarker)]: grasp.ghostFillPress,
    },
  },
  // Checked or chosen: the action's fill, with the mark in its words' colour. Never mint: mint is
  // for approving.
  full: {
    backgroundColor: grasp.actionFill,
    boxShadow: `0 0 0 ${grasp.checkboxEdgeWidth} ${choiceVars.wrong}`,
  },
  fullLive: {
    backgroundColor: {
      default: grasp.actionFill,
      [stylex.when.ancestor(":hover", choiceMarker)]: {
        default: null,
        [HOVER]: grasp.checkboxFillHover,
      },
      [stylex.when.ancestor(":active", choiceMarker)]: grasp.actionFillPress,
    },
  },
  // A press anywhere on the row presses the box.
  pressable: {
    transform: {
      default: null,
      [stylex.when.ancestor(":active", choiceMarker)]:
        `scale(${grasp.pressScale})`,
    },
  },
  // The tick, the dash or the dot. It grows in and fades in; it leaves faster than it came.
  mark: {
    opacity: {
      default: 1,
      ":is([data-starting-style], [data-ending-style])": 0,
    },
    transform: {
      default: "none",
      ":is([data-starting-style], [data-ending-style])": {
        default: `scale(${grasp.checkboxMarkFrom})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: simply.mark,
      ":is([data-ending-style])": simply.hover,
    },
    transitionTimingFunction: grasp.ease,
  },
});

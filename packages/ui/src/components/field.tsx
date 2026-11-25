// Field: a control with its label, its description and the error it shows,
// in StyleX, built on UI SDK's Field,
// which wires the label's `for`, `aria-labelledby`, `aria-describedby` and `aria-invalid` itself:
// a control of ours inside a Field needs no ids and no spread.
//
//   <Field name="email">
//     <FieldLabel>Work email</FieldLabel>
//     <Input type="email" autoComplete="email" required />
//     <FieldDescription>We send the invite here.</FieldDescription>
//     <FieldError match="valueMissing">Enter your work email.</FieldError>
//   </Field>
//
// Three ways to stand. `vertical`: label, control, description and error one under the other.
// `horizontal`: a checkbox or a radio first and its words (a FieldContent) after it, or the words
// first and a switch at the end, on one row at least 44px tall. `responsive`: a setting, its words
// at the start and its control on an end edge every row in its FieldGroup shares, the control going
// under the words when the row is narrower than 34rem; a FieldStatus beside it says where a save
// on change is.
//
//   <FieldSet>
//     <FieldLegend variant="label">Organization</FieldLegend>
//     <FieldGroup>
//       <Field orientation="responsive">
//         <FieldContent>
//           <FieldLabel>Time zone</FieldLabel>
//           <FieldDescription>For schedules and the times shown.</FieldDescription>
//         </FieldContent>
//         <Select …/>
//         <FieldStatus status={status} onRetry={save} />
//       </Field>
//     </FieldGroup>
//   </FieldSet>
//
// Inside a CheckboxGroup or a RadioGroup, each choice is a horizontal Field of its own, a row wired
// to its control by id, so the group's Field keeps the group's validity and error. Anywhere else a
// horizontal Field is a field of its own, inside another Field too.
//
// The label shows the required mark when its control is `required`. An error shows after a submit
// finds the control wrong, or at once with `data-invalid` on the Field (an error from the server).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Field as FieldPrimitive,
  FieldDescription as FieldDescriptionPrimitive,
  FieldError as FieldErrorPrimitive,
  FieldGroup as FieldGroupPrimitive,
  FieldLabel as FieldLabelPrimitive,
  FieldLegend as FieldLegendPrimitive,
  FieldSet as FieldSetPrimitive,
  useFieldControl as useFieldControlPrimitive,
} from "@ui-sdk/react/field";
import { Label as LabelPrimitive } from "@ui-sdk/react/label";
import { createContext, use, useContext, useId } from "react";
import type { ComponentProps, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { CheckIcon, Icon } from "../lib/icons";
import { hyphenate, visuallyHidden } from "../lib/styles";
import { colors, duration, font, size, space } from "../lib/tokens.stylex";
import { ChoiceGroupContext, isBlank, isInvalid } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { fieldControlMarker, motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import { fieldVars } from "./field.stylex";
import { Spinner } from "./spinner";

// A row narrower than this puts its control under its words (the row's own width).
const NARROW = "@container field (width < 34rem)";
// A horizontal row that holds a switch: the words first, the switch at the end.
const SWITCH = ":has(> [role=switch], > * > [role=switch])";
// A row inside a RadioGroup or a CheckboxGroup while its group is out of use.
const GROUP_OFF =
  ":is([data-slot=radio-group][data-disabled] *, [data-slot=checkbox-group][data-disabled] *)";

// ---- Grouped rows -------------------------------------------------------------------------------
//
// A horizontal Field inside a CheckboxGroup or a RadioGroup (which say so through
// ChoiceGroupContext) is a row of the group, whose Field round the group holds the group's
// validity and shows its error. UI SDK gives a field the controls
// whose nearest field it is, so a row that were a field of its own would take its control's
// validity from the group's (a required RadioGroup would never show its error). The row is a plain
// row instead: it hands its control and its words one id, by which they wire each other, and
// useFieldControl hands the control that wiring.

/** The id a grouped row hands its control and its words. Unset outside such a row. */
const FieldControlIdContext = createContext<string | undefined>(undefined);
/** A grouped row out of use: its words dim, its control is disabled. */
const FieldDisabledContext = createContext(false);
/** A grouped row shown as wrong: its control says `aria-invalid`. */
const FieldInvalidContext = createContext(false);

/** The ids a grouped row's words take, from the row's one id. */
const getFieldIds = (id: string) => ({
  label: `${id}-label`,
  description: `${id}-description`,
  error: `${id}-error`,
});

// ---- Field --------------------------------------------------------------------------------------

const styles = stylex.create({
  field: {
    minWidth: 0,
    margin: 0,
  },
  // Label, control, description and error, one under the other, 8px apart.
  vertical: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    rowGap: space[2],
  },
  // A control and its words on one row, at least 44px tall: the control first, or, holding a
  // switch, the words first and the switch at the end. Read from the page itself (:has), so it is
  // there before any script runs.
  horizontal: {
    position: "relative",
    isolation: "isolate",
    display: "grid",
    alignItems: "start",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr)",
      [SWITCH]: "minmax(0, 1fr) auto",
    },
    columnGap: { default: space[3], [SWITCH]: space[4] },
    paddingBlock: `calc((${size.tapTarget} - ${font.textSmLine}) / 2)`,
  },
  // A setting: its own width is what its narrow form measures. A hairline over every row but the
  // first, so the rows of one group stand apart; inside it, field-row tall at least and the table's
  // inset at the sides.
  responsive: {
    containerType: "inline-size",
    containerName: "field",
    boxSizing: "border-box",
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    borderTopWidth: { default: size.hairline, ":first-child": 0 },
    fontFamily: font.sans,
  },
  // Inside a responsive Field: the words, and the control on the shared end edge. A narrow `fit`
  // row is a wrapping line: the control beside the words while the name keeps its floor, under them
  // once it would not.
  row: {
    position: "relative",
    boxSizing: "border-box",
    minHeight: space.fieldRow,
    paddingBlock: space[2],
    paddingInline: space.tableCellInline,
    display: { default: "grid", [NARROW]: fieldVars.displayNarrow },
    flexWrap: "wrap",
    gridTemplateColumns: {
      default: fieldVars.columns,
      [NARROW]: fieldVars.columnsNarrow,
    },
    alignItems: "center",
    justifyItems: "end",
    columnGap: space[6],
    rowGap: space[2],
  },
});

/** How a Field's parts stand: one under the other, a control and its words on one row, or a setting. */
export type FieldOrientation = "vertical" | "horizontal" | "responsive";

/** Every prop a Field takes: these, and the rest of UI SDK's Field and a <div>. */
export interface FieldProps extends Omit<
  ComponentProps<typeof FieldPrimitive>,
  "className" | "style" | "render" | "invalid"
> {
  /** The label, the control, its description and its error, in that order. */
  children: ReactNode;
  /** The name the control is sent under in a form, when the control has no `name` of its own. */
  name?: string;
  /**
   * Out of use: the control, its label and its description, at half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Shows the field as wrong now, for an error your code decides (the server said no):
   * its control says `aria-invalid` with it. Leave it out and the field shows the browser's
   * own check after a submit.
   */
  "data-invalid"?: boolean;
  /**
   * How its parts stand. `vertical`: label, control, description and error, one under the other.
   * `horizontal`: a Checkbox or a Radio first, then its words (a FieldContent), on one row at least
   * 44px tall; or the words first and a Switch at the end. Inside a CheckboxGroup or a
   * RadioGroup, a horizontal Field is a row of the group, its words wired to its control by id,
   * and the group's Field keeps the group's validity. `responsive`: a setting in a FieldGroup,
   * its words (a FieldContent) at the start and its control on the group's shared end edge, under
   * the words when the row is narrower than 34rem.
   * @default "vertical"
   */
  orientation?: FieldOrientation;
  /** Layout only: margins, alignment and width. The look belongs to the field. */
  style?: LayoutStyle;
}

/** A row of a CheckboxGroup or a RadioGroup: a plain row, its control and its words wired by id. */
const GroupedRow = ({
  disabled = false,
  invalid = false,
  style,
  children,
}: Pick<FieldProps, "disabled" | "style" | "children"> & {
  invalid?: boolean;
}) => {
  const id = `field${useId()}`;
  return (
    <FieldControlIdContext value={id}>
      <FieldDisabledContext value={disabled}>
        <FieldInvalidContext value={invalid}>
          <div
            data-orientation="horizontal"
            data-disabled={disabled || undefined}
            data-invalid={invalid || undefined}
            {...stylex.props(
              fieldControlMarker,
              styles.field,
              styles.horizontal,
              style
            )}
          >
            {children}
          </div>
        </FieldInvalidContext>
      </FieldDisabledContext>
    </FieldControlIdContext>
  );
};

export const Field = ({
  orientation = "vertical",
  "data-invalid": invalid,
  style,
  children,
  ...rest
}: FieldProps) => {
  const grouped = use(ChoiceGroupContext) !== null;
  if (orientation === "horizontal" && grouped) {
    return (
      <GroupedRow disabled={rest.disabled} invalid={invalid} style={style}>
        {children}
      </GroupedRow>
    );
  }
  return (
    <FieldPrimitive
      {...rest}
      invalid={invalid}
      data-orientation={orientation}
      {...stylex.props(
        fieldControlMarker,
        styles.field,
        orientation === "vertical" && styles.vertical,
        orientation === "horizontal" && styles.horizontal,
        orientation === "responsive" && styles.responsive,
        style
      )}
    >
      {orientation === "responsive" ? (
        <div {...stylex.props(styles.row)}>{children}</div>
      ) : (
        children
      )}
    </FieldPrimitive>
  );
};

// ---- FieldContent -------------------------------------------------------------------------------

const contentStyles = stylex.create({
  content: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: {
      default: space[1],
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: 0,
    },
    minWidth: 0,
    // In a setting the words stand at the top of the row, in a band one small control tall where
    // the name sits centred: level with a control of one line, and at the top beside a taller one.
    // In a narrow fit row (a wrapping line) they keep a floor of 8rem.
    justifySelf: "stretch",
    alignSelf: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: "start",
    },
    alignContent: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: "center",
    },
    minHeight: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: size.controlSm,
    },
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: "8rem",
    // Placed, so a FieldStatus's failure can stand in the help's place over it.
    gridRow: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: "1",
    },
    gridColumn: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: "1",
    },
  },
});

/** Every prop a FieldContent takes. */
export interface FieldContentProps {
  /** The words beside a control in a horizontal or responsive Field: its FieldLabel, FieldDescription and FieldError. */
  children: ReactNode;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** The words beside a control in a horizontal or responsive Field, one under the other. */
export const FieldContent = ({ children, style }: FieldContentProps) => (
  <div
    data-slot="field-content"
    {...stylex.props(contentStyles.content, style)}
  >
    {children}
  </div>
);

// ---- FieldLabel and FieldTitle ------------------------------------------------------------------

// The label's look, the same as Label's (label.tsx keeps its own private): lib/styles has no shared
// label style yet.
const labelStyles = stylex.create({
  label: {
    display: "block",
    minWidth: 0,
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    // A long name breaks inside the word, hyphenated where its language allows. Never cut off.
    overflowWrap: "anywhere",
    cursor: "default",
    // A field out of use takes its label with it, and a radio or checkbox group out of use the
    // labels of its rows.
    opacity: {
      default: 1,
      ":is([data-disabled])": size.opacityDisabled,
      [GROUP_OFF]: size.opacityDisabled,
    },
  },
  // The required mark shows when the field holds a required control. Read from the page itself
  // (:has), so it is there before any script runs and with none. For the eye only: never in the
  // label's text or the name it gives its control; the control's own `required` says it.
  mark: {
    "::after": {
      content: {
        default: "none",
        [stylex.when.ancestor(":has(:required)", fieldControlMarker)]:
          '"*" / ""',
      },
      marginInlineStart: space[1],
      fontWeight: font.weightNormal,
      color: colors.mutedForeground,
    },
  },
});

/** Every prop a FieldLabel takes. */
export interface FieldLabelProps extends Omit<
  ComponentProps<typeof FieldLabelPrimitive>,
  "className" | "style" | "children" | "render"
> {
  /** The words: what goes in the control, in sentence case ("Work email"). Never a question. */
  children: ReactNode;
  /** Where it sits: margins and alignment. Type and colour belong to the label. */
  style?: LayoutStyle;
}

/** The field's label. It names the control, and shows the required mark when it is `required`. */
export const FieldLabel = ({ children, style, ...rest }: FieldLabelProps) => {
  const row = useContext(FieldControlIdContext);
  const off = useContext(FieldDisabledContext);
  // In a grouped row: a plain label, named by id. The group is what is required: no mark.
  if (row !== undefined) {
    return (
      <LabelPrimitive
        id={getFieldIds(row).label}
        htmlFor={rest.htmlFor ?? row}
        data-disabled={off || undefined}
        {...stylex.props(labelStyles.label, hyphenate, style)}
      >
        {children}
      </LabelPrimitive>
    );
  }
  return (
    <FieldLabelPrimitive
      {...rest}
      {...stylex.props(labelStyles.label, hyphenate, labelStyles.mark, style)}
    >
      {children}
    </FieldLabelPrimitive>
  );
};

/** Every prop a FieldTitle takes. */
export interface FieldTitleProps {
  /** The words: what the field is about, in sentence case ("Data location"). */
  children: ReactNode;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/**
 * A field's name in the label's look, when it names no control: a fact in a setting's columns, or
 * the title over a choice drawn as a card.
 */
export const FieldTitle = ({ children, style }: FieldTitleProps) => (
  <div
    data-slot="field-title"
    {...stylex.props(labelStyles.label, hyphenate, style)}
  >
    {children}
  </div>
);

// ---- FieldDescription and FieldError ------------------------------------------------------------

const noteStyles = stylex.create({
  // A sentence under the control: what it is for, or what goes in it. In a setting, the help line
  // under the name, at the name's size.
  note: {
    margin: 0,
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: {
      default: font.textXs,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: font.textSm,
    },
    lineHeight: {
      default: font.textXsLine,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: font.textSmLine,
    },
    fontWeight: font.weightNormal,
    // A word too long for its line still breaks.
    overflowWrap: "anywhere",
    // No word left alone on a last line.
    textWrap: "pretty",
    justifySelf: "stretch",
  },
  description: {
    color: colors.mutedForeground,
    opacity: {
      default: 1,
      ":is([data-disabled])": size.opacityDisabled,
      [GROUP_OFF]: size.opacityDisabled,
    },
    // A setting whose save failed: the failure takes the help's place (FieldStatus).
    visibility: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive]):has([data-status=error])",
        fieldControlMarker
      )]: "hidden",
    },
  },
  // What is wrong, in words, in the destructive colour. The control's hairline turns with it. In a
  // setting it runs across the row, under the words and the control.
  error: {
    color: colors.destructive,
    gridColumn: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: "1 / -1",
    },
    order: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: 1,
    },
  },
  list: {
    margin: 0,
    paddingInlineStart: space[4],
  },
});

/** Every prop a FieldDescription takes. */
export interface FieldDescriptionProps extends Omit<
  ComponentProps<typeof FieldDescriptionPrimitive>,
  "className" | "style" | "children" | "render"
> {
  /** One sentence: what the field is for. A screen reader says it after the control's name. */
  children: ReactNode;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/**
 * A sentence under the control. A screen reader says it after the control's name; right inside a
 * FieldSet, it describes the set, said as focus enters it.
 */
export const FieldDescription = ({
  children,
  style,
  ...rest
}: FieldDescriptionProps) => {
  const row = useContext(FieldControlIdContext);
  const off = useContext(FieldDisabledContext);
  // In a grouped row: a plain sentence its control names by id.
  if (row !== undefined) {
    return (
      <p
        id={getFieldIds(row).description}
        data-slot="field-description"
        data-disabled={off || undefined}
        {...stylex.props(
          noteStyles.note,
          hyphenate,
          noteStyles.description,
          style
        )}
      >
        {children}
      </p>
    );
  }
  return (
    <FieldDescriptionPrimitive
      {...rest}
      {...stylex.props(
        noteStyles.note,
        hyphenate,
        noteStyles.description,
        style
      )}
    >
      {children}
    </FieldDescriptionPrimitive>
  );
};

/** Every prop a FieldError takes. */
export interface FieldErrorProps extends Omit<
  ComponentProps<typeof FieldErrorPrimitive>,
  "className" | "style" | "children" | "render"
> {
  /**
   * What is wrong and how to put it right ("Enter your work email"). Always your own words: the
   * browser's own message never shows.
   */
  children?: ReactNode;
  /**
   * The errors a form library reports, each with its message: shown at once, one as a sentence,
   * several as a list. Give the Field `data-invalid` with them. `children` wins when both are given.
   */
  errors?: readonly ({ message?: string } | undefined)[];
  /**
   * When it shows: `"valueMissing"`, `"typeMismatch"` or another of the browser's checks for that
   * problem only, `true` always (an error from your code, with `data-invalid` on the Field). Without it,
   * any problem shows it.
   */
  match?: ComponentProps<typeof FieldErrorPrimitive>["match"];
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** The messages of a form library's errors, each once, in order. */
const messagesOf = (errors: FieldErrorProps["errors"]): string[] => [
  ...new Set(
    (errors ?? []).flatMap((each) =>
      each?.message === undefined || each.message === "" ? [] : [each.message]
    )
  ),
];

/** The words an error shows: its own, or a form library's messages. */
const wordsOf = (children: ReactNode, messages: string[]): ReactNode => {
  if (!isBlank(children)) {
    return children;
  }
  if (messages.length > 1) {
    return (
      <ul {...stylex.props(noteStyles.list)}>
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    );
  }
  return messages[0];
};

/** The error under the control, while the field is wrong. A screen reader says it with the control. */
export const FieldError = ({
  children,
  errors,
  match,
  style,
  ...rest
}: FieldErrorProps) => {
  const row = useContext(FieldControlIdContext);
  const messages = messagesOf(errors);
  const words = wordsOf(children, messages);
  // Without words of its own, nothing: UI SDK would fill in the browser's sentence.
  if (isBlank(words)) {
    return null;
  }
  // In a grouped row: the row's own error, said with its control by id, as the group's Field holds
  // the group's.
  if (row !== undefined) {
    return (
      <p
        id={getFieldIds(row).error}
        data-slot="field-error"
        {...stylex.props(noteStyles.note, hyphenate, noteStyles.error, style)}
      >
        {words}
      </p>
    );
  }
  return (
    <FieldErrorPrimitive
      {...rest}
      match={
        match ?? (isBlank(children) && messages.length > 0 ? true : undefined)
      }
      {...stylex.props(noteStyles.note, hyphenate, noteStyles.error, style)}
    >
      {words}
    </FieldErrorPrimitive>
  );
};

// ---- FieldStatus --------------------------------------------------------------------------------

// Saved: the tick stands as long as any result holds, then leaves; with reduced motion it goes at once.
const leave = stylex.keyframes({
  from: { opacity: 1 },
  to: { opacity: 0 },
});

const statusStyles = stylex.create({
  // Beside a vertical or horizontal field's control: the mark and the words on one line. In a
  // setting it takes no box of its own: the mark stands beside the control, the words under the name.
  status: {
    display: {
      default: "flex",
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: "contents",
    },
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
  },
  // Where the save is, beside the control and never under the name: a spinner while it saves, a
  // tick once it has, in the room between the words and the control, so no row changes size. In a
  // narrow row, where the control stands under the words, it stands over the control's end.
  mark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: size.iconSm,
    height: size.iconSm,
    color: colors.success,
    pointerEvents: "none",
    position: {
      default: "static",
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: "absolute",
    },
    gridRow: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: { default: "1", [NARROW]: "2" },
    },
    gridColumn: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: { default: "2", [NARROW]: "1" },
    },
    insetInlineEnd: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: { default: "100%", [NARROW]: 0 },
    },
    insetBlockStart: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: { default: "50%", [NARROW]: "auto" },
    },
    insetBlockEnd: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: { default: "auto", [NARROW]: `calc(100% + ${space[2]})` },
    },
    marginInlineEnd: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: { default: space[1], [NARROW]: 0 },
    },
    transform: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive])",
        fieldControlMarker
      )]: { default: "translateY(-50%)", [NARROW]: "none" },
    },
  },
  leaves: {
    animationName: leave,
    animationDuration: motionVars.leave,
    animationDelay: duration.hold,
    animationTimingFunction: duration.ease,
    animationFillMode: "forwards",
  },
  // The words: said, in a setting under the name in the help's place. Only a failure shows there.
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space[2],
    margin: 0,
    minWidth: 0,
    gridColumn: "1",
    // In a setting with a line of help, the failure stands in the help's place (the help steps
    // aside, below), so the row keeps its height.
    gridRow: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive]):has([data-slot=field-description])",
        fieldControlMarker
      )]: "1",
    },
    alignSelf: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=responsive]):has([data-slot=field-description])",
        fieldControlMarker
      )]: "end",
    },
    justifySelf: "stretch",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  failed: { color: colors.destructive },
  // Try again, in a box one line tall: its button may be taller, the row never is.
  // Its button stands out of the line by half what it is taller, into the gap to the control above
  // and the row's edge below: its touch target reaches the middle of what is left (tapTarget).
  retry: {
    display: "inline-flex",
    alignItems: "center",
    height: font.textSmLine,
    "--tap-reach": `calc((${space[2]} - (${size.controlXs} - ${font.textSmLine}) / 2) / 2)`,
  },
});

/** Where a save on change is: at rest, saving, saved, or failed with the value kept. */
export type FieldStatusValue = "idle" | "loading" | "success" | "error";

/** Every prop a FieldStatus takes. */
export interface FieldStatusProps {
  /**
   * Where the save is. `loading`: a spinner beside the control. `success`: a tick that leaves after
   * a moment. `error`: the save failed; the person's value is kept, and Try again saves it. Each is
   * said once, politely.
   */
  status: FieldStatusValue;
  /** Called by Try again, after a failed save. Without it there is no Try again. */
  onRetry?: () => void;
}

/** Says where a field's save on change is: a spinner, then a tick that leaves, or that it failed. */
export const FieldStatus = ({ status, onRetry }: FieldStatusProps) => {
  const { field: words } = useI18n();
  const said = {
    idle: "",
    loading: words.statusLoading,
    success: words.statusSuccess,
    error: words.statusError,
  }[status];
  return (
    <div
      data-slot="field-status"
      data-status={status}
      {...stylex.props(statusStyles.status)}
    >
      {status === "loading" && (
        <span aria-hidden="true" {...stylex.props(statusStyles.mark)}>
          <Spinner />
        </span>
      )}
      {status === "success" && (
        <span
          aria-hidden="true"
          {...stylex.props(statusStyles.mark, statusStyles.leaves)}
        >
          <Icon icon={CheckIcon} />
        </span>
      )}
      {/* Always there, so a screen reader hears it change. Not every one treats <output> as a live
          region. Only a failure is shown; saving and saved are said. */}
      <p
        role="status"
        {...stylex.props(
          statusStyles.line,
          status === "error" ? statusStyles.failed : visuallyHidden
        )}
      >
        {said}
        {status === "error" && onRetry !== undefined && (
          <span {...stylex.props(statusStyles.retry)}>
            <Button size="xs" variant="ghost" onClick={onRetry}>
              {words.statusRetry}
            </Button>
          </span>
        )}
      </p>
    </div>
  );
};

// ---- FieldSet, FieldLegend, FieldGroup and FieldSeparator ---------------------------------------

const setStyles = stylex.create({
  // A set after another stands under a hairline, with room under it, so its legend belongs to the
  // fields below it and does not float under what came before.
  set: {
    display: "block",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    borderTopWidth: { default: 0, ":not(:first-child)": size.hairline },
    paddingBlockStart: { default: 0, ":not(:first-child)": space[4] },
  },
  // A legend floated the full width takes its place in the flow like any heading.
  legend: {
    float: "inline-start",
    width: "100%",
    margin: 0,
    padding: 0,
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
  },
  // The set's heading: the name of a group of fields.
  legendLook: {
    paddingBlockEnd: space[3],
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    color: colors.foreground,
  },
  // A small muted name over a group of settings, on the rows' own start edge.
  labelLook: {
    paddingBlockEnd: space[1],
    paddingInline: space.tableCellInline,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  // Fields one under the other; settings meet, each under its hairline.
  group: {
    clear: "both",
    display: "flex",
    flexDirection: "column",
    rowGap: {
      default: space.formGap,
      ":has(> [data-orientation=responsive])": 0,
    },
    minWidth: 0,
  },
  // Each control its own width, beside its words while the name keeps its floor; in a narrow row
  // whose control would leave the name less, the control goes under the words, so a long value
  // never breaks the name a letter a line.
  fit: {
    [fieldVars.columns]: "minmax(0, 1fr) auto",
    [fieldVars.columnsNarrow]: "minmax(0, 1fr) auto",
    [fieldVars.displayNarrow]: "flex",
  },
  separator: {
    clear: "both",
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space[3],
    minHeight: size.hairline,
    marginBlock: space[2],
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    "::before": {
      content: '""',
      flexGrow: 1,
      height: size.hairline,
      backgroundColor: colors.border,
    },
    "::after": {
      content: '""',
      flexGrow: 1,
      height: size.hairline,
      backgroundColor: colors.border,
    },
  },
  // Without words, one line: the second half is not drawn.
  bare: {
    "::after": { content: "none" },
  },
});

/** Every prop a FieldSet takes: these, and the rest of UI SDK's FieldSet and a <fieldset>. */
export interface FieldSetProps extends Omit<
  ComponentProps<typeof FieldSetPrimitive>,
  "className" | "style" | "render"
> {
  /** A FieldLegend first, then a FieldDescription if it helps, then a FieldGroup of its Fields. */
  children: ReactNode;
  /**
   * Every field in it out of use at once, before any script runs.
   * @default false
   */
  disabled?: boolean;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/**
 * Fields that belong together, under a legend, as a <fieldset>: a screen reader says the legend
 * with each field. A set after another stands under a hairline.
 */
export const FieldSet = ({ children, style, ...rest }: FieldSetProps) => (
  <FieldSetPrimitive {...rest} {...stylex.props(setStyles.set, style)}>
    {children}
  </FieldSetPrimitive>
);

/** Every prop a FieldLegend takes. */
export interface FieldLegendProps {
  /** What the fields are about, in sentence case ("Notifications"). */
  children: ReactNode;
  /**
   * `legend`: the set's heading, in the body's size. `label`: a small muted name over a group of
   * settings, on the rows' start edge.
   * @default "legend"
   */
  variant?: "legend" | "label";
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Names a FieldSet. Keep it the set's first child. */
export const FieldLegend = ({
  children,
  variant = "legend",
  style,
}: FieldLegendProps) => (
  <FieldLegendPrimitive
    data-variant={variant}
    {...stylex.props(
      setStyles.legend,
      variant === "legend" ? setStyles.legendLook : setStyles.labelLook,
      style
    )}
  >
    {children}
  </FieldLegendPrimitive>
);

/** Every prop a FieldGroup takes. */
export interface FieldGroupProps {
  /** Its Fields, one under the other. Responsive Fields meet, a hairline between them. */
  children: ReactNode;
  /**
   * How wide its responsive Fields' controls are: `column`, each fills the shared control column
   * and goes under its words in a narrow row; `fit`, each its own width on the end edge, beside its
   * words at any width while the name keeps its floor, as a settings page of selects, switches
   * and quiet actions has it.
   * @default "column"
   */
  controls?: "column" | "fit";
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Fields one under the other; settings in it share one end edge for their controls. */
export const FieldGroup = ({
  children,
  controls = "column",
  style,
}: FieldGroupProps) => (
  <FieldGroupPrimitive
    data-controls={controls}
    {...stylex.props(
      setStyles.group,
      controls === "fit" && setStyles.fit,
      style
    )}
  >
    {children}
  </FieldGroupPrimitive>
);

/** Every prop a FieldSeparator takes. */
export interface FieldSeparatorProps {
  /** A word or two on the line, when it helps ("Or"). */
  children?: ReactNode;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** A hairline between fields of one form, with a word on it if it helps. Not read: it only draws. */
export const FieldSeparator = ({ children, style }: FieldSeparatorProps) => (
  <div
    data-slot="field-separator"
    aria-hidden={children === undefined ? true : undefined}
    {...stylex.props(
      setStyles.separator,
      children === undefined && setStyles.bare,
      style
    )}
  >
    {children}
  </div>
);

// ---- useFieldControl ----------------------------------------------------------------------------

/** What the Field round a control hands it: its id, the words that describe it, and its state. */
export interface FieldControlProps {
  /** The id its FieldLabel names. */
  id?: string;
  /** The ids of its FieldDescription and of the FieldError that shows. */
  "aria-describedby"?: string;
  /** Its FieldLabel, for a control that is not a labelable element. */
  "aria-labelledby"?: string;
  /** Wrong, while the field shows an error. */
  "aria-invalid"?: boolean;
  /** Out of use, with its Field or FieldSet. */
  disabled?: boolean;
  /** The name it is sent under, when it has none of its own. */
  name?: string;
}

/** A string attribute UI SDK gave, or nothing. */
const stringOf = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The wiring of the Field round a control that is not one of ours (ours read it themselves): spread
 * it on the control. Null outside a Field.
 */
export const useFieldControl = (): FieldControlProps | null => {
  const field = useFieldControlPrimitive();
  const row = useContext(FieldControlIdContext);
  const off = useContext(FieldDisabledContext);
  const wrong = useContext(FieldInvalidContext);
  // In a grouped row: the row's id, its words by their ids, and its own state.
  if (row !== undefined) {
    const ids = getFieldIds(row);
    return {
      id: row,
      "aria-labelledby": ids.label,
      "aria-describedby": `${ids.description} ${ids.error}`,
      "aria-invalid": wrong || undefined,
      disabled: off || undefined,
    };
  }
  if (field === null) {
    return null;
  }
  const wired: Record<string, unknown> = field.props({});
  return {
    id: stringOf(wired.id),
    "aria-describedby": stringOf(wired["aria-describedby"]),
    "aria-labelledby": stringOf(wired["aria-labelledby"]),
    "aria-invalid": isInvalid(wired["aria-invalid"]) || undefined,
    disabled: field.disabled,
    name: field.name,
  };
};

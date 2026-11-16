// FormGroup: fields that belong together in a Form (form.tsx), under a title and a sentence, as a
// <fieldset> and its <legend>, so a screen reader says the title with each field. Groups after the
// first stand under a hairline.
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { grasp } from "../tokens/tokens.stylex";

/** Every prop a FormGroup takes. */
export interface FormGroupProps {
  /** What the fields are about, in sentence case ("Notifications"). */
  title: ReactNode;
  /** One sentence under the title, when it helps. */
  description?: ReactNode;
  /** The group's Fields and FormRows. */
  children: ReactNode;
  /** Every field in it out of use at once. @default false */
  disabled?: boolean;
}

const styles = stylex.create({
  // The hairline is on a wrapper, not the fieldset: a fieldset's border always runs through its
  // legend. A group after another stands under it, with the same room either side.
  group: {
    minWidth: 0,
    paddingBlockStart: { default: 0, ":not(:first-child)": grasp.formGroupGap },
    marginBlockStart: {
      default: 0,
      ":not(:first-child)": `calc(${grasp.formGroupGap} - ${grasp.formGap})`,
    },
    borderBlockStartWidth: {
      default: 0,
      ":not(:first-child)": grasp.separatorWidth,
    },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  fieldset: { minWidth: 0, margin: 0, padding: 0, borderWidth: 0 },
  // A legend floated the full width takes its place in the flow like any heading.
  title: {
    float: "inline-start",
    width: "100%",
    padding: 0,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
  },
  description: {
    clear: "both",
    margin: 0,
    paddingBlockStart: grasp.space1,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  fields: {
    clear: "both",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: grasp.formGap,
    paddingBlockStart: grasp.formGap,
  },
});

/** Whether a description says anything: not left out, empty or false. */
const hasWords = (node: ReactNode) =>
  node !== undefined &&
  node !== null &&
  node !== false &&
  node !== "" &&
  node !== 0;

/** Fields that belong together, under a title. */
export const FormGroup = ({
  title,
  description,
  children,
  disabled = false,
}: FormGroupProps) => {
  const id = useId();
  return (
    <div data-slot="form-group" {...stylex.props(styles.group)}>
      <fieldset
        disabled={disabled}
        aria-describedby={hasWords(description) ? id : undefined}
        {...stylex.props(styles.fieldset)}
      >
        <legend {...stylex.props(styles.title)}>{title}</legend>
        {hasWords(description) && (
          <p id={id} {...stylex.props(styles.description)}>
            {description}
          </p>
        )}
        <div {...stylex.props(styles.fields)}>{children}</div>
      </fieldset>
    </div>
  );
};

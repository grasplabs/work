// Form: the layout of a form, the room between its fields, its sections and its buttons.
// Field does the checking, with UI SDK's own checks, so this is
// only the layout. A plain <form>: the browser sends it, checks it and resets it; each Field shows
// its own error. Give every Field that can be wrong a FieldError with its words: a Field without one
// falls back to the browser's bubble.
//
//   <Form onSubmit={save} aria-label="Profile">
//     <FormSection title="Your details" description="As your team sees them.">
//       <FormRow>
//         <Field>…first name…</Field>
//         <Field>…last name…</Field>
//       </FormRow>
//       <Field>…email…</Field>
//     </FormSection>
//     <FormFooter>
//       <Button type="reset" variant="outline">Cancel</Button>
//       <Button type="submit">Save</Button>
//     </FormFooter>
//   </Form>
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ComponentProps, ReactNode } from "react";

import { colors, font, size, space } from "../lib/tokens.stylex";
import { isBlank } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";

const styles = stylex.create({
  form: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space.formGap,
    width: "100%",
    maxWidth: size.formWidth,
    margin: 0,
  },
  // The hairline is on a wrapper, not the fieldset: a fieldset's border always runs through its
  // legend. A section after another stands under it, with the same room either side.
  section: {
    minWidth: 0,
    paddingBlockStart: { default: 0, ":not(:first-child)": space.formGroupGap },
    marginBlockStart: {
      default: 0,
      ":not(:first-child)": `calc(${space.formGroupGap} - ${space.formGap})`,
    },
    borderBlockStartWidth: {
      default: 0,
      ":not(:first-child)": size.separatorWidth,
    },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  fieldset: { minWidth: 0, margin: 0, padding: 0, borderWidth: 0 },
  // A legend floated the full width takes its place in the flow like any heading.
  title: {
    float: "inline-start",
    width: "100%",
    padding: 0,
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightMedium,
  },
  description: {
    clear: "both",
    margin: 0,
    paddingBlockStart: space[1],
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  fields: {
    clear: "both",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space.formGap,
    paddingBlockStart: space.formGap,
  },
  // As many side by side as fit: on a narrow screen, or when a field would be narrower than
  // form-column, they stack, each the column's width.
  row: {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${size.formColumn}), 1fr))`,
    gap: space.formGap,
    alignItems: "start",
    minWidth: 0,
  },
  // When the line is too narrow the buttons wrap, still in their order.
  footer: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[3],
    paddingBlockStart: space[2],
  },
  start: { justifyContent: "flex-start" },
  end: { justifyContent: "flex-end" },
});

/** Every prop a Form takes: these, and the rest of a <form>'s. */
export interface FormProps extends Omit<
  ComponentProps<"form">,
  "className" | "style"
> {
  /** Its Fields, FormRows and FormSections, then a FormFooter. */
  children: ReactNode;
  /** Its name, when no heading names it, so a screen reader lists it ("Profile"). */
  "aria-label"?: string;
  /** Where it sits and how wide it is. It stands at most `form-width` wide. */
  style?: LayoutStyle;
}

/** The layout of a form: its fields, sections and buttons, with the room between them. */
export const Form = ({ children, style, ...rest }: FormProps) => (
  <form data-slot="form" {...rest} {...stylex.props(styles.form, style)}>
    {children}
  </form>
);

/** Every prop a FormSection takes. */
export interface FormSectionProps {
  /** What the fields are about, in sentence case ("Notifications"). */
  title: ReactNode;
  /** One sentence under the title, when it helps. */
  description?: ReactNode;
  /** The section's Fields and FormRows. */
  children: ReactNode;
  /**
   * Every field in it out of use at once.
   * @default false
   */
  disabled?: boolean;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/**
 * Fields that belong together, under a title and a sentence, as a <fieldset> and its <legend>, so a
 * screen reader says the title with each field. Sections after the first stand under a hairline.
 */
export const FormSection = ({
  title,
  description,
  children,
  disabled = false,
  style,
}: FormSectionProps) => {
  const id = useId();
  const described = !isBlank(description);
  return (
    <div data-slot="form-section" {...stylex.props(styles.section, style)}>
      <fieldset
        disabled={disabled}
        aria-describedby={described ? id : undefined}
        {...stylex.props(styles.fieldset)}
      >
        <legend {...stylex.props(styles.title)}>{title}</legend>
        {described && (
          <p id={id} {...stylex.props(styles.description)}>
            {description}
          </p>
        )}
        <div {...stylex.props(styles.fields)}>{children}</div>
      </fieldset>
    </div>
  );
};

/** Every prop a FormRow takes. */
export interface FormRowProps {
  /** Two or three Fields that are read together: a first and a last name, a city and a postcode. */
  children: ReactNode;
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** Fields side by side, stacking when there is no room. */
export const FormRow = ({ children, style }: FormRowProps) => (
  <div data-slot="form-row" {...stylex.props(styles.row, style)}>
    {children}
  </div>
);

/** Every prop a FormFooter takes. */
export interface FormFooterProps {
  /** The Buttons, the one that sends the form last ("Cancel", then "Save"). */
  children: ReactNode;
  /**
   * Where they stand: `end` of the line, as a dialog's; `start` under a form that reads down the
   * page's start edge.
   * @default "end"
   */
  align?: "start" | "end";
  /** Where it sits: margins and alignment. */
  style?: LayoutStyle;
}

/** A form's buttons, the one that sends it last. */
export const FormFooter = ({
  children,
  align = "end",
  style,
}: FormFooterProps) => (
  <div
    data-slot="form-footer"
    {...stylex.props(
      styles.footer,
      align === "start" ? styles.start : styles.end,
      style
    )}
  >
    {children}
  </div>
);

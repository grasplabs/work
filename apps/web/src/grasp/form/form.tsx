// Form: the layout of a form, the room between its fields, its groups and its buttons. The
// product's own part: shadcn's form is a react-hook-form recipe, which Field (src/components/field)
// already answers with UI SDK's own checks, so this is only the layout. A plain <form>: the
// browser sends it, checks it and resets it; each Field shows its own error.
//
//   <Form onSubmit={save} aria-label="Profile">
//     <FormGroup title="Your details" description="As your team sees them.">
//       <FormRow>
//         <Field>…first name…</Field>
//         <Field>…last name…</Field>
//       </FormRow>
//       <Field>…email…</Field>
//     </FormGroup>
//     <FormActions>
//       <Button type="reset">Cancel</Button>
//       <Button type="submit" variant="ink">Save</Button>
//     </FormActions>
//   </Form>
//
// Every value is a token (src/tokens). A caller may set layout and width only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode, SubmitEvent, SyntheticEvent } from "react";

import { grasp } from "../tokens/tokens.stylex";

type Layout = string | number | null;

/** What a caller may style: where the form sits and how wide it is. Never its rhythm. */
export type FormLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  justifySelf?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  width?: Layout;
  maxWidth?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginInline?: Layout;
}>;

/** Every prop a Form takes. */
export interface FormProps {
  /** Its Fields, FormRows and FormGroups, then FormActions. */
  children: ReactNode;
  /** Runs when it is sent and every Field is right. Call `event.preventDefault()` to send it yourself. */
  onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void;
  /** Runs when it is reset, by a `type="reset"` button. */
  onReset?: (event: SyntheticEvent<HTMLFormElement>) => void;
  /** Where the browser sends it when you do not send it yourself. */
  action?: string;
  /** Its id, for a control that stands outside it (`form="…"`). */
  id?: string;
  /** Its name, when no heading names it, so a screen reader lists it ("Profile"). */
  "aria-label"?: string;
  /** Layout only: where it sits and how wide it is. It stands at most `form-width` wide. */
  style?: FormLayoutStyle;
}

const styles = stylex.create({
  form: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: grasp.formGap,
    width: "100%",
    maxWidth: grasp.formWidth,
    margin: 0,
  },
});

/** The layout of a form: its fields, groups and buttons, with the room between them. */
export const Form = ({ children, style, ...rest }: FormProps) => (
  <form data-slot="form" {...rest} {...stylex.props(styles.form, style)}>
    {children}
  </form>
);

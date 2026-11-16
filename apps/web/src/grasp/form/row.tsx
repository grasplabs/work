// FormRow: fields side by side in a Form (form.tsx), as many as fit: on a narrow screen, or when a
// field would be narrower than `form-column`, they stack, each the column's width.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp } from "../tokens/tokens.stylex";

/** Every prop a FormRow takes. */
export interface FormRowProps {
  /** Two or three Fields that are read together: a first and a last name, a city and a postcode. */
  children: ReactNode;
}

const styles = stylex.create({
  row: {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${grasp.formColumn}), 1fr))`,
    gap: grasp.formGap,
    alignItems: "start",
    minWidth: 0,
  },
});

/** Fields side by side, stacking when there is no room. */
export const FormRow = ({ children }: FormRowProps) => (
  <div data-slot="form-row" {...stylex.props(styles.row)}>
    {children}
  </div>
);

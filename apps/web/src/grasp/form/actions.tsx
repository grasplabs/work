// FormActions: a Form's buttons (form.tsx), at the end of the line, the one that sends it last.
// When the line is too narrow they wrap, still in that order.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp } from "../tokens/tokens.stylex";

/** Every prop a FormActions takes. */
export interface FormActionsProps {
  /** The Buttons, the one that sends the form last ("Cancel", then "Save"). */
  children: ReactNode;
  /**
   * Where they stand: `end` of the line, as a dialog's; `start` under a form that reads down the
   * page's left edge.
   * @default "end"
   */
  align?: "start" | "end";
}

const styles = stylex.create({
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space3,
    paddingBlockStart: grasp.space2,
  },
  start: { justifyContent: "flex-start" },
  end: { justifyContent: "flex-end" },
});

/** A form's buttons, the one that sends it last. */
export const FormActions = ({ children, align = "end" }: FormActionsProps) => (
  <div
    data-slot="form-actions"
    {...stylex.props(styles.actions, styles[align])}
  >
    {children}
  </div>
);

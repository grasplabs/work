// What a Setting row reads from the rows it is in (SettingsRows).
import * as stylex from "@stylexjs/stylex";

export const settingRowVars = stylex.defineVars({
  /**
   * The row's columns: its words, and the control column every control fills (control-column), or
   * each control at its own width on the end edge (SettingsRows `controls="fit"`).
   */
  columns: "minmax(0, 1fr) var(--grasp-control-column)",
  /** The row's columns when it is narrower than 34rem: its control under its words, or still beside them when it fits. */
  columnsNarrow: "minmax(0, 1fr)",
});

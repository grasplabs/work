import * as stylex from "@stylexjs/stylex";

import { Input } from "../grasp/input/index.ts";
import { SettingRow } from "../grasp/setting-row/index.ts";

// A value nobody changes here, as a settings card's row: its words in a
// field that only reads, on the rows' shared edge, so it looks like every
// other row's value. A value that is no words (a status Badge) stays a
// FactRow.

const styles = stylex.create({
  // The field fills the rows' shared control column.
  fill: { width: "100%" },
});

/** A value nobody changes here, in a read-only field; more about it behind the row's info mark. */
export const ReadOnlyRow = ({
  label,
  value,
  info,
  infoLabel,
}: {
  label: string;
  value: string;
  /** More about it, behind the row's info mark. */
  info?: string;
  /** The info mark's name for a screen reader. */
  infoLabel?: string;
}) => (
  <SettingRow
    {...(info === undefined ? {} : { info })}
    {...(infoLabel === undefined ? {} : { infoLabel })}
    label={label}
  >
    {(field) => (
      <Input {...field} layout={styles.fill} readOnly size="sm" value={value} />
    )}
  </SettingRow>
);

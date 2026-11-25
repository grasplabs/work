import { Input } from "@grasp-os/ui/components/input";
import * as stylex from "@stylexjs/stylex";

import { SettingRow } from "./section.tsx";

// A value nobody changes here, as a settings card's row: its words in a
// field that only reads, on the rows' shared edge, so it looks like every
// other row's value. A value that is no words (a status Badge) stays a
// FactRow (section.tsx).

const styles = stylex.create({
  // The field fills the rows' shared control column.
  fill: { width: "100%" },
});

/** A value nobody changes here, in a read-only field, with one short line under its name. */
export const ReadOnlyRow = ({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  /** One short line on what it is, under its name. */
  help?: string;
}) => (
  <SettingRow {...(help === undefined ? {} : { help })} label={label}>
    <Input readOnly size="sm" style={styles.fill} value={value} />
  </SettingRow>
);

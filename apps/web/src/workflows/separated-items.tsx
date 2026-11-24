import { ItemGroup, ItemSeparator } from "@grasp-os/ui/components/item";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";
import type { ReactNode } from "react";

// Items with a hairline between each, as the reference's separated
// ItemGroup: 4px either side of each hairline, and the same 4px at the
// list's top and foot. Damsko's ItemGroup gives that room only once it
// holds a separator, so a list of one row gets it here (the registry gap
// "ItemGroup has no separated").

const styles = stylex.create({
  alone: { marginBlock: space["1"] },
});

/** One row of the list: an Item, under its key. */
export interface SeparatedRow {
  key: string;
  row: ReactNode;
}

export const SeparatedItems = ({
  rows,
  "aria-label": label,
}: {
  rows: readonly SeparatedRow[];
  "aria-label"?: string;
}) => (
  <ItemGroup
    {...(label === undefined ? {} : { "aria-label": label })}
    {...(rows.length === 1 ? { style: styles.alone } : {})}
  >
    {rows.map(({ key, row }, at) => (
      <Fragment key={key}>
        {at === 0 ? null : <ItemSeparator />}
        {row}
      </Fragment>
    ))}
  </ItemGroup>
);

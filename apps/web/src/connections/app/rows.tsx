import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import type { AlertVariant } from "@grasp-os/ui/components/alert";
import {
  colors,
  font,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// The rows of an app's settings cards that Damsko's responsive Field
// doesn't draw, as #2503's library setting row framed them: a hairline
// over every row but the first, the row's least height, its sides on the
// table's inset (Damsko's field row). A row of its own inside (a group of
// tools that opens in place, an account with its actions), a fact nobody
// changes here in a setting's columns (`FactRow`), a notice across the
// card (`RowAlert`), and the rows of one card, one under the other.

export const rowFrame = stylex.create({
  // The row's own width is what its narrow form measures. A hairline over
  // every row but the first: the rows of one card, apart.
  box: {
    containerType: "inline-size",
    containerName: "setting-row",
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    borderTopWidth: { default: sizes.hairline, ":first-child": 0 },
  },
  // Inside the hairline: a field row tall at least, the table's inset at the sides.
  pad: {
    boxSizing: "border-box",
    minHeight: space.fieldRow,
    paddingBlock: space["2"],
    paddingInline: space.tableCellInline,
    fontFamily: font.sans,
  },
});

/** Where a row is narrow enough to stack its value under its words. */
const NARROW = "@container setting-row (width < 34rem)";

const styles = stylex.create({
  rows: { display: "flex", flexDirection: "column", minWidth: 0 },
  // A fact's words, and its value on the control column's end edge.
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: `minmax(0, 1fr) ${sizes.fieldControlColumn}`,
      [NARROW]: "minmax(0, 1fr)",
    },
    alignItems: "center",
    columnGap: space["6"],
    rowGap: space["2"],
  },
  words: {
    display: "grid",
    alignSelf: "start",
    alignContent: "center",
    minHeight: sizes.controlSm,
    minWidth: 0,
  },
  name: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    width: "fit-content",
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  help: {
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  value: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
  },
  alertRow: {
    paddingBlock: space["2"],
    paddingInline: space.tableCellInline,
  },
});

/** One row of a settings card: the hairline over it, and inside it the row's height and sides. */
export const RowFrame = ({
  inner,
  children,
  ...data
}: {
  /** How the inside of the frame lays out its parts. */
  inner: stylex.StyleXStyles;
  children: ReactNode;
  "data-state"?: string;
}) => (
  <div data-slot="setting-row" {...data} {...stylex.props(rowFrame.box)}>
    <div {...stylex.props(rowFrame.pad, inner)}>{children}</div>
  </div>
);

/** The rows of one card, a hairline between them and no frame. */
export const SettingsRows = ({ children }: { children: ReactNode }) => (
  <div data-slot="settings-rows" {...stylex.props(styles.rows)}>
    {children}
  </div>
);

/** A fact nobody changes here, in a setting's columns: its value in place of a control. */
export const FactRow = ({
  label,
  help,
  children,
}: {
  label: string;
  /** One quiet line under its name. */
  help?: string;
  children: ReactNode;
}) => (
  <RowFrame inner={styles.row}>
    <div {...stylex.props(styles.words)}>
      <span {...stylex.props(styles.name)}>{label}</span>
      {help === undefined ? null : <p {...stylex.props(styles.help)}>{help}</p>}
    </div>
    <div {...stylex.props(styles.value)}>{children}</div>
  </RowFrame>
);

/** A notice across a settings card, in a row of its own. */
export const RowAlert = ({
  variant = "default",
  children,
}: {
  variant?: AlertVariant;
  children: ReactNode;
}) => (
  <div data-slot="row-alert" {...stylex.props(rowFrame.box, styles.alertRow)}>
    <Alert variant={variant}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  </div>
);

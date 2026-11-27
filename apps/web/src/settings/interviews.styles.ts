import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// Settings › Interviews: where its Damsko parts stand.

export const interviewStyles = stylex.create({
  // What needs the admin, in one line under the figures; on a phone its
  // parts wrap, each whole.
  needs: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space["2"],
    rowGap: space["1"],
    margin: 0,
    paddingBlock: 0,
    paddingInline: space["4"],
    listStyleType: "none",
  },
  dot: { color: colors.mutedForeground },
  calm: { marginInline: space["4"] },
  need: { display: "flex", alignItems: "baseline", columnGap: space["2"] },
  // A table the line above jumps to: it takes the focus without a ring of
  // its own, and never grows past the page's column.
  place: { minWidth: 0, outlineStyle: "none" },
  // A table's own controls, over it: the search takes the room that is
  // left, and on a phone the filter goes under it.
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
    paddingBlock: space["3"],
    paddingInline: space.tableCellInline,
  },
  search: { flexGrow: 1, flexBasis: "176px", minWidth: 0 },
  // A team's small bar, wide enough to read at a glance.
  bar: { minWidth: space["20"] },
  // A disabled checkbox's box, so its reason shows under a pointer.
  inline: { display: "inline-flex" },
  // A lead's name over what is to know of them.
  lead: { display: "grid", minWidth: 0 },
  // The days' chart over the plan's facts, a Separator between them.
  activity: { display: "grid", rowGap: space["4"], minWidth: 0 },
  chart: { width: "100%" },
  // The one field of the address's dialog.
  fill: { width: "100%" },
});

import { radius, size } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// A region's flag, small, beside the words that name it: a language in
// the language choice (Settings › Profile), a provider's region (Settings
// › AI and spend). The drawings come from country-flag-icons, 3 by 2; this
// rounds them to the system's corner and draws its edge inside them, so a
// white flag keeps its rim on a white ground. Damsko has no flags (the
// rename map's "flags → the product, country-flag-icons directly").

export { DE, ES, EU, FR, GB, NL, US } from "country-flag-icons/string/3x2";

/** A flag's drawing: one of this module's flags. */
export type FlagData = string;

/** Small text's flag: 12px tall. */
const height = "12px";

const styles = stylex.create({
  flag: {
    position: "relative",
    display: "inline-block",
    flexShrink: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    height,
    width: `calc(${height} * 3 / 2)`,
    borderRadius: `calc(${height} / 4)`,
    cornerShape: radius.shape,
    verticalAlign: "middle",
    lineHeight: 0,
    // The drawing never catches a click meant for the control it is in.
    pointerEvents: "none",
    // The edge, over the picture: drawn inside, so it adds nothing to the
    // size. In forced colours the system's own line.
    "::after": {
      content: "''",
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      cornerShape: "inherit",
      boxShadow: {
        default: size.avatarBorder,
        "@media (forced-colors: active)": "inset 0 0 0 1px CanvasText",
      },
    },
  },
  picture: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
});

// The drawing goes in as a data address, so no markup is written into the page.
const address = (drawing: FlagData) =>
  `data:image/svg+xml,${encodeURIComponent(drawing)}`;

/** A region's flag beside the words that name it, hidden from a screen reader. */
export const Flag = ({ flag }: { flag: FlagData }) => (
  <span {...stylex.props(styles.flag)}>
    <img
      alt=""
      draggable={false}
      src={address(flag)}
      {...stylex.props(styles.picture)}
    />
  </span>
);

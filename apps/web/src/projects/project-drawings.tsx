import * as stylex from "@stylexjs/stylex";

import { AspectRatio } from "../grasp/aspect-ratio/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// An App's card on a project's overview shows a small drawing of an App's
// page: a sheet with a title bar, rows and a column of figures. Core keeps
// no picture of an App's own page yet (core need 65), so every App shows
// the same drawing; it says "an App", never what this one holds.

const styles = stylex.create({
  ground: {
    display: "block",
    width: "100%",
    height: "100%",
    backgroundColor: grasp.soft,
  },
  page: { fill: grasp.raised, stroke: grasp.line },
  bar: { fill: grasp.muted, opacity: 0.45 },
  line: { fill: grasp.line },
  figure: { fill: grasp.mintDeep, opacity: 0.8 },
});

const rows = [0, 1, 2, 3] as const;

/** A drawing of an App's page, 16 by 10, at the top of its card. */
export const AppPageDrawing = () => (
  <AspectRatio ratio={16 / 10}>
    <svg
      aria-hidden="true"
      preserveAspectRatio="xMidYMax slice"
      viewBox="0 0 160 100"
      {...stylex.props(styles.ground)}
    >
      <rect
        height="96"
        rx="5"
        width="112"
        x="24"
        y="14"
        {...stylex.props(styles.page)}
      />
      <rect
        height="4"
        rx="2"
        width="30"
        x="36"
        y="24"
        {...stylex.props(styles.bar)}
      />
      {rows.map((row) => (
        <g key={row}>
          <rect
            height="3"
            rx="1.5"
            width="18"
            x="36"
            y={38 + row * 9}
            {...stylex.props(styles.line)}
          />
          <rect
            height="3"
            rx="1.5"
            width="46"
            x="58"
            y={38 + row * 9}
            {...stylex.props(styles.line)}
          />
          <rect
            height="3"
            rx="1.5"
            width="16"
            x="108"
            y={38 + row * 9}
            {...stylex.props(styles.figure)}
          />
        </g>
      ))}
    </svg>
  </AspectRatio>
);

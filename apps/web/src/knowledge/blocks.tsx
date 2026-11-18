import type { Collection } from "@grasp-os/shared/knowledge";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// The pictures on Knowledge's blocks, in the prototype's style
// (grasplabs/prototype `components/brain-home.tsx`): a pale field with a
// dashed grid, a line drawing in the middle. In the palette's own greys:
// Knowledge has no part colours of its own. A panel stands in a card's
// CardMedia, which gives it its corners.

const styles = stylex.create({
  panel: {
    position: "relative",
    overflow: "hidden",
    height: `calc(${grasp.space24} + ${grasp.space16})`,
    backgroundColor: grasp.soft,
  },
  short: { height: `calc(${grasp.space24} + ${grasp.space4})` },
  grid: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
  },
  gridLine: { stroke: grasp.line },
  middle: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  drawing: { height: `calc(${grasp.space24} + ${grasp.space8})` },
  line: { stroke: grasp.ink, fill: "none" },
  surface: { stroke: grasp.ink, fill: grasp.raised },
  tinted: { stroke: grasp.ink, fill: grasp.ghostFillPress },
});

/** A pale field with a dashed grid, the drawing in the middle. */
export const Panel = ({
  short = false,
  children,
}: {
  short?: boolean;
  children: ReactNode;
}) => {
  const id = useId();
  return (
    <div {...stylex.props(styles.panel, short && styles.short)}>
      <svg aria-hidden="true" {...stylex.props(styles.grid)}>
        <defs>
          <pattern height="28" id={id} patternUnits="userSpaceOnUse" width="28">
            <path
              {...stylex.props(styles.gridLine)}
              d="M28 0H0V28"
              fill="none"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect fill={`url(#${id})`} height="100%" width="100%" />
      </svg>
      <div {...stylex.props(styles.middle)}>{children}</div>
    </div>
  );
};

const line = stylex.props(styles.line);
const surface = stylex.props(styles.surface);
const tinted = stylex.props(styles.tinted);

const drawingProps = {
  "aria-hidden": true,
  ...stylex.props(styles.drawing),
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.5,
  viewBox: "0 0 200 120",
} as const;

/** A stack of documents and a speech bubble: what was shared and said. */
const SharedDrawing = () => (
  <svg {...drawingProps}>
    <rect {...surface} height="74" rx="6" width="58" x="44" y="30" />
    <rect {...surface} height="74" rx="6" width="58" x="54" y="22" />
    <path {...line} d="M64 40 H100 M64 50 H100 M64 60 H88" fill="none" />
    <path
      {...tinted}
      d="M112 44 H160 A8 8 0 0 1 168 52 V78 A8 8 0 0 1 160 86 H132 L120 96 V86 H112 A8 8 0 0 1 104 78 V52 A8 8 0 0 1 112 44 Z"
    />
    <path {...line} d="M118 60 H154 M118 70 H142" fill="none" />
  </svg>
);

/** Three people side by side, the middle one in front: a team's own. */
const TeamsDrawing = () => (
  <svg {...drawingProps}>
    <circle {...surface} cx="62" cy="46" r="13" />
    <path {...surface} d="M36 96 C36 74 88 74 88 96 Z" />
    <circle {...surface} cx="138" cy="46" r="13" />
    <path {...surface} d="M112 96 C112 74 164 74 164 96 Z" />
    <circle {...tinted} cx="100" cy="40" r="16" />
    <path {...tinted} d="M68 102 C68 74 132 74 132 102 Z" />
  </svg>
);

/** One person beside their own page: only its owner reads it. */
const OwnDrawing = () => (
  <svg {...drawingProps}>
    <rect {...surface} height="74" rx="6" width="58" x="104" y="24" />
    <path {...line} d="M114 40 H152 M114 50 H152 M114 60 H140" fill="none" />
    <circle {...tinted} cx="72" cy="44" r="15" />
    <path {...tinted} d="M42 100 C42 72 102 72 102 100 Z" />
  </svg>
);

/** Two app windows, one behind the other: what Grasp ships, read-only. */
const ShippedDrawing = () => (
  <svg {...drawingProps}>
    <rect {...surface} height="64" rx="7" width="92" x="44" y="22" />
    <rect {...tinted} height="64" rx="7" width="92" x="64" y="38" />
    <path {...line} d="M64 52 H156" fill="none" />
    <rect {...surface} height="22" rx="5" width="22" x="76" y="62" />
    <rect {...surface} height="22" rx="5" width="22" x="104" y="62" />
  </svg>
);

/** A process as three steps, the middle one lifted out: what Apps keep. */
const AppsDrawing = () => (
  <svg {...drawingProps}>
    <rect {...surface} height="30" rx="7" width="40" x="18" y="58" />
    <rect {...surface} height="30" rx="7" width="40" x="142" y="58" />
    <path
      {...line}
      d="M58 73 H76 M124 73 H142"
      fill="none"
      strokeDasharray="4 4"
    />
    <rect {...tinted} height="36" rx="8" width="48" x="76" y="34" />
    <path {...line} d="M92 52 L98 58 L110 46" fill="none" />
  </svg>
);

/**
 * A collection's picture, by where its documents come from and who reads
 * them, so blocks side by side tell apart at a glance.
 */
export const CollectionDrawing = ({
  collection,
}: {
  collection: Pick<Collection, "access" | "source">;
}) => {
  if (collection.source === "grasp") {
    return <ShippedDrawing />;
  }
  if (collection.source === "apps") {
    return <AppsDrawing />;
  }
  if (collection.access === "me") {
    return <OwnDrawing />;
  }
  return collection.access === "teams" ? <TeamsDrawing /> : <SharedDrawing />;
};

/** A notebook with a pen: what every agent always has in mind. */
export const MemoryDrawing = () => (
  <svg {...drawingProps}>
    <rect {...surface} height="84" rx="7" width="72" x="58" y="18" />
    <path {...line} d="M70 18 V102" fill="none" />
    <path
      {...line}
      d="M80 36 H118 M80 48 H118 M80 60 H108 M80 72 H114"
      fill="none"
    />
    <path {...tinted} d="M142 30 L152 30 L152 88 L147 98 L142 88 Z" />
    <path {...line} d="M142 40 H152" fill="none" />
  </svg>
);

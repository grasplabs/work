import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "../grasp/button/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import {
  ArrowLeft,
  ChevronRight,
  Fit,
  Icon,
  Minus,
  Plus,
} from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import type { AtlasView } from "./atlas-canvas.tsx";
import type { RegionGroup } from "./atlas-map.ts";
import { Mark } from "./region-marks.tsx";

/**
 * What sits in the corners of the atlas, out of the brain's way, as in the prototype
 * (grasplabs/prototype, packages/grasp: components/knowledge/atlas-overlays.tsx): top left what a
 * dot says, under the small brain when a region is open, and above it the region's groups to
 * narrow it to; with the zoom under it. Bottom left the way you came, to step back along. The
 * chat has the bottom centre (chat/global-chat.tsx). Nothing takes a side of the screen.
 */

/** Which dots a mark of the legend stands for. */
export type Spot = "known" | "waiting" | "open";

/**
 * The corner of the canvas the legend takes, in pixels, with a little air, for the brain to keep
 * clear: how wide it is, and how high, seen whole and in a region, where the small brain sits in
 * its upper part. From the panel's own styles below.
 */
export const LEGEND_CORNER = { width: 184, whole: 164, region: 258 };

/** The corner with a region's groups in the panel as well: wider for their names, and a row higher for each, with "All" and a line under them. */
export const legendCorner = (groups: number): typeof LEGEND_CORNER => {
  if (groups === 0) {
    return LEGEND_CORNER;
  }
  return {
    ...LEGEND_CORNER,
    width: 264,
    region: LEGEND_CORNER.region + (groups + 1) * 28 + 13,
  };
};

/** A region's groups, to narrow it to one: the tools people named, the employee interviews. */
export interface LegendGroups {
  items: RegionGroup[];
  /** How many notes the region shows in all. */
  total: number;
  /** The group it is narrowed to, by its key; none for all of it. */
  selected?: string;
  onSelect: (key: string | undefined) => void;
}

const PHONE = media.belowTablet;
const HOVER = media.hover;
const REDUCED = media.reduced;

// The legend's sizes, which LEGEND_CORNER above counts on: 160 pixels wide, 240 with a region's
// groups; inside a region its top leaves 100 pixels for the small brain drawn there.
const LEGEND_WIDTH = `calc(2 * ${grasp.space20})`;
const LEGEND_WIDE = `calc(3 * ${grasp.space20})`;
const UNDER_BRAIN = `calc(${grasp.space24} + ${grasp.space1})`;
// Room on the right of the way back for the chat's bar at the foot of the page.
const BESIDE_CHAT = `calc(100% - 7.5 * ${grasp.space16})`;
// The room inside the legend, round its rows and either side of its lines.
const INSET = `calc(1.5 * ${grasp.space1})`;
// The room between the steps of the way back.
const STEP_GAP = `calc(${grasp.space1} / 2)`;

const styles = stylex.create({
  // One small panel, top left. It lets the pointer through to the brain round its rows.
  legend: {
    position: "absolute",
    top: grasp.space3,
    left: grasp.space3,
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: LEGEND_WIDTH,
    padding: INSET,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.line,
    borderRadius: grasp.corner,
    pointerEvents: "none",
    transitionProperty: { default: "width, padding", [REDUCED]: "none" },
    transitionDuration: grasp.durationUi,
    transitionTimingFunction: grasp.ease,
  },
  legendWide: { width: LEGEND_WIDE },
  legendUnder: { paddingTop: UNDER_BRAIN },
  // A region's groups, over the marks, a line under them.
  groups: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    marginBottom: INSET,
    padding: 0,
    paddingBottom: INSET,
    borderWidth: 0,
    borderBottomWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.line,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: grasp.controlXs,
    margin: 0,
    paddingBlock: 0,
    paddingInline: grasp.space2,
    borderWidth: 0,
    borderRadius: grasp.treeRowCorner,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    textAlign: "start",
    cursor: "pointer",
    pointerEvents: "auto",
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
    },
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // The mark whose dots are lit now.
  lit: { backgroundColor: grasp.ghostFillHover },
  // What a click chose, kept lit.
  chosen: { fontWeight: grasp.weightMedium },
  groupName: { flexGrow: 1, minWidth: 0 },
  count: { fontVariantNumeric: "tabular-nums" },
  zoom: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: INSET,
    paddingTop: INSET,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    pointerEvents: "auto",
  },
  // Bottom left, clear of the chat's bar beside it; on a phone over the chat.
  trail: {
    position: "absolute",
    bottom: { default: grasp.space3, [PHONE]: grasp.space16 },
    left: grasp.space3,
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    maxWidth: {
      default: BESIDE_CHAT,
      [PHONE]: `calc(100% - ${grasp.space6})`,
    },
  },
  // Beside the open chat there is room for the way back only, and on a phone none.
  compact: {
    position: "absolute",
    bottom: grasp.space3,
    left: grasp.space3,
    display: { default: "flex", [PHONE]: "none" },
    minWidth: 0,
    maxWidth: BESIDE_CHAT,
  },
  steps: {
    display: "flex",
    alignItems: "center",
    gap: STEP_GAP,
    minWidth: 0,
    margin: 0,
    padding: 0,
    overflow: "hidden",
    listStyle: "none",
  },
  step: {
    display: { default: "flex", [PHONE]: "none" },
    alignItems: "center",
    gap: STEP_GAP,
    flexShrink: 0,
  },
  stepHere: { display: "flex", flexShrink: 1, minWidth: 0 },
  between: { display: "flex", color: grasp.muted },
  here: {
    display: "flex",
    minWidth: 0,
    paddingInline: grasp.space2,
  },
  shrink: { minWidth: 0, maxWidth: "100%" },
});

/** A row of the legend, each a button that keeps what it chose pressed. */
const LegendRow = ({
  pressed,
  lit,
  chosen,
  label,
  children,
  ...handlers
}: {
  pressed: boolean;
  lit: boolean;
  chosen: boolean;
  label?: string;
  children: ReactNode;
  onClick: () => void;
  onBlur?: () => void;
  onFocus?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) => (
  <button
    aria-pressed={pressed}
    title={label}
    type="button"
    {...handlers}
    {...stylex.props(
      styles.row,
      lit && styles.lit,
      chosen && styles.chosen,
      focus.ring
    )}
  >
    {children}
  </button>
);

/**
 * Top left: what a dot says, drawn as the brain draws it: filled where something is known, hollow
 * where it is still waiting, in the attention colour where a question is open. Pointing at one
 * lights up the dots that have it, in the brain or the region on screen; a click keeps them lit.
 * Inside a region it sits under the small brain that says where you are.
 */
export const AtlasLegend = ({
  spot,
  under,
  groups,
  onSpot,
  onZoom,
  onReset,
}: {
  spot?: Spot;
  /** A region is open: the small brain is above it. */
  under: boolean;
  /** The open region's groups, when it has several. */
  groups?: LegendGroups;
  onSpot: (spot: Spot | undefined) => void;
  /** Closer or further by a factor. */
  onZoom: (factor: number) => void;
  /** Back to how the view puts it. */
  onReset: () => void;
}) => {
  const { t } = useLingui();
  // The mark that is kept lit: what a click chose.
  const [picked, setPicked] = useState<Spot>();
  const marks: { state: Spot; label: ReactNode }[] = [
    { state: "known", label: <Trans>Known</Trans> },
    { state: "waiting", label: <Trans>Still waiting</Trans> },
    { state: "open", label: <Trans>Still open</Trans> },
  ];
  return (
    // Inside a region the small brain is drawn in its upper part, to click on; under it the marks, and the zoom.
    <div
      {...stylex.props(
        styles.legend,
        under && styles.legendUnder,
        groups !== undefined && styles.legendWide
      )}
    >
      {groups ? (
        <fieldset aria-label={t`Show`} {...stylex.props(styles.groups)}>
          {[
            { key: undefined, label: t`All`, count: groups.total },
            ...groups.items,
          ].map((group) => (
            <LegendRow
              chosen={groups.selected === group.key}
              key={group.key ?? "all"}
              label={group.label}
              lit={groups.selected === group.key}
              onClick={() => {
                groups.onSelect(group.key);
              }}
              pressed={groups.selected === group.key}
            >
              <Text
                element="span"
                layout={styles.groupName}
                size="sm"
                tone="ink"
                wrap="truncate"
              >
                {group.label}
              </Text>
              <span {...stylex.props(styles.count)}>
                <Text element="span" size="sm" tone="muted">
                  {group.count}
                </Text>
              </span>
            </LegendRow>
          ))}
        </fieldset>
      ) : null}
      {marks.map((mark) => (
        // Pointing shows its dots for a moment; a click keeps them lit until it is clicked again, so they can be gone over one by one.
        <LegendRow
          chosen={picked === mark.state}
          key={mark.state}
          lit={spot === mark.state}
          onBlur={() => {
            onSpot(picked);
          }}
          onClick={() => {
            const next = picked === mark.state ? undefined : mark.state;
            setPicked(next);
            onSpot(next);
          }}
          onFocus={() => {
            onSpot(mark.state);
          }}
          onPointerEnter={() => {
            onSpot(mark.state);
          }}
          onPointerLeave={() => {
            onSpot(picked);
          }}
          pressed={picked === mark.state}
        >
          <Mark state={mark.state} />
          {mark.label}
        </LegendRow>
      ))}
      <div {...stylex.props(styles.zoom)}>
        <Button
          aria-label={t`Zoom out`}
          icon={Minus}
          onClick={() => {
            onZoom(1 / 1.25);
          }}
          size="sm"
          variant="ghost"
        />
        <Button
          aria-label={t`Zoom in`}
          icon={Plus}
          onClick={() => {
            onZoom(1.25);
          }}
          size="sm"
          variant="ghost"
        />
        <Button
          aria-label={t`Fit and center`}
          icon={Fit}
          onClick={onReset}
          size="sm"
          variant="ghost"
        />
      </div>
    </div>
  );
};

/** One step of the way into the brain: what it is called, and the view it is. */
export interface TrailStep {
  label: string;
  view: AtlasView;
}

/**
 * Bottom left, once you are in a region: back one step, and the way you came from the whole
 * brain, each step a way back to it. Where you are is the last, and not a link. Beside the open
 * chat there is room only for the way back, which then names where it goes.
 */
export const AtlasTrail = ({
  steps,
  compact = false,
  onGo,
}: {
  steps: TrailStep[];
  compact?: boolean;
  onGo: (view: AtlasView) => void;
}) => {
  const { t } = useLingui();
  const previous = steps.at(-2);
  if (!previous) {
    return null;
  }
  const destination = previous.label;
  if (compact) {
    return (
      <nav
        aria-label={t`Where you are in the brain`}
        {...stylex.props(styles.compact)}
      >
        <Button
          aria-label={t`Back to ${destination}`}
          icon={ArrowLeft}
          layout={styles.shrink}
          onClick={() => {
            onGo(previous.view);
          }}
          size="sm"
          truncate
          variant="ghost"
        >
          {previous.label}
        </Button>
      </nav>
    );
  }
  return (
    <nav
      aria-label={t`Where you are in the brain`}
      {...stylex.props(styles.trail)}
    >
      <Button
        icon={ArrowLeft}
        onClick={() => {
          onGo(previous.view);
        }}
        size="sm"
        variant="ghost"
      >
        <Trans>Back</Trans>
      </Button>
      <ol {...stylex.props(styles.steps)}>
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          return (
            <li
              key={step.label}
              {...stylex.props(styles.step, last && styles.stepHere)}
            >
              {index > 0 ? (
                <span {...stylex.props(styles.between)}>
                  <Icon icon={ChevronRight} />
                </span>
              ) : null}
              {last ? (
                <span aria-current="page" {...stylex.props(styles.here)}>
                  <Text
                    element="span"
                    size="sm"
                    tone="ink"
                    weight="medium"
                    wrap="truncate"
                  >
                    {step.label}
                  </Text>
                </span>
              ) : (
                <Button
                  onClick={() => {
                    onGo(step.view);
                  }}
                  size="sm"
                  truncate
                  variant="ghost"
                >
                  {step.label}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

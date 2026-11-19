import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { ButtonGroup, ButtonGroupButton } from "../grasp/button-group/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  ArrowLeft,
  ChevronRight,
  Fit,
  Icon,
  Minus,
  Plus,
} from "../grasp/icons/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { ToolbarBand } from "../grasp/toolbar-band/index.ts";
import type { AtlasView } from "./atlas-canvas.tsx";
import type { RegionGroup } from "./atlas-map.ts";
import { Mark } from "./region-marks.tsx";

/**
 * What stands round the atlas, out of the brain's way, as in the prototype (grasplabs/prototype,
 * packages/grasp: components/knowledge/atlas-overlays.tsx), on the library's parts: above it a
 * Toolbar band, with what a dot says at its start (pointing lights those dots, a press keeps them
 * lit) and at its end a region's groups to narrow it to and the zoom. Bottom left the way you
 * came, to step back along. The chat has the bottom centre (chat/global-chat.tsx).
 */

/** Which dots a mark of the legend stands for. */
export type Spot = "known" | "waiting" | "open";

/**
 * The canvas's top left corner, in pixels, for the brain to keep clear: inside a region the small
 * brain is drawn there, to click on; seen whole, nothing is.
 */
export const LEGEND_CORNER = { width: 160, whole: 0, region: 120 };

/** The corner the brain keeps clear: only the small brain's, now the rest is above the canvas. */
export const legendCorner = (_groups: number): typeof LEGEND_CORNER =>
  LEGEND_CORNER;

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

// Room on the right of the way back for the chat's bar at the foot of the page.
const BESIDE_CHAT = `calc(100% - 7.5 * ${grasp.space16})`;
// The room between the steps of the way back.
const STEP_GAP = `calc(${grasp.space1} / 2)`;

const styles = stylex.create({
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

/**
 * Above the atlas, the library's Toolbar band: at its start what a dot says, drawn as the brain
 * draws it (filled where something is known, hollow where it is still waiting, in the attention
 * colour where a question is open), each a toggle. Pointing at one lights up the dots that have
 * it, in the brain or the region on screen; a press keeps them lit. At its end, in a region with
 * groups, which group it shows; then the zoom.
 */
export const AtlasToolbar = ({
  spot,
  groups,
  onSpot,
  onZoom,
  onReset,
}: {
  spot?: Spot;
  /** The open region's groups, when it has several. */
  groups?: LegendGroups;
  onSpot: (spot: Spot | undefined) => void;
  /** Closer or further by a factor. */
  onZoom: (factor: number) => void;
  /** Back to how the view puts it. */
  onReset: () => void;
}) => {
  const { t } = useLingui();
  // The mark that is kept lit: what a press chose.
  const [picked, setPicked] = useState<Spot>();
  const marks: { state: Spot; label: string }[] = [
    { state: "known", label: t`Known` },
    { state: "waiting", label: t`Still waiting` },
    { state: "open", label: t`Still open` },
  ];
  const all = "all";
  const total = groups?.total ?? 0;
  return (
    <ToolbarBand
      aria-label={t`The brain's view`}
      end={
        <>
          {groups === undefined ? null : (
            <Select
              items={[
                { value: all, label: t`All (${total})` },
                ...groups.items.map((group) => ({
                  value: group.key,
                  label: `${group.label} (${group.count})`,
                })),
              ]}
              onValueChange={(value) => {
                groups.onSelect(
                  typeof value === "string" && value !== all ? value : undefined
                );
              }}
              value={groups.selected ?? all}
            >
              <SelectTrigger aria-label={t`Show`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          )}
          <ButtonGroup aria-label={t`Zoom`} size="sm">
            <ButtonGroupButton
              aria-label={t`Zoom out`}
              icon={Minus}
              onClick={() => {
                onZoom(1 / 1.25);
              }}
            />
            <ButtonGroupButton
              aria-label={t`Zoom in`}
              icon={Plus}
              onClick={() => {
                onZoom(1.25);
              }}
            />
            <ButtonGroupButton
              aria-label={t`Fit and center`}
              icon={Fit}
              onClick={onReset}
            />
          </ButtonGroup>
        </>
      }
      start={
        <ToggleGroup
          aria-label={t`Light up the dots`}
          onValueChange={(chosen: unknown[]) => {
            const next = marks.find((mark) => mark.state === chosen[0])?.state;
            setPicked(next);
            onSpot(next);
          }}
          size="sm"
          value={picked === undefined ? [] : [picked]}
        >
          {marks.map((mark) => (
            // Pointing shows its dots for a moment; a press keeps them lit until it is pressed again.
            <Toggle
              key={mark.state}
              onBlur={() => {
                onSpot(picked);
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
              value={mark.state}
              {...(spot === mark.state ? { "data-lit": "" } : {})}
            >
              <Mark state={mark.state} />
              {mark.label}
            </Toggle>
          ))}
        </ToggleGroup>
      }
    />
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

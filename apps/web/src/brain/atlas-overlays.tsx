import { Button } from "@grasp-os/ui/components/button";
import { ButtonGroup } from "@grasp-os/ui/components/button-group";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Icon, MinusIcon, PlusIcon, ScanIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { RegionGroup } from "./atlas-map.ts";
import { Mark } from "./region-marks.tsx";

/**
 * What stands round the atlas, out of the brain's way, as in the prototype (grasplabs/prototype,
 * packages/grasp: components/knowledge/atlas-overlays.tsx), on the library's parts: above it a
 * row, with what a dot says at its start (pointing lights those dots, a press keeps them
 * lit) and at its end a region's groups to narrow it to and the zoom. The way back is the
 * sidebar's and the bar's crumbs. The chat has the bottom centre (chat/global-chat.tsx).
 */

const styles = stylex.create({
  // One row at every width: the legend at the start, the zoom pinned at the end. The library's
  // Toolbar band stacks its halves below 40rem, which put the three zoom buttons on a row of their
  // own beside a docked chat; a map's legend and zoom belong on one line.
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
    minWidth: 0,
  },
  // Where even the legend's words don't fit (a phone), it scrolls sideways rather than wrap:
  // its marks stay on one line, as wide as they are, as #2503's legend keeps them.
  legend: { minWidth: 0, overflowX: "auto", scrollbarWidth: "none" },
  oneLine: { width: "max-content", maxWidth: "none" },
  end: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
  },
});

/** Which dots a mark of the legend stands for. */
export type Spot = "known" | "waiting" | "open";

/**
 * The canvas's top left corner, in pixels, for the brain to keep clear: inside a region the small
 * brain is drawn there, to click on; seen whole, nothing is.
 */
const LEGEND_CORNER = { width: 160, whole: 0, region: 120 };

/** The corner the brain keeps clear: only the small brain's, now the rest is above the canvas. */
export const legendCorner = (_groups: number): typeof LEGEND_CORNER =>
  LEGEND_CORNER;

/** A region's groups, to narrow it to one: the tools people named, the employee interviews. */
interface LegendGroups {
  items: RegionGroup[];
  /** How many notes the region shows in all. */
  total: number;
  /** The group it is narrowed to, by its key; none for all of it. */
  selected?: string;
  onSelect: (key: string | undefined) => void;
}

/**
 * Above the atlas, one row: at its start what a dot says, drawn as the brain
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
    <div
      aria-label={t`The brain's view`}
      role="toolbar"
      {...stylex.props(styles.row)}
    >
      <div {...stylex.props(styles.legend)}>
        <ToggleGroup
          aria-label={t`Light up the dots`}
          onValueChange={(chosen: unknown[]) => {
            const next = marks.find((mark) => mark.state === chosen[0])?.state;
            setPicked(next);
            onSpot(next);
          }}
          size="xs"
          style={styles.oneLine}
          value={picked === undefined ? [] : [picked]}
        >
          {marks.map((mark) => (
            // Pointing shows its dots for a moment; a press keeps them lit until it is pressed again.
            <ToggleGroupItem
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
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div {...stylex.props(styles.end)}>
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
        <ButtonGroup aria-label={t`Zoom`}>
          <Button
            aria-label={t`Zoom out`}
            onClick={() => {
              onZoom(1 / 1.25);
            }}
            size="icon-sm"
            variant="ghost"
          >
            <Icon icon={MinusIcon} />
          </Button>
          <Button
            aria-label={t`Zoom in`}
            onClick={() => {
              onZoom(1.25);
            }}
            size="icon-sm"
            variant="ghost"
          >
            <Icon icon={PlusIcon} />
          </Button>
          <Button
            aria-label={t`Fit and center`}
            onClick={onReset}
            size="icon-sm"
            variant="ghost"
          >
            <Icon icon={ScanIcon} />
          </Button>
        </ButtonGroup>
      </div>
    </div>
  );
};

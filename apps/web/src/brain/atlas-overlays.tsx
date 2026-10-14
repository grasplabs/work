import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type { AtlasView } from "./atlas-canvas.tsx";
import type { RegionGroup } from "./atlas-map.ts";
import { Mark } from "./region-marks.tsx";

/**
 * What sits in the corners of the atlas, out of the brain's way, as in the prototype
 * (grasplabs/prototype, packages/grasp: components/knowledge/atlas-overlays.tsx): top left what a
 * dot says, under the small brain when a region is open, and above it the region's groups to
 * narrow it to; with the zoom under it. Bottom left the way you came, to step back along. The
 * chat has the bottom right (chat/chat-dock.tsx). Nothing takes a side of the screen.
 */

/** Which dots a mark of the legend stands for. */
export type Spot = "known" | "waiting" | "open";

/**
 * The corner of the canvas the legend takes, in pixels, with a little air, for the brain to keep
 * clear: how wide it is, and how high, seen whole and in a region, where the small brain sits in
 * its upper part. From the panel's own classes below.
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

const rowClass =
  "flex items-center gap-2 rounded-md px-2 py-1 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50";

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
    // One small panel, top left: inside a region the small brain is drawn in its upper part, to click on; under it the marks, and the zoom.
    <div
      className={cn(
        "pointer-events-none absolute top-3 left-3 flex w-40 flex-col rounded-xl border p-1.5 text-sm transition-all duration-500 *:pointer-events-auto",
        under && "pt-25",
        groups && "w-60"
      )}
    >
      {groups ? (
        <fieldset
          aria-label={t`Show`}
          className="mb-1.5 flex flex-col border-b pb-1.5"
        >
          {[
            { key: undefined, label: t`All`, count: groups.total },
            ...groups.items,
          ].map((group) => (
            <button
              aria-pressed={groups.selected === group.key}
              className={cn(
                rowClass,
                groups.selected === group.key && "bg-accent font-medium"
              )}
              key={group.key ?? "all"}
              onClick={() => {
                groups.onSelect(group.key);
              }}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate" title={group.label}>
                {group.label}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {group.count}
              </span>
            </button>
          ))}
        </fieldset>
      ) : null}
      {marks.map((mark) => (
        // Pointing shows its dots for a moment; a click keeps them lit until it is clicked again, so they can be gone over one by one.
        <button
          aria-pressed={picked === mark.state}
          className={cn(
            rowClass,
            spot === mark.state && "bg-accent",
            picked === mark.state && "font-medium"
          )}
          key={mark.state}
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
          type="button"
        >
          <Mark state={mark.state} />
          {mark.label}
        </button>
      ))}
      <div className="mt-1.5 flex justify-between border-t pt-1.5">
        <Button
          aria-label={t`Zoom out`}
          onClick={() => {
            onZoom(1 / 1.25);
          }}
          size="icon-sm"
          variant="ghost"
        >
          <MinusIcon />
        </Button>
        <Button
          aria-label={t`Zoom in`}
          onClick={() => {
            onZoom(1.25);
          }}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
        <Button
          aria-label={t`Fit and center`}
          onClick={onReset}
          size="icon-sm"
          variant="ghost"
        >
          <MaximizeIcon />
        </Button>
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
        className="absolute bottom-3 left-3 max-w-[calc(100%-30rem)] min-w-0 max-md:hidden"
      >
        <Button
          aria-label={t`Back to ${destination}`}
          className="max-w-full"
          onClick={() => {
            onGo(previous.view);
          }}
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
          <span className="truncate">{previous.label}</span>
        </Button>
      </nav>
    );
  }
  return (
    <nav
      aria-label={t`Where you are in the brain`}
      className="absolute bottom-3 left-3 flex max-w-[calc(100%-30rem)] min-w-0 items-center gap-1 text-sm max-md:bottom-16 max-md:max-w-[calc(100%-1.5rem)]"
    >
      <Button
        onClick={() => {
          onGo(previous.view);
        }}
        size="sm"
        variant="ghost"
      >
        <ArrowLeftIcon />
        <Trans>Back</Trans>
      </Button>
      <ol className="flex min-w-0 items-center gap-0.5 overflow-hidden">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          return (
            <li
              className={cn(
                "flex items-center gap-0.5",
                last ? "min-w-0" : "flex-none max-md:hidden"
              )}
              key={step.label}
            >
              {index > 0 ? (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="text-muted-foreground size-3.5 flex-none"
                />
              ) : null}
              {last ? (
                <span aria-current="page" className="truncate px-2 font-medium">
                  {step.label}
                </span>
              ) : (
                <Button
                  onClick={() => {
                    onGo(step.view);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <span className="truncate">{step.label}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

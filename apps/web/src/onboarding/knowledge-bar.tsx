import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { Fragment, useSyncExternalStore } from "react";

import { dotsOf } from "./setup.ts";
import type { KnownDot } from "./setup.ts";

// What Grasp knows, as a bar of dots split by where it comes from: dark for
// what is in, grey for what is still to come, the next dot breathing.
// Explained large on "How this works"; after it, it keeps count at the top
// of the screen. From the prototype's
// `components/onboarding/onboarding-knowledge.tsx`.

/** What Grasp knows: by source, in all, and where the team can start. */
export interface Knowledge {
  parts: readonly { weight: number; known: number }[];
  percent: number;
  /** Where the team can start, in percent. */
  threshold: number;
}

/**
 * How many dots the bar has: 40 where there is room, 20 on a phone. 40 with
 * the percentage beside them take about 515 pixels, so they need a screen of
 * 36rem with its margins. Every source weighs a multiple of 5%, so at 20
 * each still has dots of its own.
 */
const roomy = "(min-width: 36rem)";

const onRoomy = (listener: () => void): (() => void) => {
  const media = window.matchMedia(roomy);
  media.addEventListener("change", listener);
  return () => {
    media.removeEventListener("change", listener);
  };
};

const useDotCount = (): number =>
  useSyncExternalStore(
    onRoomy,
    () => (window.matchMedia(roomy).matches ? 40 : 20),
    () => 40
  );

const dotClass = {
  filled: "bg-foreground block rounded-full transition-colors duration-500",
  next: "bg-muted-foreground block animate-pulse rounded-full transition-colors duration-500",
  empty: "bg-border block rounded-full transition-colors duration-500",
} as const;

const lookOf = (dot: KnownDot, breathing: boolean): string => {
  if (dot.filled) {
    return dotClass.filled;
  }
  return breathing && dot.next ? dotClass.next : dotClass.empty;
};

/** The dots, with the mark where the team can start raised a little towards the words above. */
const Dots = ({
  dots,
  cut,
  gate,
  breathing,
}: {
  dots: KnownDot[];
  cut: number;
  gate: boolean;
  breathing: boolean;
}) => (
  <>
    {dots.map((dot, at) => (
      <Fragment key={at}>
        {at === cut ? (
          <span
            className={cn(
              "bg-foreground mx-1 block h-4 w-px shrink-0 -translate-y-1 transition-opacity duration-700",
              !gate && "opacity-0"
            )}
          />
        ) : null}
        <span
          className={cn(
            "aspect-square w-1.5",
            dot.first && "ml-1.5",
            lookOf(dot, breathing)
          )}
        />
      </Fragment>
    ))}
  </>
);

/**
 * The bar at full size, as the story on "How this works" tells it: `shown`
 * is how much of each source's dots are dark right now. Where the team can
 * start appears with `gate`. The dots run the full width, so they end under
 * the words above them.
 */
export const KnowledgeBar = ({
  parts,
  threshold,
  gate,
  caption,
}: {
  parts: readonly { weight: number; known: number }[];
  threshold: number;
  gate: boolean;
  /** What the bar says above it, on the left. */
  caption?: string;
}) => {
  const { t } = useLingui();
  const dots = dotsOf(parts, useDotCount());
  const cut = Math.round((threshold / 100) * dots.length);
  return (
    <div className="flex w-full flex-col gap-4 overflow-x-clip text-left">
      {/* Side by side where both fit; on a phone, in a longer language, where the team can start goes under. */}
      <div className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-4">
        <span className="animate-in fade-in font-medium duration-400">
          {caption}
        </span>
        <span
          className={cn(
            "text-muted-foreground transition-opacity duration-600",
            !gate && "opacity-0"
          )}
        >
          {t`Your team can start at ${threshold}%`}
        </span>
      </div>
      <div
        aria-hidden="true"
        className="flex items-center justify-between gap-1"
      >
        <Dots breathing={false} cut={cut} dots={dots} gate={gate} />
      </div>
    </div>
  );
};

/**
 * The bar at the top of every step after "How this works": how much Grasp
 * knows, and on hover what that means.
 */
export const KnowledgeCorner = ({ parts, percent, threshold }: Knowledge) => {
  const { t } = useLingui();
  const dots = dotsOf(parts, useDotCount());
  const gate = Math.round((threshold / 100) * dots.length);
  return (
    // On a screen too narrow even for 20 dots, the dots grow smaller with it, still round, and the percentage keeps its size.
    <div className="animate-in fade-in min-w-0 duration-500">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={t`${percent}% known. Your team can start at ${threshold}%.`}
              className="focus-visible:ring-ring/50 flex max-w-full items-center gap-2.5 rounded-full px-2 py-1 outline-none focus-visible:ring-3"
              type="button"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1">
            <Dots breathing cut={gate} dots={dots} gate />
          </span>
          <span className="tabular-nums">{percent}%</span>
        </TooltipTrigger>
        <TooltipContent>
          {t`${percent}% known. Your team can start at ${threshold}%, and I keep learning after that.`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

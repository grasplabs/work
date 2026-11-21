import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useSyncExternalStore } from "react";

import { focus } from "../grasp/focus/focus.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../grasp/tooltip/index.ts";
import { comeIn, motion } from "./motion.ts";
import { useArrives } from "./setup-parts.tsx";
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
  const query = window.matchMedia(roomy);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
};

const useDotCount = (): number =>
  useSyncExternalStore(
    onRoomy,
    () => (window.matchMedia(roomy).matches ? 40 : 20),
    () => 40
  );

/** Where the corner's name shows beside its dots. */
const ROOMY = "@media (min-width: 64rem)";

const breathe = stylex.keyframes({
  "50%": { opacity: 0.4 },
});

const styles = stylex.create({
  dot: {
    display: "block",
    flexShrink: 1,
    aspectRatio: "1",
    width: "0.375rem",
    borderRadius: "50%",
    transitionProperty: "background-color",
    transitionDuration: grasp.durationArrive,
    transitionTimingFunction: grasp.ease,
  },
  filled: { backgroundColor: grasp.ink },
  empty: { backgroundColor: grasp.line },
  next: {
    backgroundColor: grasp.muted,
    animationName: { default: breathe, [media.reduced]: "none" },
    animationDuration: "2s",
    animationIterationCount: "infinite",
    animationTimingFunction: grasp.easeInOut,
  },
  first: { marginInlineStart: "0.375rem" },
  // Where the team can start: a line raised a little towards the words above.
  gate: {
    display: "block",
    flexShrink: 0,
    width: grasp.hairline,
    height: "1rem",
    marginInline: grasp.space1,
    transform: "translateY(-0.25rem)",
    backgroundColor: grasp.ink,
    transitionProperty: "opacity",
    transitionDuration: grasp.durationArrive,
    transitionTimingFunction: grasp.ease,
  },
  hidden: { opacity: 0 },
  bar: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    width: "100%",
    overflowX: "clip",
    textAlign: "start",
  },
  // Side by side where both fit; on a phone, in a longer language, where the team can start goes under.
  words: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    minHeight: "1.25rem",
  },
  dots: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space1,
  },
  gateWords: {
    transitionProperty: "opacity",
    transitionDuration: grasp.durationArrive,
    transitionTimingFunction: grasp.ease,
  },
  corner: { minWidth: 0 },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    maxWidth: "100%",
    paddingInline: grasp.space2,
    paddingBlock: grasp.space1,
    borderWidth: 0,
    borderRadius: "999px",
    backgroundColor: "transparent",
    color: grasp.text,
    font: "inherit",
    cursor: "default",
  },
  name: {
    display: { default: "none", [ROOMY]: "inline" },
    whiteSpace: "nowrap",
  },
  cornerDots: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
  },
  percent: { fontVariantNumeric: "tabular-nums" },
});

const lookOf = (dot: KnownDot, breathing: boolean) => {
  if (dot.filled) {
    return styles.filled;
  }
  return breathing && dot.next ? styles.next : styles.empty;
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
          <span {...stylex.props(styles.gate, !gate && styles.hidden)} />
        ) : null}
        <span
          {...stylex.props(
            styles.dot,
            dot.first && styles.first,
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
  const captionArrives = useArrives(caption ?? "");
  return (
    <div {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.words)}>
        <span {...comeIn(captionArrives, motion.fade)}>
          <Text element="span" weight="medium">
            {caption}
          </Text>
        </span>
        <span {...stylex.props(styles.gateWords, !gate && styles.hidden)}>
          <Text element="span" tone="muted">
            {t`Your team can start at ${threshold}%`}
          </Text>
        </span>
      </div>
      <div aria-hidden="true" {...stylex.props(styles.dots)}>
        <Dots breathing={false} cut={cut} dots={dots} gate={gate} />
      </div>
    </div>
  );
};

/**
 * The bar at the top of every step after "How this works": how much Grasp
 * knows of the organization, named as such beside it, and on hover what
 * that means. It is not how far the admin is through the steps (the dots
 * at the bottom say that), so it says so: it fills as the documents come
 * in and the team talks, long after the steps are done.
 */
export const KnowledgeCorner = ({ parts, percent, threshold }: Knowledge) => {
  const { t } = useLingui();
  const dots = dotsOf(parts, useDotCount());
  const gate = Math.round((threshold / 100) * dots.length);
  return (
    // On a screen too narrow even for 20 dots, the dots grow smaller with it, still round, and the percentage keeps its size; the name makes way first.
    <div {...stylex.props(styles.corner)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={t`What I know about your organization: ${percent}%. This is not how far you are in these steps. Your team can start at ${threshold}%.`}
              type="button"
              {...stylex.props(styles.trigger, focus.ring)}
            />
          }
        >
          <span {...stylex.props(styles.name)}>
            <Text element="span" size="sm" tone="muted">
              {t`Known about your organization`}
            </Text>
          </span>
          <span {...stylex.props(styles.cornerDots)}>
            <Dots breathing cut={gate} dots={dots} gate />
          </span>
          <span {...stylex.props(styles.percent)}>{percent}%</span>
        </TooltipTrigger>
        <TooltipContent>
          {t`How much I know about your organization, not how far you are in these steps. It grows as you share and as I talk to your team. Your team can start at ${threshold}%, and I keep learning after that.`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

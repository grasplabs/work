// Highlight: one figure that matters, with its name and how it moved, after Profound's Palermo
// (Highlights): the name small and quiet over the value, the change beside it in its tone, and an
// icon at the end of the name when it helps. There is no shadcn original; it is plain HTML.
//
//   <Highlight title="Revenue" value="€45,678" change="+8.2%" tone="success" />
//   <Highlight title="Open tickets" value="12" loading />
//
// It says, it does not do: nothing in it is pressed. Every value is a token (src/tokens).
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../icons";
import type { IconData } from "../icons";
import { arrive } from "../motion/arrive";
import { Skeleton } from "../skeleton";
import { highlightStyles as styles } from "./styles";

/** @deprecated Use `StatTone`, from `@/components/grasp/stats`. */
export type HighlightTone =
  | "neutral"
  | "success"
  | "danger"
  | "attention"
  | "info";

/** Every prop a Highlight takes. @deprecated Use `StatProps`, from `@/components/grasp/stats`. */
export interface HighlightProps {
  /** What the figure is, in a word or two ("Revenue", "Active users"). */
  title: string;
  /** The figure itself, formatted for reading ("€45,678", "3.45%"). */
  value: string;
  /** How it moved, beside the value ("+8.2%", "−3 since Monday"). */
  change?: string;
  /**
   * What the change means, in colour: `success` good, `danger` bad, `attention` worth a look,
   * `info` a plain note, `neutral` no judgement. Rising is not always good: a rise in returns is
   * `danger`. The words say it too.
   * @default "neutral"
   */
  tone?: HighlightTone;
  /** An icon at the end of the title, in muted. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * Still loading: skeletons hold the value's and the change's room, so nothing moves when they
   * arrive.
   * @default false
   */
  loading?: boolean;
  /**
   * A small chart under the figures: a ChartSpark at its tile size, the figure's trend. With its
   * `onPoint`, the value it shows can follow the point under the pointer.
   */
  chart?: ReactNode;
}

/** One highlight's insides, drawn alone or in a grid's cell, with the id that names it. */
export const useHighlightBody = ({
  title,
  value,
  change,
  tone = "neutral",
  icon,
  loading = false,
  chart,
}: HighlightProps) => {
  const id = useId();
  // Figures that replace the placeholders fade in; ones there from the first paint are simply there.
  // Remembered as state, set the first time it loads (React's way of keeping what a render saw).
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) {
    setWaited(true);
  }
  const arrived = waited && !loading;
  return {
    id,
    body: (
      <>
        <div {...stylex.props(styles.head)}>
          <p id={id} {...stylex.props(styles.title)}>
            {title}
          </p>
          {icon && (
            <span aria-hidden="true" {...stylex.props(styles.icon)}>
              <Icon icon={icon} />
            </span>
          )}
        </div>
        {loading ? (
          <div {...stylex.props(styles.figures)}>
            <Skeleton variant="block" layout={styles.skeletonValue} />
            {change !== undefined && (
              <Skeleton layout={styles.skeletonChange} />
            )}
          </div>
        ) : (
          <p {...stylex.props(styles.figures, arrived && arrive.in)}>
            <span {...stylex.props(styles.value)}>{value}</span>
            {change !== undefined && change !== "" ? (
              <span {...stylex.props(styles.change, styles[tone])}>
                {change}
              </span>
            ) : null}
          </p>
        )}
        {chart !== undefined && (
          <div {...stylex.props(styles.chart)}>{chart}</div>
        )}
      </>
    ),
  };
};

/** One highlight: a card on its own. Put several in a HighlightsGrid to read them as one row. @deprecated Use `Stat`, from `@/components/grasp/stats`. */
export const Highlight = (props: HighlightProps) => {
  const { id, body } = useHighlightBody(props);
  return (
    <section
      aria-labelledby={id}
      aria-busy={props.loading === true ? true : undefined}
      {...stylex.props(styles.card, styles.alone)}
    >
      {body}
    </section>
  );
};

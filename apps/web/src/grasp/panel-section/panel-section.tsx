// PanelSection: one section of an inspector panel, after Profound's agent panel. Always the same
// three things: a quiet label (with a dashed underline when it explains itself in a tooltip), one
// quiet action at the end of the label's row, and one card under it. Empty, the card is one row
// that adds the first. The label's words stand on the same line as the words in the card's rows.
//
//   <PanelSection label="Tools" hint="What the agent may use while it works." action={<RowListAction icon={Plus}>Add</RowListAction>}>
//     <RowList>...</RowList>
//   </PanelSection>
//   <PanelSection label="Triggers" empty="Add trigger" onAdd={openTriggers} />
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { TooltipTrigger as TriggerPrimitive } from "@ui-sdk/react/tooltip";
import { useId } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import type { LayoutStyle } from "../layout/layout";
import { RowList, RowListAdd } from "../row-list";
import { grasp, media } from "../tokens/tokens.stylex";
import { Tooltip, TooltipContent } from "../tooltip";

/** What a caller may style: where the section sits. Never its look. */
export type PanelSectionLayoutStyle = LayoutStyle;

/** What every section takes. */
interface PanelSectionBase {
  /** Its name, a word or two in sentence case, on one line ("Triggers"). */
  label: string;
  /**
   * One sentence that says what the section is for, in a tooltip on the label, which then wears a
   * dashed underline ("What starts this agent: a schedule, an event or a person.").
   */
  hint?: string;
  /** At the end of the label's row: one quiet action, a RowListAction ("Add") or a two-way ToggleGroup. */
  action?: ReactNode;
  /**
   * The heading level of the label, under the panel's own title.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4;
  /** @deprecated Use `headingLevel`. */
  level?: 2 | 3 | 4;
  /** @deprecated Use `layout`. */
  style?: PanelSectionLayoutStyle;
  /** Layout only: margins. */
  layout?: PanelSectionLayoutStyle;
}

/**
 * A section with something in it.
 */
interface WithContent {
  /** What the card holds: a RowList, or a long text, or fields. */
  children: ReactNode;
  /**
   * Draw the card round the children. Off for children that draw their own.
   * @default true
   */
  card?: boolean;
  empty?: never;
  onAdd?: never;
}

/**
 * A section with nothing in it yet: the card is one row that adds the first.
 */
interface Empty {
  children?: never;
  card?: never;
  /** The words of the row that adds the first one ("Add trigger"). */
  empty: string;
  /** Runs when that row is pressed. */
  onAdd?: () => void;
}

/** Every prop a PanelSection takes. */
export type PanelSectionProps = PanelSectionBase & (WithContent | Empty);

const styles = stylex.create({
  section: {
    display: "grid",
    rowGap: grasp.inspectorLabelGap,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // The label row: 28px, its words inset as far as the card's rows' words.
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
    boxSizing: "border-box",
    height: grasp.controlXs,
    minWidth: 0,
    paddingInlineStart: grasp.inspectorInset,
  },
  // One line, never clipped: a hinted label's 44px target reaches past its words.
  label: {
    margin: 0,
    whiteSpace: "nowrap",
    fontSize: grasp.inspectorText,
    lineHeight: grasp.inspectorTextLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  // The label that explains itself: a dashed underline, a step under the words.
  // Its box stands a step out round the words, into its own margin, so the ring keeps off the
  // letters and clears the dashed underline; the line it sits in stays the same.
  hinted: {
    margin: `calc(-1 * ${grasp.ringOffsetWords})`,
    padding: grasp.ringOffsetWords,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: "inherit",
    cursor: "help",
    position: "relative",
    // Its target: the label row's 28px, and a finger's 44px on touch, drawn unseen.
    "::after": {
      content: '""',
      position: "absolute",
      // A short label ("Owner") is narrower than a finger: the target grows to 44px either side.
      left: {
        default: 0,
        [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
      },
      right: {
        default: 0,
        [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
      },
      // Longhands: StyleX drops the inset-block shorthand.
      top: {
        default: `calc((${grasp.inspectorTextLine} - ${grasp.controlXs}) / 2 + ${grasp.ringOffsetWords})`,
        [media.coarse]: `calc((${grasp.inspectorTextLine} - ${grasp.tap}) / 2 + ${grasp.ringOffsetWords})`,
      },
      bottom: {
        default: `calc((${grasp.inspectorTextLine} - ${grasp.controlXs}) / 2 + ${grasp.ringOffsetWords})`,
        [media.coarse]: `calc((${grasp.inspectorTextLine} - ${grasp.tap}) / 2 + ${grasp.ringOffsetWords})`,
      },
    },
    textDecorationLine: "underline",
    textDecorationStyle: "dashed",
    textDecorationColor: grasp.quiet,
    textDecorationThickness: grasp.hairline,
    textUnderlineOffset: grasp.inspectorDashOffset,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
  },
  end: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
  },
  card: {
    minWidth: 0,
    overflow: "clip",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftMedium,
    // Forced colours drop the lift: a line keeps the card.
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
  },
});

const headings = { 2: "h2", 3: "h3", 4: "h4" } as const;

/** The label's words: a button that opens its hint in a tooltip, or the words alone. */
const Words = ({
  label,
  hint,
}: {
  label: string;
  hint: string | undefined;
}) => {
  if (hint === undefined || hint === "") {
    return label;
  }
  return (
    <Tooltip>
      <TriggerPrimitive
        render={(trigger: Record<string, unknown>) => (
          <button
            {...trigger}
            type="button"
            {...stylex.props(styles.hinted, focus.words)}
          >
            {label}
          </button>
        )}
      />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
};

/** The card under the label: what it holds, or one row that adds the first. */
const Card = ({ props, id }: { props: PanelSectionProps; id: string }) => (
  <div data-slot="panel-section-card" {...stylex.props(styles.card)}>
    {props.empty === undefined ? (
      props.children
    ) : (
      <RowList aria-labelledby={id}>
        <RowListAdd onPress={props.onAdd}>{props.empty}</RowListAdd>
      </RowList>
    )}
  </div>
);

/** One section of an inspector: label, one action, one card. */
export const PanelSection = (props: PanelSectionProps) => {
  const {
    label,
    hint,
    action,
    level: levelDeprecated,
    headingLevel: level = levelDeprecated ?? 3,
    style: styleProp,
    layout,
  } = props;
  const id = useId();
  const Heading = headings[level];
  const hasAction = action !== undefined && action !== null && action !== false;
  return (
    <section
      aria-labelledby={id}
      data-slot="panel-section"
      {...stylex.props(styles.section, layout ?? styleProp)}
    >
      <div data-slot="panel-section-head" {...stylex.props(styles.head)}>
        <Heading id={id} {...stylex.props(styles.label)}>
          <Words label={label} hint={hint} />
        </Heading>
        {hasAction && <div {...stylex.props(styles.end)}>{action}</div>}
      </div>
      {props.empty === undefined && props.card === false ? (
        props.children
      ) : (
        <Card props={props} id={id} />
      )}
    </section>
  );
};

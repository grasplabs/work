// Trace: a list of lines for the steps an assistant takes, from shadcn's (registry/bases/base/ui/
// trace.tsx), converted from Tailwind to StyleX and built on UI SDK's Collapsible with the shared
// disclosure styles, in the look Damsko's AI parts share: a step's mark in its seat, a quiet line of
// fine pixels joining the marks, the title and a muted description, and a quiet trigger row that opens.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Trace>
//     <TraceLine>
//       <TraceIcon />
//       <TraceTitle>Searched the web</TraceTitle>
//       <TraceDescription>pricing pages</TraceDescription>
//     </TraceLine>
//     <TraceLine status="running">
//       <TraceIcon />
//       <TraceTitle>Reading brief.md</TraceTitle>
//     </TraceLine>
//   </Trace>
//
//   <Trace>
//     <TraceCollapsible>
//       <TraceCollapsibleTrigger>
//         <TraceLine><TraceTitle>Searched 3 times</TraceTitle></TraceLine>
//       </TraceCollapsibleTrigger>
//       <TraceCollapsibleContent>…</TraceCollapsibleContent>
//     </TraceCollapsible>
//   </Trace>
//
// A line straight inside a Trace is a step: a step apart from the next, its first TraceIcon in a
// seat at its start (the mark's width and space-3), so words that wrap stay clear of it, and the
// dots running down from its mark to the next step's mark. A line inside a TraceCollapsibleTrigger
// is the trigger's words, the original's activity line: its mark beside its title, a space-2 apart,
// at the text's own weight and line, muted until the pointer is on it or it is open, as tall as a
// small control. The trigger's words stand on the column's edge, where the panel's lines and
// surfaces start; its fill under the pointer reaches past them by its own padding. In a card that
// carries traceCardMarker (Tool's) the trigger runs the card's width and takes no fill: its words
// turn to ink, as a step that opens did in the original. A TraceIcon with nothing in it is the
// status mark: a dot, the alert when the step failed. A running title shimmers (Shimmer) in ink, a
// failed one stands in the body's ink beside its red mark. Each status is said in words after the
// line, not only by its mark and colour.
//
// What is said aloud, through the page's live region: a line is said once, when its status changes
// after it was drawn, to done (no status) from running or pending, or to error from anything else.
// It is never said because it appeared: lines drawn with the Trace, lines added later (a to-do, a
// step that arrives already done) and a trigger's line are silent until their status changes.
// Nesting changes nothing: each line keeps to the rule on its own. Lines whose status changes in one
// render are said together, in one announcement. Every value is a token. A caller may set layout
// only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Collapsible as CollapsiblePrimitive,
  CollapsiblePanel,
  CollapsibleTrigger as CollapsibleTriggerPrimitive,
} from "@ui-sdk/react/collapsible";
import {
  createContext,
  createElement,
  isValidElement,
  use,
  useEffect,
  useRef,
} from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { ChevronDownIcon, CircleAlertIcon, Icon } from "../lib/icons";
import {
  disclosureStyles,
  focusRing,
  tapTarget,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { announce, className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, ringInsetMarker, traceCardMarker } from "../lib/vars.stylex";
import { Shimmer } from "./shimmer";

/** Where the work a line reports stands: `running` under way, `error` failed, `pending` not begun. Without one it is done. */
export type TraceLineStatus = "running" | "error" | "pending";

/** Every prop a Trace takes. */
export interface TraceProps {
  /** Its rows: TraceLine, TraceCollapsible, or a link or a dialog's trigger round a TraceLine. */
  children: ReactNode;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a TraceLine takes. */
export interface TraceLineProps {
  /** Its TraceIcon, TraceTitle and TraceDescription, and anything else that stands in the line (a Badge). */
  children: ReactNode;
  /** Where the work it reports stands. Without one it is done. */
  status?: TraceLineStatus;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a TraceIcon takes. */
export interface TraceIconProps {
  /** The mark: an Icon. Without one, the line's status mark: a dot, or the alert when it failed. */
  children?: ReactNode;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a TraceTitle takes. */
export interface TraceTitleProps {
  /** What happened, as a sentence in the tense of its status ("Searched the web", "Searching the web"). Text shimmers while the line runs. */
  children: ReactNode;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a TraceDescription takes. */
export interface TraceDescriptionProps {
  /** A quiet note after the title: a count, a duration, a diff's lines. */
  children: ReactNode;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a TraceCollapsible takes. */
export interface TraceCollapsibleProps {
  /** Its TraceCollapsibleTrigger, then its TraceCollapsibleContent. */
  children: ReactNode;
  /** Whether it is open. Pass it with `onOpenChange` to control it. */
  open?: boolean;
  /**
   * Whether it starts open, when you do not control it.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs with the new state when the trigger is pressed. */
  onOpenChange?: (open: boolean) => void;
  /**
   * The trigger does nothing; it stays focusable.
   * @default false
   */
  disabled?: boolean;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a TraceCollapsibleTrigger takes. */
export interface TraceCollapsibleTriggerProps {
  /** Its TraceLine. With `asChild`, the one element drawn as the trigger. */
  children: ReactNode;
  /**
   * Draws its one child element as the trigger, with the trigger's behaviour and none of its look
   * or chevron.
   * @default false
   */
  asChild?: boolean;
  /** Layout only: where it sits and how much room it takes (`justifySelf: "stretch"` for a row as wide as its box). */
  style?: LayoutStyle;
}

/** Every prop a TraceCollapsibleContent takes. */
export interface TraceCollapsibleContentProps {
  /** What the panel holds: more lines in a Trace, a code block, the thoughts. */
  children: ReactNode;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;
const HOVER = media.hover;
const OPEN = ":is([aria-expanded=true])";
const OFF = ":is([data-disabled])";

// The seat a line's first mark sits in, and the room after it before the words: one for steps and
// trigger lines alike, so every title in a column starts at one edge.
const SEAT = `calc(${size.iconSm} + ${space["3"]})`;
// How far a small control's height stands past a line of words, on each side.
const ROOM = `(${size.controlSm} - ${font.textSmLine}) / 2`;
// Half the line's leading: how far a mark's drawing stands inside its one-line-high seat.
const LEADING = `(1lh - ${size.iconSm}) / 2`;

// A step arriving: it fades in, a little lower first. With reduced motion it is simply there.
const arrive = stylex.keyframes({
  from: { opacity: 0, transform: `translateY(${space["1"]})` },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  trace: {
    display: "grid",
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  // A line: its mark in its seat, its words and whatever stands beside them, wrapping where there
  // is no room; a long title wraps beside its mark rather than under it.
  line: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: space["2"],
    rowGap: space["1"],
    minWidth: 0,
    paddingInlineStart: {
      default: 0,
      ":has(> [data-slot=trace-icon]:first-child)": SEAT,
    },
  },
  // A step: a step apart from the next.
  step: {
    rowGap: 0,
    paddingBlock: space["2"],
    animationName: { default: arrive, [REDUCED]: "none" },
    animationDuration: duration.ui,
    animationTimingFunction: duration.ease,
    animationFillMode: "backwards",
  },
  icon: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: size.iconSm,
    color: colors.mutedForeground,
  },
  iconRunning: { color: colors.foreground },
  iconError: { color: colors.destructive },
  // A line's first mark, in its seat: one line high, level with the first line of its words.
  seat: {
    position: { default: null, ":first-child": "absolute" },
    insetInlineStart: { default: null, ":first-child": 0 },
    top: { default: null, ":first-child": 0 },
    height: { default: null, ":first-child": "1lh" },
  },
  seatStep: {
    top: { default: null, ":first-child": space["2"] },
  },
  // The joining line, from under a step's first mark to the next step's, clear of both by
  // space-1: a line of square pixels, as wide as they are tall, one in every space-1, faint ahead
  // of the work and drawn in muted ink once the step is done. None under the last row.
  join: {
    position: "absolute",
    display: {
      default: "none",
      ":is([data-slot=trace-line]:has(> [data-slot=trace-icon]:first-child):not(:last-child) > *)":
        "block",
    },
    insetInlineStart: `calc(${size.iconSm} / 2 - ${size.hairline})`,
    top: `calc(${space["2"]} + 1lh - ${LEADING} + ${space["1"]})`,
    bottom: `calc(${space["1"]} - ${space["2"]} - ${LEADING})`,
    width: `calc(${size.hairline} * 2)`,
    backgroundImage: `linear-gradient(transparent ${size.hairline}, currentColor ${size.hairline} calc(${size.hairline} * 3), transparent 0)`,
    backgroundSize: `100% ${space["1"]}`,
    color: { default: colors.agentIndicatorRest, [FORCED]: "GrayText" },
    forcedColorAdjust: "none",
  },
  joinDone: {
    color: { default: colors.mutedForeground, [FORCED]: "CanvasText" },
  },
  // The status mark: a dot in the mark's ink, faint while the step waits. An even size, as its seat
  // (icon-sm) and the joining line (two hairlines) are: an odd dot stands half a pixel off the
  // line's middle.
  dot: {
    width: `calc(${space["1"]} + ${space["1"]} / 2)`,
    height: `calc(${space["1"]} + ${space["1"]} / 2)`,
    borderRadius: radius.circle,
    backgroundColor: { default: "currentColor", [FORCED]: "CanvasText" },
    forcedColorAdjust: "none",
  },
  dotPending: {
    backgroundColor: {
      default: colors.agentIndicatorRest,
      [FORCED]: "GrayText",
    },
  },
  // A sentence: on a narrow screen it wraps rather than lose its end.
  title: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  titleRunning: { color: colors.foreground },
  // Failed: the body's ink, the red is its mark's.
  titleError: { color: colors.bodyForeground },
  description: {
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  collapsible: {
    display: "grid",
    width: "100%",
    minWidth: 0,
  },
  // A row that opens among steps: as tall as a step, its mark where a step's stands, so the dots
  // from the step before reach it.
  collapsibleStep: {
    paddingBlock: {
      default: 0,
      ":not(:only-child)": `calc(${space["2"]} - ${ROOM})`,
    },
  },
  // The trigger: the original's activity line, only as wide as its line and chevron (a card's width
  // in a card), at the text's own weight and line, muted until the pointer is on it or it is open,
  // as tall as a small control. Its fill under the pointer reaches past its words by its padding;
  // in a card it takes none.
  trigger: {
    justifySelf: {
      default: "start",
      [stylex.when.ancestor(":is(*)", traceCardMarker)]: "stretch",
    },
    maxWidth: {
      default: "100%",
      [stylex.when.ancestor(":is(*)", traceCardMarker)]: "none",
    },
    // In a card: the whole row, over the card's edge on three sides when closed, with its corner, a
    // step of room above and below its line, so its ring lies on the card's edge.
    marginInline: {
      default: `calc(-1 * ${size.collapsiblePadding})`,
      [stylex.when.ancestor(":is(*)", traceCardMarker)]:
        `calc(-1 * (${size.collapsiblePadding} + ${size.hairline}))`,
    },
    marginBlock: {
      default: 0,
      [stylex.when.ancestor(":is(*)", traceCardMarker)]:
        `calc(-1 * ${size.hairline})`,
    },
    minHeight: {
      default: size.controlSm,
      [stylex.when.ancestor(":is(*)", traceCardMarker)]:
        `calc(${space["2"]} * 2 + ${font.textSmLine} + 2 * ${size.hairline})`,
    },
    // A title that wraps keeps a little room above and below; one line stays a small control tall.
    paddingBlock: `calc(${ROOM})`,
    columnGap: space["2"],
    // A row's corner, in a card too: a trigger there is still a row, as a Sources trigger is.
    borderRadius: `min(${radius.row}, calc(${size.controlSm} / 2))`,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
      [OPEN]: colors.foreground,
      [OFF]: { default: colors.subtleForeground, [FORCED]: "GrayText" },
    },
  },
  // Points down while closed and turns up as it opens.
  chevron: {
    color: colors.mutedForeground,
    transform: {
      default: null,
      ":is([aria-expanded=true] > *)": "rotate(0.5turn)",
    },
  },
});

// Lines whose status changed in one render: their effects run one after another, then this list
// is said as one announcement.
let changed: string[] = [];
const report = (said: string) => {
  if (changed.length === 0) {
    queueMicrotask(() => {
      announce(changed.join(". "));
      changed = [];
    });
  }
  changed.push(said);
};

/** Whether a change of status is news: work that ended, or failed. */
const isNews = (
  was: TraceLineStatus | undefined,
  now: TraceLineStatus | undefined
): boolean =>
  now === "error" ||
  (now === undefined && (was === "running" || was === "pending"));

/** The words of an element as a screen reader has them: without what is hidden from it. */
const spokenText = (element: Element): string => {
  let said = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      said += node.textContent ?? "";
    } else if (
      node instanceof Element &&
      node.getAttribute("aria-hidden") !== "true"
    ) {
      said += spokenText(node);
    }
  }
  return said;
};

// Whether a line here is a step (straight inside a Trace) or a trigger's words.
const StepContext = createContext(false);
// The status of the line a part is in.
const StatusContext = createContext<TraceLineStatus | undefined>(undefined);

/** A list of lines: the steps an assistant takes. */
export const Trace = ({ children, style }: TraceProps) => (
  <div data-slot="trace" {...stylex.props(styles.trace, style)}>
    <StepContext value>{children}</StepContext>
  </div>
);

/** One line: its mark, its title and a quiet description. Wrap it in a trigger or a link to make it do something. */
export const TraceLine = ({ children, status, style }: TraceLineProps) => {
  const step = use(StepContext);
  const words = useI18n().trace;
  const ref = useRef<HTMLSpanElement>(null);

  // Said once, when its status changes to done or to error after it was drawn; never for appearing.
  const was = useRef(status);
  useEffect(() => {
    const before = was.current;
    was.current = status;
    if (before === status || !isNews(before, status) || ref.current === null) {
      return;
    }
    const said = spokenText(ref.current).replaceAll(/\s+/gu, " ").trim();
    if (said !== "") {
      report(said);
    }
  }, [status]);

  return (
    <span
      ref={ref}
      data-slot="trace-line"
      data-status={status}
      {...stylex.props(styles.line, step && styles.step, style)}
    >
      <StatusContext value={status}>{children}</StatusContext>
      {/* The status in words, for a screen reader: the mark and the colour say it to the eye. */}
      {status !== undefined && (
        <span {...stylex.props(visuallyHidden)}>
          {`, ${words.states[status]}`}
        </span>
      )}
      {step && (
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.join,
            status === undefined && styles.joinDone
          )}
        />
      )}
    </span>
  );
};

/** A line's mark, hidden from screen readers: an icon, or the status mark. */
export const TraceIcon = ({ children, style }: TraceIconProps) => {
  const status = use(StatusContext);
  const step = use(StepContext);
  let mark = children;
  if (mark === undefined) {
    mark =
      status === "error" ? (
        <Icon icon={CircleAlertIcon} />
      ) : (
        <span
          {...stylex.props(
            styles.dot,
            status === "pending" && styles.dotPending
          )}
        />
      );
  }
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      {...stylex.props(
        styles.icon,
        status === "running" && styles.iconRunning,
        status === "error" && styles.iconError,
        styles.seat,
        step && styles.seatStep,
        style
      )}
    >
      {mark}
    </span>
  );
};

/** What happened, in one sentence. It shimmers while its line runs. */
export const TraceTitle = ({ children, style }: TraceTitleProps) => {
  const status = use(StatusContext);
  return (
    <span
      data-slot="trace-title"
      {...stylex.props(
        styles.title,
        status === "running" && styles.titleRunning,
        status === "error" && styles.titleError,
        style
      )}
    >
      {status === "running" && typeof children === "string" ? (
        <Shimmer>{children}</Shimmer>
      ) : (
        children
      )}
    </span>
  );
};

/** A quiet note after the title: a count, a duration, a diff's lines. */
export const TraceDescription = ({
  children,
  style,
}: TraceDescriptionProps) => (
  <>
    {/* A comma a screen reader says between title and note; the eye has the space. */}
    <span {...stylex.props(visuallyHidden)}>, </span>
    <span
      data-slot="trace-description"
      {...stylex.props(styles.description, style)}
    >
      {children}
    </span>
  </>
);

/** A row that opens: its trigger, a line, and what opens under it. */
export const TraceCollapsible = ({
  children,
  open,
  defaultOpen,
  onOpenChange,
  disabled,
  style,
}: TraceCollapsibleProps) => {
  const step = use(StepContext);
  return (
    // The slot is set on the element drawn: UI SDK keeps a part's own data-slot over a prop.
    <CollapsiblePrimitive
      render={<div data-slot="trace-collapsible" />}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      disabled={disabled}
      {...stylex.props(
        styles.collapsible,
        step && styles.collapsibleStep,
        // Its rows stand edge to edge and its panel clips: every ring inside is drawn inside its
        // control, the trigger's on the card's own edge when it is one.
        ringInsetMarker,
        style
      )}
    >
      <StepContext value={false}>{children}</StepContext>
    </CollapsiblePrimitive>
  );
};

/** The button that opens and closes the row: its TraceLine, and the chevron that turns. */
export const TraceCollapsibleTrigger = ({
  children,
  asChild = false,
  style,
}: TraceCollapsibleTriggerProps) => {
  if (asChild && isValidElement<Record<string, unknown>>(children)) {
    return (
      <CollapsibleTriggerPrimitive
        render={createElement(children.type, {
          ...children.props,
          "data-slot": "trace-collapsible-trigger",
        })}
        {...stylex.props(style)}
      />
    );
  }
  return (
    <CollapsibleTriggerPrimitive
      // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- named by the TraceLine it holds
      render={<button type="button" data-slot="trace-collapsible-trigger" />}
      {...stylex.props(
        disclosureStyles.trigger,
        disclosureStyles.ghost,
        styles.trigger,
        focusRing,
        style
      )}
    >
      <span aria-hidden="true" {...stylex.props(tapTarget)} />
      {children}
      <span
        aria-hidden="true"
        {...stylex.props(disclosureStyles.chevron, styles.chevron)}
      >
        <Icon icon={ChevronDownIcon} />
      </span>
    </CollapsibleTriggerPrimitive>
  );
};

/** What opens under the row. The browser's find opens it when it holds the words found. */
export const TraceCollapsibleContent = ({
  children,
  style,
}: TraceCollapsibleContentProps) => (
  // The class only: UI SDK writes the panel's measured height as its own inline style.
  <CollapsiblePanel
    render={<div data-slot="trace-collapsible-content" />}
    hiddenUntilFound
    className={className(disclosureStyles.panel, disclosureStyles.quiet, style)}
  >
    <div
      data-slot="trace-collapsible-content-inner"
      {...stylex.props(disclosureStyles.body)}
    >
      {children}
    </div>
  </CollapsiblePanel>
);

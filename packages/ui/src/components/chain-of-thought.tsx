// ChainOfThought: the steps an assistant took to an answer, behind one line that opens. It is made
// of Damsko's Trace: a Trace with a TraceCollapsible for the summary, and a Trace of steps inside,
// each a TraceLine. The line is the run's summary, which the caller writes ("Searched 3 times and
// read 2 files, 14s"); while a step is active the line runs (`status="running"`: Trace shimmers its
// title) and says that step instead. A run that finishes while the person has not opened or closed
// it settles back into its one line.
//
//   <ChainOfThought>
//     <ChainOfThoughtHeader>Searched 3 times and read 2 files</ChainOfThoughtHeader>
//     <ChainOfThoughtContent>
//       <ChainOfThoughtStep label="Searched the web" description="pricing pages" status="complete" />
//       <ChainOfThoughtStep label="Reading brief.md" status="active" />
//     </ChainOfThoughtContent>
//   </ChainOfThought>
//
// It is a named section, its steps a list. Trace draws the line that opens, the steps' marks and
// the dotted line between them, says a step's status in words after it, and says a step once as it
// finishes or fails, with the steps that change with it; a step that appears already done is not
// said, nor the summary line, whose steps speak for it. ChainOfThoughtImage shows a picture a step
// made or found, with its caption. Every value is a token. A caller may set layout only (the
// `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, use, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { Icon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { colors, font, media, radius, size, space } from "../lib/tokens.stylex";
import { hasText, nothing } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { Badge } from "./badge";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "./trace";
import type { TraceLineStatus } from "./trace";

/** Where a step is: `pending` not yet begun, `active` under way, `complete` done, `error` failed. */
export type ChainOfThoughtStepStatus =
  | "pending"
  | "active"
  | "complete"
  | "error";

/** One step, as data: what a run's step comes to before it is drawn. */
export interface ChainOfThoughtStepData {
  /** What it does, in a few words: "Searched the web" once done, "Searching the web" while active. */
  label: string;
  /** A quiet note after the label: a tool's name, a count ("12 results"). */
  description?: string;
  /**
   * Where it is.
   * @default "complete"
   */
  status?: ChainOfThoughtStepStatus;
}

/** Every prop a ChainOfThought takes. */
export interface ChainOfThoughtProps {
  /** Its ChainOfThoughtHeader, then its ChainOfThoughtContent. */
  children: ReactNode;
  /**
   * Its name, for a screen reader: what the steps were for.
   * @default "Steps"
   */
  "aria-label"?: string;
  /** Open on the steps. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open on the steps at first. A run that finishes while the person has not opened or closed it
   * settles into its one line.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when it opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a ChainOfThoughtHeader takes. */
export interface ChainOfThoughtHeaderProps {
  /**
   * The run's one line: what it did ("Searched 3 times and read 2 files"), with its time if you
   * have it. While a step is active the line says that step's label instead.
   */
  children: ReactNode;
}

/** Every prop a ChainOfThoughtStep takes. */
export interface ChainOfThoughtStepProps extends ChainOfThoughtStepData {
  /** A mark of its own, in place of the dot. A failed step always shows the alert. */
  icon?: IconData;
  /** What the step holds under its line: its results (ChainOfThoughtSearchResults), a tool's input and output. */
  children?: ReactNode;
}

/** Every prop a ChainOfThoughtContent takes. */
export interface ChainOfThoughtContentProps {
  /** The steps, ChainOfThoughtStep, in the order they happened. */
  children: ReactNode;
}

/** Every prop a ChainOfThoughtSearchResults takes. */
export interface ChainOfThoughtSearchResultsProps {
  /** The results, ChainOfThoughtSearchResult, in the order they came. */
  children: ReactNode;
}

/** Every prop a ChainOfThoughtSearchResult takes. */
export interface ChainOfThoughtSearchResultProps {
  /** The result, in a word or two: its site's name ("northwind.example"). */
  children: ReactNode;
}

/** Every prop a ChainOfThoughtImage takes. */
export interface ChainOfThoughtImageProps {
  /** The picture: an `<img>` with its `alt`, or a chart. */
  children: ReactNode;
  /** A quiet line under it: what it shows. */
  caption?: ReactNode;
}

const styles = stylex.create({
  root: {
    display: "grid",
    minWidth: 0,
    fontFamily: font.sans,
  },
  // The steps: a step closer to the line than the panel's own spacing, space-1 above and below.
  steps: {
    display: "grid",
    minWidth: 0,
    marginBlock: `calc(${space["1"]} - ${space["2"]})`,
  },
  // A step's words, as a list item: no box of its own, so they stand in the line as they are.
  item: { display: "contents" },
  // What a step holds, on a row of its own under its line.
  held: {
    display: "grid",
    flexBasis: "100%",
    rowGap: space["2"],
    marginBlockStart: space["2"],
    minWidth: 0,
  },
  results: {
    display: "flex",
    flexWrap: "wrap",
    gap: space["1"],
    minWidth: 0,
  },
  image: {
    display: "grid",
    rowGap: space["2"],
    minWidth: 0,
    margin: 0,
  },
  // The picture on a muted ground, held to a height, its own size kept.
  frame: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    maxHeight: `calc(${size.popupWidth} * 1.1)`,
    overflow: "hidden",
    padding: space["3"],
    borderWidth: { default: 0, [media.forcedColors]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.muted,
  },
  caption: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
});

// A step's status as Trace says it: done is a line with none.
const statuses: Record<ChainOfThoughtStepStatus, TraceLineStatus | undefined> =
  {
    pending: "pending",
    active: "running",
    complete: undefined,
    error: "error",
  };

interface Active {
  id: string;
  label: string;
}

interface ChainOfThoughtState {
  /** Notes a step as active, with its label; returns what notes it is no longer. */
  activate: (step: Active) => () => void;
  /** The first step active now, if any. */
  current: Active | undefined;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtState | null>(null);

const useChainOfThought = (part: string): ChainOfThoughtState => {
  const state = use(ChainOfThoughtContext);
  if (state === null) {
    throw new Error(`${part} must be inside a ChainOfThought.`);
  }
  return state;
};

/** The steps an assistant took, behind one line that opens. */
export const ChainOfThought = ({
  children,
  "aria-label": label,
  open,
  defaultOpen = false,
  onOpenChange,
  style,
}: ChainOfThoughtProps) => {
  const [active, setActive] = useState<readonly Active[]>([]);
  // Made once, from the setter alone, so a step's effect that names it never runs again for it.
  // oxlint-disable-next-line react/hook-use-state -- a writer made once, never replaced
  const [activate] = useState(() => (step: Active) => {
    setActive((was) => [...was.filter((each) => each.id !== step.id), step]);
    return () => {
      setActive((was) => was.filter((each) => each.id !== step.id));
    };
  });
  const working = active.length > 0;
  const words = useI18n().chainOfThought;

  // Open and closed: the person's choice wins. A run that finishes without the person having
  // opened or closed it settles back into its one line.
  const [shown, setShown] = useState(defaultOpen);
  const chosen = useRef(false);
  const was = useRef(working);
  useEffect(() => {
    if (was.current && !working && !chosen.current && open === undefined) {
      setShown(false);
    }
    was.current = working;
  }, [working, open]);

  const state: ChainOfThoughtState = { activate, current: active[0] };
  return (
    <section
      aria-label={label ?? words.name}
      data-slot="chain-of-thought"
      aria-busy={working || undefined}
      {...stylex.props(styles.root, style)}
    >
      <Trace>
        <TraceCollapsible
          open={open ?? shown}
          onOpenChange={(next) => {
            chosen.current = true;
            setShown(next);
            onOpenChange?.(next);
          }}
        >
          {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
          <ChainOfThoughtContext value={state}>
            {children}
          </ChainOfThoughtContext>
        </TraceCollapsible>
      </Trace>
    </section>
  );
};

/** The one line that opens the steps: the run's summary, or the active step while it works. */
export const ChainOfThoughtHeader = ({
  children,
}: ChainOfThoughtHeaderProps) => {
  const { current } = useChainOfThought("ChainOfThoughtHeader");
  const working = current !== undefined;
  return (
    <TraceCollapsibleTrigger>
      {/* A new line once the run ends, so Trace does not say the summary: each step was said. */}
      <TraceLine
        key={working ? "working" : "done"}
        status={working ? "running" : undefined}
      >
        {/* No mark: the original's activity line is its words alone, on the column's edge. */}
        <TraceTitle>{working ? current.label : children}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
};

/** The steps, under the line, while it is open: a list, as Trace's lines are not one. */
export const ChainOfThoughtContent = ({
  children,
}: ChainOfThoughtContentProps) => (
  <TraceCollapsibleContent>
    <div role="list" {...stylex.props(styles.steps)}>
      <Trace>{children}</Trace>
    </div>
  </TraceCollapsibleContent>
);

/** One step: its mark on the line of dots, its label and a quiet description. */
export const ChainOfThoughtStep = ({
  label,
  description,
  status = "complete",
  icon,
  children,
}: ChainOfThoughtStepProps) => {
  const { activate } = useChainOfThought("ChainOfThoughtStep");
  const id = useId();

  // While active, the header says this step.
  useEffect(
    () => (status === "active" ? activate({ id, label }) : nothing),
    [activate, status, id, label]
  );

  return (
    <TraceLine status={statuses[status]}>
      <TraceIcon>
        {status === "error" || icon === undefined ? undefined : (
          <Icon icon={icon} />
        )}
      </TraceIcon>
      <span role="listitem" {...stylex.props(styles.item)}>
        <TraceTitle>{label}</TraceTitle>
        {hasText(description) && (
          <TraceDescription>{description}</TraceDescription>
        )}
        {children !== undefined && (
          <span {...stylex.props(styles.held)}>{children}</span>
        )}
      </span>
    </TraceLine>
  );
};

/** A step's search results, under its line: one small Badge each, wrapping. */
export const ChainOfThoughtSearchResults = ({
  children,
}: ChainOfThoughtSearchResultsProps) => (
  <span
    data-slot="chain-of-thought-search-results"
    {...stylex.props(styles.results)}
  >
    {children}
  </span>
);

/** One search result: its site, a label in a small `secondary` Badge. */
export const ChainOfThoughtSearchResult = ({
  children,
}: ChainOfThoughtSearchResultProps) => (
  <Badge size="sm" variant="secondary">
    {children}
  </Badge>
);

/** A picture a step made or found, under its line, with a quiet caption. */
export const ChainOfThoughtImage = ({
  children,
  caption,
}: ChainOfThoughtImageProps) => (
  <figure data-slot="chain-of-thought-image" {...stylex.props(styles.image)}>
    <span {...stylex.props(styles.frame)}>{children}</span>
    {caption === undefined ? null : (
      <figcaption {...stylex.props(styles.caption)}>{caption}</figcaption>
    )}
  </figure>
);

"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { Alert } from "../alert";
import type { AlertVariant } from "../alert";
import { Button } from "../button";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, Tick } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { Skeleton } from "../skeleton";
import { Spinner } from "../spinner";
import { grasp } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { InfoMark, RowFrame, rowFrame } from "./frame";
import { RowProblem } from "./line-context";
import { settingRowVars } from "./setting-row.stylex";
import { settingRowWords } from "./words";
import type { SettingRowWords } from "./words";

/** What a caller may style: where the rows sit and how wide they are. Never their look. */
export type SettingsRowsLayoutStyle = LayoutStyle;

/** Where a row that saves on change stands: at rest, saving, saved, or failed with the value kept. */
export type SettingRowState = "idle" | "saving" | "saved" | "failed";

/** What a row hands its control: the id its name labels, and the help that describes it. */
export interface SettingField {
  id: string;
  "aria-describedby"?: string;
}

/** Every prop a SettingRow takes. */
export interface SettingRowProps {
  /** The setting's name, in sentence case ("Time zone"). */
  label: string;
  /** One short line on what it does, under about 80 characters. */
  help?: string;
  /** More about it behind an info mark: why it matters, what it costs. */
  info?: string;
  /** The info mark's name for a screen reader. @default "More about this setting" */
  infoLabel?: string;
  /**
   * The control, on the shared end edge: an Input, a Select, a Button. As a function it is handed
   * the id the name labels and the help that describes it: `{(field) => <Input {...field} />}`.
   * Given as a node, the control needs its own name (`aria-label`).
   */
  children: ReactNode | ((field: SettingField) => ReactNode);
  /** Why its last change did not save (the server's reason): an alert across the row, under it. */
  error?: string;
  /**
   * A row that saves on change, whatever its control: `saving`, then `saved`, or `failed`, which
   * keeps the person's value and offers Try again. Said politely, once, in the help's place.
   * @default "idle"
   */
  status?: SettingRowState;
  /** @deprecated Use `status`. */
  state?: SettingRowState;
  /** Called by Try again, after a failed save. */
  onRetry?: () => void;
  /** Said while it saves. @default "Saving" */
  savingLabel?: string;
  /** Said once it saved. @default "Saved" */
  savedLabel?: string;
  /** Said when the save failed: what did not happen, and that the value is kept. @default "Could not save. Your choice is kept." */
  failedLabel?: string;
  /** The button that saves again. @default "Try again" */
  retryLabel?: string;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ failed: "Could not save. Your name is kept." }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<SettingRowWords>;
  /**
   * The setting is not there yet (a page's first paint): its name, and its help when `help` is
   * given (even empty), are quiet lines in their own lines, so the row keeps its height; pass a
   * placeholder as the control. Hidden from a reader: the page says it is loading.
   * @default false
   */
  loading?: boolean;
}

/** Every prop a FactRow takes. */
export interface FactRowProps {
  /** What the fact is ("Data location"). */
  label: string;
  /** One short line about it. */
  help?: string;
  /** More about it behind an info mark, as a SettingRow's: anything longer than a short phrase. */
  info?: string;
  /** The info mark's name for a screen reader. @default "More about this setting" */
  infoLabel?: string;
  /** Its value, in the control's place: words, a Badge, a Copy field. */
  children: ReactNode;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ info: "More about this fact" }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<SettingRowWords>;
}

/** Every prop a RowAlert takes. */
export interface RowAlertProps {
  /** How it stands, as an Alert's. @default "neutral" */
  variant?: AlertVariant;
  /** One sentence: what happened, and what to do. */
  children: string;
}

/** Every prop SettingsRows takes. */
export interface SettingsRowsProps {
  /** The rows: SettingRow, FactRow and RowAlert, in order. */
  children: ReactNode;
  /**
   * A small name over the group ("Notifications"), muted, which names the group for a screen reader
   * too. Without it the group stands unnamed, as before.
   */
  label?: string;
  /**
   * The level of the label's heading: 3 under a page's h2 sections, 2 where the page has none.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4;
  /**
   * How wide the rows' controls are: `column`, each fills the shared control column (20rem) and
   * goes under its words in a narrow row; `fit`, each its own width on the end edge, beside its
   * words at any width, as a settings page of selects, switches and quiet actions has it.
   * @default "column"
   */
  controls?: "column" | "fit";
  /** @deprecated Use `layout`. */
  style?: SettingsRowsLayoutStyle;
  /** Layout only. */
  layout?: SettingsRowsLayoutStyle;
}

/** A row narrower than this puts its control under its words (the row's own width). */
const NARROW = "@container setting-row (width < 34rem)";

// Saved: the tick stands a moment, then leaves.
const leave = stylex.keyframes({
  "0%": { opacity: 1 },
  "87%": { opacity: 1 },
  "100%": { opacity: 0 },
});

const styles = stylex.create({
  rows: { display: "flex", flexDirection: "column", minWidth: 0 },
  // A named group: its label over the rows, no frame, the label on the rows' own start edge.
  group: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    minWidth: 0,
  },
  // A named group that is not the first thing in its card (after rows, a table, a paragraph): a
  // hairline over its label, across the card as a row's is, and room under it, so the label belongs
  // to the rows below it and does not float under what came before. The first thing in a card has
  // none: the card's own edge is above it.
  groupAfter: {
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    borderTopWidth: { default: 0, ":not(:first-child)": grasp.hairline },
    paddingBlockStart: { default: 0, ":not(:first-child)": grasp.space4 },
  },
  // Each control its own width, beside its words at any width.
  fit: {
    [settingRowVars.columns]: "minmax(0, 1fr) auto",
    [settingRowVars.columnsNarrow]: "minmax(0, 1fr) auto",
  },
  groupLabel: {
    margin: 0,
    paddingInline: grasp.tableCellInline,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  // Inside the row's frame (frame.tsx): the words, and the control on the shared end edge.
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: settingRowVars.columns,
      [NARROW]: settingRowVars.columnsNarrow,
    },
    alignItems: "center",
    columnGap: grasp.space6,
    rowGap: grasp.space2,
  },
  words: { display: "grid", minWidth: 0 },
  name: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    width: "fit-content",
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // Try again, in a box one line tall, as the info mark's (frame.tsx): its button may be taller, the row never is.
  retry: {
    display: "inline-flex",
    alignItems: "center",
    height: grasp.textSmLine,
  },
  help: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space2,
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  failed: { color: grasp.danger },
  // While it loads: the name's and the help's lines, quiet, each in its own line's box.
  nameWait: { width: "9rem", maxWidth: "100%" },
  helpWait: { width: "16rem", maxWidth: "100%" },
  control: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    minWidth: 0,
  },
  // Where the save is, beside the control and never under the name: a spinner while it saves, a
  // tick once it has, in the room between the words and the control, so no row changes size. In a
  // narrow row, where the control stands under the words, it stands over the control's end.
  mark: {
    position: "absolute",
    insetInlineEnd: { default: "100%", [NARROW]: 0 },
    insetBlockStart: { default: "50%", [NARROW]: "auto" },
    insetBlockEnd: {
      default: "auto",
      [NARROW]: `calc(100% + ${grasp.space2})`,
    },
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.iconSm,
    height: grasp.iconSm,
    marginInlineEnd: { default: grasp.space1, [NARROW]: 0 },
    transform: { default: "translateY(-50%)", [NARROW]: "none" },
    color: grasp.success,
    pointerEvents: "none",
  },
  markLeaves: {
    animationName: leave,
    animationDuration: "2300ms",
    animationTimingFunction: grasp.ease,
    animationFillMode: "forwards",
  },
  value: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  across: { gridColumn: "1 / -1" },
  alertRow: {
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
  },
});

/** The line under the name: the help, or where the save is. */
interface LineProps {
  id: string;
  help: string | undefined;
  state: SettingRowState;
  onRetry: (() => void) | undefined;
  savingLabel: string;
  savedLabel: string;
  failedLabel: string;
  retryLabel: string;
  /** A problem the control put here (a file it refused): in the danger tone, in the help's place. */
  problem: string;
  /** The row is not there yet: the help's line holds a quiet line. */
  loading: boolean;
}

const Line = ({
  id,
  help,
  state,
  onRetry,
  savingLabel,
  savedLabel,
  failedLabel,
  retryLabel,
  problem,
  loading,
}: LineProps) => {
  if (loading) {
    return help === undefined ? null : (
      <Skeleton text="sm" layout={styles.helpWait} />
    );
  }
  // Saving and saved are drawn beside the control (the row's mark); here they are only said, and
  // the help keeps its place, so nothing under the name changes.
  if (state === "saving" || state === "saved") {
    return (
      <>
        {help !== undefined && <span id={id}>{help}</span>}
        <span {...stylex.props(visuallyHidden)}>
          {state === "saving" ? savingLabel : savedLabel}
        </span>
      </>
    );
  }
  if (state === "failed") {
    return (
      <>
        <span id={id} {...stylex.props(styles.failed)}>
          {failedLabel}
        </span>
        <span {...stylex.props(styles.retry)}>
          <Button size="xs" variant="ghost" onClick={onRetry}>
            {retryLabel}
          </Button>
        </span>
      </>
    );
  }
  if (problem !== "") {
    return (
      <span
        id={id}
        data-slot="setting-row-problem"
        {...stylex.props(styles.failed)}
      >
        {problem}
      </span>
    );
  }
  return help === undefined ? null : <span id={id}>{help}</span>;
};

/** A setting: its name and help at the start, its control at the end, on the shared edge. */
export const SettingRow = ({
  label,
  help,
  info,
  infoLabel: infoLabelGiven,
  children,
  error,
  state: stateDeprecated,
  status: state = stateDeprecated ?? "idle",
  onRetry,
  savingLabel: savingLabelGiven,
  savedLabel: savedLabelGiven,
  failedLabel: failedLabelGiven,
  retryLabel: retryLabelGiven,
  words,
  loading = false,
}: SettingRowProps) => {
  const {
    info: infoLabel,
    saving: savingLabel,
    saved: savedLabel,
    failed: failedLabel,
    retry: retryLabel,
  } = withGiven(useWords("settingRow", settingRowWords, words), {
    info: infoLabelGiven,
    saving: savingLabelGiven,
    saved: savedLabelGiven,
    failed: failedLabelGiven,
    retry: retryLabelGiven,
  });
  const id = useId();
  const helpId = useId();
  // A problem the control reports (a file it refused), shown in the row's own line.
  const [problem, setProblem] = useState("");
  const field: SettingField =
    help === undefined && problem === ""
      ? { id }
      : { id, "aria-describedby": helpId };
  return (
    <RowFrame
      slot="setting-row"
      data-state={state}
      aria-hidden={loading ? true : undefined}
      inner={styles.row}
    >
      <div {...stylex.props(styles.words)}>
        <label htmlFor={id} {...stylex.props(styles.name)}>
          {loading ? <Skeleton text="sm" layout={styles.nameWait} /> : label}
          {info !== undefined && <InfoMark label={infoLabel}>{info}</InfoMark>}
        </label>
        {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region */}
        <p role="status" {...stylex.props(styles.help)}>
          <Line
            id={helpId}
            help={help}
            loading={loading}
            state={state}
            onRetry={onRetry}
            savingLabel={savingLabel}
            savedLabel={savedLabel}
            failedLabel={failedLabel}
            retryLabel={retryLabel}
            problem={problem}
          />
        </p>
      </div>
      <div {...stylex.props(styles.control)}>
        {state === "saving" && (
          <span
            aria-hidden="true"
            data-slot="setting-row-mark"
            {...stylex.props(styles.mark)}
          >
            <Spinner size="sm" />
          </span>
        )}
        {state === "saved" && (
          <span
            aria-hidden="true"
            data-slot="setting-row-mark"
            {...stylex.props(styles.mark, styles.markLeaves)}
          >
            <Icon icon={Tick} />
          </span>
        )}
        <RowProblem value={setProblem}>
          {typeof children === "function" ? children(field) : children}
        </RowProblem>
      </div>
      {error !== undefined && (
        <div {...stylex.props(styles.across)}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </RowFrame>
  );
};

/** A fact nobody changes here, in a setting's columns: its value in place of a control. */
export const FactRow = ({
  label,
  help,
  info,
  infoLabel: infoLabelGiven,
  words,
  children,
}: FactRowProps) => {
  const { info: infoLabel } = withGiven(
    useWords("settingRow", settingRowWords, words),
    { info: infoLabelGiven }
  );
  return (
    <RowFrame slot="fact-row" inner={styles.row}>
      <div {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.name)}>
          {label}
          {info !== undefined && <InfoMark label={infoLabel}>{info}</InfoMark>}
        </span>
        {help !== undefined && <p {...stylex.props(styles.help)}>{help}</p>}
      </div>
      <div {...stylex.props(styles.value)}>{children}</div>
    </RowFrame>
  );
};

/** Something to know about a card's rows, a failure or a warning, as a row of its own. */
export const RowAlert = ({ variant = "neutral", children }: RowAlertProps) => (
  <div data-slot="row-alert" {...stylex.props(rowFrame.box, styles.alertRow)}>
    <Alert tone={variant}>{children}</Alert>
  </div>
);

const headings = { 2: "h2", 3: "h3", 4: "h4" } as const;

/**
 * The rows of one group, a hairline between them and no frame: in a flush Section card, or alone on
 * a page with a `label` over it.
 */
export const SettingsRows = ({
  children,
  label,
  headingLevel = 3,
  controls = "column",
  style,
  layout,
}: SettingsRowsProps) => {
  const labelId = useId();
  const fit = controls === "fit";
  if (label === undefined) {
    return (
      <div
        data-slot="settings-rows"
        data-controls={controls}
        {...stylex.props(styles.rows, fit && styles.fit, layout ?? style)}
      >
        {children}
      </div>
    );
  }
  const Heading = headings[headingLevel];
  return (
    <section
      data-slot="settings-rows"
      data-controls={controls}
      aria-labelledby={labelId}
      {...stylex.props(
        styles.group,
        styles.groupAfter,
        fit && styles.fit,
        layout ?? style
      )}
    >
      <Heading
        id={labelId}
        data-slot="settings-rows-label"
        {...stylex.props(styles.groupLabel)}
      >
        {label}
      </Heading>
      <div {...stylex.props(styles.rows)}>{children}</div>
    </section>
  );
};

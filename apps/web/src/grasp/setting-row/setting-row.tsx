"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { Alert } from "../alert";
import type { AlertVariant } from "../alert";
import { Button } from "../button";
import { Info } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { Spinner } from "../spinner";
import { grasp } from "../tokens/tokens.stylex";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { useWords, withGiven } from "../words/words";
import { settingRowWords } from "./words";

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
}

/** Every prop a FactRow takes. */
export interface FactRowProps {
  /** What the fact is ("Data location"). */
  label: string;
  /** One short line about it. */
  help?: string;
  /** Its value, in the control's place: words, a Badge, a Copy field. */
  children: ReactNode;
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
  /** @deprecated Use `layout`. */
  style?: SettingsRowsLayoutStyle;
  /** Layout only. */
  layout?: SettingsRowsLayoutStyle;
}

/** A row narrower than this puts its control under its words (the row's own width). */
const NARROW = "@container setting-row (width < 34rem)";

const styles = stylex.create({
  rows: { display: "flex", flexDirection: "column", minWidth: 0 },
  // A named group: its label over the rows, no frame, the label on the rows' own start edge.
  group: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    minWidth: 0,
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
  box: {
    containerType: "inline-size",
    containerName: "setting-row",
    // A hairline over every row but the first: the rows of one card, apart.
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
  },
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: `minmax(0, 1fr) ${grasp.controlColumn}`,
      [NARROW]: "minmax(0, 1fr)",
    },
    alignItems: "center",
    columnGap: grasp.space6,
    rowGap: grasp.space2,
    boxSizing: "border-box",
    minHeight: grasp.settingRow,
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
    fontFamily: grasp.fontSans,
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
  // The info mark, and Try again, in a box one line tall: its button may be taller, the row never is.
  info: {
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
  status: { display: "inline-flex", alignItems: "center", gap: grasp.space1 },
  control: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    minWidth: 0,
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
}: LineProps) => {
  if (state === "saving") {
    return (
      <span {...stylex.props(styles.status)}>
        <Spinner size="sm" />
        {savingLabel}
      </span>
    );
  }
  if (state === "saved") {
    return <span>{savedLabel}</span>;
  }
  if (state === "failed") {
    return (
      <>
        <span id={id} {...stylex.props(styles.failed)}>
          {failedLabel}
        </span>
        <span {...stylex.props(styles.info)}>
          <Button size="xs" variant="ghost" onClick={onRetry}>
            {retryLabel}
          </Button>
        </span>
      </>
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
}: SettingRowProps) => {
  const {
    info: infoLabel,
    saving: savingLabel,
    saved: savedLabel,
    failed: failedLabel,
    retry: retryLabel,
  } = withGiven(useWords("settingRow", settingRowWords), {
    info: infoLabelGiven,
    saving: savingLabelGiven,
    saved: savedLabelGiven,
    failed: failedLabelGiven,
    retry: retryLabelGiven,
  });
  const id = useId();
  const helpId = useId();
  const field: SettingField =
    help === undefined ? { id } : { id, "aria-describedby": helpId };
  return (
    <div
      data-slot="setting-row"
      data-state={state}
      {...stylex.props(styles.box)}
    >
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.words)}>
          <label htmlFor={id} {...stylex.props(styles.name)}>
            {label}
            {info !== undefined && (
              <span {...stylex.props(styles.info)}>
                <Tooltip>
                  <TooltipTrigger
                    icon={Info}
                    aria-label={infoLabel}
                    variant="ghost"
                    size="xs"
                  />
                  <TooltipContent>{info}</TooltipContent>
                </Tooltip>
              </span>
            )}
          </label>
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region */}
          <p role="status" {...stylex.props(styles.help)}>
            <Line
              id={helpId}
              help={help}
              state={state}
              onRetry={onRetry}
              savingLabel={savingLabel}
              savedLabel={savedLabel}
              failedLabel={failedLabel}
              retryLabel={retryLabel}
            />
          </p>
        </div>
        <div {...stylex.props(styles.control)}>
          {typeof children === "function" ? children(field) : children}
        </div>
        {error !== undefined && (
          <div {...stylex.props(styles.across)}>
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
      </div>
    </div>
  );
};

/** A fact nobody changes here, in a setting's columns: its value in place of a control. */
export const FactRow = ({ label, help, children }: FactRowProps) => (
  <div data-slot="fact-row" {...stylex.props(styles.box)}>
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.name)}>{label}</span>
        {help !== undefined && <p {...stylex.props(styles.help)}>{help}</p>}
      </div>
      <div {...stylex.props(styles.value)}>{children}</div>
    </div>
  </div>
);

/** Something to know about a card's rows, a failure or a warning, as a row of its own. */
export const RowAlert = ({ variant = "neutral", children }: RowAlertProps) => (
  <div data-slot="row-alert" {...stylex.props(styles.box, styles.alertRow)}>
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
  style,
  layout,
}: SettingsRowsProps) => {
  const labelId = useId();
  if (label === undefined) {
    return (
      <div
        data-slot="settings-rows"
        {...stylex.props(styles.rows, layout ?? style)}
      >
        {children}
      </div>
    );
  }
  const Heading = headings[headingLevel];
  return (
    <section
      data-slot="settings-rows"
      aria-labelledby={labelId}
      {...stylex.props(styles.group, layout ?? style)}
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

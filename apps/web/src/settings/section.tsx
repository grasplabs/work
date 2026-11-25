import { Alert } from "@grasp-os/ui/components/alert";
import type { AlertVariant } from "@grasp-os/ui/components/alert";
import { Card, CardContent, CardFooter } from "@grasp-os/ui/components/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldStatus,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import type { FieldStatusValue } from "@grasp-os/ui/components/field";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { I18nProvider, useI18n } from "@grasp-os/ui/lib/i18n";
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";
import { colors, font, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import { isFileGone } from "../error-reports.ts";
import { WithInfo } from "../frame/info-tip.tsx";
import { ErrorState } from "../frame/page-states.tsx";
import { useRouteErrorReason } from "../route-error-reason.ts";

// Settings' own small parts, composed of Damsko's: a Settings page is its
// name as the page's one header (the layout draws it), then a group per
// topic, its title on the page over its card (SettingsGroup, Damsko's
// settings pattern: a SectionHeader of `variant="group"` over a `Card
// size="sm"`), its rows Damsko's responsive Fields (SettingRow, FactRow,
// RowAlert here), or ReadOnlyRow for a value nobody changes
// (read-only-row.tsx). Then what Damsko has no part for:
// - SettingsStack: a section's fields and facts, one under the other.
// - RowNote: a row's line, or why its action failed.
// - TitleLine: an Item's title with a quieter detail beside it.
// - OwnWords: a part's own words in one place, over the catalogue's
//   (frame/ui-words.tsx), as the reference's parts took them.
// - LoadingLines and SettingsError: a section that is loading, or failed
//   as it rendered. One that didn't load is NotLoadedState
//   (frame/page-states.tsx), as everywhere.

const styles = stylex.create({
  // The title a small step over its card, its words where the rows' start.
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space["2"],
    minWidth: 0,
  },
  head: { paddingInline: space["4"] },
  titleLine: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: space["2"],
  },
  // Text sm muted, as its own span: a long word (an email) breaks
  // anywhere, so on a phone it never runs under the row's controls.
  detail: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  // As wide as a form stands: a line of text stays readable. Never wider
  // than the box it is in (a dialog): a code block's long lines scroll
  // inside it rather than push it past the box's edge.
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: space["5"],
    minWidth: 0,
    maxWidth: size.formWidth,
  },
  lines: { display: "flex", flexDirection: "column", gap: space["3"] },
  // A fact's value in the control's place, from the start of its column.
  value: {
    display: "flex",
    alignItems: "center",
    justifySelf: "stretch",
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
  },
  // An alert across the row, under its words and control.
  across: { gridColumn: "1 / -1", justifySelf: "stretch" },
  // A named group of rows after other rows in the same card: a hairline
  // over its label, across the card, and room under it, so the label
  // belongs to the rows below it.
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    minWidth: 0,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    borderTopWidth: { default: 0, ":not(:first-child)": size.hairline },
    paddingBlockStart: { default: 0, ":not(:first-child)": space["4"] },
  },
  rowsLabel: {
    margin: 0,
    paddingInline: space.tableCellInline,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
  },
  alertRow: {
    paddingBlock: space["2"],
    paddingInline: space.tableCellInline,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    borderTopWidth: { default: size.hairline, ":first-child": 0 },
  },
});

/** What a group of settings takes. */
interface SettingsGroupProps {
  /** The group's name, on the page over its card. */
  title: string;
  /** One sentence under the title: what the group holds. */
  description?: string;
  /** More about it behind an info mark beside its title. */
  info?: string;
  /** Beside the title: a badge. */
  aside?: ReactNode;
  /** At the end of the title's row: the group's own buttons, xs. */
  actions?: ReactNode;
  /** A line at the card's foot, under a hairline. */
  footer?: ReactNode;
  /** What it holds runs edge to edge: rows, a table, a list of Items. */
  flush?: boolean;
  /** Placeholders where the title and the sentence will be. */
  loading?: boolean;
  children: ReactNode;
}

/** A group of a settings page: its title on the page, a small step over the card of its rows. */
export const SettingsGroup = ({
  title,
  description,
  info,
  aside,
  actions,
  footer,
  flush = false,
  loading = false,
  children,
}: SettingsGroupProps) => {
  const { t } = useLingui();
  const id = useId();
  const named =
    info === undefined ? (
      title
    ) : (
      <WithInfo info={info} label={t`More about this section`}>
        {title}
      </WithInfo>
    );
  return (
    <section aria-labelledby={id} {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.head)}>
        <SectionHeader
          actions={actions}
          badge={aside}
          description={description}
          id={id}
          loading={loading}
          title={named}
          variant="group"
        />
      </div>
      <Card size="sm">
        <CardContent flush={flush}>{children}</CardContent>
        {footer === undefined || footer === null ? null : (
          <CardFooter>{footer}</CardFooter>
        )}
      </Card>
    </section>
  );
};

/** One topic on its own card, which the page's title names: rows edge to edge. */
export const SettingsCard = ({
  "aria-label": label,
  children,
}: {
  "aria-label": string;
  children: ReactNode;
}) => (
  <Card aria-label={label} asChild size="sm">
    <section>
      <CardContent flush>{children}</CardContent>
    </section>
  </Card>
);

/**
 * The parts inside say `words` (each part given whole, from the catalogue
 * with the words changed) in place of the catalogue's: "Your name is kept"
 * where a setting's row says "Your choice is kept".
 */
export const OwnWords = ({
  words,
  children,
}: {
  words: (catalog: I18nCatalog) => Partial<I18nCatalog>;
  children: ReactNode;
}) => {
  const { i18n } = useLingui();
  const catalog = useI18n();
  return (
    <I18nProvider
      catalog={{ ...catalog, ...words(catalog) }}
      locale={i18n.locale}
    >
      {children}
    </I18nProvider>
  );
};

/** Where a row that saves on change is, in Damsko's words. */
export type SettingRowState = "idle" | "saving" | "saved" | "failed";

const statusOf: Record<SettingRowState, FieldStatusValue> = {
  idle: "idle",
  saving: "loading",
  saved: "success",
  failed: "error",
};

/** A setting: its name and help at the start, its control on the rows' shared end edge. */
export const SettingRow = ({
  label,
  help,
  info,
  infoLabel,
  error,
  status = "idle",
  onRetry,
  failed,
  children,
}: {
  /** The setting's name, in sentence case. */
  label: string;
  /** One short line on what it does. */
  help?: string;
  /** More about it behind an info mark. */
  info?: string;
  /** The info mark's name for a screen reader. */
  infoLabel?: string;
  /** Why its last change did not save: an alert across the row, under it. */
  error?: string;
  /** A row that saves on change: where the save is. */
  status?: SettingRowState;
  /** Try again, after a failed save. */
  onRetry?: () => void;
  /** Said when the save failed, in place of "Your choice is kept": what is kept. */
  failed?: string;
  /** The control, labelled by the row's name through the Field. */
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const row = (
    <Field orientation="responsive">
      <FieldContent>
        {info === undefined ? (
          <FieldLabel>{label}</FieldLabel>
        ) : (
          <WithInfo info={info} label={infoLabel ?? t`More about this setting`}>
            <FieldLabel>{label}</FieldLabel>
          </WithInfo>
        )}
        {help === undefined ? null : (
          <FieldDescription>{help}</FieldDescription>
        )}
      </FieldContent>
      {children}
      {status === "idle" ? null : (
        <FieldStatus
          status={statusOf[status]}
          {...(onRetry === undefined ? {} : { onRetry })}
        />
      )}
      {error === undefined ? null : (
        <Alert style={styles.across} variant="destructive">
          {error}
        </Alert>
      )}
    </Field>
  );
  return failed === undefined ? (
    row
  ) : (
    <OwnWords
      words={({ field }) => ({ field: { ...field, statusError: failed } })}
    >
      {row}
    </OwnWords>
  );
};

/** A fact nobody changes here, in a setting's columns: its value in place of a control. */
export const FactRow = ({
  label,
  help,
  info,
  children,
}: {
  label: string;
  help?: string;
  info?: string;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <Field orientation="responsive">
      <FieldContent>
        {info === undefined ? (
          <FieldTitle>{label}</FieldTitle>
        ) : (
          <WithInfo info={info} label={t`More about this setting`}>
            <FieldTitle>{label}</FieldTitle>
          </WithInfo>
        )}
        {help === undefined ? null : (
          <FieldDescription>{help}</FieldDescription>
        )}
      </FieldContent>
      <div {...stylex.props(styles.value)}>{children}</div>
    </Field>
  );
};

/** A group of a card's rows under a small muted name, which names it for a screen reader too. */
export const NamedRows = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => {
  const id = useId();
  return (
    <section aria-labelledby={id} {...stylex.props(styles.rows)}>
      <h3 id={id} {...stylex.props(styles.rowsLabel)}>
        {label}
      </h3>
      {children}
    </section>
  );
};

/** Something to know about a card's rows, a failure or a warning, as a row of its own. */
export const RowAlert = ({
  variant = "default",
  children,
}: {
  variant?: AlertVariant;
  children: string;
}) => (
  <div {...stylex.props(styles.alertRow)}>
    <Alert variant={variant}>{children}</Alert>
  </div>
);

/** A section's fields and facts, one under the other. */
export const SettingsStack = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.stack)}>{children}</div>
);

/** A row's line under its title, or, once its action failed, why: said at once. */
export const RowNote = ({
  children,
  failure,
}: {
  children: string;
  failure: string | undefined;
}) => (failure === undefined ? children : <span role="alert">{failure}</span>);

/**
 * An Item's title on one line: `children`, its name (with a Badge, say),
 * then `detail` in quieter words beside it; it wraps under only where the
 * row is too narrow for both.
 */
export const TitleLine = ({
  children,
  detail,
}: {
  children: ReactNode;
  detail?: ReactNode;
}) => (
  <span {...stylex.props(styles.titleLine)}>
    {children}
    {detail === undefined ? null : (
      <span {...stylex.props(styles.detail)}>{detail}</span>
    )}
  </span>
);

/** Lines of placeholder where a section's content will be, announced once as loading. */
export const LoadingLines = ({ lines = 3 }: { lines?: number }) => {
  const { t } = useLingui();
  return (
    <output
      aria-busy="true"
      aria-label={t`Loading…`}
      {...stylex.props(styles.lines)}
    >
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton key={line} />
      ))}
    </output>
  );
};

/**
 * A section that failed as it rendered: the error in the Settings layout,
 * rather than a page of its own with a second header. Trying again reads
 * the page again, or loads Grasp anew when its file is gone.
 */
export const SettingsError = ({ error }: ErrorComponentProps) => (
  <ErrorState
    heading="h2"
    reason={useRouteErrorReason(error)}
    reload={isFileGone(error)}
  />
);

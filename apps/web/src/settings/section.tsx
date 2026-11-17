import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import { isFileGone } from "../error-reports.ts";
import { ErrorState } from "../frame/page-states.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { Retry } from "../grasp/icons/index.ts";
import { Label } from "../grasp/label/index.ts";
import { Skeleton } from "../grasp/skeleton/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useRouteErrorReason } from "../route-error.tsx";

// Settings' building blocks on Grasp UI. A Settings page is its own name
// as the page's one header (the layout draws it), then one Section card
// per topic, `flush`, holding rows:
//
//   <SectionCard flush title={t`Organization`}>
//     <SettingsRows>
//       <SettingRow help={t`Your company's name in Grasp.`} label={t`Name`}>
//         {(field) => <Input {...field} value={name} … />}
//       </SettingRow>
//       <FactRow help={t`Everything stays here.`} label={t`Data location`}>
//         {t`European Union`}
//       </FactRow>
//     </SettingsRows>
//   </SectionCard>
//
// - SettingRow: what can be changed. The label (and one short line of help,
//   under about 80 characters) on the left; the control on the right, in a
//   column of one width for every row, so controls share an edge. The
//   children are a function handed the control's `id` and
//   `aria-describedby`, so the label names it and the help describes it.
// - FactRow: what nobody changes here, in the same columns: its value in
//   place of a control (words, a Badge, a Copy field).
// - SettingsRows: rows of one card, a hairline between them.
// - RowAlert: a failure or a warning as a row of its own in those rows.
// - SwitchRow: a row holding one Switch, which brings its own label,
//   description and saving state: `<SwitchRow><Switch label=… /></SwitchRow>`.
// - Lists of things (members, providers, sources) are Items in an
//   ItemGroup in a flush card; adding or editing one is a button in the
//   card's header that opens a Dialog with a Form, never a form on the page.
//   A long list (members, teams) takes `size="sm"` Items of one line: the
//   Item's title is a TitleLine, its name and then a quieter detail (an
//   email, a count) beside it, and no description.
// - SectionNotLoaded, SettingsLoading and SettingsError: a section that
//   didn't load, is loading, or failed as it rendered.
// All text in rows is text-sm (labels, help, values), as Grasp UI's type
// foundation has it for dense parts. On a phone a row stacks: the control
// goes under its label, full width.

/**
 * The width of the controls' column. No token names it yet (asked of the
 * library): a value that fits in about 20 characters gets no wider.
 */
const controlWidth = "20rem";

const styles = stylex.create({
  titleLine: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: grasp.space2,
  },
  // Text sm muted, as its own span: Text's \`break-word\` keeps a long word
  // (an email) whole when the row is measured, so on a phone it ran under
  // the row's controls; \`anywhere\` lets it break there.
  detail: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
  },
  rows: { display: "flex", flexDirection: "column" },
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: `minmax(0, 1fr) ${controlWidth}`,
      [media.belowPhone]: "minmax(0, 1fr)",
    },
    alignItems: "center",
    columnGap: grasp.space6,
    rowGap: grasp.space2,
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
    minHeight: grasp.space12,
    // A hairline above each row but the first: rows of one card, apart.
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
  },
  named: { display: "flex", flexDirection: "column", minWidth: 0 },
  across: { gridColumn: "1 / -1" },
  single: { gridTemplateColumns: "minmax(0, 1fr)" },
  value: { display: "flex", alignItems: "center", minWidth: 0 },
  // As wide as a form of Grasp UI's stands: a line of text stays readable.
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    maxWidth: grasp.formWidth,
  },
  lines: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  failed: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space3,
  },
  fact: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space1,
  },
});

/** The rows of one card, a hairline between them. */
export const SettingsRows = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.rows)}>{children}</div>
);

/** What a SettingRow hands its control: the id its label names, and the help that describes it. */
export interface SettingField {
  id: string;
  "aria-describedby"?: string;
}

/** A setting that can be changed: its label and help on the left, its control on the right. */
export const SettingRow = ({
  label,
  help,
  error,
  children,
}: {
  label: string;
  /** One short line on what it does, under about 80 characters. */
  help?: string;
  /** Why its last change didn't save (core's reason), across the row under it. */
  error?: string;
  children: (field: SettingField) => ReactNode;
}) => {
  const id = useId();
  const helpId = useId();
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.named)}>
        <Label htmlFor={id}>{label}</Label>
        {help === undefined ? null : (
          <Text id={helpId} size="sm" tone="muted">
            {help}
          </Text>
        )}
      </div>
      <div {...stylex.props(styles.value)}>
        {children(
          help === undefined ? { id } : { id, "aria-describedby": helpId }
        )}
      </div>
      {error === undefined ? null : (
        <div {...stylex.props(styles.across)}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </div>
  );
};

/** A fact nobody changes here, in a setting's columns: its name and help on the left, its value on the right. */
export const FactRow = ({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.row)}>
    <div {...stylex.props(styles.named)}>
      <Text element="span" size="sm" tone="ink" weight="medium">
        {label}
      </Text>
      {help === undefined ? null : (
        <Text size="sm" tone="muted">
          {help}
        </Text>
      )}
    </div>
    <div {...stylex.props(styles.value)}>
      {typeof children === "string" ? (
        <Text element="span" size="sm">
          {children}
        </Text>
      ) : (
        children
      )}
    </div>
  </div>
);

/** Something to know about a card's rows (a failure, a warning), as a row of its own across the card. */
export const RowAlert = ({
  variant,
  children,
}: {
  variant: "neutral" | "attention" | "danger";
  children: string;
}) => (
  <div {...stylex.props(styles.row, styles.single)}>
    <Alert variant={variant}>{children}</Alert>
  </div>
);

/**
 * A Switch as a row of SettingsRows: Grasp UI's Switch draws its own label
 * and description (and its saving state), so the row only gives it the
 * rows' rhythm: their padding, hairline and height, across both columns.
 */
export const SwitchRow = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.row, styles.single)}>{children}</div>
);

/** A section's fields and facts, one under the other. */
export const SettingsStack = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.stack)}>{children}</div>
);

/** A fact's value in a Key value list, with a quiet line under it on what it means. */
export const FactValue = ({
  children,
  note,
}: {
  children: ReactNode;
  note?: string;
}) => (
  <span {...stylex.props(styles.fact)}>
    {children}
    {note === undefined ? null : (
      <Text element="span" size="sm" tone="muted">
        {note}
      </Text>
    )}
  </span>
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

/** A section while its read is slow: a card of lines in placeholder, where its title and rows will be. */
export const SettingsLoading = () => (
  <Card>
    <LoadingLines lines={5} />
  </Card>
);

/**
 * Why a part of a page did not load, in the section it is part of: core's
 * reason, with the reference to quote, or that Grasp is out of reach.
 */
export const SectionNotLoaded = ({
  page,
  onRetry,
}: {
  page: Exclude<Loaded<unknown>, { state: "ready" }>;
  /** Reads it again; the page's own read when left out. */
  onRetry?: () => void;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const trying = useRouterState({ select: (state) => state.isLoading });
  return (
    <div {...stylex.props(styles.failed)}>
      <Alert tone="danger">{notLoadedText(page, i18n)}</Alert>
      <Button
        disabled={onRetry === undefined && trying}
        icon={Retry}
        onClick={() => {
          if (onRetry === undefined) {
            void router.invalidate();
            return;
          }
          onRetry();
        }}
        size="sm"
      >
        {onRetry === undefined && trying ? t`Trying again…` : t`Try again`}
      </Button>
    </div>
  );
};

/**
 * A section that failed as it rendered: the error in the Settings layout,
 * rather than a page of its own with a second header. Trying again reads
 * the page again, or loads Grasp anew when its file is gone.
 */
export const SettingsError = ({ error }: ErrorComponentProps) => (
  // Grasp UI's failed page under the section's own heading: the page
  // around it (Settings' sidebar) is the way on.
  <ErrorState
    heading="h2"
    reason={useRouteErrorReason(error)}
    reload={isFileGone(error)}
  />
);

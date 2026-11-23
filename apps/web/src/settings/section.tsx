import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Card, CardContent, CardFooter } from "@grasp-os/ui/components/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldStatus,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import type { FieldStatusValue } from "@grasp-os/ui/components/field";
import { ItemGroup, ItemSeparator } from "@grasp-os/ui/components/item";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Fragment, useId } from "react";
import type { ReactElement, ReactNode } from "react";

import { isFileGone } from "../error-reports.ts";
import { ErrorState } from "../frame/page-states.tsx";
import { useRouteErrorReason } from "../route-error.tsx";

// Settings' own small parts, composed of Damsko's: a Settings page is its
// section's name as the page's one header (the layout draws it), then a
// group per topic, its title on the page's ground over a card of rows
// (Damsko's grouped card: a SectionHeader over a Card), each row a
// responsive Field: its words at the start and its control on the edge
// every row shares. Here only what Damsko leaves to the product:
// - SettingsStack: a page's groups, one under the other.
// - SettingsGroup: a topic's title over its card; SettingsCard, a card
//   with no title of its own, which the page's title names.
// - SettingRow and FactRow: a setting that can be changed, and a value
//   that only reads, as a row.
// - RowNote and TitleLine: a row's line, and a title with a quieter detail.
// - LoadingLines, SettingsPending and SettingsError: a section that is
//   loading, or failed as it rendered. One that didn't load is
//   NotLoadedState (frame/page-states.tsx), as everywhere.

const styles = stylex.create({
  // The groups stand a section's gap apart.
  stack: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: space.sectionHeaderGap,
    minWidth: 0,
  },
  // A group's title over its card, on the page's ground, a small step above it.
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space[2],
    minWidth: 0,
  },
  // Its words start where the rows' do.
  head: { marginInline: space.tableCellInline },
  // Buttons too wide to stand beside the title on a phone (a search among
  // them) stand under it there. Damsko's head would keep them beside it
  // and squeeze the title down to nothing, breaking it inside its words
  // (its words' floor is zero; logged in the registry gaps).
  headStacked: {
    display: { default: null, "@container settings (width < 30rem)": "grid" },
  },
  titleLine: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: space[2],
    minWidth: 0,
  },
  // A quieter word beside a title: the row's own small muted type, broken
  // anywhere so a long address never runs under the row's controls.
  detail: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    overflowWrap: "anywhere",
  },
  lines: {
    display: "grid",
    gap: space[3],
    paddingBlock: space[4],
    paddingInline: space.tableCellInline,
  },
  // The title's placeholder at its inset, as wide as a short title.
  pendingHead: { width: "10rem" },
});

/** A page's groups, one under the other, a section's gap apart. */
export const SettingsStack = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.stack)}>{children}</div>
);

/**
 * A topic of a settings page: its title (and a line, a badge or its own
 * buttons beside it) on the page's ground, over the card that holds its
 * rows. A region of the page, named by its title.
 */
export const SettingsGroup = ({
  title,
  description,
  badge,
  actions,
  wideActions = false,
  flush = true,
  footer,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  /** xs Buttons, on the title's line. */
  actions?: ReactNode;
  /** The buttons are too wide to stand beside the title on a phone: there they stand under it. */
  wideActions?: boolean;
  /**
   * What it holds runs edge to edge, as rows, a list of Items or a Table
   * do; without it the card's room surrounds it (words, an empty state).
   */
  flush?: boolean;
  /** A line at the card's foot, under a hairline: a total, a way to show all. */
  footer?: ReactNode;
  /** What the card holds; with nothing, the title stands alone, with no empty card. */
  children?: ReactNode;
}) => {
  const empty =
    children === undefined ||
    children === null ||
    (Array.isArray(children) &&
      children.every((child) => child === null || child === undefined));
  const id = useId();
  return (
    <section aria-labelledby={id} {...stylex.props(styles.group)}>
      <SectionHeader
        actions={actions}
        badge={badge}
        description={description}
        id={id}
        style={[styles.head, wideActions && styles.headStacked]}
        title={title}
        variant="group"
      />
      {empty ? null : (
        <Card size="sm">
          <CardContent flush={flush}>{children}</CardContent>
          {footer === undefined ? null : <CardFooter>{footer}</CardFooter>}
        </Card>
      )}
    </section>
  );
};

/**
 * One topic's card with no title of its own, as a page of one topic has
 * it: the page's title names the topic, and `aria-label` the region.
 */
export const SettingsCard = ({
  "aria-label": label,
  flush = true,
  children,
}: {
  "aria-label": string;
  flush?: boolean;
  children: ReactNode;
}) => (
  <Card aria-label={label} asChild size="sm">
    <section>
      <CardContent flush={flush}>{children}</CardContent>
    </section>
  </Card>
);

/** A card's list of Items, a hairline between two, as its rows have. */
export const ItemList = ({
  "aria-label": label,
  children,
}: {
  "aria-label": string;
  /** The Items, as a list's `map` makes them, each with its key. */
  children: readonly ReactElement[];
}) => (
  <ItemGroup aria-label={label}>
    {children.map((item, at) => (
      <Fragment key={item.key ?? String(at)}>
        {at === 0 ? null : <ItemSeparator />}
        {item}
      </Fragment>
    ))}
  </ItemGroup>
);

/** A group's rows, a hairline between two. */
export const SettingsRows = ({ children }: { children: ReactNode }) => (
  <FieldGroup>{children}</FieldGroup>
);

/**
 * A setting: its name and one short line on the left, its control on the
 * rows' shared edge. The control is Damsko's, so the Field names and
 * describes it. `status` says where a save on change is; `error` why the
 * row's own action failed.
 */
export const SettingRow = ({
  label,
  help,
  status,
  onRetry,
  error,
  children,
}: {
  label: string;
  help?: ReactNode;
  status?: FieldStatusValue;
  onRetry?: () => void;
  error?: string;
  children: ReactNode;
}) => (
  <Field data-invalid={error !== undefined} orientation="responsive">
    <FieldContent>
      <FieldLabel>{label}</FieldLabel>
      {help === undefined ? null : <FieldDescription>{help}</FieldDescription>}
      {error === undefined ? null : <FieldError match>{error}</FieldError>}
    </FieldContent>
    {children}
    {status === undefined ? null : (
      <FieldStatus status={status} {...(onRetry ? { onRetry } : {})} />
    )}
  </Field>
);

/**
 * A fact, or a row whose control is no field (a Badge, a Button): its name
 * as a title rather than a label, and the value on the rows' shared edge.
 */
export const FactRow = ({
  label,
  help,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  children?: ReactNode;
}) => (
  <Field orientation="responsive">
    <FieldContent>
      <FieldTitle>{label}</FieldTitle>
      {help === undefined ? null : <FieldDescription>{help}</FieldDescription>}
    </FieldContent>
    {children}
  </Field>
);

/**
 * Why something failed, where it failed: Damsko's quiet destructive note,
 * said at once. Nothing while nothing failed.
 */
export const Failure = ({ children }: { children: string | undefined }) =>
  children === undefined ? null : (
    <Alert appearance="subtle" variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
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

/** Lines of placeholder where a card's content will be, announced once as loading. */
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
 * A section while its read is slow: each group's title and its card of
 * rows as placeholders, as tall as the rows will be, in the layout's
 * column. `groups` is how many rows each group holds.
 */
/** One group of three rows: a section's usual first read. */
const oneGroup = [3] as const;

export const SettingsPending = ({
  groups = oneGroup,
}: {
  groups?: readonly number[];
}) => (
  <SettingsStack>
    {groups.map((rows, group) => (
      <div key={group} {...stylex.props(styles.group)}>
        <Skeleton size="lg" style={[styles.head, styles.pendingHead]} />
        <Card size="sm">
          <CardContent flush>
            <LoadingLines lines={rows} />
          </CardContent>
        </Card>
      </div>
    ))}
  </SettingsStack>
);

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

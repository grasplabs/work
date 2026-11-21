import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { isFileGone } from "../error-reports.ts";
import { ErrorState } from "../frame/page-states.tsx";
import { PartNotLoaded } from "../frame/part-failed.tsx";
import { Skeleton } from "../grasp/skeleton/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useRouteErrorReason } from "../route-error.tsx";

// Settings' own small parts, beside the library's: a Settings page is its
// name as the page's one header (the layout draws it), then a grouped
// Section card per topic, its rows the library's SettingsRows, SettingRow,
// FactRow and RowAlert (grasp/setting-row), or ReadOnlyRow for a value
// nobody changes (read-only-row.tsx). Here only what the library has not:
// - SettingsStack: a section's fields and facts, one under the other.
// - RowNote: a row's line, or why its action failed.
// - TitleLine: an Item's title with a quieter detail beside it.
// - LoadingLines, SectionNotLoaded and SettingsError: a section that is
//   loading, didn't load, or failed as it rendered.

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
  // As wide as a form of Grasp UI's stands: a line of text stays readable.
  // Never wider than the box it is in (a dialog): a code block's long
  // lines scroll inside it rather than push it past the box's edge.
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    minWidth: 0,
    maxWidth: grasp.formWidth,
  },
  lines: { display: "flex", flexDirection: "column", gap: grasp.space3 },
});

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
}) => <PartNotLoaded onRetry={onRetry} page={page} />;

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

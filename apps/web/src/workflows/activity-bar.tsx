import type { WorkflowActivity } from "@grasp-os/shared/workflow-resources";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatDateTime } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { ArrowRight, ChevronDown, ChevronUp } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { runStatusLabels } from "./run-status.ts";

// What happened to a workflow lately (`workflowResources.activity`), as
// the prototype's bar under the canvas (`inside-activity.tsx`): closed it
// is one line, its name and the newest thing that happened, so a look
// says whether the workflow is alive; open, the recent lines newest first,
// with the way to all of them in Traces. Who did something is named as
// the directory knows them; a run's person is "you" or "someone else".

/** Who someone is on this page: their name where it's known. */
export interface Names {
  people: ReadonlyMap<string, string>;
  me: string;
}

const personOf = (names: Names, userId: string): string =>
  names.people.get(userId) ?? userId;

/** One line of activity, in a whole sentence. */
export const activityText = (row: WorkflowActivity, names: Names): string => {
  if (row.kind === "version") {
    const person = personOf(names, row.by);
    const { version } = row;
    return i18n._(msg`${person} published version ${version}`);
  }
  if (row.kind === "binding") {
    const person = personOf(names, row.by);
    const { alias, version } = row;
    return row.change === "approved"
      ? i18n._(msg`${person} approved ${alias} for version ${version}`)
      : i18n._(msg`${person} revoked ${alias} for version ${version}`);
  }
  const { version } = row;
  const mine = row.principal === names.me;
  if (row.change === "started") {
    return mine
      ? i18n._(msg`A run of version ${version} started for you`)
      : i18n._(msg`A run of version ${version} started for someone else`);
  }
  const status = i18n._(runStatusLabels[row.status]);
  return mine
    ? i18n._(msg`Your run of version ${version} ended: ${status}`)
    : i18n._(
        msg`A run of version ${version} for someone else ended: ${status}`
      );
};

/** A line's key: what happened, when, to what. */
export const activityKey = (row: WorkflowActivity): string => {
  if (row.kind === "run") {
    return `run ${row.runId} ${row.change}`;
  }
  if (row.kind === "binding") {
    return `binding ${row.alias} ${row.version} ${row.change} ${row.at}`;
  }
  return `version ${row.version}`;
};

const styles = stylex.create({
  line: {
    display: "grid",
    gridTemplateColumns: "10rem minmax(0, 1fr)",
    alignItems: "baseline",
    columnGap: grasp.space4,
    paddingBlock: grasp.space1,
  },
  bar: {
    position: "sticky",
    insetBlockEnd: 0,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space6,
    backgroundColor: grasp.paper,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  head: { display: "flex", alignItems: "center", gap: grasp.space4 },
  heading: {
    flexShrink: 0,
    margin: 0,
    marginInlineStart: `calc(-1 * ${grasp.space2})`,
  },
  all: { marginInlineStart: "auto" },
  newest: { flexGrow: 1, minWidth: 0 },
  // The recent lines, opening under the bar's one line.
  fold: {
    display: "grid",
    gridTemplateRows: "0fr",
    transitionProperty: "grid-template-rows",
    transitionDuration: { default: grasp.durationOpen, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  folded: { gridTemplateRows: "1fr" },
  inner: { minHeight: 0, overflow: "hidden" },
  lines: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "13rem",
    overflowY: "auto",
    margin: 0,
    paddingBlockStart: grasp.space1,
    paddingBlockEnd: grasp.space2,
    paddingInline: 0,
    listStyle: "none",
  },
});

/** One line: when, and what happened. */
export const ActivityLine = ({
  row,
  names,
}: {
  row: WorkflowActivity;
  names: Names;
}) => (
  <li {...stylex.props(styles.line)}>
    <Text element="span" size="sm" tone="muted">
      <time dateTime={row.at}>{formatDateTime(row.at)}</time>
    </Text>
    <Text element="span" size="sm" wrap="truncate">
      {activityText(row, names)}
    </Text>
  </li>
);

/**
 * The bar under the page: closed, the newest line; open, the recent
 * lines, and `onAll` to see them all in Traces, where there is a Traces.
 */
export const ActivityBar = ({
  activity,
  names,
  onAll,
}: {
  activity: Loaded<WorkflowActivity[]>;
  names: Names;
  onAll: (() => void) | undefined;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  if (activity.state !== "ready") {
    return null;
  }
  const rows = activity.data;
  const [newest] = rows;
  return (
    <section aria-labelledby="workflow-activity" {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.head)}>
        <h2 id="workflow-activity" {...stylex.props(styles.heading)}>
          <Button
            aria-controls="workflow-activity-lines"
            aria-expanded={open}
            iconEnd={open ? ChevronDown : ChevronUp}
            onClick={() => {
              setOpen(!open);
            }}
            size="sm"
            variant="ghost"
          >
            {t({ message: "Activity", context: "what a workflow did lately" })}
          </Button>
        </h2>
        {open && onAll !== undefined ? (
          <Button
            aria-label={t`Activity: see all of it in Traces`}
            iconEnd={ArrowRight}
            layout={styles.all}
            onClick={onAll}
            size="sm"
            variant="ghost"
          >
            {t({ message: "See all", context: "open the whole list" })}
          </Button>
        ) : null}
        {!open && newest !== undefined ? (
          <Text layout={styles.newest} size="sm" tone="muted" wrap="truncate">
            <time dateTime={newest.at}>{formatDateTime(newest.at)}</time>
            {" · "}
            {activityText(newest, names)}
          </Text>
        ) : null}
        {newest === undefined ? (
          <Text size="sm" tone="muted">
            {t`Nothing has happened yet.`}
          </Text>
        ) : null}
      </div>
      <div
        id="workflow-activity-lines"
        inert={!open}
        {...stylex.props(styles.fold, open && styles.folded)}
      >
        <div {...stylex.props(styles.inner)}>
          <ol {...stylex.props(styles.lines)}>
            {rows.map((row) => (
              <ActivityLine key={activityKey(row)} names={names} row={row} />
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
};

import type { WorkflowActivity } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowRightIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";

import { formatDateTime } from "../format.ts";
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

/** One line: when, and what happened. */
export const ActivityLine = ({
  row,
  names,
}: {
  row: WorkflowActivity;
  names: Names;
}) => (
  <li className="grid grid-cols-[10rem_minmax(0,1fr)] items-baseline gap-x-4 py-1">
    <time className="text-muted-foreground tabular-nums" dateTime={row.at}>
      {formatDateTime(row.at)}
    </time>
    <span className="min-w-0 truncate">{activityText(row, names)}</span>
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
    <section
      aria-labelledby="workflow-activity"
      className="bg-background sticky bottom-0 border-t px-6 py-1.5"
    >
      <div className="flex items-center gap-4">
        <h2 className="-ml-2.5 flex-none" id="workflow-activity">
          <Button
            aria-controls="workflow-activity-lines"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
            size="sm"
            variant="ghost"
          >
            <Trans context="what a workflow did lately">Activity</Trans>
            <ChevronUpIcon
              className={cn(
                "transition-transform duration-300",
                open && "rotate-180"
              )}
              data-icon="inline-end"
            />
          </Button>
        </h2>
        {open && onAll !== undefined ? (
          <Button
            aria-label={t`Activity: see all of it in Traces`}
            className="-mr-2.5 ml-auto"
            onClick={onAll}
            size="sm"
            variant="ghost"
          >
            <Trans context="open the whole list">See all</Trans>
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        ) : null}
        {!open && newest !== undefined ? (
          <p className="text-muted-foreground min-w-0 flex-1 truncate">
            <time dateTime={newest.at}>{formatDateTime(newest.at)}</time>
            {" · "}
            {activityText(newest, names)}
          </p>
        ) : null}
        {newest === undefined ? (
          <p className="text-muted-foreground">
            <Trans>Nothing has happened yet.</Trans>
          </p>
        ) : null}
      </div>
      <div
        className={cn(
          "ease-sidebar grid transition-all duration-300",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
        id="workflow-activity-lines"
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <ol className="flex max-h-52 flex-col overflow-y-auto pt-1 pb-2">
            {rows.map((row) => (
              <ActivityLine key={activityKey(row)} names={names} row={row} />
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
};

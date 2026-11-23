import type { WorkflowActivity } from "@grasp-os/shared/workflow-resources";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { runStatusLabels } from "./run-status.ts";

// What happened to a workflow lately (`workflowResources.activity`), a
// line each, as its builders' Runs and tests list it (traces.tsx). Who did
// something is named as the page knows them, never by an ID.

/** Who someone is on this page: their name where it's known. */
export interface Names {
  people: ReadonlyMap<string, string>;
  me: string;
}

/**
 * Someone by name, as the page knows them; else "Someone else", never
 * their ID. Not "a former member": the directory lists no Grasp staff, who
 * publish and run workflows too.
 */
export const personOf = (names: Names, userId: string): string =>
  names.people.get(userId) ?? i18n._(msg`Someone else`);

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

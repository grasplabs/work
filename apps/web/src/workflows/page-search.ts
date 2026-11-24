import { runFilterStatuses } from "@grasp-os/shared/run-filter";
import type { RunFilterStatus } from "@grasp-os/shared/run-filter";

import { projectSearchOf } from "../frame/item-shell.tsx";
import { workflowSettingsSectionOf } from "./settings-sections.ts";
import type { WorkflowSettingsSection } from "./settings-sections.ts";

// What the workflows pages' addresses may ask of them, read as far as it
// is valid (the routes' validateSearch). Every key a page reads is named
// in what is returned, undefined where the address's value is not one:
// the router keeps an address's raw value under any key left out, so a
// bad `?status=` or `?view=` would reach the page as it was typed.

/** A workflow page's views. */
export type WorkflowView = "flow" | "runs" | "settings";

/** What a link to a workflow's page may ask of it. */
export interface WorkflowSearch {
  /** The view it opens on, for its builders (Settings for anyone); none for its page. */
  view?: WorkflowView;
  /** In Settings, the section open: General by default. */
  section?: WorkflowSettingsSection;
  /** The project it was started or opened from: the way back. */
  project?: string;
  /**
   * The chat the person came from, building it in Grasp's chat: the page
   * makes it the workflow's. Core checks it is theirs on each read.
   */
  chat?: string;
}

/** A view named in an address, or none for anything else. */
const viewOf = (value: unknown): WorkflowView | undefined =>
  value === "flow" || value === "runs" || value === "settings"
    ? value
    : undefined;

/** What the address asks of a workflow's page, as far as it is valid. */
export const workflowSearchOf = (
  search: Record<string, unknown>
): WorkflowSearch => ({
  view: viewOf(search.view),
  section: workflowSettingsSectionOf(search.section),
  project: projectSearchOf(search),
  chat: typeof search.chat === "string" ? search.chat : undefined,
});

/** What Workflows › Runs' address filters its log by. */
export interface RunsSearch {
  status?: RunFilterStatus;
}

/** A status the runs log filters by. */
export const isRunFilterStatus = (value: unknown): value is RunFilterStatus =>
  runFilterStatuses.some((status) => status === value);

/** What Workflows › Runs' address asks for, as far as it is valid. */
export const runsSearchOf = (search: Record<string, unknown>): RunsSearch => ({
  status: isRunFilterStatus(search.status) ? search.status : undefined,
});

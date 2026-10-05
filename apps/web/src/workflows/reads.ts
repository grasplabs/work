import type { App } from "@grasp-os/shared/apps";
import { roleErrors } from "@grasp-os/shared/roles";
import type {
  RunFilter,
  RunsPage,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";

import type { Session } from "../core.ts";

// Lists core refuses to the user role while sharing Apps is switched off:
// such a person has no engine to list, so a refusal reads as none, not as
// a failure. Shared by the Workflows and Engines pages.

/** Whether core refused a read to the person's role. */
const refused = (error: unknown): boolean =>
  roleErrors.codeOf(error) === "role.forbidden";

/** The engines (core's Apps) core lets the person open: their own, those shared with them, and every one for admins. */
export const openableApps = async (session: Session): Promise<App[]> => {
  try {
    return await session.apps.list();
  } catch (error) {
    if (refused(error)) {
      return [];
    }
    throw error;
  }
};

/** The workflows core lists for the person. */
export const listWorkflows = async (
  session: Session
): Promise<WorkflowSummary[]> => {
  try {
    return await session.workflows.overview();
  } catch (error) {
    if (refused(error)) {
      return [];
    }
    throw error;
  }
};

/** The runs core lists for the person, as `filter` narrows them. */
export const listRuns = async (
  session: Session,
  filter: RunFilter
): Promise<RunsPage> => {
  try {
    return await session.workflows.runs(filter);
  } catch (error) {
    if (refused(error)) {
      return { runs: [], more: false };
    }
    throw error;
  }
};

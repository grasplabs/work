import { roleErrors } from "@grasp-os/shared/roles";
import { workflowLabel } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceVersion } from "@grasp-os/shared/workflow-resources";
import type {
  RunActivity,
  RunFilter,
  RunsPage,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";

import type { Session } from "../core.ts";
import { listedOrNone, readPeople } from "../directory.ts";

// Lists core refuses to the user role while sharing Apps is switched off:
// such a person has no App to list, so a refusal reads as none, not as
// a failure. Shared by the Workflows and Apps pages.

/** Whether core refused a read to the person's role. */
const refused = (error: unknown): boolean =>
  roleErrors.codeOf(error) === "role.forbidden";

/** What `read` lists, or none when core refuses it to the person's role. */
export const noneIfRefused = async <T>(read: Promise<T[]>): Promise<T[]> => {
  try {
    return await read;
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

/**
 * Who and what a workflow's runs name, by ID, for names only: people as
 * the directory lists them for an admin, with each workflow's owner beside
 * them (core names the owner to anyone who has the workflow, where the
 * directory is an admin's alone); and each workflow by the name people see
 * (`workflowLabel`). Either read refused or slow leaves its names out.
 */
export const readWorkflowNames = async (
  session: Session
): Promise<{
  people: ReadonlyMap<string, string>;
  /** Whether the directory answered: `people` then names every member. */
  everyone: boolean;
  workflows: ReadonlyMap<string, string>;
}> => {
  const [people, workflows] = await Promise.all([
    readPeople(session),
    listedOrNone(listWorkflows(session)),
  ]);
  const named = new Map(people);
  for (const { owner } of workflows) {
    if (owner.name !== null && !named.has(owner.userId)) {
      named.set(owner.userId, owner.name);
    }
  }
  return {
    people: named,
    everyone: people.size > 0,
    workflows: new Map(
      workflows.map((workflow) => [
        workflow.workflowId,
        workflowLabel(workflow),
      ])
    ),
  };
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

/**
 * The runs core counted for the person over its default window
 * (`workflows.activity`); null where their role lists none.
 */
export const readActivity = async (
  session: Session
): Promise<RunActivity | null> => {
  try {
    return await session.workflows.activity();
  } catch (error) {
    if (refused(error)) {
      return null;
    }
    throw error;
  }
};

/**
 * Workflow `workflow`'s versions, newest first (`versions.list`), as a
 * workflow's: its kind's, though the shared list names both kinds.
 */
export const workflowVersions = async (
  session: Session,
  workflow: string
): Promise<WorkflowResourceVersion[]> => {
  const versions = await session.versions.list({
    kind: "workflow",
    id: workflow,
  });
  return versions.filter(
    (version): version is WorkflowResourceVersion => version.kind === "workflow"
  );
};

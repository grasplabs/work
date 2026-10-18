// The map's workflows and teams as its screen reads them from the App's
// store (operations/), and what each refusal means to the person using
// it.

import type { Id } from "@grasp-os/sdk";

import type { Parameter, Step, WorkflowRecord } from "./totals";

/** A workflow, at its current version or an earlier one. */
export interface Workflow {
  id: Id<"workflows">;
  /** The revision it was read at, which a save or link asserts. */
  revision: number;
  version: number;
  record: WorkflowRecord;
  /** Its notes: empty where the list leaves them out. */
  body: string;
}

/** A team the map groups workflows by. */
export interface Team {
  id: Id<"teams">;
  title: string;
}

/** A workflow opened, and the version of it last drawn beside it. */
export interface Opened {
  current: Workflow;
  drawn: Workflow | null;
}

/** A call's answer, or the code of why it was refused. */
export type Outcome<T> = { ok: T } | { error: string };

/** A workflow's fields as the store keeps them. */
interface Stored {
  title: string;
  state: "drawn" | "designed";
  team: Id<"teams"> | null;
  steps: Step[];
  parameters: Parameter[];
  gain: { hoursPerWeek: number } | null;
  app: { appId: string; workflowId: string } | null;
  version: number;
}

/** A workflow's fields as the map reads them, from the store's. */
export const recordFrom = (stored: Stored): WorkflowRecord => ({
  type: "workflow",
  title: stored.title,
  state: stored.state,
  ...(stored.team === null ? {} : { team: stored.team }),
  steps: stored.steps,
  parameters: stored.parameters,
  ...(stored.gain === null ? {} : { gain: stored.gain }),
  ...(stored.app === null ? {} : { app: stored.app }),
});

/** A workflow the list shows, without its notes. */
export const listedFrom = (
  listed: Stored & { id: Id<"workflows">; revision: number }
): Workflow => ({
  id: listed.id,
  revision: listed.revision,
  version: listed.version,
  record: recordFrom(listed),
  body: "",
});

/** A workflow, or a version of it, as the store answers it. */
export const workflowFrom = (
  id: Id<"workflows">,
  stored: Stored & { _rev: number; notes: string }
): Workflow => ({
  id,
  revision: stored._rev,
  version: stored.version,
  record: recordFrom(stored),
  body: stored.notes,
});

/** A workflow's fields. */
export const recordOf = (workflow: Workflow): WorkflowRecord => workflow.record;

/** The code of why a call failed, or that it couldn't be made. */
const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : "app.unreachable";

/**
 * What `run` resolves with, or the code of why it rejected, so no call
 * ends in an unhandled rejection.
 */
export const settle = async <T>(run: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: codeOf(error) };
  }
};

/** What a refusal means to the person using the map. */
export const refusal = (code: string): string => {
  switch (code) {
    case "data.conflict":
    case "data.reads_changed": {
      return "Someone saved this workflow since you opened it. Open it again to see their changes.";
    }
    case "data.access_denied":
    case "data.write_denied": {
      return "Only the App's builders change the map.";
    }
    case "data.invalid":
    case "contract.invalid_args": {
      return "That isn't a valid workflow: check each step has a name, and each number is between 0 and 10,000.";
    }
    case "contract.input_too_large":
    case "map.too_large": {
      return "This workflow is too large: shorten its steps, parameters or description.";
    }
    case "map.too_many_teams": {
      return "The map holds at most 100 teams: use one it has.";
    }
    case "map.not_found": {
      return "This workflow is gone.";
    }
    case "map.not_drawn": {
      return "A workflow is drawn before it is designed.";
    }
    case "map.not_designed": {
      return "Only a designed workflow links to an App workflow.";
    }
    case "map.linked_drawn": {
      return "This workflow is linked to an App workflow, so it stays designed.";
    }
    case "app.unreachable": {
      return "Grasp can't be reached right now. Try again in a moment.";
    }
    default: {
      return `That didn't work (${code}).`;
    }
  }
};

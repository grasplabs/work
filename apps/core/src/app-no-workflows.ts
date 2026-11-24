import { appErrors } from "@grasp-os/shared/apps";

// An App holds no workflows of its own (GRA-1367): what runs on its own is
// an independent workflow the App binds under an alias, whose every call
// is a binding of its validated definition that an admin approves. So no
// version of an App holds code under
// `workflows/`: every write that makes one (a commit, a chat's proposed
// draft, an App created or updated from a blueprint) refuses such files,
// naming them, and nothing in an App is code that runs outside the
// review of what it declares.

/** The folder an App's own workflows were in. */
const workflowsFolder = "workflows/";

/** Most paths the refusal names: enough to find them, bounded to send. */
const namedPathsMax = 20;

/** Refuses with `app.no_workflows` paths under `workflows/`, naming them. */
export const refuseAppWorkflows = (paths: Iterable<string>): void => {
  const workflows = [...paths]
    .filter((path) => path.startsWith(workflowsFolder))
    .toSorted();
  if (workflows.length > 0) {
    throw appErrors.create("app.no_workflows", {
      issues: workflows.slice(0, namedPathsMax),
    });
  }
};

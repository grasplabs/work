import { workflowsFolder } from "@grasp-os/compiler";
import { appErrors } from "@grasp-os/shared/apps";

// An App holds no workflows of its own (GRA-1367): what runs on its own is
// an independent JSON workflow the App binds under an alias, whose every
// call is a binding of its validated definition that an admin approves for
// that exact version. Code under `workflows/` would run as the App's own
// workflow instead, its calls read out of the code. The chat's agent
// writes none (agent-builds.ts) and creates no App from a blueprint that
// carries any (app-blueprints.ts), refused naming the files.

/** Most paths the refusal names: enough to find them, bounded to send. */
const namedPathsMax = 20;

/** Refuses with `app.no_workflows` paths under `workflows/`, naming them. */
export const refuseAppWorkflows = (paths: Iterable<string>): void => {
  const workflows = [...paths]
    .filter((path) => path.startsWith(workflowsFolder.folder))
    .toSorted();
  if (workflows.length > 0) {
    throw appErrors.create("app.no_workflows", {
      issues: workflows.slice(0, namedPathsMax),
    });
  }
};

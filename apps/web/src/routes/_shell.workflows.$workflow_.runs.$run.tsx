import { isAdmin } from "@grasp-os/shared/roles";
import { workflowLabel } from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { chatPresence } from "../chat/chat-presence.ts";
import { LoadingBar } from "../frame/page-skeletons-b.tsx";
import { PageNotLoaded } from "../frame/page-states.tsx";
import { Workflow as WorkflowMark } from "../grasp/icons/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { listRuns, readWorkflowNames } from "../workflows/reads.ts";
import { RunPage } from "../workflows/run-page.tsx";

// One run of an independent workflow, on its own page (workflows/run-page.tsx):
// beside its workflow's page, not under it, so the workflow's bar and views
// give way to the run's own.

const WorkflowRun = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { workflow, run, decision, names } = Route.useLoaderData();
  const { workflow: id } = Route.useParams();
  const crumbs = [
    { label: t`Workflows`, to: "/workflows" } as const,
    { label: t`Run` },
  ];
  if (workflow.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={crumbs}
        icon={WorkflowMark}
        notFound={t`Workflow not found`}
        page={workflow}
      />
    );
  }
  if (run.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={crumbs}
        icon={WorkflowMark}
        notFound={t`Run not found`}
        page={run}
      />
    );
  }
  return (
    <RunPage
      // Another run starts from what its own read says.
      key={run.data.id}
      admin={isAdmin(identity.role)}
      decision={decision}
      name={workflowLabel(workflow.data)}
      names={{
        people: names.state === "ready" ? names.data.people : new Map(),
        me: identity.userId,
      }}
      opened={run.data}
      workflow={id}
    />
  );
};

export const Route = createFileRoute("/_shell/workflows/$workflow_/runs/$run")({
  // A run is read, not talked over: Grasp's chat stays away, as on its workflow.
  staticData: { chat: chatPresence.hidden },
  pendingComponent: LoadingBar,
  loader: async ({ context: { core }, params: { workflow, run } }) => {
    const [resource, read, names] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflowResources.get(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.run(workflow, run)
      ),
      loadFromCore(core, readWorkflowNames),
    ]);
    // The answer it waits for, where the reader may give it: core names
    // it on the Runs log's waiting runs alone (core need 79).
    const waiting =
      read.state === "ready" && read.data.endedAt === null
        ? await loadFromCore(core, async (session) => {
            const page = await listRuns(session, { status: "waiting" });
            const id = page.runs.find((each) => each.id === run)?.decision;
            return id === undefined
              ? undefined
              : await session.decisions.get(id);
          })
        : undefined;
    return {
      workflow: resource,
      run: read,
      names,
      decision: waiting?.state === "ready" ? waiting.data : undefined,
    };
  },
  component: WorkflowRun,
});

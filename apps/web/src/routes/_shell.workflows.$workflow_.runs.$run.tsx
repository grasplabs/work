import { isAdmin } from "@grasp-os/shared/roles";
import { workflowLabel } from "@grasp-os/shared/workflow-resources";
import { Icon, WorkflowIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { chatPresence } from "../chat/chat-presence.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { readWorkflowNames, titledDecision } from "../workflows/reads.ts";
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

/** A workflow's mark, where a page says it wasn't found. */
const WorkflowMark = () => <Icon icon={WorkflowIcon} />;

export const Route = createFileRoute("/_shell/workflows/$workflow_/runs/$run")({
  // A run is read, not talked over: Grasp's chat stays away, as on its workflow.
  staticData: { chat: chatPresence.hidden },
  pendingComponent: PageLoading,
  loader: async ({ context: { core }, params: { workflow, run } }) => {
    const [resource, read, names, waiting] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflowResources.get(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.run(workflow, run)
      ),
      loadFromCore(core, readWorkflowNames),
      // The answer it waits for, where the reader may give it.
      loadFromCore(core, async (session) => await session.decisions.waiting()),
    ]);
    const asked =
      waiting.state === "ready"
        ? waiting.data.find((decision) => decision.run === run)
        : undefined;
    const titles: ReadonlyMap<string, string> =
      names.state === "ready" ? names.data.workflows : new Map();
    return {
      workflow: resource,
      run: read,
      names,
      decision: asked === undefined ? undefined : titledDecision(asked, titles),
    };
  },
  component: WorkflowRun,
});

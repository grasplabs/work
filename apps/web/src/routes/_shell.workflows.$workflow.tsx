import type {
  SteeredWrite,
  WorkflowDraft,
  WorkflowParams,
  WorkflowResource,
  WorkflowActionReview,
  WorkflowResourceRun,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import { formatDateTime, formatList } from "../format.ts";
import {
  NotLoadedState,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { DefinitionEditor } from "../workflows/definition-editor.tsx";
import { ResourceParams } from "../workflows/resource-params.tsx";
import { ResourceRuns } from "../workflows/resource-runs.tsx";
import { TestRun } from "../workflows/test-run.tsx";

// One independent workflow (platform specification 13): for its builders,
// its definition as a draft they edit, check and publish; for everyone
// with a role, its published versions. Core decides who sees what: the
// draft is read only for builders, as it can hold a sensitive default.
// Each version shows what its own actions may call, as sealed with it
// (GRA-709): each binding they use, and a connector's exact operations;
// and, for one that asks a model, the writes its answers may steer
// (GRA-718), which no reviewer should have to piece together. Its
// parameters, which its builders set, and its runs, as core lists them for
// the reader (GRA-674).

/**
 * One use whose writes a model's answers may steer (GRA-718), as its
 * neighbouring use badge names it: a connector's alias and the operations
 * that may write; an App export's alias alone, as any of it may write.
 */
const SteeredWriteBadge = ({ write }: { write: SteeredWrite }) => {
  const target =
    write.kind === "connector"
      ? `${write.alias}: ${formatList(write.operations)}`
      : write.alias;
  return (
    <Badge variant="destructive">
      <Trans>Writes a model may steer: {target}</Trans>
    </Badge>
  );
};

/** What a version's own actions may call: each action, then its uses. */
const ActionEffects = ({ actions }: { actions: WorkflowActionReview[] }) => {
  if (actions.length === 0) {
    return (
      <span className="text-muted-foreground">
        <Trans>None</Trans>
      </span>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {actions.map((action) => (
        <li className="flex flex-wrap items-center gap-1" key={action.binding}>
          <code>{action.binding}</code>
          {action.uses.map((use) => (
            <Badge key={use.alias} variant="outline">
              {use.kind === "connector"
                ? `${use.alias}: ${formatList(use.operations)}`
                : use.alias}
            </Badge>
          ))}
          {action.modelSteeredWrites.map((write) => (
            <SteeredWriteBadge key={write.alias} write={write} />
          ))}
        </li>
      ))}
    </ul>
  );
};

const Versions = ({ versions }: { versions: WorkflowResourceVersion[] }) => {
  const { t } = useLingui();
  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>Nothing is published yet.</Trans>
      </p>
    );
  }
  return (
    <Table>
      <TableCaption>
        <Trans>
          Writes a model may steer cover each action&apos;s own model uses and
          the workflow&apos;s own model tasks. An action&apos;s model uses reach
          only that action; each of the workflow&apos;s model tasks is taken to
          reach every call the workflow makes.
        </Trans>
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t`Version`}</TableHead>
          <TableHead>{t`Definition version`}</TableHead>
          <TableHead>{t`Published`}</TableHead>
          <TableHead>{t`Actions`}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.map((version) => (
          <TableRow key={version.version}>
            <TableCell>{version.version}</TableCell>
            <TableCell>{version.definitionVersion}</TableCell>
            <TableCell>{formatDateTime(version.createdAt)}</TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                {version.modelSteeredWrites.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-muted-foreground">
                      <Trans>Its model tasks</Trans>
                    </span>
                    {version.modelSteeredWrites.map((write) => (
                      <SteeredWriteBadge key={write.alias} write={write} />
                    ))}
                  </div>
                )}
                <ActionEffects actions={version.actions} />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const WorkflowResourceView = ({
  resource,
  draft,
  versions,
  params,
  runs,
  me,
}: {
  resource: WorkflowResource;
  draft: Loaded<WorkflowDraft> | undefined;
  versions: Loaded<WorkflowResourceVersion[]>;
  params: Loaded<WorkflowParams>;
  runs: Loaded<WorkflowResourceRun[]>;
  me: string;
}) => {
  const router = useRouter();
  const { currentVersion } = resource;
  return (
    <Tabs defaultValue={draft === undefined ? "versions" : "definition"}>
      <div className="flex flex-col gap-3 border-b px-6 pt-5">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-medium tracking-tight">
            {resource.name}
          </h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {currentVersion === null ? (
                <Trans>Not published</Trans>
              ) : (
                <Trans>Version {currentVersion}</Trans>
              )}
            </Badge>
            {/* Its approved packages, for its builders: read there, and
                retired or revoked by whoever may approve packages. */}
            {resource.role === "builder" ? (
              <Link
                className="hover:underline focus-visible:underline"
                params={{ workflow: resource.id }}
                to="/settings/packages/workflows/$workflow"
              >
                <Trans>Packages</Trans>
              </Link>
            ) : null}
          </div>
        </div>
        <TabsList variant="line">
          {draft === undefined ? null : (
            <TabsTrigger value="definition">
              <Trans context="tab of a workflow">Definition</Trans>
            </TabsTrigger>
          )}
          <TabsTrigger value="parameters">
            <Trans context="tab of a workflow">Parameters</Trans>
          </TabsTrigger>
          <TabsTrigger value="runs">
            <Trans context="tab listing the runs of workflows">Runs</Trans>
          </TabsTrigger>
          <TabsTrigger value="versions">
            <Trans context="tab of a workflow">Versions</Trans>
          </TabsTrigger>
        </TabsList>
      </div>
      {draft === undefined ? null : (
        // Kept while another tab shows: what was typed stays.
        <TabsContent keepMounted value="definition">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
            {draft.state === "ready" ? (
              <DefinitionEditor
                currentVersion={currentVersion}
                loaded={draft.data}
                onVersionMoved={() => {
                  void router.invalidate();
                }}
                onPublished={() => {
                  // The new current version, and its place among the
                  // versions, as core has them now.
                  void router.invalidate();
                }}
                workflow={resource.id}
              />
            ) : (
              <NotLoadedState page={draft} />
            )}
            {currentVersion === null ? null : (
              <TestRun version={currentVersion} workflow={resource.id} />
            )}
          </div>
        </TabsContent>
      )}
      {/* Kept while another tab shows: what was typed stays. */}
      <TabsContent keepMounted value="parameters">
        <div className="mx-auto w-full max-w-5xl p-6">
          {params.state === "ready" ? (
            <ResourceParams
              editable={resource.role === "builder"}
              loaded={params.data}
              workflow={resource.id}
            />
          ) : (
            <NotLoadedState page={params} />
          )}
        </div>
      </TabsContent>
      <TabsContent value="runs">
        <div className="mx-auto w-full max-w-5xl p-6">
          {runs.state === "ready" ? (
            <ResourceRuns me={me} runs={runs.data} />
          ) : (
            <NotLoadedState page={runs} />
          )}
        </div>
      </TabsContent>
      <TabsContent value="versions">
        <div className="mx-auto w-full max-w-5xl p-6">
          {versions.state === "ready" ? (
            <Versions versions={versions.data} />
          ) : (
            <NotLoadedState page={versions} />
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
};

const WorkflowResourcePage = () => {
  const { resource, draft, versions, params, runs } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { t } = useLingui();
  const name = resource.state === "ready" ? resource.data.name : undefined;
  const crumbs = [
    { label: t`Workflows`, to: "/workflows" },
    { label: name ?? t`Workflow` },
  ] as const;
  if (resource.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={crumbs}
        icon={WorkflowIcon}
        notFound={t`Workflow not found`}
        page={resource}
      />
    );
  }
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="flex flex-col text-sm">
        <WorkflowResourceView
          // Another workflow starts afresh; a new current version of this
          // one keeps what is typed in its editor.
          key={resource.data.id}
          draft={draft}
          me={identity.userId}
          params={params}
          resource={resource.data}
          runs={runs}
          versions={versions}
        />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/$workflow")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core }, params: { workflow } }) => {
    const [resource, versions, params, runs] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflowResources.get(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.versions(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.params(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.runs(workflow)
      ),
    ]);
    // Only its builders read its draft.
    const draft =
      resource.state === "ready" && resource.data.role === "builder"
        ? await loadFromCore(
            core,
            async (session) => await session.workflowResources.draft(workflow)
          )
        : undefined;
    return { resource, draft, versions, params, runs };
  },
  component: WorkflowResourcePage,
});

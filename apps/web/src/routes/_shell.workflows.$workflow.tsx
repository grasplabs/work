import type {
  WorkflowDraft,
  WorkflowResource,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
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
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import { formatDateTime } from "../format.ts";
import {
  NotLoadedState,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { DefinitionEditor } from "../workflows/definition-editor.tsx";

// One independent workflow (platform specification 13): for its builders,
// its definition as a draft they edit, check and publish; for everyone
// with a role, its published versions. Core decides who sees what: the
// draft is read only for builders, as it can hold a sensitive default.

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
      <TableHeader>
        <TableRow>
          <TableHead>{t`Version`}</TableHead>
          <TableHead>{t`Definition version`}</TableHead>
          <TableHead>{t`Published`}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.map((version) => (
          <TableRow key={version.version}>
            <TableCell>{version.version}</TableCell>
            <TableCell>{version.definitionVersion}</TableCell>
            <TableCell>{formatDateTime(version.createdAt)}</TableCell>
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
}: {
  resource: WorkflowResource;
  draft: Loaded<WorkflowDraft> | undefined;
  versions: Loaded<WorkflowResourceVersion[]>;
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
          </div>
        </div>
        <TabsList variant="line">
          {draft === undefined ? null : (
            <TabsTrigger value="definition">
              <Trans context="tab of a workflow">Definition</Trans>
            </TabsTrigger>
          )}
          <TabsTrigger value="versions">
            <Trans context="tab of a workflow">Versions</Trans>
          </TabsTrigger>
        </TabsList>
      </div>
      {draft === undefined ? null : (
        // Kept while another tab shows: what was typed stays.
        <TabsContent keepMounted value="definition">
          <div className="mx-auto w-full max-w-5xl p-6">
            {draft.state === "ready" ? (
              <DefinitionEditor
                currentVersion={currentVersion}
                loaded={draft.data}
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
          </div>
        </TabsContent>
      )}
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
  const { resource, draft, versions } = Route.useLoaderData();
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
          // Another workflow, or a new current version, starts afresh.
          key={`${resource.data.id}/${resource.data.currentVersion}`}
          draft={draft}
          resource={resource.data}
          versions={versions}
        />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/$workflow")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core }, params: { workflow } }) => {
    const [resource, versions] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflowResources.get(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.versions(workflow)
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
    return { resource, draft, versions };
  },
  component: WorkflowResourcePage,
});

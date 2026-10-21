import { runFileContentPath } from "@grasp-os/shared/run-files";
import type { RunFileListing } from "@grasp-os/shared/run-files";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { DownloadIcon, WorkflowIcon } from "lucide-react";

import { formatDateTime, formatFileSize } from "../format.ts";
import {
  NotLoadedState,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { statusLabels } from "../workflows/resource-runs.tsx";

// One run of an independent workflow (GRA-888): how it stands and, for
// those core lets download them (its person and, unless the run is
// restricted, the organization's admins), the files it finished. Core
// decides who sees what and serves each file only as an attachment; the
// page shows what it gets.

const RunFiles = ({
  workflow,
  run,
  files,
}: {
  workflow: string;
  run: string;
  files: RunFileListing[];
}) => {
  const { t } = useLingui();
  if (files.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>This run kept no files.</Trans>
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t`Name`}</TableHead>
          <TableHead>{t`Size`}</TableHead>
          <TableHead>{t`Finished`}</TableHead>
          <TableHead>
            <span className="sr-only">{t`Download`}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TableRow key={file.id}>
            <TableCell>{file.name}</TableCell>
            <TableCell>{formatFileSize(file.size)}</TableCell>
            <TableCell>{formatDateTime(file.finishedAt)}</TableCell>
            <TableCell>
              {/* Core serves it as an attachment only, to those who may download it. */}
              <a
                aria-label={t`Download ${file.name}`}
                className={buttonVariants({
                  size: "icon-sm",
                  variant: "ghost",
                })}
                download
                href={runFileContentPath(workflow, run, file.id)}
              >
                <DownloadIcon />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const ResourceRunPage = () => {
  const { resource, status, files } = Route.useLoaderData();
  const { workflow, run } = Route.useParams();
  const { t } = useLingui();
  const name = resource.state === "ready" ? resource.data.name : undefined;
  const crumbs = [
    { label: t`Workflows`, to: "/workflows" },
    {
      label: name ?? t`Workflow`,
      to: "/workflows/$workflow",
      params: { workflow },
    },
    { label: t`Run` },
  ] as const;
  if (status.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={crumbs}
        icon={WorkflowIcon}
        notFound={t`Run not found`}
        page={status}
      />
    );
  }
  const { data: summary } = status;
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6 text-sm">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium tracking-tight">
            {name === undefined ? t`Run` : t`Run of ${name}`}
          </h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>{t(statusLabels[summary.status])}</span>
            <span className="tabular-nums">
              {formatDateTime(summary.createdAt)}
            </span>
            {summary.endedAt === null ? null : (
              <span className="tabular-nums">
                <Trans>Ended {formatDateTime(summary.endedAt)}</Trans>
              </span>
            )}
          </div>
        </div>
        {files.state === "ready" && files.data === null ? null : (
          <section aria-labelledby="run-files" className="flex flex-col gap-2">
            <h2 className="text-lg font-medium" id="run-files">
              <Trans>Files</Trans>
            </h2>
            {files.state === "ready" ? (
              <RunFiles
                files={files.data ?? []}
                run={run}
                workflow={workflow}
              />
            ) : (
              <NotLoadedState page={files} />
            )}
          </section>
        )}
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/$workflow_/runs/$run")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core }, params: { workflow, run } }) => {
    const [resource, status, files] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflowResources.get(workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflowResources.run(workflow, run)
      ),
      loadFromCore(
        core,
        async (session) =>
          await session.workflowResources.runFiles(workflow, run)
      ),
    ]);
    return { resource, status, files };
  },
  component: ResourceRunPage,
});

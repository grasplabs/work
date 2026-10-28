import { releaseIdSchema } from "@grasp-os/shared/release";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { AdminPage } from "../../../admin/page.tsx";
import { Panel } from "../../../admin/panel.tsx";
import {
  PlatformNav,
  platformCrumb,
  releasesCrumb,
  startRolloutId,
} from "../../../admin/platform-nav.tsx";
import { Facts, listed, Quiet } from "../../../admin/release-parts.tsx";
import { formatBytes, formatTime } from "../../../releases/format.ts";
import { fetchRelease } from "../../../releases/functions.ts";
import type { WorkerView } from "../../../releases/queries.ts";
import { versionWords } from "../../../releases/version.ts";

/** One of the release's Workers: how it runs, its modules and its databases' migrations. */
const WorkerPanel = ({ worker }: { worker: WorkerView }) => (
  <Panel description={worker.name} title={worker.app}>
    <Facts
      rows={[
        { label: "Main module", value: worker.mainModule, mono: true },
        {
          label: "Compatibility flags",
          value: listed(worker.compatibilityFlags),
          mono: true,
        },
        { label: "Crons", value: listed(worker.crons), mono: true },
        {
          label: "Required secrets",
          value: listed(worker.requiredSecrets),
          mono: true,
        },
        {
          label: "Durable Object migrations",
          value: listed(worker.durableObjectMigrations),
          mono: true,
        },
        { label: "Static assets", value: String(worker.assetCount) },
      ]}
    />
    <div className="@container border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead variant="card">Module</TableHead>
            <TableHead className="hidden @xl:table-cell" variant="card">
              Type
            </TableHead>
            <TableHead className="text-right" variant="card">
              Size
            </TableHead>
            <TableHead className="hidden @2xl:table-cell" variant="card">
              SHA-256
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {worker.modules.map((module) => (
            <TableRow key={module.name}>
              <TableCell className="whitespace-normal" variant="card">
                <span className="font-mono text-xs break-all">
                  {module.name}
                </span>
              </TableCell>
              <TableCell className="hidden @xl:table-cell" variant="card">
                {module.type}
              </TableCell>
              <TableCell className="text-right" variant="card">
                <span className="tabular-nums">{formatBytes(module.size)}</span>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell" variant="card">
                <span className="text-muted-foreground font-mono text-xs">
                  {module.sha256.slice(0, 12)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    {worker.d1Databases.map((database) => (
      <section
        className="flex flex-col gap-2 border-t px-5 py-3"
        key={database.binding}
      >
        <h3 className="font-medium">
          {`D1 ${database.binding} `}
          <span className="text-muted-foreground font-normal">
            {`(${database.databaseName}), ${database.migrations.length} migrations`}
          </span>
        </h3>
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {database.migrations.map((migration) => (
            <li key={migration}>{migration}</li>
          ))}
        </ul>
      </section>
    ))}
  </Panel>
);

/**
 * One release, as CI built it and the admin imported it: its commit,
 * each Worker with its modules and migrations, and the packages it was
 * built with. The admin's release page, under Platform.
 */
const ReleasePage = () => {
  const release = Route.useLoaderData();
  const packages = Object.entries(release.packages);
  return (
    <AdminPage
      action={
        <Link
          className={buttonVariants({ size: "sm" })}
          hash={startRolloutId}
          to="/platform/rollouts"
        >
          Start a rollout
        </Link>
      }
      description={release.notes}
      parents={[platformCrumb, releasesCrumb]}
      title={versionWords(release) ?? release.id}
    >
      <PlatformNav />
      <div className="flex flex-col gap-6 text-sm">
        <Panel title="The release">
          <Facts
            rows={[
              { label: "Release", value: release.id, mono: true },
              { label: "Commit", value: release.commitSha, mono: true },
              { label: "Built (UTC)", value: formatTime(release.builtAt) },
              {
                label: "Imported (UTC)",
                value: formatTime(release.importedAt),
              },
              {
                label: "Manifest SHA-256",
                value: release.manifestSha256,
                mono: true,
              },
              {
                label: "Compatibility date",
                value: release.compatibilityDate,
                mono: true,
              },
              { label: "Wrangler", value: release.wranglerVersion, mono: true },
            ]}
          />
        </Panel>
        {release.workers.map((worker) => (
          <WorkerPanel key={worker.app} worker={worker} />
        ))}
        <Panel title="Packages">
          {packages.length === 0 ? (
            <Quiet>None recorded.</Quiet>
          ) : (
            <Facts
              rows={packages.map(([name, version]) => ({
                label: name,
                value: version,
                mono: true,
              }))}
            />
          )}
        </Panel>
      </div>
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/releases/$releaseId")({
  loader: async ({ params }) => {
    const id = releaseIdSchema.safeParse(params.releaseId);
    const release = id.success
      ? await fetchRelease({ data: { id: id.data } })
      : null;
    if (release === null) {
      throw notFound();
    }
    return release;
  },
  component: ReleasePage,
});

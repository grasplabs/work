import { releaseIdSchema } from "@grasp-os/shared/release-id";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { PageLoading } from "../../../admin/failure.tsx";
import { AdminPage } from "../../../admin/page.tsx";
import {
  channelsId,
  PlatformNav,
  platformCrumb,
  releasesCrumb,
} from "../../../admin/platform-nav.tsx";
import { Facts, listed, Quiet } from "../../../admin/release-parts.tsx";
import { Section } from "../../../admin/section.tsx";
import { formatTime } from "../../../releases/format.ts";
import { fetchRelease } from "../../../releases/functions.ts";
import type { WorkerView } from "../../../releases/queries.ts";
import { releaseTitle } from "../../../releases/version.ts";
import { channelWords } from "../../../rollout/channel-words.ts";

/** One of the release's Workers, in a line: what deploying it changes. */
const workerLine = (worker: WorkerView): string =>
  `${worker.modules} modules, ${worker.d1Migrations} D1 migrations, Durable Object migrations ${listed(worker.durableObjectMigrations)}`;

/**
 * One release: what it holds, the channels it has been on and who runs
 * it, and its record. Its name, summary and changelog join "What it
 * holds" (GRA-1418).
 */
const ReleasePage = () => {
  const release = Route.useLoaderData();
  const title = releaseTitle(release.notes);
  return (
    <AdminPage
      action={
        <Link className={buttonVariants()} hash={channelsId} to="/platform">
          Promote it
        </Link>
      }
      description={title === "" ? undefined : title}
      parents={[platformCrumb, releasesCrumb]}
      title={release.id}
    >
      <PlatformNav />
      <div className="flex flex-col gap-6 text-sm">
        <Section title="What it holds">
          {release.notes === "" ? (
            <Quiet>No note.</Quiet>
          ) : (
            <p className="border-t px-5 py-3">{release.notes}</p>
          )}
        </Section>
        <Section
          description="Every time a channel was set to it, the newest first."
          title="Channels"
        >
          {release.history.length === 0 ? (
            <Quiet>It hasn&apos;t been on a channel.</Quiet>
          ) : (
            <ul className="flex flex-col">
              {release.history.map((event) => (
                <li
                  className="flex items-baseline justify-between gap-4 border-t px-5 py-2"
                  key={`${event.at.getTime()}-${event.channel}`}
                >
                  <span>{`${channelWords[event.channel]}, by ${event.actor}`}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {formatTime(event.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Who runs it">
          {release.running.length === 0 ? (
            <Quiet>No company runs it now.</Quiet>
          ) : (
            <ul className="flex flex-col">
              {release.running.map((client) => (
                <li className="border-t px-5 py-2" key={client.id}>
                  <Link
                    className="underline-offset-4 hover:underline"
                    params={{ clientId: client.id }}
                    to="/organizations/$clientId/setup"
                  >
                    {client.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="The record">
          <Facts
            rows={[
              { label: "Commit", value: release.commitSha, mono: true },
              { label: "Built (UTC)", value: formatTime(release.builtAt) },
              {
                label: "Imported (UTC)",
                value: formatTime(release.importedAt),
              },
              {
                label: "Bundle",
                value:
                  release.bundleDeletedAt === null
                    ? "Kept"
                    : `Deleted ${formatTime(release.bundleDeletedAt)} UTC: never promoted past Edge`,
                attention: release.bundleDeletedAt !== null,
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
              ...release.workers.map((worker) => ({
                label: worker.app,
                value: workerLine(worker),
              })),
            ]}
          />
        </Section>
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
  pendingComponent: PageLoading,
});

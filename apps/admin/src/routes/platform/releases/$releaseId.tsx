import { releaseIdSchema } from "@grasp-os/shared/release-id";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import {
  createFileRoute,
  Link as RouterLink,
  notFound,
} from "@tanstack/react-router";

import { PageLoading } from "../../../admin/failure.tsx";
import { EmptyPart, PagePart } from "../../../admin/page-part.tsx";
import {
  channelsId,
  PlatformPage,
  platformCrumb,
  releasesCrumb,
} from "../../../admin/platform-nav.tsx";
import { actorWords } from "../../../admin/setup-history.ts";
import { Facts } from "../../../admin/setup-parts.tsx";
import { formatTime } from "../../../releases/format.ts";
import { fetchRelease } from "../../../releases/functions.ts";
import type { WorkerView } from "../../../releases/queries.ts";
import { releaseTitle } from "../../../releases/version.ts";
import { channelWords } from "../../../rollout/channel-words.ts";

/** A list, in words: `none` when it's empty. */
const listed = (items: readonly string[]): string => items.join(", ") || "none";

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
    <PlatformPage
      action={
        <Button asChild>
          <RouterLink hash={channelsId} to="/platform">
            Promote it
          </RouterLink>
        </Button>
      }
      description={title === "" ? undefined : title}
      parents={[platformCrumb, releasesCrumb]}
      title={release.id}
    >
      <PagePart id="holds" title="What it holds">
        {release.notes === "" ? (
          <EmptyPart>No note.</EmptyPart>
        ) : (
          <Text size="sm">{release.notes}</Text>
        )}
      </PagePart>
      <PagePart
        description="Every time a channel was set to it, the newest first."
        id="channels"
        title="Channels"
      >
        {release.history.length === 0 ? (
          <EmptyPart>It hasn&apos;t been on a channel.</EmptyPart>
        ) : (
          <ItemGroup aria-labelledby="channels" separated>
            {release.history.map((event) => (
              <Item key={`${event.at.getTime()}-${event.channel}`} size="sm">
                <ItemContent>
                  <ItemTitle>{channelWords[event.channel]}</ItemTitle>
                  <ItemDescription>{`${actorWords(event.actor)} · ${formatTime(event.at)}`}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )}
      </PagePart>
      <PagePart id="runs" title="Who runs it">
        {release.running.length === 0 ? (
          <EmptyPart>No company runs it now.</EmptyPart>
        ) : (
          <ItemGroup aria-labelledby="runs" separated>
            {release.running.map((client) => (
              <Item asChild key={client.id} size="sm">
                <RouterLink
                  params={{ clientId: client.id }}
                  to="/organizations/$clientId/setup"
                >
                  <ItemContent>
                    <ItemTitle>{client.name}</ItemTitle>
                  </ItemContent>
                </RouterLink>
              </Item>
            ))}
          </ItemGroup>
        )}
      </PagePart>
      <PagePart id="record" title="The record">
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
      </PagePart>
    </PlatformPage>
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

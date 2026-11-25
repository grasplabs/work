import { releaseIdSchema } from "@grasp-os/shared/release-id";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Link as RouterLink,
  notFound,
} from "@tanstack/react-router";

import { PageLoading } from "../../../admin/failure.tsx";
import { AdminPage } from "../../../admin/page.tsx";
import { Panel, PanelNote } from "../../../admin/panel.tsx";
import {
  channelsId,
  PlatformNav,
  platformCrumb,
  releasesCrumb,
} from "../../../admin/platform-nav.tsx";
import { Facts, listed } from "../../../admin/release-parts.tsx";
import { formatTime } from "../../../releases/format.ts";
import { fetchRelease } from "../../../releases/functions.ts";
import type { WorkerView } from "../../../releases/queries.ts";
import { releaseTitle } from "../../../releases/version.ts";
import { channelWords } from "../../../rollout/channel-words.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space["6"] },
});

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
      <PlatformNav />
      <div {...stylex.props(styles.page)}>
        <Panel title="What it holds">
          {release.notes === "" ? (
            <PanelNote>No note.</PanelNote>
          ) : (
            <CardContent>
              <Text size="sm">{release.notes}</Text>
            </CardContent>
          )}
        </Panel>
        <Panel
          description="Every time a channel was set to it, the newest first."
          title="Channels"
        >
          {release.history.length === 0 ? (
            <PanelNote>It hasn&apos;t been on a channel.</PanelNote>
          ) : (
            <CardContent flush>
              <ItemGroup separated>
                {release.history.map((event) => (
                  <Item
                    key={`${event.at.getTime()}-${event.channel}`}
                    size="sm"
                  >
                    <ItemContent>
                      <ItemTitle>{`${channelWords[event.channel]}, by ${event.actor}`}</ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <Text as="span" color="muted" size="xs">
                        {formatTime(event.at)}
                      </Text>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </CardContent>
          )}
        </Panel>
        <Panel title="Who runs it">
          {release.running.length === 0 ? (
            <PanelNote>No company runs it now.</PanelNote>
          ) : (
            <CardContent flush>
              <ItemGroup separated>
                {release.running.map((client) => (
                  <Item key={client.id} size="sm">
                    <ItemContent>
                      <ItemTitle>
                        <Link asChild variant="plain">
                          <RouterLink
                            params={{ clientId: client.id }}
                            to="/organizations/$clientId/setup"
                          >
                            {client.name}
                          </RouterLink>
                        </Link>
                      </ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </CardContent>
          )}
        </Panel>
        <Panel title="The record">
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
  pendingComponent: PageLoading,
});

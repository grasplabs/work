import { Badge } from "@grasp-os/ui/components/badge";
import { CardContent } from "@grasp-os/ui/components/card";
import { Link } from "@grasp-os/ui/components/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";

import { PageLoading } from "../../../admin/failure.tsx";
import { AdminPage } from "../../../admin/page.tsx";
import { Panel, PanelNote } from "../../../admin/panel.tsx";
import { PlatformNav, platformCrumb } from "../../../admin/platform-nav.tsx";
import { formatTime } from "../../../releases/format.ts";
import { fetchReleases } from "../../../releases/functions.ts";
import type { ReleaseSummary } from "../../../releases/queries.ts";
import { releaseTitle } from "../../../releases/version.ts";
import { channelIds } from "../../../rollout/channel-ids.ts";
import type { Channel } from "../../../rollout/channel-ids.ts";
import { channelWords } from "../../../rollout/channel-words.ts";

const styles = stylex.create({
  badges: { display: "flex", flexWrap: "wrap", gap: space["1"] },
  release: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
  },
});

/** The channels a release has been on, Edge first. */
const ChannelsOn = ({ on }: { on: readonly Channel[] }) =>
  on.length === 0 ? (
    <Text as="span" color="muted" size="sm">
      –
    </Text>
  ) : (
    <span {...stylex.props(styles.badges)}>
      {channelIds
        .filter((channel) => on.includes(channel))
        .map((channel) => (
          <Badge key={channel} variant="secondary">
            {channelWords[channel]}
          </Badge>
        ))}
    </span>
  );

/** Every release, the newest first, with the channels each has been on. */
const EveryRelease = ({
  releases,
  older,
  channelsOn,
}: {
  releases: ReleaseSummary[];
  older: ReleaseSummary | null;
  channelsOn: Readonly<Record<string, Channel[]>>;
}) => (
  <Panel
    description={
      older === null
        ? "As CI made them, the newest first. A release opens what it holds and who runs it."
        : `The newest ${releases.length} releases.`
    }
    title="Every release"
  >
    {releases.length === 0 ? (
      <PanelNote>
        No releases yet. Every merge to main publishes one, and the admin
        imports it within a minute.
      </PanelNote>
    ) : (
      <CardContent flush>
        <Table aria-label="Every release">
          <TableHeader>
            <TableRow>
              <TableHead>Release</TableHead>
              <TableHead hideBelow="sm">Channels</TableHead>
              <TableHead hideBelow="md">Built (UTC)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {releases.map((release) => (
              <TableRow key={release.id}>
                <TableCell rowHeader wrap>
                  <span {...stylex.props(styles.release)}>
                    <Link asChild variant="plain">
                      <RouterLink
                        params={{ releaseId: release.id }}
                        to="/platform/releases/$releaseId"
                      >
                        {release.id}
                      </RouterLink>
                    </Link>
                    <span>{releaseTitle(release.notes)}</span>
                    {release.bundleDeletedAt === null ? null : (
                      <Text as="span" color="muted" size="xs">
                        Bundle deleted: never promoted past Edge
                      </Text>
                    )}
                  </span>
                </TableCell>
                <TableCell hideBelow="sm">
                  <ChannelsOn on={channelsOn[release.id] ?? []} />
                </TableCell>
                <TableCell hideBelow="md">
                  <Text as="span" color="muted" size="sm">
                    {formatTime(release.builtAt)}
                  </Text>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    )}
  </Panel>
);

/**
 * Every release CI published, as the admin imported it, with the channels
 * each has been on.
 */
const ReleasesPage = () => {
  const { releases, older, channelsOn } = Route.useLoaderData();
  return (
    <AdminPage
      description="Every merge to main publishes a release; the admin imports it and puts it on Edge by itself. Promote it to Beta, then Stable, from Platform. A release never promoted past Edge keeps its bundle for 14 days; its record stays for good."
      parents={[platformCrumb]}
      title="Releases"
    >
      <PlatformNav />
      <EveryRelease channelsOn={channelsOn} older={older} releases={releases} />
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/releases/")({
  loader: async () => await fetchReleases(),
  component: ReleasesPage,
  pendingComponent: PageLoading,
});

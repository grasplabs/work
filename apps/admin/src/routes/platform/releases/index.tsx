import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PageLoading } from "../../../admin/failure.tsx";
import { AdminPage } from "../../../admin/page.tsx";
import { PlatformNav, platformCrumb } from "../../../admin/platform-nav.tsx";
import { Quiet } from "../../../admin/release-parts.tsx";
import { Section } from "../../../admin/section.tsx";
import { channelIds } from "../../../db/schema.ts";
import type { Channel } from "../../../db/schema.ts";
import { formatTime } from "../../../releases/format.ts";
import { fetchReleases } from "../../../releases/functions.ts";
import type { ReleaseSummary } from "../../../releases/queries.ts";
import { releaseTitle } from "../../../releases/version.ts";
import { channelWords } from "../../../rollout/channel-words.ts";

/** The channels a release has been on, Edge first. */
const ChannelsOn = ({ on }: { on: readonly Channel[] }) =>
  on.length === 0 ? (
    <span className="text-muted-foreground">–</span>
  ) : (
    <span className="flex flex-wrap gap-1">
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
  <Section
    description={
      older === null
        ? "As CI made them, the newest first. A release opens what it holds and who runs it."
        : `The newest ${releases.length} releases.`
    }
    title="Every release"
  >
    {releases.length === 0 ? (
      <Quiet>
        No releases yet. Every merge to main publishes one, and the admin
        imports it within a minute.
      </Quiet>
    ) : (
      <div className="@container border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Release</TableHead>
              <TableHead className="hidden @xl:table-cell" variant="card">
                Channels
              </TableHead>
              <TableHead className="hidden @2xl:table-cell" variant="card">
                Built (UTC)
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {releases.map((release) => (
              <TableRow key={release.id}>
                <TableCell className="whitespace-normal" variant="card">
                  <div className="flex flex-col gap-0.5">
                    <Link
                      className="font-mono text-xs underline-offset-4 hover:underline"
                      params={{ releaseId: release.id }}
                      to="/platform/releases/$releaseId"
                    >
                      {release.id}
                    </Link>
                    <span>{releaseTitle(release.notes)}</span>
                    {release.bundleDeletedAt === null ? null : (
                      <span className="text-muted-foreground text-xs">
                        Bundle deleted: never promoted past Edge
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden @xl:table-cell" variant="card">
                  <ChannelsOn on={channelsOn[release.id] ?? []} />
                </TableCell>
                <TableCell className="hidden @2xl:table-cell" variant="card">
                  <span className="text-muted-foreground tabular-nums">
                    {formatTime(release.builtAt)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </Section>
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
      <div className="flex flex-col gap-6 text-sm">
        <EveryRelease
          channelsOn={channelsOn}
          older={older}
          releases={releases}
        />
      </div>
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/releases/")({
  loader: async () => await fetchReleases(),
  component: ReleasesPage,
  pendingComponent: PageLoading,
});

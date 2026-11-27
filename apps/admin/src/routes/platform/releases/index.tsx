import { Badge } from "@grasp-os/ui/components/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PageLoading } from "../../../admin/failure.tsx";
import { EmptyPart, PagePart } from "../../../admin/page-part.tsx";
import { PlatformPage, platformCrumb } from "../../../admin/platform-nav.tsx";
import { formatTime } from "../../../releases/format.ts";
import { fetchReleases } from "../../../releases/functions.ts";
import type { ReleaseSummary } from "../../../releases/queries.ts";
import { releaseTitle } from "../../../releases/version.ts";
import { channelIds } from "../../../rollout/channel-ids.ts";
import type { Channel } from "../../../rollout/channel-ids.ts";
import { channelWords } from "../../../rollout/channel-words.ts";

/** One release, a row to its page: when CI built it and what it holds, the channels it has been on at its end. */
const ReleaseRow = ({
  release,
  on,
}: {
  release: ReleaseSummary;
  on: readonly Channel[];
}) => {
  const title = releaseTitle(release.notes);
  const built = `${formatTime(release.builtAt)} UTC`;
  return (
    <Item asChild>
      <Link
        params={{ releaseId: release.id }}
        to="/platform/releases/$releaseId"
      >
        <ItemContent>
          <ItemTitle>{release.id}</ItemTitle>
          <ItemDescription>
            {title === "" ? built : `${built} · ${title}`}
          </ItemDescription>
        </ItemContent>
        {on.length === 0 && release.bundleDeletedAt === null ? null : (
          <ItemActions>
            {channelIds
              .filter((channel) => on.includes(channel))
              .map((channel) => (
                <Badge key={channel} variant="secondary">
                  {channelWords[channel]}
                </Badge>
              ))}
            {release.bundleDeletedAt === null ? null : (
              <Badge variant="outline">Bundle deleted</Badge>
            )}
          </ItemActions>
        )}
      </Link>
    </Item>
  );
};

/**
 * Every release CI published, as the admin imported it, the newest first,
 * each a row to its own page with the channels it has been on.
 */
const ReleasesPage = () => {
  const { releases, older, channelsOn } = Route.useLoaderData();
  return (
    <PlatformPage
      description="Every merge to main publishes a release; the admin imports it and puts it on Edge by itself. Promote it to Beta, then Stable, from Platform. A release never promoted past Edge keeps its bundle for 14 days; its record stays for good."
      parents={[platformCrumb]}
      title="Releases"
    >
      <PagePart
        description={
          older === null
            ? "As CI made them, the newest first, with the channels each has been on."
            : `The newest ${releases.length} releases, with the channels each has been on.`
        }
        id="every-release"
        title="Every release"
      >
        {releases.length === 0 ? (
          <EmptyPart>
            No releases yet. Every merge to main publishes one, and the admin
            imports it within a minute.
          </EmptyPart>
        ) : (
          <ItemGroup aria-labelledby="every-release" separated>
            {releases.map((release) => (
              <ReleaseRow
                key={release.id}
                on={channelsOn[release.id] ?? []}
                release={release}
              />
            ))}
          </ItemGroup>
        )}
      </PagePart>
    </PlatformPage>
  );
};

export const Route = createFileRoute("/platform/releases/")({
  loader: async () => await fetchReleases(),
  component: ReleasesPage,
  pendingComponent: PageLoading,
});

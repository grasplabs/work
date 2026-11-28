import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { createFileRoute } from "@tanstack/react-router";

import { AlertChannels } from "../../admin/alert-parts.tsx";
import { PageLoading } from "../../admin/failure.tsx";
import { EmptyPart, PagePart } from "../../admin/page-part.tsx";
import { fetchPlatform } from "../../admin/platform-data.ts";
import { platformCrumb, PlatformPage } from "../../admin/platform-nav.tsx";
import { eventWords } from "../../admin/platform-parts.tsx";
import type { StaffEvent } from "../../admin/platform-reads.ts";
import { SharedSecrets } from "../../admin/secrets-parts.tsx";
import { fetchAlertChannelsFn } from "../../alerts/functions.ts";
import { fetchClientGrid } from "../../clients/functions.ts";
import { formatTime } from "../../releases/format.ts";

/** What someone at Grasp did, the latest first, as the admin's audit log keeps it. */
const DoneHere = ({
  events,
  names,
}: {
  events: StaffEvent[];
  names: ReadonlyMap<string, string>;
}) => (
  <PagePart
    description="What someone at Grasp did to the platform by hand, the latest first."
    id="done-here"
    title="Done here"
  >
    {events.length === 0 ? (
      <EmptyPart>Nobody at Grasp did anything here yet.</EmptyPart>
    ) : (
      <ItemGroup aria-labelledby="done-here" separated>
        {events.map((event) => (
          <Item key={event.id} size="sm">
            <ItemContent>
              <ItemTitle>
                {eventWords(event, (id) => names.get(id) ?? id)}
              </ItemTitle>
              <ItemDescription>{`${formatTime(event.at)} UTC`}</ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    )}
  </PagePart>
);

/**
 * Platform's Maintenance page: what is rarely needed and so stays off its
 * overview. Where alerts go, whether the shared secrets' old values can
 * go, and what someone at Grasp did, as the admin's audit log keeps it.
 */
const MaintenancePage = () => {
  const { rows, platform, alertChannels } = Route.useLoaderData();
  const names = new Map(rows.map(({ id, name }) => [id, name]));
  return (
    <PlatformPage parents={[platformCrumb]} title="Maintenance">
      <AlertChannels channels={alertChannels} />
      <SharedSecrets />
      <DoneHere events={platform.events} names={names} />
    </PlatformPage>
  );
};

export const Route = createFileRoute("/platform/maintenance")({
  loader: async () => {
    // Every company read anew on entering: staff act on them here.
    const [rows, platform, alertChannels] = await Promise.all([
      fetchClientGrid(),
      fetchPlatform(),
      fetchAlertChannelsFn(),
    ]);
    return { rows, platform, alertChannels };
  },
  head: () => ({ meta: [{ title: "Maintenance" }] }),
  component: MaintenancePage,
  pendingComponent: PageLoading,
});

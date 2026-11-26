import { CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";

import { PageLoading } from "../../admin/failure.tsx";
import { AdminPage } from "../../admin/page.tsx";
import { EmptyPanel, Panel } from "../../admin/panel.tsx";
import { fetchPlatform } from "../../admin/platform-data.ts";
import { platformCrumb, PlatformNav } from "../../admin/platform-nav.tsx";
import { eventWords } from "../../admin/platform-parts.tsx";
import type { StaffEvent } from "../../admin/platform-reads.ts";
import { SharedSecrets } from "../../admin/secrets-parts.tsx";
import { formatDate } from "../../admin/words.ts";
import { fetchClientGrid } from "../../clients/functions.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space["6"] },
});

/** A day, as the admin's pages say it. */
const dayOf = (at: Date): string => formatDate(at.toISOString().slice(0, 10));

/** What someone at Grasp did, as the admin's audit log keeps it. */
const DoneHere = ({
  events,
  names,
}: {
  events: StaffEvent[];
  names: ReadonlyMap<string, string>;
}) =>
  events.length === 0 ? (
    <EmptyPanel>Nobody at Grasp did anything here yet.</EmptyPanel>
  ) : (
    <Panel title="Done here">
      <CardContent flush>
        <ItemGroup separated>
          {events.map((event) => (
            <Item key={event.id} size="sm">
              <ItemContent>
                <ItemTitle>
                  {eventWords(event, (id) => names.get(id) ?? id)}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Text as="span" color="muted" size="xs">
                  {dayOf(event.at)}
                </Text>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
    </Panel>
  );

/**
 * Platform's Maintenance page: what is rarely needed and so stays off its
 * overview. Whether the shared secrets' old values can go, and what
 * someone at Grasp did, as the admin's audit log keeps it.
 */
const MaintenancePage = () => {
  const { rows, platform } = Route.useLoaderData();
  const names = new Map(rows.map(({ id, name }) => [id, name]));
  return (
    <AdminPage parents={[platformCrumb]} title="Maintenance">
      <PlatformNav />
      <div {...stylex.props(styles.page)}>
        <SharedSecrets />
        <DoneHere events={platform.events} names={names} />
      </div>
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/maintenance")({
  loader: async () => {
    // Every company read anew on entering: staff act on them here.
    const [rows, platform] = await Promise.all([
      fetchClientGrid(),
      fetchPlatform(),
    ]);
    return { rows, platform };
  },
  head: () => ({ meta: [{ title: "Maintenance" }] }),
  component: MaintenancePage,
  pendingComponent: PageLoading,
});

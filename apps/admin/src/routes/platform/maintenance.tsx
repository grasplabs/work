import { createFileRoute } from "@tanstack/react-router";

import { PageLoading } from "../../admin/failure.tsx";
import { AdminPage } from "../../admin/page.tsx";
import { fetchPlatform } from "../../admin/platform-data.ts";
import type { StaffEvent } from "../../admin/platform-data.ts";
import { platformCrumb, PlatformNav } from "../../admin/platform-nav.tsx";
import { eventWords } from "../../admin/platform-parts.tsx";
import { SharedSecrets } from "../../admin/secrets-parts.tsx";
import { EmptySection, Section } from "../../admin/section.tsx";
import { formatDate } from "../../admin/words.ts";
import { fetchClientGrid } from "../../clients/functions.ts";

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
    <EmptySection>Nobody at Grasp did anything here yet.</EmptySection>
  ) : (
    <Section title="Done here">
      <ul className="flex flex-col">
        {events.map((event) => (
          <li
            className="flex items-baseline justify-between gap-4 border-t px-5 py-3"
            key={event.id}
          >
            <span className="min-w-0">
              {eventWords(event, (id) => names.get(id) ?? id)}
            </span>
            <span className="text-muted-foreground flex-none text-xs tabular-nums">
              {dayOf(event.at)}
            </span>
          </li>
        ))}
      </ul>
    </Section>
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
      <div className="flex flex-col gap-6 text-sm">
        <SharedSecrets />
        <DoneHere events={platform.events} names={names} />
      </div>
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/maintenance")({
  loader: async () => {
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

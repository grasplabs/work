import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { createFileRoute, Link } from "@tanstack/react-router";

import { WithAdmins } from "../admin/admins.tsx";
import { StephenLab } from "../admin/lab.tsx";
import { AdminPage } from "../admin/page.tsx";
import { organizationsOf } from "../admin/views.ts";

type Channel = "edge" | "beta" | "stable";
const CHANNELS: readonly Channel[] = ["edge", "beta", "stable"];

/** Which release channel's real interviews the Lab shows (`?where=edge`), all when unset. */
interface LabSearch {
  where?: Channel;
}

const isChannel = (value: unknown): value is Channel =>
  CHANNELS.some((channel) => channel === value);

/** Each choice of channel, as its link says it: every channel first. */
const choices: readonly { where?: Channel; label: string }[] = [
  { label: "All" },
  { where: "edge", label: "Edge" },
  { where: "beta", label: "Beta" },
  { where: "stable", label: "Stable" },
];

/**
 * Which release channel, for the whole page: links that set the page's
 * `where`, drawn as a segmented switch (Damsko's TabsNav), the chosen one
 * raised.
 */
const Channels = ({ search }: { search: LabSearch }) => (
  <TabsNav aria-label="Which channel" size="sm">
    {choices.map(({ where, label }) => (
      <TabsLink asChild current={search.where === where} key={label}>
        <Link search={{ ...search, where }} to="/lab">
          {label}
        </Link>
      </TabsLink>
    ))}
  </TabsNav>
);

/** Stephen Lab: testing and improving Stephen, in the lab and with real people (src/admin/lab.tsx). */
const LabPage = () => {
  const search = Route.useSearch();
  return (
    <AdminPage
      action={<Channels search={search} />}
      description="Where Stephen stands in the lab and with real people, version by version, and what needs us."
      title="Stephen Lab"
    >
      <WithAdmins>
        {(admins) => (
          <StephenLab
            now={new Date().toISOString()}
            organizations={organizationsOf(admins)}
            {...(search.where === undefined ? {} : { channel: search.where })}
          />
        )}
      </WithAdmins>
    </AdminPage>
  );
};

export const Route = createFileRoute("/lab")({
  validateSearch: (search: Record<string, unknown>): LabSearch =>
    isChannel(search.where) ? { where: search.where } : {},
  component: LabPage,
});

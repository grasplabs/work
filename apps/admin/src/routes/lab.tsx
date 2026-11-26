import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/app-kit/components/toggle-group";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { WithAdmins } from "../admin/admins.tsx";
import { StephenLab } from "../admin/lab.tsx";
import { loadEveryAdmin } from "../admin/org-loads.ts";
import { freshMs } from "../admin/org-reads.ts";
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

/** Which release channel, for the whole page. */
const Channels = ({ search }: { search: LabSearch }) => {
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <ToggleGroup
      aria-label="Which channel"
      size="sm"
      spacing={0}
      variant="outline"
      onValueChange={(value: string[]) => {
        const where = value.find(isChannel);
        void navigate({
          search: { ...search, where },
        });
      }}
      value={[search.where ?? "all"]}
    >
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="edge">Edge</ToggleGroupItem>
      <ToggleGroupItem value="beta">Beta</ToggleGroupItem>
      <ToggleGroupItem value="stable">Stable</ToggleGroupItem>
    </ToggleGroup>
  );
};

/** Stephen Lab: testing and improving Stephen, in the lab and with real people (src/admin/lab.tsx). */
const LabPage = () => {
  const search = Route.useSearch();
  const { admins } = Route.useLoaderData();
  return (
    <AdminPage
      action={<Channels search={search} />}
      description="Where Stephen stands in the lab and with real people, version by version, and what needs us."
      title="Stephen Lab"
    >
      <WithAdmins admins={admins}>
        {(read) => (
          <StephenLab
            now={new Date().toISOString()}
            organizations={organizationsOf(read)}
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
  loader: loadEveryAdmin,
  staleTime: freshMs,
  // A preload reads nothing: opened, the page loads anew and reads them.
  preloadStaleTime: 0,
  component: LabPage,
});

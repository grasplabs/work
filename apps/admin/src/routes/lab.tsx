import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { WithAdmins } from "../admin/admins.tsx";
import { StephenLab } from "../admin/lab.tsx";
import { AdminPage } from "../admin/page.tsx";
import { organizationsOf } from "../admin/views.ts";

type Channel = "edge" | "beta" | "stable";
const CHANNELS: readonly Channel[] = ["edge", "beta", "stable"];

/**
 * Whose numbers the Lab shows: Stephen's, or Claire's (`?who=claire`); and
 * which release channel's real interviews (`?where=edge`), all when unset.
 */
interface LabSearch {
  who?: "claire";
  where?: Channel;
}

const isChannel = (value: unknown): value is Channel =>
  CHANNELS.some((channel) => channel === value);

/** Stephen or Claire, and which release channel, for the whole page. */
const Switches = ({ search }: { search: LabSearch }) => {
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <div className="flex flex-wrap items-center gap-3">
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
      <ToggleGroup
        aria-label="Whose numbers"
        size="sm"
        spacing={0}
        variant="outline"
        onValueChange={(value: string[]) => {
          void navigate({
            search: {
              ...search,
              who: value.includes("claire") ? "claire" : undefined,
            },
          });
        }}
        value={[search.who === "claire" ? "claire" : "stephen"]}
      >
        <ToggleGroupItem value="stephen">Stephen</ToggleGroupItem>
        <ToggleGroupItem value="claire">Claire</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
};

/** Stephen Lab: testing and improving Stephen, in the lab and with real people (src/admin/lab.tsx). */
const LabPage = () => {
  const search = Route.useSearch();
  return (
    <AdminPage
      action={<Switches search={search} />}
      description="Where Stephen stands in the lab and with real people, version by version, and what needs us."
      title="Stephen Lab"
    >
      <WithAdmins>
        {(admins) => (
          <StephenLab
            interviewer={search.who === "claire" ? "claire" : "stephen"}
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
  validateSearch: (search: Record<string, unknown>): LabSearch => ({
    ...(search.who === "claire" ? { who: "claire" } : {}),
    ...(isChannel(search.where) ? { where: search.where } : {}),
  }),
  component: LabPage,
});

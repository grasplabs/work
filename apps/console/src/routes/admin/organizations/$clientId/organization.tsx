import { createFileRoute } from "@tanstack/react-router";

import { useOrganization } from "../../../../admin/organization.tsx";
import { OrgOrganization } from "../../../../admin/teams.tsx";

interface OrganizationSearch {
  /** The team that is open; all of them when none is. */
  team?: string;
}

const OrganizationSection = () => {
  const { admin, view } = useOrganization();
  const { team } = Route.useSearch();
  // Titles are on the company's list, which the model's people don't carry.
  const titles = new Map(
    (admin.snapshot.roster?.people ?? []).map((person) => [
      person.id,
      person.title,
    ])
  );
  return (
    <OrgOrganization
      clientId={admin.client.id}
      team={team}
      titles={titles}
      view={view}
    />
  );
};

/** An organization's Organization: its teams, who leads them, who is in them, and the work they do. */
export const Route = createFileRoute(
  "/admin/organizations/$clientId/organization"
)({
  // The router keeps what a search had under a key validated away: a team
  // that can't be one is said to be none, not left out. An id of digits
  // comes parsed as a number.
  validateSearch: (search: Record<string, unknown>): OrganizationSearch => {
    const { team } = search;
    if (typeof team === "number") {
      return { team: String(team) };
    }
    return { team: typeof team === "string" && team !== "" ? team : undefined };
  },
  component: OrganizationSection,
});

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  InterviewersDoing,
  InterviewersSetup,
} from "../../../admin/interviewers.tsx";
import { InterviewPeople, InterviewTeams } from "../../../admin/interviews.tsx";
import { useOrganization } from "../../../admin/organization.tsx";

/**
 * The interviews from every side, as the prototype's tabs have them
 * (grasplabs/prototype `components/admin/org-interviews.tsx`): where every
 * team stands, with each team whole behind its name, everyone by name
 * with their interview's numbers, and Stephen and Claire, how they did
 * and how they are set up. Stephen is part of the
 * interviews: how people rate him and whether they finish is part of how
 * the interviews go.
 */
const interviewTabs = ["teams", "people", "interviewers", "setup"] as const;
type InterviewTab = (typeof interviewTabs)[number];

const tabWords: Record<InterviewTab, string> = {
  teams: "Teams",
  people: "People",
  interviewers: "Interviewers",
  setup: "Their setup",
};

/** The tab in the address (the teams, the first, have none), and the team that is open there. */
interface InterviewsSearch {
  tab?: Exclude<InterviewTab, "teams">;
  team?: string;
}

const Interviews = () => {
  const { view, admin } = useOrganization();
  const clientId = admin.client.id;
  const { tab = "teams", team } = Route.useSearch();
  // Titles are on the company's list, which the model's people don't carry.
  const titles = new Map(
    (admin.snapshot.roster?.people ?? []).map((person) => [
      person.id,
      person.title,
    ])
  );
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Tabs
      onValueChange={(value: string) => {
        const chosen = interviewTabs.find((each) => each === value);
        void navigate({
          search:
            chosen === undefined || chosen === "teams" ? {} : { tab: chosen },
        });
      }}
      value={tab}
    >
      <TabsList aria-label="Interviews" variant="line">
        {interviewTabs.map((each) => (
          <TabsTrigger className="flex-none" key={each} value={each}>
            {tabWords[each]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="teams">
        <div className="mt-4 flex flex-col gap-6">
          <InterviewTeams
            clientId={clientId}
            team={team}
            titles={titles}
            view={view}
          />
        </div>
      </TabsContent>
      <TabsContent value="people">
        <div className="mt-4 flex flex-col gap-6">
          <InterviewPeople
            clientId={clientId}
            links={admin.snapshot.links}
            view={view}
          />
        </div>
      </TabsContent>
      <TabsContent value="interviewers">
        <div className="mt-4 flex flex-col gap-6">
          <InterviewersDoing view={view} />
        </div>
      </TabsContent>
      <TabsContent value="setup">
        <div className="mt-4 flex flex-col gap-6">
          <InterviewersSetup
            clientId={clientId}
            setupRead={admin.snapshot.setup}
            view={view}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
};

/** An organization's Interviews, its tab in the address. */
export const Route = createFileRoute("/organizations/$clientId/interviews")({
  // A tab that isn't one is the teams. A team is open on the teams alone;
  // an id of digits comes parsed as a number.
  validateSearch: (search: Record<string, unknown>): InterviewsSearch => {
    const tab = interviewTabs.find((each) => each === search.tab);
    if (tab !== undefined && tab !== "teams") {
      return { tab };
    }
    const { team } = search;
    if (typeof team === "number") {
      return { team: String(team) };
    }
    return typeof team === "string" && team !== "" ? { team } : {};
  },
  component: Interviews,
});

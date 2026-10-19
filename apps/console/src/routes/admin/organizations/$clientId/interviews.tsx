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
} from "../../../../admin/interviewers.tsx";
import {
  InterviewList,
  InterviewPeople,
  InterviewTeams,
} from "../../../../admin/interviews.tsx";
import { useOrganization } from "../../../../admin/organization.tsx";

/**
 * The interviews from every side, as the prototype's tabs have them
 * (grasplabs/prototype `components/admin/org-interviews.tsx`): where every
 * team stands, everyone by name, the interviews one by one, and Stephen
 * and Claire, how they did and how they are set up. Stephen is part of the
 * interviews: how people rate him and whether they finish is part of how
 * the interviews go.
 */
const interviewTabs = [
  "teams",
  "people",
  "transcripts",
  "interviewers",
  "setup",
] as const;
type InterviewTab = (typeof interviewTabs)[number];

const tabWords: Record<InterviewTab, string> = {
  teams: "Teams",
  people: "People",
  transcripts: "Transcripts",
  interviewers: "Interviewers",
  setup: "Their setup",
};

/** The tab in the address; the teams, the first, have none. */
interface InterviewsSearch {
  tab?: Exclude<InterviewTab, "teams">;
}

const Interviews = () => {
  const { view } = useOrganization();
  const { tab = "teams" } = Route.useSearch();
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
          <InterviewTeams view={view} />
        </div>
      </TabsContent>
      <TabsContent value="people">
        <div className="mt-4 flex flex-col gap-6">
          <InterviewPeople view={view} />
        </div>
      </TabsContent>
      <TabsContent value="transcripts">
        <div className="mt-4 flex flex-col gap-6">
          <InterviewList view={view} />
        </div>
      </TabsContent>
      <TabsContent value="interviewers">
        <div className="mt-4 flex flex-col gap-6">
          <InterviewersDoing view={view} />
        </div>
      </TabsContent>
      <TabsContent value="setup">
        <div className="mt-4 flex flex-col gap-6">
          <InterviewersSetup view={view} />
        </div>
      </TabsContent>
    </Tabs>
  );
};

/** An organization's Interviews, its tab in the address. */
export const Route = createFileRoute(
  "/admin/organizations/$clientId/interviews"
)({
  validateSearch: (search: Record<string, unknown>): InterviewsSearch => {
    const tab = interviewTabs.find((each) => each === search.tab);
    return tab === undefined || tab === "teams" ? {} : { tab };
  },
  component: Interviews,
});

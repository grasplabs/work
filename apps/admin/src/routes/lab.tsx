import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { WithAdmins } from "../admin/admins.tsx";
import { StephenLab } from "../admin/lab.tsx";
import { AdminPage } from "../admin/page.tsx";
import { organizationsOf } from "../admin/views.ts";

/** Whose numbers the Lab shows: Stephen's, or Claire's (`?who=claire`). */
interface LabSearch {
  who?: "claire";
}

/** Stephen or Claire, for the whole page. */
const WhoSwitch = ({ claire }: { claire: boolean }) => {
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <ToggleGroup
      aria-label="Whose numbers"
      onValueChange={(value: string[]) => {
        void navigate({
          search: value.includes("claire") ? { who: "claire" } : {},
        });
      }}
      value={[claire ? "claire" : "stephen"]}
    >
      <ToggleGroupItem value="stephen">Stephen</ToggleGroupItem>
      <ToggleGroupItem value="claire">Claire</ToggleGroupItem>
    </ToggleGroup>
  );
};

/** Stephen Lab: testing and improving Stephen, in the lab and with real people (src/admin/lab.tsx). */
const LabPage = () => {
  const { who } = Route.useSearch();
  const claire = who === "claire";
  return (
    <AdminPage
      action={<WhoSwitch claire={claire} />}
      description="Where Stephen stands in the lab and with real people, version by version, and what needs us."
      title="Stephen Lab"
    >
      <WithAdmins>
        {(admins) => (
          <StephenLab
            interviewer={claire ? "claire" : "stephen"}
            now={new Date().toISOString()}
            organizations={organizationsOf(admins)}
          />
        )}
      </WithAdmins>
    </AdminPage>
  );
};

export const Route = createFileRoute("/lab")({
  validateSearch: (search: Record<string, unknown>): LabSearch =>
    search.who === "claire" ? { who: "claire" } : {},
  component: LabPage,
});

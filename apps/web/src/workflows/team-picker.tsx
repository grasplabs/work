import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { useCore } from "../use-core.ts";

// The team that owns a workflow (GRA-517), beside its owner on its page,
// changed right there (GRA-1210): the organization's teams to pick from,
// read when the list first opens, and none. Those who may change the
// owner (`changesOwner`: an admin or a builder of the App) may change the
// team too; everyone else reads it. A refusal is said in a toast, and the
// page keeps the team it had.

/** A team, as the select offers it. */
export interface TeamChoice {
  id: string;
  name: string;
}

/** The select's value for no team: no team's ID is empty. */
const noTeam = "";

/**
 * The select's items: none first, then `teams` by name, with `current`
 * among them while the organization's teams aren't read yet.
 */
export const teamItemsOf = (
  current: TeamChoice | null,
  teams: readonly TeamChoice[] | null,
  none: string
): { value: string; label: string }[] => {
  const offered = teams ?? (current === null ? [] : [current]);
  return [
    { value: noTeam, label: none },
    ...offered
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name }) => ({ value: id, label: name })),
  ];
};

/** A workflow's team, as a select for those who change it, else in words. */
export const WorkflowTeamView = ({
  team,
  teams,
  editable,
  onOpen,
  onPick,
}: {
  team: TeamChoice | null;
  teams: readonly TeamChoice[] | null;
  editable: boolean;
  onOpen: () => void;
  onPick: (team: TeamChoice | null) => void;
}) => {
  const { t } = useLingui();
  if (!editable) {
    const name = team?.name;
    return (
      <span className="text-xs">
        {name === undefined ? t`No team` : t`Team: ${name}`}
      </span>
    );
  }
  const items = teamItemsOf(team, teams, t`No team`);
  return (
    <Select
      items={items}
      value={team?.id ?? noTeam}
      onOpenChange={(open: boolean) => {
        if (open) {
          onOpen();
        }
      }}
      onValueChange={(value: string | null) => {
        const chosen = items.find((item) => item.value === value);
        if (chosen === undefined || chosen.value === (team?.id ?? noTeam)) {
          return;
        }
        onPick(
          chosen.value === noTeam
            ? null
            : { id: chosen.value, name: chosen.label }
        );
      }}
    >
      <SelectTrigger aria-label={t`Team`} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/** A workflow's team on its page, set through core. */
export const WorkflowTeamPicker = ({
  workflow,
}: {
  workflow: WorkflowSummary;
}) => {
  const core = useCore();
  const router = useRouter();
  const { t } = useLingui();
  const [teams, setTeams] = useState<TeamChoice[] | null>(null);
  const readTeams = async (): Promise<void> => {
    if (teams !== null) {
      return;
    }
    try {
      setTeams(
        await core.withSession(
          async (session) => await session.workflows.teams()
        )
      );
    } catch {
      // Only the team it has, and none, are offered.
    }
  };
  const pick = async (team: TeamChoice | null): Promise<void> => {
    try {
      await core.withSession(async (session) => {
        await changeThenRefresh(
          async () =>
            await session.workflows.setTeam(
              workflow.app,
              workflow.workflow,
              team?.id ?? null
            ),
          async () => {
            await router.invalidate({ sync: true });
          }
        );
      });
    } catch (error) {
      const named = workflow.workflow;
      toast.add({
        type: "error",
        title: t`Couldn't change the team of ${named}`,
        description: failureText(error),
      });
    }
  };
  return (
    <WorkflowTeamView
      editable={workflow.changesOwner}
      team={workflow.team}
      teams={teams}
      onOpen={() => {
        void readTeams();
      }}
      onPick={(team) => {
        void pick(team);
      }}
    />
  );
};

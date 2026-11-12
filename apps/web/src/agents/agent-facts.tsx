import type { Agent, AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import type { ToolClassAudience } from "@grasp-os/shared/connect";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { Badge } from "@grasp-os/ui/components/badge";
import { useLingui } from "@lingui/react/macro";

// What the Agents pages say of an agent at a glance (agents-overview.tsx,
// agent-page.tsx): whether it is on, whom it answers, how much it may do
// and when it next works on its own. Each is read from what core keeps
// (`connections.agents`, `agentSettings`, `agentWakes`), never worked out
// anew here.

/** Whether an agent answers, as a badge: filled while it is on. */
export const AgentStateBadge = ({ state }: { state: Agent["state"] }) => {
  const { t } = useLingui();
  return (
    <Badge variant={state === "on" ? "default" : "outline"}>
      {state === "on" ? t`On` : t`Paused`}
    </Badge>
  );
};

/** Whom an audience names, in a few words. */
export const useAudienceLine = (teams: StephenReach["teams"]) => {
  const { t, i18n } = useLingui();
  return (audience: ToolClassAudience): string => {
    if (audience.who === "everyone") {
      return t`Everyone`;
    }
    if (audience.who === "nobody") {
      return t`Nobody yet`;
    }
    const names = audience.teams.map(
      (teamId) => teams.find((team) => team.teamId === teamId)?.name ?? teamId
    );
    return new Intl.ListFormat(i18n.locale, {
      style: "short",
      type: "conjunction",
    }).format(names);
  };
};

/** How many of the company's classes of tools an agent has for anyone. */
export const classesOn = (
  settings: AgentSettings
): { on: number; of: number } => ({
  on: settings.classes.filter(({ audience }) => audience.who !== "nobody")
    .length,
  of: settings.classes.length,
});

/** The wake-ups that fire: the ones that are on. */
export const wakesOn = (wakes: readonly AgentWake[]): AgentWake[] =>
  wakes.filter(({ state }) => state === "on");

/** When an agent next works on its own (ISO 8601); undefined when it never does. */
export const nextWakeAt = (wakes: readonly AgentWake[]): string | undefined =>
  wakesOn(wakes)
    .flatMap(({ nextAt }) => (nextAt === null ? [] : [nextAt]))
    .toSorted()
    .at(0);

import type { Agent, AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import type { ToolClassAudience } from "@grasp-os/shared/connect";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { useLingui } from "@lingui/react/macro";

import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";

// What the Agents pages say of an agent at a glance (agents-overview.tsx,
// agent-page.tsx): whether it is on, whom it answers, how much it may do
// and when it next works on its own. Each is read from what core keeps
// (`connections.agents`, `agentSettings`, `agentWakes`), never worked out
// anew here.

/** Whether an agent answers, as a badge: green while it is on. */
export const AgentStateBadge = ({ state }: { state: Agent["state"] }) => {
  const { t } = useLingui();
  return (
    <Badge size="sm" tone={state === "on" ? "success" : "neutral"}>
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

/** Why a change to an agent failed, where it was asked; nothing when it didn't. */
export const AgentFailure = ({ children }: { children: string | undefined }) =>
  children === undefined ? null : <Alert title={children} variant="danger" />;

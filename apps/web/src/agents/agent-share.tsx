import type { Agent } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import { Button } from "@grasp-os/ui/components/button";
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Switch } from "@grasp-os/ui/components/switch";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { Fragment } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { useCoreAction } from "../use-core-action.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { SettingRow, SettingsCard } from "./settings-card.tsx";
import type { Change } from "./settings-card.tsx";

// A person's own agent offered to the company (core's agent-builder.ts,
// `offerOwnAgent`, `adoptAgent`): its owner offers it from its page, and
// the company's admins take it on or decline it from the Agents page.
// Taken on, it is one of the company's, reaching nobody and doing nothing
// until an admin says so, and its owner no longer changes it. What it is
// told is its instruction file, which stays in its owner's own store,
// read by them alone: neither the offer nor taking it on carries it
// (core's instruction-files.ts). Both are settings cards, as the agent's
// page has its other parts.

/**
 * On a person's own agent's page: offering it to the company, or taking
 * the offer back. Nothing on any other agent's page.
 */
export const ShareAgent = ({
  agent,
  can,
  change,
}: {
  agent: Agent;
  /** Whether they may now: not while a change is on its way to core. */
  can: boolean;
  change: Change;
}) => {
  const { t, i18n } = useLingui();
  if (agent.ownerId === null) {
    return null;
  }
  const { name } = agent;
  const offered = agent.offeredAt !== null;
  const since =
    agent.offeredAt === null
      ? ""
      : new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
          new Date(agent.offeredAt)
        );
  // A row as Settings has its settings: a switch, one short line, and
  // what it means behind the info mark.
  return (
    <SettingsCard title={t`Sharing`}>
      <FieldGroup>
        <SettingRow
          help={
            offered
              ? t`Offered on ${since}`
              : t`The company's admins may take ${name} on`
          }
          info={t`If an admin takes it on, it becomes one of the company's agents: they choose who may ask it and what it may do. What you told it doesn't go with it, and you can no longer change or open it.`}
          label={t`Offer to the company`}
        >
          <Switch
            checked={offered}
            disabled={!can}
            // A spinner while it saves; failed, it stays and says so.
            onSave={async (next) => {
              const done = await change(async (session) => {
                await session.connections.offerOwnAgent(agent.id, next);
              });
              if (!done) {
                throw new Error("The offer wasn't saved.");
              }
            }}
          />
        </SettingRow>
      </FieldGroup>
    </SettingsCard>
  );
};

/** For admins on the Agents page: the agents people offered the company. */
export const OfferedAgents = ({
  offered,
  people,
  editable,
}: {
  offered: readonly Agent[];
  /** The company's people, by whom each offer is named. */
  people: readonly Member[];
  /** Whether the person may take one on: the company's own admins. */
  editable: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  if (offered.length === 0) {
    return null;
  }
  const nameOf = (userId: string | null): string => {
    const found = people.find((each) => each.userId === userId);
    if (found === undefined) {
      return t`Someone no longer in the company`;
    }
    return found.name === "" ? found.email : found.name;
  };
  const decide = (agentId: string, adopt: boolean): void => {
    void run(async (session) => {
      // Read again however it ends: another admin may have decided first.
      await changeThenRefresh(
        async () => {
          await (adopt
            ? session.connections.adoptAgent(agentId)
            : session.connections.declineAgent(agentId));
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <>
      <SettingsCard
        description={t`Agents people made for themselves and offered to the company. Taking one on makes it the company's: it starts reaching nobody, with nothing it may do, until you say so.`}
        title={t`Offered to the company`}
      >
        <ItemGroup aria-label={t`Offered to the company`}>
          {offered.map((agent, index) => {
            const { name, job } = agent;
            const from = nameOf(agent.ownerId);
            return (
              <Fragment key={agent.id}>
                {index === 0 ? null : <ItemSeparator />}
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{name}</ItemTitle>
                    <ItemDescription>
                      {job === "" ? t`From ${from}` : t`From ${from} · ${job}`}
                    </ItemDescription>
                  </ItemContent>
                  {editable ? (
                    <ItemActions>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          decide(agent.id, false);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        {t`Decline`}
                      </Button>
                      <Button
                        aria-label={t`Take ${name} on for the company`}
                        disabled={busy}
                        onClick={() => {
                          decide(agent.id, true);
                        }}
                        size="sm"
                      >
                        {t`Take on`}
                      </Button>
                    </ItemActions>
                  ) : null}
                </Item>
              </Fragment>
            );
          })}
        </ItemGroup>
      </SettingsCard>
      {/* Why a decision failed, under the card it was made in. */}
      <AgentFailure>{failure}</AgentFailure>
    </>
  );
};

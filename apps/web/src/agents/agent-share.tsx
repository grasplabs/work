import type { Agent } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { SettingsSection } from "../settings/settings-parts.tsx";
import { Row } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A person's own agent offered to the company (core's agent-builder.ts,
// `offerOwnAgent`, `adoptAgent`): its owner offers it from its page, and
// the company's admins take it on or decline it from the Agents page.
// Taken on, it is one of the company's, reaching nobody and doing nothing
// until an admin says so, and its owner no longer changes it. Until its
// owner offers it, nobody but them reads what it is told.

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

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
  return (
    <SettingsSection
      action={
        <Button
          disabled={!can}
          onClick={() => {
            void change(async (session) => {
              await session.connections.offerOwnAgent(agent.id, !offered);
            });
          }}
          size="sm"
          variant="outline"
        >
          {offered ? t`Take the offer back` : t`Offer to the company`}
        </Button>
      }
      description={
        offered
          ? t`Offered on ${since}. Your company's admins can now read what ${name} is told and the documents it has, and may take it on.`
          : t`Offer ${name} to your company's admins. If they take it on, it becomes one of the company's agents: they choose who may ask it and what it may do, and you no longer change it.`
      }
      title={t`Share with the company`}
    />
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
      await (adopt
        ? session.connections.adoptAgent(agentId)
        : session.connections.declineAgent(agentId));
      await router.invalidate({ sync: true });
    });
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium">
          <Trans>Offered to the company</Trans>
        </h2>
        <p className="text-muted-foreground text-sm">
          <Trans>
            Agents people made for themselves and offered to the company. Taking
            one on makes it the company&apos;s: it starts reaching nobody, with
            nothing it may do, until you say so.
          </Trans>
        </p>
      </div>
      <Card variant="panel">
        <ul className="[&>li:first-child]:border-t-0">
          {offered.map((agent) => {
            const { name, job } = agent;
            const from = nameOf(agent.ownerId);
            return (
              <Row
                description={
                  job === "" ? t`From ${from}` : t`From ${from} · ${job}`
                }
                key={agent.id}
                name={name}
              >
                <details className="text-sm sm:max-w-80">
                  <summary className="cursor-pointer">
                    <Trans>What it is told</Trans>
                  </summary>
                  <p className="text-muted-foreground mt-2 whitespace-pre-wrap">
                    {agent.instructions === ""
                      ? t`Nothing beyond Grasp's own rules.`
                      : agent.instructions}
                  </p>
                </details>
                {editable ? (
                  <span className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => {
                        decide(agent.id, false);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <Trans>Decline</Trans>
                    </Button>
                    <Button
                      aria-label={t`Take ${name} on for the company`}
                      disabled={busy}
                      onClick={() => {
                        decide(agent.id, true);
                      }}
                      size="sm"
                    >
                      <Trans>Take on</Trans>
                    </Button>
                  </span>
                ) : null}
              </Row>
            );
          })}
        </ul>
      </Card>
      <ErrorText>{failure}</ErrorText>
    </section>
  );
};
